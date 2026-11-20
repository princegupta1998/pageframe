"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { zipSync } from "fflate";
import { getDevice } from "@/lib/devices";

export type ShotStatus = "queued" | "running" | "done" | "failed" | "missing";
export interface Shot {
  id: string;
  site: string;
  label: string;
  ord: number;
  url: string;
  device: string;
  status: ShotStatus;
  error?: string;
  blob?: Blob;
  src?: string;
  width?: number;
  height?: number;
  truncated?: boolean;
  reduced?: boolean;
  broken?: string[];
  httpStatus?: number;
}
export interface Run {
  startedAt: number;
  mode: "urls" | "wordpress";
  devices: string[];
  phase: "discovering" | "capturing" | "done" | "stopped";
  shots: Shot[];
  /** Per-site notes, e.g. "not a WordPress site" */
  notes?: Record<string, string>;
}

const pretty = (s: string) => { const t = s.replace(/-/g, " "); return t.charAt(0).toUpperCase() + t.slice(1); };
const devName = (id: string) => getDevice(id)?.name ?? id;
// Status codes that usually mean the site blocks automated visitors rather than a missing page
const blockedHint = (code?: number) => (code && [401, 403, 429, 503].includes(code) ? " (the site may block automated visitors)" : "");
const fileName = (s: Shot) => `${String(s.ord + 1).padStart(2, "0")}-${s.label}.jpg`;

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const btnBase = "inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold disabled:pointer-events-none disabled:opacity-45";
const btn = `${btnBase} border-line bg-surface text-ink hover:border-muted`;
const btnPrimary = `${btnBase} border-accent bg-accent text-on-accent hover:brightness-110`;

