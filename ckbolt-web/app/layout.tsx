import React from "react"
import type { Metadata, Viewport } from 'next'
import { Instrument_Sans, JetBrains_Mono } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import { FiberWalletHost } from '@/components/app/fiber-wallet/host/wallet-host'
import { MOTION_RESTORE_SCRIPT } from '@/lib/motion'
import './globals.css'

const instrumentSans = Instrument_Sans({ 
  subsets: ["latin"],
  variable: '--font-instrument'
});

const jetbrainsMono = JetBrains_Mono({ 
  subsets: ["latin"],
  variable: '--font-jetbrains'
});

/** The public site, so shared links get absolute image URLs (the share card is app/opengraph-image.png). */
const SITE_URL = 'https://ckbolt.texlabs.org'

/** Paper, the brand's page ground (brand kit v1.0). */
export const viewport: Viewport = {
  themeColor: '#FAFAF9',
}

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'CKBolt - Payments and swaps between Bitcoin Lightning and CKB',
  description: "Prototype by TEX Labs. CKBolt is building the link between Bitcoin Lightning and CKB's Fiber Network, so you can spend CKB wherever Lightning works and accept Lightning payments on CKB's Fiber Network. Live testnet demo: only test money moves.",
  authors: [{ name: 'TEX Labs', url: 'https://texlabs.org' }],
  openGraph: {
    type: 'website',
    siteName: 'CKBolt',
    title: 'CKBolt - Payments and swaps between Bitcoin Lightning and CKB',
    description: "Spend CKB wherever Lightning works, and accept Lightning payments on CKB's Fiber Network. A prototype by TEX Labs.",
  },
  twitter: {
    card: 'summary_large_image',
    site: '@CKBoltNetwork',
    creator: '@texlabsorg',
    title: 'CKBolt - Payments and swaps between Bitcoin Lightning and CKB',
    description: "Spend CKB wherever Lightning works, and accept Lightning payments on CKB's Fiber Network. A prototype by TEX Labs.",
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Restores the visitor's Pause motion choice before the first paint. */}
        <script
          dangerouslySetInnerHTML={{
            __html: MOTION_RESTORE_SCRIPT,
          }}
        />
      </head>
      <body className={`${instrumentSans.variable} ${jetbrainsMono.variable} font-sans antialiased`}>
        {/* The header's Fiber node: its iframe is created on first open and kept across client-side navigation. */}
        <FiberWalletHost>{children}</FiberWalletHost>
        {/* Vercel Analytics only exists on Vercel; elsewhere its script would 404. */}
        {process.env.VERCEL ? <Analytics /> : null}
      </body>
    </html>
  )
}
