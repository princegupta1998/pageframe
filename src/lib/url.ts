/** Turns "gigwise.com" into "https://gigwise.com/" and rejects junk. Safe in browser and server. */
export function normalizeUrl(raw: unknown): string | null {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (!["http:", "https:"].includes(u.protocol) || !u.hostname.includes(".")) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

export const hostOf = (u: string) => new URL(u).hostname.replace(/^www\./, "");

/** Same page written differently (www., capitals, trailing slash) gives the same key. */
export function pageKey(u: string): string {
  const x = new URL(u);
  return hostOf(u) + (x.pathname.replace(/\/+$/, "") || "/") + x.search;
}

/** A short, readable name for a page: the last part of its address ("/blog/my-post/" -> "my-post"). */
export function slugFromUrl(u: string): string {
  const p = new URL(u).pathname.replace(/^\/+|\/+$/g, "");
  if (!p) return "home";
  const last = p.split("/").pop() || p;
  return last.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "page";
}
