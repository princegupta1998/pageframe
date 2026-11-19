import { normalizeUrl, hostOf } from "@/lib/url";
import { assertSafeUrl } from "@/lib/guard";
import { discoverWordPress, WP_PAGES } from "@/lib/discover";
import { allow, clientIp } from "@/lib/rate-limit";

export const maxDuration = 60;

const fail = (status: number, error: string) => Response.json({ error }, { status });

export async function POST(req: Request) {
  let body: { url?: unknown };
  try { body = await req.json(); } catch { return fail(400, "Invalid request."); }
  const url = normalizeUrl(body.url);
  if (!url) return fail(400, "That doesn't look like a website address.");
  if (!allow(`d:${clientIp(req)}`, 60, 10 * 60_000)) return fail(429, "Too many requests. Wait a few minutes.");

  try { await assertSafeUrl(url); }
  catch (e) { return fail(400, `${hostOf(url)}: ${(e as Error).message}.`); }

  const found = await discoverWordPress(url).catch(() => ({ home: url }) as Record<string, string>);
  return Response.json({
    site: hostOf(url),
    pages: WP_PAGES.map(([key, label], ord) => ({ label, ord, url: (found as Record<string, string | undefined>)[key] ?? null })),
  });
}
