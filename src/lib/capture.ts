import "server-only";
import type { Browser, HTTPRequest, Page } from "puppeteer-core";
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

/**
 * Makes the page look "settled", the way a visitor sees it after a few seconds:
 * - animations and transitions finish instantly instead of being caught halfway
 * - Elementor, AOS and WOW.js entrance animations are shown instead of staying invisible
 * - content-visibility:auto is turned off: Chrome skips drawing those sections when
 *   they are outside the screen, which leaves blank holes in full-page screenshots
 */
const BASE_CSS = `
*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}
*{content-visibility:visible!important}
.elementor-invisible{visibility:visible!important;opacity:1!important}
[data-aos]{opacity:1!important;transform:none!important}
.wow{visibility:visible!important}
body.dialog-prevent-scroll{overflow:auto!important}
`;

function buildCss(opts: CaptureOptions) {
  const hide = [
    ...(opts.hideCookies ? COOKIE_SELECTORS : []),
    ...opts.hideSelectors.split("\n").map((s) => s.trim()).filter(Boolean),
  ];
  return BASE_CSS + hide.map((s) => `${s}{display:none!important}`).join("\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, "");

/**
 * WP Rocket ("Delay JavaScript execution"), LiteSpeed, Perfmatters and FlyingPress
 * don't run a site's JavaScript until a real visitor moves the mouse, touches the
 * screen or presses a key. Until then: no carousels, no sliders, no Elementor lazy
 * backgrounds. So we behave like a visitor first, then wait for those scripts.
 */
async function actLikeAVisitor(page: Page, device: Device) {
  const x = Math.round(device.width / 2);
  const y = Math.min(300, Math.round(device.height / 2));
  await page.mouse.move(x, y).catch(() => {});
  await page.mouse.move(x + 40, y + 30, { steps: 4 }).catch(() => {});
  await page.mouse.wheel({ deltaY: 120 }).catch(() => {});
  await page.keyboard.press("Shift").catch(() => {});
  await page.evaluate(() => {
    for (const type of ["touchstart", "touchmove", "touchend"]) window.dispatchEvent(new Event(type));
  }).catch(() => {});
  // Park the mouse at the bottom-left edge so no menu stays open from hovering
  await page.mouse.move(0, device.height - 1).catch(() => {});
  await page.evaluate(() => scrollTo(0, 0)).catch(() => {});
  await page.waitForNetworkIdle({ idleTime: 700, timeout: 10_000 }).catch(() => {});
}

/**
 * Lazy-loading plugins keep the real image address in data-src / data-lazy-src
 * and swap it in when the image scrolls into view. Swap them all in now, and
 * mark Elementor containers as loaded so their background images appear.
 */
async function revealLazyContent(page: Page) {
  await page.evaluate(() => {
    const isPlaceholder = (src: string | null) =>
      !src || src.startsWith("data:") || /lazy|placeholder|blank\.(gif|png)/i.test(src);

    document.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
      img.loading = "eager";
      const real = img.getAttribute("data-lazy-src") || img.getAttribute("data-src");
      const set = img.getAttribute("data-lazy-srcset") || img.getAttribute("data-srcset");
      if (real && isPlaceholder(img.getAttribute("src"))) {
        if (set) img.srcset = set;
        img.src = real;
      }
    });
    document.querySelectorAll<HTMLSourceElement>("picture source").forEach((s) => {
      const set = s.getAttribute("data-lazy-srcset") || s.getAttribute("data-srcset");
      if (set) s.srcset = set;
    });
    document.querySelectorAll<HTMLIFrameElement>("iframe").forEach((f) => {
      f.loading = "eager";
      const real = f.getAttribute("data-lazy-src") || f.getAttribute("data-src");
      if (real && (!f.getAttribute("src") || f.src === "about:blank")) f.src = real;
    });
    document.querySelectorAll<HTMLElement>("[data-bg], [data-lazy-background], [data-background-image], [data-bg-image]").forEach((el) => {
      const bg = el.getAttribute("data-bg") || el.getAttribute("data-lazy-background")
        || el.getAttribute("data-background-image") || el.getAttribute("data-bg-image");
      if (bg && !el.style.backgroundImage) el.style.backgroundImage = bg.startsWith("url(") ? bg : `url("${bg}")`;
    });
    // Elementor hides container backgrounds until .e-lazyloaded is added
    document.querySelectorAll(".e-con, .elementor-section, .elementor-column, [data-e-bg-lazyload]")
      .forEach((el) => el.classList.add("e-lazyloaded"));
    // lazysizes and similar libraries
    document.querySelectorAll(".lazyload, .lazy").forEach((el) => el.classList.add("lazyloaded"));
  }).catch(() => {});
}

