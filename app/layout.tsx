import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Veritas Forge",
  description:
    "AI Personality Research • Memory Continuity • Governance Systems",

  openGraph: {
    title: "Veritas Forge",
    description:
      "AI Personality Research • Memory Continuity • Governance Systems",
    url: "https://echo-r.veritasforge.net",
    siteName: "Veritas Forge",
    images: [
      {
        url: "https://echo-r.veritasforge.net/og-image.png",
        width: 1200,
        height: 630,
        alt: "Veritas Forge / ECHO-R",
      },
    ],
    locale: "en_US",
    type: "website",
  },

  twitter: {
    card: "summary_large_image",
    title: "Veritas Forge",
    description:
      "AI Personality Research • Memory Continuity • Governance Systems",
    images: ["https://echo-r.veritasforge.net/og-image.png"],
  },

  icons: {
    icon: "/logo.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}