import "server-only";
/** Finds the 7 key pages of a WordPress site through its REST API, with fallbacks. */
import { safeFetch } from "./guard";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// [key, label]: label becomes the row title and the file name
export const WP_PAGES = [
  ["home", "home"],
  ["about", "about-us"],
  ["contact", "contact-us"],
  ["blog", "blog-page"],
  ["category", "category-archive"],
  ["post", "single-post"],
  ["author", "author-archive"],
  ["privacy", "privacy-policy"],
] as const;

type Found = Partial<Record<(typeof WP_PAGES)[number][0], string>>;

// Unique query parameter + no-cache headers: Cloudflare, Nginx and LiteSpeed caches
// treat it as a page they've never seen and ask WordPress for a fresh answer.
const NO_CACHE_HEADERS = { "Cache-Control": "no-cache", Pragma: "no-cache" };
const bust = (url: string) => {
  const u = new URL(url);
  u.searchParams.set("pf_nocache", Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  return u.toString();
};

async function getJSON(url: string): Promise<unknown> {
  try {
    const { res } = await safeFetch(bust(url), { headers: { "User-Agent": UA, Accept: "application/json", ...NO_CACHE_HEADERS } });
    if (!res.ok) { await res.body?.cancel(); return null; }
    return JSON.parse(await res.text());
  } catch {
    return null;
  }
}

// Pretty permalinks first, then ?rest_route= for sites without them
async function wp(base: string, route: string, query: string) {
  return (await getJSON(`${base}/wp-json/wp/v2/${route}?${query}`))
    ?? (await getJSON(`${base}/?rest_route=/wp/v2/${route}&${query}`));
}

async function resolves(url: string) {
  try {
    const { res, finalUrl } = await safeFetch(url, { headers: { "User-Agent": UA } });
    await res.body?.cancel();
    return res.ok ? finalUrl : null;
  } catch {
    return null;
  }
}

const trim = (u: string) => u.replace(/\/+$/, "");

interface WPPost {
  link?: string;
  _embedded?: { author?: { link?: string }[]; "wp:term"?: { link?: string }[][] };
}
interface WPItem { slug: string; link: string }

export async function discoverWordPress(siteUrl: string): Promise<{ found: Found; wordpress: boolean }> {
  const u = new URL(siteUrl);
  // Always the site root: pasting a page URL (example.com/about/) in WordPress mode
  // should still find the whole site's key pages
  const base = trim(u.origin);
  const isHome = (x: string) => trim(x) === base || trim(x) === trim(u.origin);
  const found: Found = { home: base + "/" };

  const [posts, cats, pages] = await Promise.all([
    wp(base, "posts", "per_page=1&_embed=author,wp:term") as Promise<WPPost[] | null>,
    wp(base, "categories", "per_page=20&orderby=count&order=desc&hide_empty=true&_fields=slug,link") as Promise<WPItem[] | null>,
    wp(base, "pages", "per_page=100&_fields=slug,link") as Promise<WPItem[] | null>,
  ]);

  // The REST API answered, or the home page mentions wp-content: it's WordPress
  let wordpress = Array.isArray(posts) || Array.isArray(pages);
  if (!wordpress) {
    try {
      const { res } = await safeFetch(bust(base + "/"), { headers: { "User-Agent": UA, ...NO_CACHE_HEADERS } });
      wordpress = /wp-content|wp-includes|wp-json/i.test(await res.text());
    } catch {}
  }
  // Not WordPress: guessing /about/, /blog/... would only produce wrong pages
  if (!wordpress) return { found, wordpress };

  const post = Array.isArray(posts) ? posts[0] : null;
  if (post?.link) {
    found.post = post.link;
    const author = post._embedded?.author?.[0];
    if (author?.link) found.author = author.link;
  }

  if (Array.isArray(cats) && cats.length) {
    found.category = (cats.find((c) => c.slug !== "uncategorized") ?? cats[0]).link;
  } else if (post?._embedded?.["wp:term"]?.[0]?.[0]?.link) {
    found.category = post._embedded["wp:term"][0][0].link;
  }

  if (Array.isArray(pages)) {
    const pick = (exact: string[], loose: RegExp) =>
      pages.find((p) => exact.includes(p.slug))?.link ?? pages.find((p) => loose.test(p.slug))?.link;
    found.about = pick(["about-us", "about"], /^about/);
    found.contact = pick(["contact-us", "contact", "contacts"], /^contact/);
    found.privacy = pick(["privacy-policy", "privacy"], /privacy/);
    // Exact slugs only: a loose "news" match would pick up pages like "newsletter"
    found.blog = pick(["blog", "blogs", "articles", "all-posts", "latest-posts", "journal", "stories", "news"], /^(blogs?|articles?)(-\d+)?$/);
  }

  // No blog page in the list? Look for a "Blog" / "Articles" link on the home page.
  if (!found.blog) {
    try {
      const { res } = await safeFetch(bust(base + "/"), { headers: { "User-Agent": UA, ...NO_CACHE_HEADERS } });
      const html = await res.text();
      const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>\s*(?:<[^>]+>\s*)*(blogs?|articles|all posts|latest posts|journal|stories)\s*(?:<[^>]+>\s*)*<\/a>/gi;
      for (const m of html.matchAll(re)) {
        const href = new URL(m[1], base + "/");
        if (href.hostname.replace(/^www\./, "") !== u.hostname.replace(/^www\./, "")) continue;
        if (/\/(category|tag|author)\//.test(href.pathname) || isHome(href.toString())) continue;
        found.blog = href.toString();
        break;
      }
    } catch {}
  }

  // Users API blocked by a security plugin? Read the author link from the post's HTML.
  if (post?.link && !found.author) {
    try {
      const { res } = await safeFetch(bust(post.link), { headers: { "User-Agent": UA, ...NO_CACHE_HEADERS } });
      const m = (await res.text()).match(/href=["']([^"']+\/author\/[^"'#?]+)["']/i);
      if (m) found.author = m[1];
    } catch {}
  }

  // REST API blocked entirely? Guess the usual slugs.
  const guesses = { about: ["about-us", "about"], contact: ["contact-us", "contact"], blog: ["blog", "blogs"], privacy: ["privacy-policy", "privacy"] } as const;
  for (const [key, slugs] of Object.entries(guesses) as [keyof typeof guesses, readonly string[]][]) {
    if (found[key]) continue;
    for (const s of slugs) {
      const hit = await resolves(`${base}/${s}/`);
      if (hit && !isHome(hit)) { found[key] = hit; break; }
    }
  }

  return { found, wordpress };
}
