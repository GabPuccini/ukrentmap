import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const metadata: Metadata = {
  title: "UK Rent Map",
  description: "Average private rent by UK postcode district, from ONS data. Works offline.",
  applicationName: "UK Rent Map",
  manifest: `${BASE}/manifest.webmanifest`,
  // Personal app: keep it out of search engines.
  robots: { index: false, follow: false, nocache: true },
  icons: {
    icon: [
      { url: `${BASE}/icons/favicon-32.png`, sizes: "32x32", type: "image/png" },
      { url: `${BASE}/icons/icon-192.png`, sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: `${BASE}/icons/apple-touch-icon.png`, sizes: "180x180" }],
  },
  appleWebApp: { capable: true, title: "Rent Map", statusBarStyle: "default" },
  formatDetection: { telephone: false },
  // Older iOS versions read this rather than the manifest to open full screen.
  other: { "apple-mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#12343b",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
