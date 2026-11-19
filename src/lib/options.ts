export interface CaptureOptions {
  fullPage: boolean;
  quality: number;
  retina: boolean;
  dark: boolean;
  blockAds: boolean;
  hideCookies: boolean;
  delay: number;
  hideSelectors: string;
}

export const DEFAULT_OPTIONS: CaptureOptions = {
  fullPage: true,
  quality: 80,
  retina: false,
  dark: false,
  blockAds: true,
  hideCookies: true,
  delay: 0,
  hideSelectors: "",
};

const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));

/** Never trust options from the browser: coerce every field to a safe value. */
export function sanitizeOptions(raw: unknown): CaptureOptions {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    fullPage: o.fullPage !== false,
    quality: clamp(Number(o.quality) || 80, 40, 95),
    retina: o.retina === true,
    dark: o.dark === true,
    blockAds: o.blockAds !== false,
    hideCookies: o.hideCookies !== false,
    delay: clamp(Number(o.delay) || 0, 0, 8000),
    hideSelectors: String(o.hideSelectors ?? "").slice(0, 2000),
  };
}
