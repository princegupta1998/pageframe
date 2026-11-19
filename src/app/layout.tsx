import type { Metadata } from "next";
import { Instrument_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const instrument = Instrument_Sans({ subsets: ["latin"], variable: "--font-instrument" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono" });

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || "PageFrame";

export const metadata: Metadata = {
  title: `${APP_NAME}: full-page website screenshots on every device`,
  description: "Free full-page screenshots of any website on desktop, tablet and phone. No sign-up. Download everything as a ZIP.",
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='2' y='6' width='20' height='14' rx='2' fill='none' stroke='%232546D6' stroke-width='2.5'/%3E%3Crect x='20' y='12' width='10' height='17' rx='2' fill='%232546D6'/%3E%3C/svg%3E",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${instrument.variable} ${plexMono.variable}`}>
      <body className="min-h-screen font-sans text-[15px] leading-normal">{children}</body>
    </html>
  );
}
