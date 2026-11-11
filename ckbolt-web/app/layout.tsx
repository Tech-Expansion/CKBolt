import React from "react"
import type { Metadata } from 'next'
import { Instrument_Sans, Instrument_Serif, JetBrains_Mono } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import { FiberWalletHost } from '@/components/app/fiber-wallet/host/wallet-host'
import './globals.css'

const instrumentSans = Instrument_Sans({ 
  subsets: ["latin"],
  variable: '--font-instrument'
});

const instrumentSerif = Instrument_Serif({ 
  subsets: ["latin"],
  weight: "400",
  variable: '--font-instrument-serif'
});

const jetbrainsMono = JetBrains_Mono({ 
  subsets: ["latin"],
  variable: '--font-jetbrains'
});

export const metadata: Metadata = {
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
    card: 'summary',
    site: '@texlabsorg',
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
            __html: "try{if(localStorage.getItem('ckbolt-motion')==='paused')document.documentElement.dataset.motion='paused'}catch(e){}",
          }}
        />
      </head>
      <body className={`${instrumentSans.variable} ${instrumentSerif.variable} ${jetbrainsMono.variable} font-sans antialiased`}>
        {/* The header's Fiber node: its iframe is created on first open and kept across client-side navigation. */}
        <FiberWalletHost>{children}</FiberWalletHost>
        {/* Vercel Analytics only exists on Vercel; elsewhere its script would 404. */}
        {process.env.VERCEL ? <Analytics /> : null}
      </body>
    </html>
  )
}
