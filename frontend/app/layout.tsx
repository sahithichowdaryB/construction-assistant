import type { Metadata, Viewport } from "next";
import { Providers } from "@/components/providers/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "SiteMate", template: "%s · SiteMate" },
  description: "AI site-manager assistant (Riverside demo)",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // Browser extensions (password managers, translators, Brave/QB tools) add attributes to <html> and <body>
    // before React loads. suppressHydrationWarning ignores those attribute differences on these two tags only;
    // mismatches inside the app are still reported.
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased" suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
