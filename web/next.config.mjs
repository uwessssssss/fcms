/** @type {import('next').NextConfig} */
const nextConfig = {
  // Source maps in production hand the whole application's source to anyone
  // who opens the browser's developer tools. They were on (a template default).
  productionBrowserSourceMaps: false,
  poweredByHeader: false,
  distDir: process.env.DIST_DIR || '.next',

  // STILL ON, deliberately for now: a production build does not fail on a type
  // error. tools/ type-checks every change, but turning this off is the real
  // guard -- do it once `npx tsc --noEmit` is clean on your machine.
  typescript: {
    ignoreBuildErrors: true,
  },

  eslint: {
    ignoreDuringBuilds: true,
  },

  // No screen loads an outside image. The template allowed four outside hosts
  // (stock photo sites and the builder's CDN) through Next's image proxy, which
  // let anyone use this server to fetch from them. None now.
  images: {
    remotePatterns: [],
    minimumCacheTTL: 60,
    qualities: [75, 85, 100],
  },

  // Basic hardening for a page that moves money: it cannot be framed by
  // another site (clickjacking a "Close shift" or "Approve"), the browser does
  // not guess content types, and addresses with ids are not sent to other sites.
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(self)' },
      ],
    }];
  },
};
export default nextConfig;
