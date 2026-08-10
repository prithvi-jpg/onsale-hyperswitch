import type { Metadata, Viewport } from "next"
import type { ReactNode } from "react"

import "../src/index.css"

export const metadata: Metadata = {
  title: "ONSALE",
  description:
    "Streamline live-event ticket purchases with a fast, secure 3-step process for buyers and comprehensive transaction tracking for payment reviewers.",
  robots: {
    index: false,
    follow: false,
  },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
}

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div id="root">{children}</div>
      </body>
    </html>
  )
}
