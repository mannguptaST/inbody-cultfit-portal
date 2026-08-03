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
  // serverExternalPackages alone stops webpack from bundling pdfjs-dist, but
  // Vercel's separate file-tracing step (@vercel/nft) still has to know to
  // upload pdfjs-dist's own data files (cmaps/standard fonts, read via
  // constructed fs paths pdf.js resolves at runtime, invisible to static
  // import analysis) into the serverless function. Without this, PDF text
  // extraction works locally (files present on disk) but fails in
  // production with a generic "could not read this PDF" on real PDFs that
  // need those files — confirmed live against a real customer PO PDF that
  // extracted successfully locally but 400'd in production.
  outputFileTracingIncludes: {
    "/*": ["node_modules/pdfjs-dist/**/*"],
  },
};

export default nextConfig;
