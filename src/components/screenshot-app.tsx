"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DEVICES, DEFAULT_DEVICES, getDevice } from "@/lib/devices";
import { DEFAULT_OPTIONS, type CaptureOptions } from "@/lib/options";
import { normalizeUrl, hostOf, slugFromUrl } from "@/lib/url";
import Results, { type Run, type Shot } from "./results";

const MAX_SITES = Number(process.env.NEXT_PUBLIC_MAX_SITES) || 20;
const MAX_SHOTS = Number(process.env.NEXT_PUBLIC_MAX_SHOTS) || 150;
const PARALLEL = 3; // screenshots requested at the same time
const WP_PAGE_COUNT = 7;

type Mode = "urls" | "wordpress";

let nextId = 0;
const uid = () => `s${++nextId}`;

/** Run async work over a list, at most `limit` at a time. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function requestShot(s: Shot, options: CaptureOptions): Promise<Partial<Shot>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch("/api/shot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: s.url, device: s.device, options }),
      });
      if (res.ok) {
        const blob = await res.blob();
        return {
          status: "done", blob, src: URL.createObjectURL(blob),
          width: Number(res.headers.get("x-width")) || undefined,
          height: Number(res.headers.get("x-height")) || undefined,
          truncated: res.headers.get("x-truncated") === "1",
        };
      }
      const data = await res.json().catch(() => null);
      const message = data?.error
        || (res.status === 504 ? "The page took too long to load." : `Server error (${res.status}).`);
      // Retry once on server errors; a 4xx answer won't change on retry
      if (res.status < 500 || attempt === 1) return { status: "failed", error: message };
    } catch {
      if (attempt === 1) return { status: "failed", error: "Network error. Check your connection." };
    }
  }
  return { status: "failed", error: "Could not capture this page." };
}

function Glyph({ width, height, mobile, dashed }: { width: number; height: number; mobile?: boolean; dashed?: boolean }) {
  const k = 0.058;
  return (
    <span
      className={`block border-2 bg-surface transition-colors ${mobile ? "rounded-md" : "rounded"} ${dashed ? "border-dashed" : ""} border-muted group-has-[:checked]:border-accent`}
      style={{ width: Math.round(width * k), height: Math.round(height * k) }}
    />
  );
}

const LOGO = (
  <svg viewBox="0 0 32 32" aria-hidden="true" className="size-7">
    <rect x="2" y="6" width="20" height="14" rx="2" fill="none" stroke="var(--accent)" strokeWidth="2.5" />
    <rect x="20" y="12" width="10" height="17" rx="2" fill="var(--accent)" />
  </svg>
);

export default function ScreenshotApp({ appName }: { appName: string }) {
  const [urlsText, setUrlsText] = useState("");
  const [mode, setMode] = useState<Mode>("urls");
  const [devices, setDevices] = useState<string[]>(DEFAULT_DEVICES);
  const [customOn, setCustomOn] = useState(false);
  const [customWidth, setCustomWidth] = useState(1366);
  const [options, setOptions] = useState<CaptureOptions>(DEFAULT_OPTIONS);
  const [error, setError] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const stopRef = useRef(false);
  const resultsRef = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);

  // Remember the last choices in this browser
  useEffect(() => {
    try {
      const p = JSON.parse(localStorage.getItem("pf-prefs") || "{}");
      if (p.urlsText) setUrlsText(p.urlsText);
      if (p.mode) setMode(p.mode);
      if (Array.isArray(p.devices)) setDevices(p.devices.filter((d: string) => getDevice(d)));
      if (typeof p.customOn === "boolean") setCustomOn(p.customOn);
      if (p.customWidth) setCustomWidth(p.customWidth);
      if (p.options) setOptions({ ...DEFAULT_OPTIONS, ...p.options });
    } catch {}
    loaded.current = true;
  }, []);
  useEffect(() => {
    if (!loaded.current) return;
    try { localStorage.setItem("pf-prefs", JSON.stringify({ urlsText, mode, devices, customOn, customWidth, options })); } catch {}
  }, [urlsText, mode, devices, customOn, customWidth, options]);

  const running = run?.phase === "discovering" || run?.phase === "capturing";
  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  const urls = useMemo(
    () => [...new Set(urlsText.split(/[\s,]+/).map(normalizeUrl).filter((u): u is string => !!u))],
    [urlsText],
  );
  const chosen = useMemo(() => {
    const list = DEVICES.map((d) => d.id).filter((id) => devices.includes(id));
    if (customOn && getDevice(`custom:${customWidth}`)) list.push(`custom:${customWidth}`);
    return list;
  }, [devices, customOn, customWidth]);
  const estimate = urls.length * (mode === "wordpress" ? WP_PAGE_COUNT : 1) * chosen.length;

  const setOpt = <K extends keyof CaptureOptions>(key: K, value: CaptureOptions[K]) =>
    setOptions((o) => ({ ...o, [key]: value }));
  const toggleDevice = (id: string) =>
    setDevices((list) => (list.includes(id) ? list.filter((d) => d !== id) : [...list, id]));

  const patchShot = (id: string, patch: Partial<Shot>) =>
    setRun((r) => r && { ...r, shots: r.shots.map((s) => (s.id === id ? { ...s, ...patch } : s)) });

  async function start() {
    setError("");
    if (!urlsText.trim()) return setError("Add at least one website address.");
    if (!urls.length) return setError("That doesn't look like a website address. Use a domain like example.com or a full https:// link.");
    if (urls.length > MAX_SITES) return setError(`Add up to ${MAX_SITES} websites at a time.`);
    if (!chosen.length) return setError("Pick at least one device.");
    if (estimate > MAX_SHOTS) return setError(`That's ${estimate} screenshots. The limit is ${MAX_SHOTS} per run, so pick fewer websites or devices.`);

    run?.shots.forEach((s) => s.src && URL.revokeObjectURL(s.src));
    stopRef.current = false;
    const opts = { ...options };
    const startedAt = Date.now();
    setRun({ startedAt, mode, devices: chosen, phase: mode === "wordpress" ? "discovering" : "capturing", shots: [] });
    setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);

    // 1) Work out which pages to capture
    const shots: Shot[] = [];
    const addPage = (site: string, label: string, ord: number, url: string | null, note?: string) => {
      for (const device of chosen) {
        shots.push({
          id: uid(), site, label, ord, url: url ?? "", device,
          status: url ? "queued" : "failed",
          error: url ? undefined : note ?? "This page could not be found on the site.",
        });
      }
    };

    if (mode === "wordpress") {
      const found = await mapLimit(urls, 3, async (u) => {
        try {
          const res = await fetch("/api/discover", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: u }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error || "Could not read this site.");
          return data as { site: string; pages: { label: string; ord: number; url: string | null }[] };
        } catch (e) {
          return { site: hostOf(u), pages: [{ label: "home", ord: 0, url: null }], error: (e as Error).message };
        }
      });
      for (const f of found) {
        const err = "error" in f ? (f.error as string) : undefined;
        for (const p of f.pages) addPage(f.site, p.label, p.ord, p.url, err);
      }
    } else {
      const counters = new Map<string, number>();
      const seen = new Map<string, number>();
      for (const u of urls) {
        const site = hostOf(u);
        const ord = counters.get(site) ?? 0;
        counters.set(site, ord + 1);
        let label = slugFromUrl(u);
        const n = (seen.get(site + label) ?? 0) + 1;
        seen.set(site + label, n);
        if (n > 1) label += `-${n}`;
        addPage(site, label, ord, u);
      }
    }
    setRun((r) => r && { ...r, phase: "capturing", shots: [...shots] });

    // 2) Capture: each screenshot is its own short request to the server
    const queue = shots.filter((s) => s.status === "queued");
    let i = 0;
    await Promise.all(Array.from({ length: PARALLEL }, async () => {
      while (i < queue.length && !stopRef.current) {
        const s = queue[i++];
        patchShot(s.id, { status: "running" });
        patchShot(s.id, await requestShot(s, opts));
      }
    }));

    if (stopRef.current) {
      setRun((r) => r && {
        ...r, phase: "stopped",
        shots: r.shots.map((s) => (s.status === "queued" ? { ...s, status: "failed", error: "Stopped before capture." } : s)),
      });
    } else {
      setRun((r) => r && { ...r, phase: "done" });
    }
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-3.5">
          {LOGO}
          <span className="text-[17px] font-bold">{appName}</span>
          <span className="ml-auto text-sm text-muted">Free. No sign-up. Nothing stored.</span>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 pb-20 pt-10">
        <div className="mb-8 max-w-3xl">
          <h1 className="text-balance text-[2rem] font-bold leading-tight tracking-tight sm:text-[2.4rem]">
            Screenshot any website on every device.
          </h1>
          <p className="mt-2 max-w-2xl text-[1.05rem] text-muted">
            Full-page captures for desktop, tablet and phone, with lazy images, animations and cookie banners handled. Download everything as one ZIP.
          </p>
        </div>

        <form
          className="rounded-2xl border border-line bg-surface p-5 sm:p-7"
          onSubmit={(e) => { e.preventDefault(); if (!running) start(); }}
          noValidate
        >
          <label className="mb-7 block">
            <span className="block font-semibold">Websites</span>
            <span className="mb-2 block text-sm text-muted">One per line. A domain like example.com, or the full address of a page.</span>
            <textarea
              value={urlsText}
              onChange={(e) => setUrlsText(e.target.value)}
              rows={5}
              spellCheck={false}
              placeholder={"gigwise.com\ncapeguide.com/about-us/"}
              className="w-full resize-y rounded-lg border border-line bg-sunken px-3 py-2.5 font-mono text-sm outline-none focus:border-accent focus:ring-[3px] focus:ring-accent-soft"
            />
          </label>

          <fieldset className="mb-7">
            <legend className="mb-2.5 font-semibold">What to capture</legend>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {([
                ["urls", "Exact pages", "Only the addresses you listed."],
                ["wordpress", "WordPress key pages", "Home, about, contact, a category, the latest post, its author and the privacy policy."],
              ] as const).map(([value, title, text]) => (
                <label key={value} className="cursor-pointer">
                  <input type="radio" name="mode" value={value} checked={mode === value}
                    onChange={() => setMode(value)} className="peer sr-only" />
                  <span className="block h-full rounded-lg border border-line bg-sunken px-3.5 py-3 peer-checked:border-accent peer-checked:bg-accent-soft peer-checked:shadow-[inset_0_0_0_1px_var(--accent)] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent">
                    <b className="block font-semibold">{title}</b>
                    <small className="text-[0.84rem] text-muted">{text}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="mb-7">
            <legend className="mb-2.5 font-semibold">Devices</legend>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {DEVICES.map((d) => (
                <label key={d.id} title={`${d.width} × ${d.height}`}
                  className="group relative grid cursor-pointer content-end justify-items-center gap-0.5 rounded-lg border border-line bg-sunken px-2 pb-2.5 pt-3 text-center has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:checked]:shadow-[inset_0_0_0_1px_var(--accent)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent">
                  <input type="checkbox" className="sr-only" checked={devices.includes(d.id)} onChange={() => toggleDevice(d.id)} />
                  <span className="mb-1.5 flex h-[72px] items-end"><Glyph width={d.width} height={d.height} mobile={d.mobile} /></span>
                  <span className="text-[0.86rem] font-semibold">{d.name}</span>
                  <span className="text-[0.78rem] tabular-nums text-muted">{d.width} × {d.height}</span>
                </label>
              ))}
              <label className="group relative grid cursor-pointer content-end justify-items-center gap-0.5 rounded-lg border border-line bg-sunken px-2 pb-2.5 pt-3 text-center has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:checked]:shadow-[inset_0_0_0_1px_var(--accent)]">
                <input type="checkbox" className="sr-only" checked={customOn} onChange={(e) => setCustomOn(e.target.checked)} />
                <span className="mb-1.5 flex h-[72px] items-end"><Glyph width={1366} height={900} dashed /></span>
                <span className="text-[0.86rem] font-semibold">Custom width</span>
                <span className="flex items-center gap-1 text-[0.78rem] text-muted">
                  <input type="number" min={320} max={3840} value={customWidth} aria-label="Custom width in pixels"
                    onChange={(e) => setCustomWidth(Number(e.target.value) || 1366)}
                    className="w-16 rounded border border-line bg-surface px-1 py-0.5 text-ink" /> px
                </span>
              </label>
            </div>
          </fieldset>

          <details className="mb-7">
            <summary className="cursor-pointer py-1 font-semibold">More options</summary>
            <div className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {([
                ["fullPage", "Capture the whole page, top to bottom"],
                ["blockAds", "Block ads and trackers"],
                ["hideCookies", "Hide cookie banners and popups"],
                ["dark", "Dark mode, on sites that support it"],
                ["retina", "Retina sharpness (2×, larger files)"],
              ] as const).map(([key, text]) => (
                <label key={key} className="flex cursor-pointer items-start gap-2.5 text-[0.92rem]">
                  <input type="checkbox" checked={options[key]} onChange={(e) => setOpt(key, e.target.checked)}
                    className="mt-1 accent-accent" />
                  <span>{text}</span>
                </label>
              ))}
              <span className="hidden sm:block" />
              <label className="grid gap-1 text-[0.9rem] font-medium">Image quality
                <select value={options.quality} onChange={(e) => setOpt("quality", Number(e.target.value))}
                  className="rounded-lg border border-line bg-sunken px-3 py-2 font-normal">
                  <option value={90}>High (bigger files)</option>
                  <option value={80}>Balanced</option>
                  <option value={65}>Small files</option>
                </select>
              </label>
              <label className="grid gap-1 text-[0.9rem] font-medium">Extra wait before capture (seconds)
                <input type="number" min={0} max={8} step={0.5} value={options.delay / 1000}
                  onChange={(e) => setOpt("delay", Math.round((Number(e.target.value) || 0) * 1000))}
                  className="rounded-lg border border-line bg-sunken px-3 py-2 font-normal" />
              </label>
              <label className="grid gap-1 text-[0.9rem] font-medium sm:col-span-2">Hide these elements
                <span className="text-[0.84rem] font-normal text-muted">CSS selectors, one per line. Useful for chat widgets or sticky bars.</span>
                <textarea value={options.hideSelectors} onChange={(e) => setOpt("hideSelectors", e.target.value)}
                  rows={2} spellCheck={false} placeholder=".chat-widget"
                  className="rounded-lg border border-line bg-sunken px-3 py-2 font-mono text-sm font-normal" />
              </label>
            </div>
          </details>

          <div className="flex flex-wrap items-center gap-4">
            <button type="submit" disabled={running}
              className="rounded-lg bg-accent px-6 py-3 font-semibold text-on-accent hover:brightness-110 disabled:opacity-50">
              {running ? "Capturing…" : "Take screenshots"}
            </button>
            {estimate > 0 && (
              <span className={`text-sm ${estimate > MAX_SHOTS ? "text-bad" : "text-muted"}`}>
                {estimate} screenshot{estimate === 1 ? "" : "s"}{estimate > MAX_SHOTS ? `, limit is ${MAX_SHOTS}` : ""}
              </span>
            )}
          </div>
          {error && <p role="alert" className="mt-4 rounded-lg bg-bad-soft px-3.5 py-2.5 text-[0.92rem] text-bad">{error}</p>}
        </form>

        <div ref={resultsRef} className="scroll-mt-6">
          {run && <Results run={run} onStop={() => { stopRef.current = true; }} />}
        </div>
      </main>

      <footer className="border-t border-line py-6 text-center text-sm text-muted">
        Screenshots are made on demand and sent straight to your browser. Nothing is saved on the server.
      </footer>
    </div>
  );
}
