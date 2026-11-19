import "server-only";
import type { Browser, HTTPRequest } from "puppeteer-core";
import type { Device } from "./devices";
import type { CaptureOptions } from "./options";
import { hostIsSafe } from "./guard";
import { singleProcess } from "./browser";

const MAX_HEIGHT = Number(process.env.MAX_PAGE_HEIGHT) || 16000;
// Vercel functions can return at most 4.5 MB, so images are kept under ~4.2 MB.
const MAX_BYTES = 4_200_000;

// Ad networks and trackers slow pages down and make every screenshot different.
const AD_HOSTS = /(googlesyndication|doubleclick|googleadservices|google-analytics|googletagmanager|adservice\.google|amazon-adsystem|facebook\.net|connect\.facebook|hotjar|clarity\.ms|taboola|outbrain|mediavine|adthrive|raptive|ezoic|criteo|pubmatic|rubiconproject|openx|casalemedia|adnxs|scorecardresearch|quantserve|quantcount|moatads|sharethrough|33across|teads|yieldmo|smartadserver)/i;

const COOKIE_SELECTORS = [
  "#cookie-notice", "#cookie-law-info-bar", ".cli-modal", ".cky-consent-container", ".cky-overlay",
  "#cmplz-cookiebanner-container", ".cmplz-cookiebanner", "#moove_gdpr_cookie_info_bar",
  "#CybotCookiebotDialog", "#onetrust-consent-sdk", ".cc-window", ".cc-banner", "#cookie-consent",
  ".fc-consent-root", "#qc-cmp2-container", ".termly-styles-root", "#usercentrics-root",
  ".elementor-popup-modal", ".dialog-lightbox-widget", ".pum-overlay",
];

// Without this, Elementor entrance animations leave sections invisible and
// half-finished transitions get frozen into the image.
const BASE_CSS = `
*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}
.elementor-invisible{visibility:visible!important;opacity:1!important}
body.dialog-prevent-scroll{overflow:auto!important}
`;

function buildCss(opts: CaptureOptions) {
  const hide = [
    ...(opts.hideCookies ? COOKIE_SELECTORS : []),
    ...opts.hideSelectors.split("\n").map((s) => s.trim()).filter(Boolean),
  ];
  return BASE_CSS + hide.map((s) => `${s}{display:none!important}`).join("\n");
}

export interface ShotResult {
  buffer: Uint8Array;
  width: number;
  height: number;
  truncated: boolean;
}

export async function captureShot(
  browser: Browser,
  { url, device, opts }: { url: string; device: Device; opts: CaptureOptions },
): Promise<ShotResult> {
  // Normally a fresh, isolated context per screenshot. In single-process mode
  // (serverless) contexts aren't possible, so use a tab and clear cookies after.
  const context = singleProcess ? null : await browser.createBrowserContext();
  const page = context ? await context.newPage() : await browser.newPage();
  try {
    await page.setViewport({
      width: device.width,
      height: device.height,
      deviceScaleFactor: opts.retina ? 2 : 1,
      isMobile: device.mobile,
      hasTouch: device.mobile,
    });
    await page.setUserAgent({ userAgent: device.ua });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: opts.dark ? "dark" : "light" }]);
    await page.setBypassCSP(true);
    await page.setBypassServiceWorker(true);

    // Every request the page makes passes through here: ads blocked, private IPs blocked.
    await page.setRequestInterception(true);
    const handle = async (req: HTTPRequest) => {
      if (req.isInterceptResolutionHandled()) return;
      let u: URL;
      try { u = new URL(req.url()); } catch { return req.abort(); }
      if (u.protocol !== "http:" && u.protocol !== "https:") return req.continue();
      if (opts.blockAds && AD_HOSTS.test(u.hostname)) return req.abort("blockedbyclient");
      if (!(await hostIsSafe(u.hostname))) return req.abort("blockedbyclient");
      return req.continue();
    };
    page.on("request", (req) => { handle(req).catch(() => {}); });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40_000 });
    await page.waitForNetworkIdle({ idleTime: 600, timeout: 12_000 }).catch(() => {});
    await page.addStyleTag({ content: buildCss(opts) }).catch(() => {});

    // Scroll down step by step so lazy-loaded images (WP Rocket, LiteSpeed,
    // loading="lazy", Elementor lazy backgrounds) actually load.
    await page.evaluate(async () => {
      document.querySelectorAll<HTMLImageElement>('img[loading="lazy"]').forEach((i) => { i.loading = "eager"; });
      const step = Math.max(300, innerHeight * 0.85);
      for (let y = 0, n = 0; y < document.documentElement.scrollHeight && n < 80; y += step, n++) {
        scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 100));
      }
      scrollTo(0, 0);
    });

    // Wait for images and web fonts, at most 8 seconds
    await page.evaluate(() => Promise.race([
      Promise.all([
        document.fonts?.ready,
        ...Array.from(document.images).filter((i) => !i.complete)
          .map((i) => new Promise((r) => { i.onload = i.onerror = r; })),
      ]),
      new Promise((r) => setTimeout(r, 8000)),
    ])).catch(() => {});
    await new Promise((r) => setTimeout(r, 500 + opts.delay));

    const pageHeight = await page.evaluate(() =>
      Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
    // Retina doubles every pixel, so it gets half the height to stay within limits
    const maxHeight = opts.retina ? MAX_HEIGHT / 2 : MAX_HEIGHT;
    const height = opts.fullPage ? Math.min(pageHeight, maxHeight) : device.height;
    const clip = { x: 0, y: 0, width: device.width, height };

    // Very long pages can exceed the 4.5 MB response limit: lower JPEG quality until it fits.
    let quality = opts.quality;
    let buffer = await page.screenshot({ type: "jpeg", quality, clip, captureBeyondViewport: true });
    while (buffer.byteLength > MAX_BYTES && quality > 40) {
      quality = Math.max(40, quality - 15);
      buffer = await page.screenshot({ type: "jpeg", quality, clip, captureBeyondViewport: true });
    }
    if (buffer.byteLength > MAX_BYTES) {
      throw new Error("This page is too long for one image. Turn off Retina or full page and try again.");
    }

    return { buffer, width: device.width, height, truncated: opts.fullPage && pageHeight > maxHeight };
  } finally {
    if (context) {
      await context.close().catch(() => {});
    } else {
      const cdp = await page.createCDPSession().catch(() => null);
      await cdp?.send("Network.clearBrowserCookies").catch(() => {});
      await page.close().catch(() => {});
    }
  }
}

export function friendlyError(err: unknown): string {
  const m = String((err as Error)?.message ?? err).split("\n")[0];
  if (/ERR_NAME_NOT_RESOLVED/.test(m)) return "This domain could not be found.";
  if (/ERR_BLOCKED_BY_CLIENT/.test(m)) return "Blocked: this address points to a private network.";
  if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED/.test(m)) return "The website refused the connection.";
  if (/ERR_CERT|SSL/.test(m)) return "The website has an SSL certificate problem.";
  if (/timeout|timed out/i.test(m)) return "The page took too long to load.";
  if (/too long for one image/.test(m)) return m;
  return "Could not capture this page.";
}
