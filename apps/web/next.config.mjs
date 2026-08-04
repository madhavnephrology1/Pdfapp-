/**
 * Two build shapes from one configuration.
 *
 * The default is a Next server — `next dev`, `next start`, the Docker image —
 * which sets its security headers over HTTP, the only place `frame-ancestors`
 * and `X-Frame-Options` can be set at all.
 *
 * Setting STATIC_EXPORT=true produces a folder of files instead, for a host
 * that runs no server of its own (GitHub Pages). That build is genuinely
 * weaker: a static host cannot send headers, so the policy moves to a <meta>
 * tag, `frame-ancestors` stops applying, and X-Content-Type-Options and
 * X-Frame-Options are lost. It also has no API, so speech falls back to the
 * browser's own voices and text recognition is unavailable. LIMITATIONS.md
 * says so, and so does the page itself.
 */

const staticExport = process.env.STATIC_EXPORT === 'true';
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The shared packages ship TypeScript source and are compiled by Next.
  transpilePackages: ['@pdfreader/shared-types', '@pdfreader/test-fixtures'],

  ...(staticExport
    ? {
        output: 'export',
        // A project page is served from a subdirectory named after the
        // repository, so every path needs that prefix.
        basePath: basePath || undefined,
        // Emit `privacy/index.html` rather than `privacy.html`: a static host
        // resolves a directory, not an extensionless file.
        trailingSlash: true,
      }
    : {
        async headers() {
          const isDev = process.env.NODE_ENV !== 'production';
          const apiOrigin = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000';

          // The document never leaves the browser, so the page is locked to its
          // own origin plus this app's API. 'unsafe-eval' is only allowed in
          // development, where the dev server needs it for fast refresh.
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
      }),
};

export default nextConfig;
