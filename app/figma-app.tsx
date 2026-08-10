"use client"

import App from "../src/App"

export interface FigmaAppProps {
  readonly resumeCheckout?: boolean
}

export default function FigmaApp({ resumeCheckout = true }: FigmaAppProps) {
  return <App resumeCheckout={resumeCheckout} />
}
