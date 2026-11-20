// Shared by the browser UI and the server. Real device profiles: viewport,
// user agent and touch, so mobile menus behave like on a real phone.
export interface Device {
  id: string;
  name: string;
  width: number;
  height: number;
  mobile: boolean;
  ua: string;
}

const UA = {
  desktop:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  ipad:
    "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  android:
    "Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
};

export const DEVICES: Device[] = [
  { id: "desktop-xl", name: "Large desktop", width: 1920, height: 1080, mobile: false, ua: UA.desktop },
  { id: "desktop", name: "Desktop", width: 1440, height: 900, mobile: false, ua: UA.desktop },
  { id: "laptop", name: "Laptop", width: 1280, height: 800, mobile: false, ua: UA.desktop },
  // 1024px is Elementor's default tablet breakpoint, so this shows the tablet layout at its widest
  { id: "tablet", name: "Tablet", width: 1024, height: 1366, mobile: true, ua: UA.ipad },
  { id: "android", name: "Pixel 7", width: 412, height: 839, mobile: true, ua: UA.android },
  { id: "phone", name: "iPhone 14", width: 390, height: 664, mobile: true, ua: UA.iphone },
];

export const DEFAULT_DEVICES = ["desktop", "tablet", "phone"];

export function getDevice(id: string): Device | null {
  const known = DEVICES.find((d) => d.id === id);
  if (known) return known;
  const m = /^custom:(\d{3,4})$/.exec(id);
  if (!m) return null;
  const width = Number(m[1]);
  if (width < 320 || width > 3840) return null;
  return { id, name: `${width}px wide`, width, height: 900, mobile: false, ua: UA.desktop };
}
