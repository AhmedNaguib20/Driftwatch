import type { Metadata } from 'next'
import Link from 'next/link'
import './globals.css'

export const metadata: Metadata = {
  title: 'Driftwatch fixture',
  description: 'A deliberately ordinary Next.js app used to validate measurement stability.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <Link href="/">Home</Link>
          <Link href="/about">About</Link>
          <Link href="/blog">Blog</Link>
          <Link href="/dashboard">Dashboard</Link>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  )
}
