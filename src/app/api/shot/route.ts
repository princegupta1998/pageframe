import { getDevice } from "@/lib/devices";
import { sanitizeOptions } from "@/lib/options";
import { normalizeUrl } from "@/lib/url";
import { assertSafeUrl } from "@/lib/guard";
import { getBrowser, resetBrowser, withSlot } from "@/lib/browser";
import { captureShot, friendlyError, failureKind } from "@/lib/capture";
import { allow, clientIp } from "@/lib/rate-limit";

// One screenshot per request, so each call stays well inside Vercel's time limit.
// Up to 300 seconds (the Hobby maximum), so the fallback retries below have room to run
export const maxDuration = 300;

const LIMIT = Number(process.env.SHOTS_PER_IP_PER_10_MIN) || 120;
const fail = (status: number, error: string) => Response.json({ error }, { status });

export async function POST(req: Request) {
  let body: { url?: unknown; device?: unknown; options?: unknown };
  try { body = await req.json(); } catch { return fail(400, "Invalid request."); }

  const url = normalizeUrl(body.url);
  if (!url) return fail(400, "That doesn't look like a website address.");
  const device = getDevice(String(body.device ?? ""));
  if (!device) return fail(400, "Unknown device.");
  const opts = sanitizeOptions(body.options);

  if (!allow(clientIp(req), LIMIT, 10 * 60_000)) {
    return fail(429, "Too many screenshots in a short time. Wait a few minutes and try again.");
  }
  try { await assertSafeUrl(url); }
  catch (e) { return fail(400, `${new URL(url).hostname}: ${(e as Error).message}.`); }

  const take = (heightLimit?: number) =>
    withSlot(async () => captureShot(await getBrowser(), { url, device, opts, heightLimit }));
  // Shorter fallback capture when the full page can't be done
  const FALLBACK_HEIGHT = 6000;

  try {
    let shot;
    let reduced = false;
    try {
      shot = await take();
    } catch (e) {
      const kind = failureKind(e);
      console.warn(`first attempt failed (${kind})`, url, device.id, String((e as Error)?.message).slice(0, 200));
      if (kind === "navigated") {
        shot = await take();
      } else if (kind === "crash") {
        // Fresh browser and the full page again; if it crashes a second time, go shorter
        await resetBrowser();
        try {
          shot = await take();
        } catch (e2) {
          if (failureKind(e2) !== "crash" && failureKind(e2) !== "too-big") throw e2;
          await resetBrowser();
          shot = await take(FALLBACK_HEIGHT);
          reduced = true;
        }
      } else if (kind === "too-big") {
        // A partial screenshot beats none
        shot = await take(FALLBACK_HEIGHT);
        reduced = true;
      } else {
        throw e;
      }
    }
    return new Response(shot.buffer as Uint8Array<ArrayBuffer>, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store",
        "X-Width": String(shot.width),
        "X-Height": String(shot.height),
        "X-Truncated": shot.truncated ? "1" : "0",
        "X-Reduced": reduced ? "1" : "0",
        "X-Status": String(shot.httpStatus),
        "X-Broken-Images": encodeURIComponent(JSON.stringify(shot.broken)),
      },
    });
  } catch (e) {
    console.error("shot failed", url, device.id, e);
    return fail(502, friendlyError(e));
  }
}
