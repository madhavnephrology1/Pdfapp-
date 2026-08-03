/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The shared packages ship TypeScript source and are compiled by Next.
  transpilePackages: ['@pdfreader/shared-types', '@pdfreader/test-fixtures'],

  async headers() {
    const isDev = process.env.NODE_ENV !== 'production';
    const apiOrigin = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000';

    // The document never leaves the browser, so the page is locked to its own
    // origin plus this app's API. 'unsafe-eval' is only allowed in development,
    // where the dev server needs it for fast refresh.
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "media-src 'self' blob: data:",
      `connect-src 'self' blob: ${apiOrigin}${isDev ? ' ws: http://localhost:*' : ''}`,
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
