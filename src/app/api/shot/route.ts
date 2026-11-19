import { getDevice } from "@/lib/devices";
import { sanitizeOptions } from "@/lib/options";
import { normalizeUrl } from "@/lib/url";
import { assertSafeUrl } from "@/lib/guard";
import { getBrowser, withSlot } from "@/lib/browser";
import { captureShot, friendlyError } from "@/lib/capture";
import { allow, clientIp } from "@/lib/rate-limit";

// One screenshot per request, so each call stays well inside Vercel's time limit.
export const maxDuration = 120;

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

  try {
    const shot = await withSlot(async () => captureShot(await getBrowser(), { url, device, opts }));
    return new Response(shot.buffer as Uint8Array<ArrayBuffer>, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store",
        "X-Width": String(shot.width),
        "X-Height": String(shot.height),
        "X-Truncated": shot.truncated ? "1" : "0",
      },
    });
  } catch (e) {
    console.error("shot failed", url, device.id, e);
    return fail(502, friendlyError(e));
  }
}
