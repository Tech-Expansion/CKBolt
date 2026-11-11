/**
 * The page that runs the visitor's Fiber node in the browser (fiber-js). It needs cross-origin isolation for its
 * SharedArrayBuffers, and gets it on this exact path only: COOP same-origin would break the CCC wallet popups (JoyID)
 * that the rest of /app uses, the node's funding page (/app/fiber/fund) included.
 */
const FIBER_NODE_ROUTE = '/app/fiber'

/**
 * The Fiber wallet that the header opens in a popover (docs/fiber-wallet-popup.md): the node page's wallet layout, in an
 * iframe of this site's own pages. Document-Isolation-Policy isolates that iframe alone (Chromium 137+), so the page
 * around it keeps its wallet popups. It is the one route same-origin pages may frame; every other route refuses any
 * framing. The same path is FIBER_WALLET_PATH in lib/wallets/fiber-popup/constants.ts.
 */
const FIBER_WALLET_ROUTE = '/app/wallet'

/**
 * Every path but the wallet's (path-to-regexp, as Next matches `source`): Next merges every rule that matches a path, so
 * the wallet must not match the rule that forbids framing at all.
 */
const ALL_BUT_WALLET = `/:path((?!${FIBER_WALLET_ROUTE.slice(1)}$).*)`

/** The content security policy, with who may frame the page. Script and connect sources stay open: wallet extensions inject scripts and CCC talks to CKB nodes. */
const contentSecurityPolicy = (frameAncestors) =>
  `frame-ancestors ${frameAncestors}; object-src 'none'; base-uri 'self'; form-action 'self'`

/** Isolates one document on its own (Chromium 137+), without COOP, so the window around it keeps its popups. */
const DOCUMENT_ISOLATION = { key: 'Document-Isolation-Policy', value: 'isolate-and-credentialless' }

/**
 * The Playwright suite's test hook (window.__ckboltTestFiberNode, a fake fiber-js) works only in a build made with
 * NEXT_PUBLIC_CKBOLT_TEST_HOOKS=1 (`npm run build:test`). The variable is always defined here, as "1" or "", so every
 * other build inlines "" where the app checks it, and the bundler drops the hooks and their names.
 */
const TEST_HOOKS = process.env.NEXT_PUBLIC_CKBOLT_TEST_HOOKS === '1' ? '1' : ''

/** Vercel's VERCEL_ENV on the deployment that serves the production domain (previews say "preview"). */
const VERCEL_PRODUCTION = 'production'

// The hooks let a page fake the visitor's wallets, so a production deployment with them must not exist: stop the build.
if (TEST_HOOKS && process.env.VERCEL_ENV === VERCEL_PRODUCTION) {
  throw new Error(
    'NEXT_PUBLIC_CKBOLT_TEST_HOOKS=1 is set for a Vercel production build. The test hooks exist only for the Playwright ' +
      'build (npm run build:test): remove the variable from the Vercel production environment and deploy again.',
  )
}

/**
 * Where `next build` writes and `next start` reads: `.next`, or the folder CKBOLT_DIST_DIR names, so a check build can
 * run while a server keeps serving the build in `.next` (tests/unit/public-demo.spec.ts reads the same variable).
 */
const DIST_DIR = process.env.CKBOLT_DIST_DIR || '.next'

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: DIST_DIR,
  env: {
    NEXT_PUBLIC_CKBOLT_TEST_HOOKS: TEST_HOOKS,
  },
  images: {
    unoptimized: true,
  },
  output: 'standalone',
  poweredByHeader: false,
  // The app asks wallets to sign, so it must not be framed by another site; only the wallet is framed, by this site.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
        ],
      },
      {
        source: ALL_BUT_WALLET,
        headers: [
          { key: 'Content-Security-Policy', value: contentSecurityPolicy("'none'") },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
      {
        source: FIBER_WALLET_ROUTE,
        headers: [
          { key: 'Content-Security-Policy', value: contentSecurityPolicy("'self'") },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          // No COOP: it means nothing in an iframe, and the wallet's own window is the node page below.
          DOCUMENT_ISOLATION,
        ],
      },
      {
        source: FIBER_NODE_ROUTE,
        headers: [
          // Chromium 137+: isolates this document alone. The node page opens no popups, so COOP below costs nothing here.
          DOCUMENT_ISOLATION,
          // Other browsers: classic cross-origin isolation. require-corp, because Safari has no credentialless; the page
          // loads only same-origin assets, and the CKB RPC answers with CORS.
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
        ],
      },
    ]
  },
}

export default nextConfig