export default function Results({ run, onStop }: { run: Run; onStop: () => void }) {
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState<string | null>(null);
  const [zipping, setZipping] = useState(false);

  const total = run.shots.length;
  const done = run.shots.filter((s) => s.status === "done").length;
  const failed = run.shots.filter((s) => s.status === "failed").length;
  const missing = run.shots.filter((s) => s.status === "missing").length;
  const active = run.phase === "discovering" || run.phase === "capturing";
  const shownDevices = filter === "all" ? run.devices : run.devices.filter((d) => d === filter);

  // site -> page rows -> one shot per device
  const sites = useMemo(() => {
    const map = new Map<string, Map<number, { label: string; url: string; byDevice: Record<string, Shot> }>>();
    for (const s of run.shots) {
      if (!map.has(s.site)) map.set(s.site, new Map());
      const pages = map.get(s.site)!;
      if (!pages.has(s.ord)) pages.set(s.ord, { label: s.label, url: s.url, byDevice: {} });
      pages.get(s.ord)!.byDevice[s.device] = s;
    }
    return map;
  }, [run.shots]);

  const viewable = run.shots.filter((s) => s.status === "done" && (filter === "all" || s.device === filter));

  async function downloadZip() {
    setZipping(true);
    try {
      const folder = `screenshots-${new Date(run.startedAt).toISOString().slice(0, 10)}`;
      const files: Record<string, Uint8Array> = {};
      for (const s of run.shots) {
        if (s.status !== "done" || !s.blob) continue;
        files[`${folder}/${s.site}/${s.device.replace(":", "-")}/${fileName(s)}`] = new Uint8Array(await s.blob.arrayBuffer());
      }
      const csv = [["site", "page", "device", "url", "status", "note"],
        ...run.shots.map((s) => [s.site, s.label, s.device, s.url,
          s.status === "done" ? (s.httpStatus && s.httpStatus >= 400 ? `ok (page returned ${s.httpStatus})` : "ok") : s.status === "missing" ? "not on site" : s.status,
          s.error ?? [s.reduced ? "shortened to fit memory" : s.truncated ? "cut at maximum height" : "", s.broken?.length ? `broken images on the site: ${s.broken.join(" | ")}` : ""].filter(Boolean).join("; ")])]
        .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
      files[`${folder}/report.csv`] = new TextEncoder().encode(csv);
      // level 0: JPEGs are already compressed, so zipping is instant
      const zipped = zipSync(files, { level: 0 });
      download(new Blob([zipped as Uint8Array<ArrayBuffer>], { type: "application/zip" }), `${folder}.zip`);
    } finally {
      setZipping(false);
    }
  }

  const toCapture = total - missing;
  const extra = [failed ? `${failed} failed` : "", missing ? `${missing} not on the site` : ""].filter(Boolean).join(", ");
  const status = run.phase === "discovering"
    ? "Finding the key pages…"
    : active ? `Capturing ${done + failed} of ${toCapture}`
    : run.phase === "stopped" ? `Stopped. ${done} ready`
    : extra ? `Done. ${done} ready, ${extra}` : `Done. All ${done} ready`;

  return (
    <section className="mt-12">
      <div className="sticky top-0 z-10 -mx-5 mb-5 border-b border-line bg-canvas/95 px-5 py-4 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold">Results</h2>
            <p className={`text-sm font-semibold ${active ? "text-accent" : failed ? "text-bad" : "text-ok"}`}>{status}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {active && <button className={btn} onClick={onStop}>Stop</button>}
            <button className={btnPrimary} disabled={!done || zipping} onClick={downloadZip}>
              {zipping ? "Preparing…" : `Download ZIP${done ? ` (${done})` : ""}`}
            </button>
          </div>
        </div>
        {active && total > 0 && (
          <div className="mt-3 h-1 overflow-hidden rounded bg-line">
            <i className="block h-full bg-accent transition-[width] duration-500" style={{ width: `${toCapture ? ((done + failed) / toCapture) * 100 : 0}%` }} />
          </div>
        )}
        {run.devices.length > 1 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {["all", ...run.devices].map((d) => (
              <button key={d} onClick={() => setFilter(d)}
                className={`rounded-full border px-3 py-1 text-sm font-medium ${filter === d ? "border-ink bg-ink text-surface" : "border-line bg-surface text-muted hover:text-ink"}`}>
                {d === "all" ? "All devices" : devName(d)}
              </button>
            ))}
          </div>
        )}
      </div>

      {run.phase === "discovering" && !total && (
        <p className="pf-pulse rounded-2xl border border-line bg-surface p-10 text-center text-muted">Finding the key pages on each site…</p>
      )}

      {[...sites].map(([site, pages]) => (
        <div key={site} className="mb-10">
          {sites.size > 1 && <h3 className="mb-3 text-lg font-bold">{site}</h3>}
          {run.notes?.[site] && (
            <p className="mb-3 rounded-lg border border-line bg-surface px-4 py-2.5 text-sm text-muted">{run.notes[site]}</p>
          )}
          {[...pages.values()].map((pg) => (
            <div key={pg.label} className="mb-3.5 rounded-2xl border border-line bg-surface px-4 pb-4 pt-3.5">
              <div className="mb-3 flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-4">
                <b className="whitespace-nowrap">{pretty(pg.label)}</b>
                {pg.url && (
                  <a href={pg.url} target="_blank" rel="noopener noreferrer"
                    className="truncate font-mono text-[0.82rem] text-muted hover:text-accent">{pg.url}</a>
                )}
              </div>
              <div className="flex items-end gap-3.5 overflow-x-auto pb-1">
                {shownDevices.map((id) => {
                  const s = pg.byDevice[id];
                  const d = getDevice(id);
                  if (!s || !d) return null;
                  // Tiles keep the devices' real proportions to each other
                  const style = { width: Math.max(110, Math.round(d.width * 0.26)), aspectRatio: `${d.width} / ${d.height}` };
                  const caption = (
                    <span className="mt-1.5 block text-[0.8rem] text-muted">
                      {d.name}
                      {!!s.httpStatus && s.httpStatus >= 400 && (
                        <span className="block font-semibold text-bad">⚠ Page returned {s.httpStatus}{blockedHint(s.httpStatus)}</span>
                      )}
                      {!!s.broken?.length && (
                        <span className="block font-semibold text-bad" title={s.broken.join("\n")}>
                          ⚠ {s.broken.length} broken image{s.broken.length > 1 ? "s" : ""} on site
                        </span>
                      )}
                    </span>
                  );
                  if (s.status === "done") {
                    // Hover-to-scroll: the tile is a small window onto a tall screenshot.
                    // How far the image must move up = its height in the tile minus the window height.
                    const frameW = style.width;
                    const frameH = frameW * (d.height / d.width);
                    const imageH = s.width && s.height ? frameW * (s.height / s.width) : frameH;
                    const shift = Math.max(0, imageH - frameH);
                    // Same reading speed for every page (about 150px per second at tile size),
                    // so long pages take longer instead of rushing past
                    const seconds = Math.min(20, Math.max(1.2, shift / 150));
                    const scrollVars = { "--pf-shift": `-${shift.toFixed(1)}px`, "--pf-dur": `${seconds.toFixed(1)}s` } as CSSProperties;
                    return (
                      <button key={id} onClick={() => setOpen(s.id)} className="pf-tile group shrink-0 text-left" aria-label={`Open ${d.name} screenshot`}>
                        <span style={style} className="relative block overflow-hidden rounded-md border border-line bg-sunken group-hover:border-accent group-hover:shadow-[0_0_0_1px_var(--accent)] group-focus-visible:border-accent">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={s.src} alt="" style={scrollVars} className="pf-scroll-img block h-auto w-full" />
                          {shift > 0 && (
                            <span aria-hidden="true" className="pointer-events-none absolute bottom-1.5 right-1.5 rounded bg-ink/75 px-1.5 py-0.5 text-[0.68rem] font-medium text-surface opacity-100 transition-opacity group-hover:opacity-0">
                              ↕ Hover to scroll
                            </span>
                          )}
                        </span>
                        {caption}
                      </button>
                    );
                  }
                  return (
                    <div key={id} className="shrink-0">
                      <span style={style} className={`grid place-items-center rounded-md border p-2 text-center text-[0.78rem] ${s.status === "failed" ? "border-transparent bg-bad-soft text-bad" : s.status === "missing" ? "border-dashed border-line text-muted" : "border-line bg-sunken text-muted"}`}>
                        <span className={s.status === "failed" || s.status === "missing" ? "" : "pf-pulse"}>
                          {s.status === "failed" || s.status === "missing" ? s.error : s.status === "running" ? "Capturing…" : "Waiting"}
                        </span>
                      </span>
                      {caption}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ))}

      {open && <Lightbox shots={viewable} startId={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

function Lightbox({ shots, startId, onClose }: { shots: Shot[]; startId: string; onClose: () => void }) {
  const [i, setI] = useState(() => Math.max(0, shots.findIndex((s) => s.id === startId)));
  const s = shots[i];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") setI((x) => Math.min(shots.length - 1, x + 1));
      if (e.key === "ArrowLeft") setI((x) => Math.max(0, x - 1));
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [shots.length, onClose]);

  if (!s) return null;
  const lbBtn = "rounded-lg border border-[#3A4458] px-3.5 py-2 text-sm font-semibold text-[#E4E9F1] hover:border-[#93A0B4] disabled:opacity-40";
  return (
    <div role="dialog" aria-modal="true" aria-label="Screenshot viewer" className="fixed inset-0 z-50 grid grid-rows-[auto_1fr] bg-[#0B0E14]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#232B39] px-5 py-3 text-[#E4E9F1]">
        <span className="mr-auto min-w-0 truncate font-semibold">
          {s.site}, {pretty(s.label)}
          <small className="ml-2 font-normal text-[#93A0B4]">{devName(s.device)}{s.height ? `, ${s.width} × ${s.height}` : ""}</small>
        </span>
        <button className={lbBtn} disabled={i === 0} onClick={() => setI(i - 1)} aria-label="Previous">‹</button>
        <button className={lbBtn} disabled={i === shots.length - 1} onClick={() => setI(i + 1)} aria-label="Next">›</button>
        <a className={lbBtn} href={s.url} target="_blank" rel="noopener noreferrer">Open page</a>
        <button className={lbBtn} onClick={() => s.blob && download(s.blob, `${s.site}-${s.device.replace(":", "-")}-${fileName(s)}`)}>Download</button>
        <button className={lbBtn} onClick={onClose}>Close</button>
      </div>
      <div className="overflow-auto px-5 py-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={s.src} alt={`${s.label} on ${devName(s.device)}`} style={{ width: Math.min(s.width ?? 1400, 1400) }}
          className="mx-auto block h-auto max-w-full rounded shadow-[0_10px_40px_rgba(0,0,0,.4)]" />
        {!!s.httpStatus && s.httpStatus >= 400 && (
          <p className="mb-3 text-center text-sm font-semibold text-[#FFB4A3]">This page returned HTTP {s.httpStatus}{blockedHint(s.httpStatus)}: what you see is the site's error page.</p>
        )}
        {s.reduced
          ? <p className="mt-3 text-center text-sm text-[#93A0B4]">The full page was too heavy to capture, so this image shows the top part only.</p>
          : s.truncated && <p className="mt-3 text-center text-sm text-[#93A0B4]">This page is very long, so the image stops at the maximum height.</p>}
        {!!s.broken?.length && (
          <div className="mx-auto mt-4 max-w-3xl rounded-lg border border-[#5A2A22] bg-[#2A1714] p-4 text-sm text-[#FFB4A3]">
            <b className="block">These images are broken on the live site (they fail for real visitors too):</b>
            <ul className="mt-2 list-disc pl-5 font-mono text-[0.78rem] break-all">
              {s.broken.map((u) => <li key={u}><a href={u} target="_blank" rel="noopener noreferrer" className="underline">{u}</a></li>)}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
