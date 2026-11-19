import "server-only";
/**
 * Simple per-IP limit. On serverless each warm instance keeps its own count,
 * so this is a speed bump against one person hammering the tool, not a hard
 * global cap. For a strict limit, add Vercel Firewall rate-limit rules.
 */
const hits = new Map<string, number[]>();

export function allow(ip: string, limit: number, windowMs: number) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) { hits.set(ip, recent); return false; }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 10_000) hits.clear();
  return true;
}

export function clientIp(req: Request) {
  return req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
