import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "/api",
  },
  // pdfkit (lib/pi-pdf.ts) reads its .afm font metrics from disk relative to
  // its own module path at runtime — bundling it breaks that path
  // resolution. Keep it as a real node_modules require instead.
  serverExternalPackages: ["pdfkit"],
};

export default nextConfig;
