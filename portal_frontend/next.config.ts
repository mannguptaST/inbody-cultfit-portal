import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "/api",
  },
  // pdfkit (lib/pi-pdf.ts) reads its .afm font metrics from disk relative to
  // its own module path at runtime — bundling it breaks that path
  // resolution. Keep it as a real node_modules require instead.
  // pdfjs-dist (lib/po-pdf-parser.ts) does its own dynamic imports for
  // optional worker/font internals — same class of bundler-path issue as
  // pdfkit above, same fix: keep it a real runtime import, not bundled.
  serverExternalPackages: ["pdfkit", "pdfjs-dist"],
};

export default nextConfig;
