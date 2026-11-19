import "server-only";
/**
 * One Chromium per server instance, reused across requests. On Vercel the
 * instance stays warm between requests, so only the first screenshot pays the
 * ~2 second startup cost.
 *
 * On Vercel (or when USE_SERVERLESS_CHROMIUM=1): @sparticuz/chromium, a Chromium
 * build small enough for serverless. On your own computer: your installed Chrome.
 */
import fs from "node:fs";
import path from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";

const LOCAL_CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

// Hides the "controlled by automation" flag that some sites use to hide content from bots
const COMMON_ARGS = ["--disable-blink-features=AutomationControlled", "--hide-scrollbars", "--mute-audio"];

// The serverless package enables these by default. A public tool that opens
// random websites should keep normal browser security on.
const UNSAFE_ARGS = new Set(["--disable-web-security", "--allow-running-insecure-content"]);

let browserPromise: Promise<Browser> | null = null;

/**
 * Serverless Chromium runs with --single-process to save memory. In that mode it
 * cannot open separate browser contexts, so capture.ts uses a normal tab and
 * clears cookies and cache instead.
 */
export let singleProcess = false;

/**
 * Serverless Chromium ships with only one font (Open Sans). Any text that relies
 * on fonts installed on the visitor's computer (Arial, Helvetica, Times, emoji,
 * Hindi...) would come out wrong or as empty boxes. This points Chromium at the
 * fonts in /fonts and maps common font names to look-alikes with the same widths,
 * so line breaks match what real visitors see.
 */
function setupServerlessFonts() {
  const dir = [path.join(process.cwd(), "fonts"), "/var/task/fonts"].find((d) => fs.existsSync(d));
  const confDir = "/tmp/pf-fontconfig";
  fs.mkdirSync(confDir, { recursive: true });
  const alias = (names: string[], to: string) =>
    names.map((n) => `<alias binding="same"><family>${n}</family><prefer><family>${to}</family></prefer></alias>`).join("\n");
  const fallbacks = "<family>DejaVu Sans</family><family>Noto Sans Devanagari</family><family>Noto Color Emoji</family>";
  fs.writeFileSync(path.join(confDir, "fonts.conf"), `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>/tmp/fonts</dir>
  ${dir ? `<dir>${dir}</dir>` : ""}
  <cachedir>/tmp/fonts-cache/</cachedir>
  ${alias(["Arial", "Helvetica", "Helvetica Neue", "Arimo", "Segoe UI", "system-ui", "-apple-system", "BlinkMacSystemFont", "Tahoma", "Verdana", "Trebuchet MS"], "Liberation Sans")}
  ${alias(["Times New Roman", "Times", "Georgia", "Cambria", "Tinos"], "Liberation Serif")}
  ${alias(["Courier New", "Courier", "Consolas", "Menlo", "Monaco", "Cousine"], "Liberation Mono")}
  <alias><family>sans-serif</family><prefer><family>Liberation Sans</family>${fallbacks}</prefer></alias>
  <alias><family>serif</family><prefer><family>Liberation Serif</family>${fallbacks}</prefer></alias>
  <alias><family>monospace</family><prefer><family>Liberation Mono</family>${fallbacks}</prefer></alias>
  <alias><family>emoji</family><prefer><family>Noto Color Emoji</family></prefer></alias>
</fontconfig>`);
  process.env.FONTCONFIG_PATH = confDir;
}

async function launch(): Promise<Browser> {
  const serverless = Boolean(
    process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.USE_SERVERLESS_CHROMIUM,
  );
  const local = serverless ? undefined : process.env.CHROME_PATH || LOCAL_CHROME.find((p) => fs.existsSync(p));

  if (local) {
    singleProcess = false;
    return puppeteer.launch({
      executablePath: local,
      headless: true,
      defaultViewport: null,
      args: ["--disable-dev-shm-usage", "--no-first-run", ...COMMON_ARGS],
    });
  }

  setupServerlessFonts(); // must run before Chromium starts
  const chromium = (await import("@sparticuz/chromium")).default;
  chromium.setGraphicsMode = false;
  const args = [...chromium.args.filter((a) => !UNSAFE_ARGS.has(a)), ...COMMON_ARGS];
  singleProcess = args.includes("--single-process");
  return puppeteer.launch({
    executablePath: await chromium.executablePath(),
    headless: "shell",
    defaultViewport: null,
    args: await puppeteer.defaultArgs({ args, headless: "shell" }),
  });
}

export async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b?.connected) return b;
  }
  browserPromise = launch().then((b) => {
    b.on("disconnected", () => { browserPromise = null; });
    return b;
  });
  browserPromise.catch(() => { browserPromise = null; });
  return browserPromise;
}

// Vercel can send several requests to one warm instance at once. Chrome pages
// use a lot of memory, so at most 2 screenshots run per instance; the rest wait.
let active = 0;
const waiting: (() => void)[] = [];
export async function withSlot<T>(fn: () => Promise<T>, max = 2): Promise<T> {
  if (active >= max) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}
