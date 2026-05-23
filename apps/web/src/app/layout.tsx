import type { Metadata } from "next";
import { Inter, Geist_Mono, Homemade_Apple } from "next/font/google";
import { headers } from "next/headers";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const homemadeApple = Homemade_Apple({
  variable: "--font-display",
  weight: "400",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Lattik Studio",
  description: "Lattik Studio — AI chat with glassmorphic UI",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Reading headers() opts the layout (and every page below it) into dynamic
  // rendering. CSP nonces are incompatible with prerendering — a cached HTML
  // body has no nonces baked in, and `strict-dynamic` in the CSP causes the
  // browser to block every <script> that lacks one.
  await headers();

  return (
    <html
      lang="en"
      className={`dark ${inter.variable} ${geistMono.variable} ${homemadeApple.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
