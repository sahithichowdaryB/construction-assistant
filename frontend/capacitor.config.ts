import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "de.sitemate.demo",
  appName: "SiteMate",
  webDir: "mobile",
  // USB debugging maps this loopback port to the laptop's running Next.js server.
  server: { url: "http://localhost:3000", errorPath: "index.html" },
};

export default config;
