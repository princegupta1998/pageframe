import "server-only";
/**
 * SSRF protection. A public screenshot tool is a browser that opens any URL a
 * stranger types. Without this, someone could screenshot internal addresses
 * like 127.0.0.1 or the cloud metadata endpoint (169.254.169.254).
 * Every hostname, for the page and every file it loads, is checked.
 */
import dns from "node:dns/promises";
import net from "node:net";

function privateV4(ip: string) {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function isPrivate(ip: string) {
  if (net.isIPv4(ip)) return privateV4(ip);
  const x = ip.toLowerCase();
  if (x === "::" || x === "::1") return true;
  if (x.startsWith("::ffff:")) {
    const v4 = x.slice(7);
    return net.isIPv4(v4) ? privateV4(v4) : true;
  }
  return /^f[cd]/.test(x) || /^fe[89ab]/.test(x);
}

type HostCheck = "ok" | "private" | "unresolved";
const cache = new Map<string, { result: HostCheck; exp: number }>();

export async function checkHost(rawHost: string): Promise<HostCheck> {
  const host = rawHost.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return "unresolved";
  if (net.isIP(host)) return isPrivate(host) ? "private" : "ok";
  if (host === "localhost" || /\.(localhost|local|internal|lan|home)$/.test(host)) return "private";

  const hit = cache.get(host);
  if (hit && hit.exp > Date.now()) return hit.result;

  let result: HostCheck;
  try {
    const addrs = await dns.lookup(host, { all: true });
    result = !addrs.length ? "unresolved" : addrs.some((a) => isPrivate(a.address)) ? "private" : "ok";
  } catch {
    result = "unresolved";
  }
  if (cache.size > 5000) cache.clear();
  cache.set(host, { result, exp: Date.now() + 60_000 });
  return result;
}

export const hostIsSafe = async (host: string) => (await checkHost(host)) === "ok";

export async function assertSafeUrl(url: string) {
  const result = await checkHost(new URL(url).hostname);
  if (result === "private") throw new Error("points to a private or local network address, which is not allowed");
  if (result === "unresolved") throw new Error("this domain could not be found. Check the spelling");
}

/** fetch() that re-checks every redirect, so a redirect can't lead into a private network. */
export async function safeFetch(url: string, init: RequestInit = {}, maxHops = 5) {
  for (let i = 0; i <= maxHops; i++) {
    await assertSafeUrl(url);
    const res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel();
      url = new URL(loc, url).toString();
      continue;
    }
    return { res, finalUrl: url };
  }
  throw new Error("Too many redirects");
}
