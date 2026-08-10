import { readFileSync } from "node:fs"

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import FigmaApp from "../../app/figma-app"
import App from "../../src/App"

const forbiddenRuntimeClaims = [
  "LIVE HOSTED",
  "LOCAL PROTOTYPE",
  "NEON INVENTORY",
  "PAYMENT · ROUTING · WEBHOOK · TICKET — UNPROVEN",
  "SIMULATE PAYMENT",
  "TICKET ISSUED ✓",
  "SN-2026-7FKX",
]

describe("C2 production entry", () => {
  it("does not ship the retired non-inventory live-hosted fallback", () => {
    const appSource = readFileSync(
      new URL("../../src/App.tsx", import.meta.url),
      "utf8",
    )

    expect(appSource).not.toContain("LIVE HOSTED")
    expect(appSource).not.toContain("onsale-evidence-strip")
    expect(appSource).not.toContain("inventoryMode = false")
  })

  it.each([
    ["Vite/default", <App />],
    ["Next wrapper", <FigmaApp />],
  ])("keeps the %s entry on the inventory runtime", (_label, entry) => {
    const html = renderToStaticMarkup(entry)

    expect(html).toContain("EVENT DEMO")
    expect(html).toContain("ALL-IN PRICING")
    expect(html).toContain("GETTING THE EVENT READY")
    expect(html).toContain("PAYMENT TRACE")
    expect(html).toContain("Starts at checkout")
    for (const claim of forbiddenRuntimeClaims) {
      expect(html).not.toContain(claim)
    }
  })
})
