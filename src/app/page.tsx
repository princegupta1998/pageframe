import ScreenshotApp from "@/components/screenshot-app";

export default function Home() {
  return <ScreenshotApp appName={process.env.NEXT_PUBLIC_APP_NAME || "PageFrame"} />;
}
