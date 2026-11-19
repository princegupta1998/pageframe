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

let browserPromise: Promise<Browser> | null = null;

/**
 * Serverless Chromium runs with --single-process to save memory. In that mode it
 * cannot open separate browser contexts, so capture.ts uses a normal tab and
 * clears cookies afterwards instead.
 */
export let singleProcess = false;

// The serverless package enables these by default. A public tool that opens
// random websites should keep normal browser security on.
const UNSAFE_ARGS = new Set(["--disable-web-security", "--allow-running-insecure-content"]);

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
      args: ["--disable-dev-shm-usage", "--no-first-run", "--hide-scrollbars", "--mute-audio"],
    });
  }

  const chromium = (await import("@sparticuz/chromium")).default;
  chromium.setGraphicsMode = false;
  const args = chromium.args.filter((a) => !UNSAFE_ARGS.has(a));
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
