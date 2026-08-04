import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PDF Human Reader',
  description:
    'Upload a PDF and listen to its meaningful text in a natural voice, with every spoken sentence traceable back to the page it came from.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f6f4' },
    { media: '(prefers-color-scheme: dark)', color: '#16171a' },
  ],
};

/**
 * On a static host there is no server to send a Content-Security-Policy header,
 * so the policy is carried in a <meta> tag instead. This is genuinely weaker
 * and the difference is not hidden: `frame-ancestors` is ignored in a meta
 * policy, and X-Frame-Options and X-Content-Type-Options cannot be expressed
 * here at all. A build served by the Next server sets all of them as real
 * headers and does not emit this tag.
 *
 * There is no API in a static build, so `connect-src` allows only this origin.
 */
const STATIC_CSP =
  process.env.NEXT_PUBLIC_STATIC_EXPORT === 'true'
    ? [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "media-src 'self' blob: data:",
        "connect-src 'self' blob:",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; ')
    : null;

/**
 * Applies the stored theme before first paint so the page never flashes the
 * wrong colours. It reads only this app's own preference key.
 */
const THEME_BOOTSTRAP = `
(function () {
  try {
    var stored = localStorage.getItem('pdf-reader-theme');
    var theme = stored && stored !== 'system'
      ? stored
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        {STATIC_CSP && <meta httpEquiv="Content-Security-Policy" content={STATIC_CSP} />}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
