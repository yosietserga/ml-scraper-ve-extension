import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ML Scraper Analytics — Dashboard",
  description:
    "Analytics dashboard for MercadoLibre VE product data scraped by the ML Scraper extension and synced via a Google Apps Script web app.",
  applicationName: "ML Scraper Analytics",
  authors: [{ name: "yosietserga" }],
  keywords: [
    "MercadoLibre",
    "Venezuela",
    "analytics",
    "scraper",
    "dashboard",
    "OSINT",
  ],
  openGraph: {
    title: "ML Scraper Analytics — Dashboard",
    description:
      "Analytics dashboard for MercadoLibre VE product data scraped by the ML Scraper extension.",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#2d3277",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