/**
 * Waits for images, CSS background images and web fonts. On Vercel the CPU is
 * slower than on a desktop computer, so pages with 100+ lazy images need more
 * time: up to 15 seconds, then one more check for anything still loading.
 * "complete" isn't enough either: an image can be downloaded but not yet decoded
 * (turned into pixels), which still shows as a blank box, so we wait for decode too.
 */
async function waitForVisuals(page: Page) {
  const pass = (timeoutMs: number) => page.evaluate(async (timeoutMs) => {
    const bgUrls = new Set<string>();
    const all = document.querySelectorAll<HTMLElement>("body *");
    for (let i = 0; i < all.length && bgUrls.size < 300; i++) {
      const bg = getComputedStyle(all[i]).backgroundImage;
      if (!bg || bg === "none") continue;
      for (const m of bg.matchAll(/url\(["']?(.*?)["']?\)/g)) if (!m[1].startsWith("data:")) bgUrls.add(m[1]);
    }
    const imgs = Array.from(document.images).filter((i) => i.getAttribute("src") || i.currentSrc);
    const ready = (img: HTMLImageElement) => new Promise<void>((r) => {
      const done = () => { img.decode().catch(() => {}).finally(() => r()); };
      if (img.complete) return done();
      img.addEventListener("load", done, { once: true });
      img.addEventListener("error", () => r(), { once: true });
    });
    await Promise.race([
      Promise.all([
        document.fonts?.ready,
        ...imgs.map(ready),
        // Same URL again is served from memory, so this finishes when the background has arrived
        ...Array.from(bgUrls).map((u) => new Promise((r) => { const im = new Image(); im.onload = im.onerror = r; im.src = u; })),
      ]),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
    return Array.from(document.images).filter((i) => !i.complete).length;
  }, timeoutMs).catch(() => 0);

  const stillLoading = await pass(15_000);
  if (stillLoading > 0) await pass(5_000);
}

export interface ShotResult {
  buffer: Uint8Array;
  width: number;
  height: number;
  truncated: boolean;
  /** Image addresses that failed to load on the live site (404s and similar) */
  broken: string[];
}

export async function captureShot(
  browser: Browser,
  { url, device, opts }: { url: string; device: Device; opts: CaptureOptions },
): Promise<ShotResult> {
  // Normally a fresh, isolated context per screenshot. In single-process mode
  // (serverless) contexts aren't possible, so use a tab and clear everything first.
  const context = singleProcess ? null : await browser.createBrowserContext();
  const page = context ? await context.newPage() : await browser.newPage();
  const siteHost = bareHost(new URL(url).hostname);
  const bustValue = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  try {
    // Start with an empty browser cache and no cookies, every time
    const cdp = await page.createCDPSession();
    await cdp.send("Network.clearBrowserCache").catch(() => {});
    await cdp.send("Network.clearBrowserCookies").catch(() => {});

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

    // Every request the page makes passes through here
    await page.setRequestInterception(true);
    const handle = async (req: HTTPRequest) => {
      if (req.isInterceptResolutionHandled()) return;
      let u: URL;
      try { u = new URL(req.url()); } catch { return req.abort(); }
      if (u.protocol !== "http:" && u.protocol !== "https:") return req.continue();
      if (opts.blockAds && AD_HOSTS.test(u.hostname)) return req.abort("blockedbyclient");
      if (!(await hostIsSafe(u.hostname))) return req.abort("blockedbyclient");

      // Skip caches: the site's own HTML, CSS and JS get a unique ?pf_nocache= value,
      // so Cloudflare, Nginx/RunCloud, LiteSpeed and WP Rocket can't answer from a
      // stored copy. The page itself still sees its normal URL.
      const sameSite = bareHost(u.hostname) === siteHost || u.hostname.endsWith("." + siteHost);
      const type = req.resourceType();
      if (opts.noCache && sameSite && (type === "document" || type === "stylesheet" || type === "script")) {
        u.searchParams.set("pf_nocache", bustValue);
        const isMainPage = req.isNavigationRequest() && req.frame() === page.mainFrame();
        return req.continue({
          url: u.toString(),
          // Extra no-cache headers only on the page itself: adding them to other files
          // could trigger cross-origin checks that block fonts and scripts
          headers: isMainPage ? { ...req.headers(), "cache-control": "no-cache", pragma: "no-cache" } : undefined,
        });
      }
      return req.continue();
    };
    page.on("request", (req) => { handle(req).catch(() => {}); });

    // 1. Load the page
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40_000 });
    await page.waitForNetworkIdle({ idleTime: 600, timeout: 10_000 }).catch(() => {});

    // 2. Behave like a visitor so delayed JavaScript (carousels, sliders...) runs
    await actLikeAVisitor(page, device);

    // 3. Settle animations, reveal lazy content
    await page.addStyleTag({ content: buildCss(opts) }).catch(() => {});
    await revealLazyContent(page);

    // 4. Scroll through the page slowly so scroll-triggered content appears
    await page.evaluate(async () => {
      const step = Math.max(300, innerHeight * 0.85);
      for (let y = 0, n = 0; y < document.documentElement.scrollHeight && n < 100; y += step, n++) {
        scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 140));
      }
      scrollTo(0, 0);
    }).catch(() => {});

    // 5. Anything added by JavaScript during the scroll gets revealed too, then wait for it all
    await revealLazyContent(page);
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 6_000 }).catch(() => {});
    await waitForVisuals(page);
    await page.evaluate(() => scrollTo(0, 0)).catch(() => {});
    await sleep(500 + opts.delay);

    // Set PF_DEBUG=1 (locally or in Vercel's environment variables) to log images
    // that still aren't ready at the moment of capture
    if (process.env.PF_DEBUG) {
      const report = await page.evaluate(() => {
        const imgs = Array.from(document.images);
        const bad = imgs.filter((i) => !i.complete || i.naturalWidth === 0 || (i.getAttribute("src") || "").startsWith("data:"));
        return { total: imgs.length, notReady: bad.length,
          examples: bad.slice(0, 6).map((i) => `${i.complete ? "done" : "loading"} ${i.naturalWidth}w ${(i.currentSrc || i.getAttribute("data-src") || "").slice(-70)}`) };
      }).catch(() => null);
      console.log("[pf-debug]", device.id, url, JSON.stringify(report));
    }

    // Images the site itself failed to deliver (missing files, 404s). Worth fixing on
    // the site, and it tells you a blank box in the screenshot isn't the tool's fault.
    const broken = await page.evaluate(() => [...new Set(Array.from(document.images)
      .filter((i) => i.complete && i.naturalWidth === 0 && i.currentSrc && !i.currentSrc.startsWith("data:"))
      .map((i) => i.currentSrc))].slice(0, 10)).catch(() => [] as string[]);

    // 6. Capture
    const pageHeight = await page.evaluate(() =>
      Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
    // Retina doubles every pixel, so it gets half the height to stay within limits
    const maxHeight = opts.retina ? MAX_HEIGHT / 2 : MAX_HEIGHT;
    const height = opts.fullPage ? Math.min(pageHeight, maxHeight) : device.height;
    const clip = { x: 0, y: 0, width: device.width, height };

    // Very long pages can exceed the 4.5 MB response limit: lower JPEG quality until it fits
    let quality = opts.quality;
    // optimizeForSpeed: faster, lighter image encoding, which matters on tall desktop pages
    const shoot = () => page.screenshot({ type: "jpeg", quality, clip, captureBeyondViewport: true, optimizeForSpeed: true });
    let buffer = await shoot();
    while (buffer.byteLength > MAX_BYTES && quality > 40) {
      quality = Math.max(40, quality - 15);
      buffer = await shoot();
    }
    if (buffer.byteLength > MAX_BYTES) {
      throw new Error("This page is too long for one image. Turn off Retina or full page and try again.");
    }

    return { buffer, width: device.width, height, truncated: opts.fullPage && pageHeight > maxHeight, broken };
  } finally {
    if (context) {
      await context.close().catch(() => {});
    } else {
      await page.close().catch(() => {});
    }
  }
}

/** Chromium died or lost its connection, usually from running out of memory. */
export function isBrowserCrash(err: unknown) {
  return /Target closed|Session closed|has been closed|disconnected|detached|crash|Connection closed|Protocol error/i
    .test(String((err as Error)?.message ?? err));
}

export function friendlyError(err: unknown): string {
  const m = String((err as Error)?.message ?? err).split("\n")[0];
  if (/ERR_NAME_NOT_RESOLVED/.test(m)) return "This domain could not be found.";
  if (/ERR_BLOCKED_BY_CLIENT/.test(m)) return "Blocked: this address points to a private network.";
  if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED/.test(m)) return "The website refused the connection.";
  if (/ERR_CERT|SSL/.test(m)) return "The website has an SSL certificate problem.";
  if (/timeout|timed out/i.test(m)) return "The page took too long to load.";
  if (/too long for one image/.test(m)) return m;
  if (isBrowserCrash(err)) return "The browser ran out of memory on this page. Try again, or turn off full page.";
  // Show the real reason, so problems can be traced instead of guessed
  return `Could not capture this page (${m.slice(0, 90)}).`;
}
