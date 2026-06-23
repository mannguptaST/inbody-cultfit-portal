import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "https://inbody-portal-api.onrender.com/api/v1",
  },
};

export default nextConfig;
