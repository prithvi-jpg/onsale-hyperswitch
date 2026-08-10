import { readFileSync } from "node:fs"

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import type { Element as HyperElement, HyperInstance } from "@juspay-tech/hyper-js"

import HyperswitchCheckoutClient, {
  SandboxTestPaymentHelpersV1,
  confirmWithOfficialCheckoutV1,
} from "../../src/HyperswitchCheckoutClient"

describe("C3 official Hyperswitch client boundary", () => {
  it("passes the mounted official elements and fixed return URL to one confirmation", async () => {
    const confirmPayment = vi.fn(async () => ({ ignored: true }))
    const hyper = { confirmPayment } as unknown as HyperInstance
    const elements = {} as HyperElement

    await confirmWithOfficialCheckoutV1(
      hyper,
      elements,
      "https://onsale.example/api/onsale/return",
    )

    expect(confirmPayment).toHaveBeenCalledTimes(1)
    expect(confirmPayment).toHaveBeenCalledWith({
      elements,
      confirmParams: {
        return_url: "https://onsale.example/api/onsale/return",
      },
      redirect: "if_required",
    })
  })

  it("keeps the ephemeral grant out of server-rendered markup", () => {
    const html = renderToStaticMarkup(
      <HyperswitchCheckoutClient
        grant={{
          clientSecret: "secret_client_canary_123456",
          publishableKey: "pk_snd_publishable_canary_123456",
        }}
        amountLabel="$410.00"
        canSubmit={false}
        submitting={false}
        onReadiness={() => undefined}
        onConfirm={async () => false}
      />,
    )

    expect(html).toContain("LOADING OFFICIAL CHECKOUT")
    expect(html).not.toContain("secret_client_canary")
    expect(html).not.toContain("pk_snd_publishable_canary")
    expect(html).not.toContain("SIMULATE")
    expect(html).not.toContain("CARD NUMBER")
  })

  it("keeps public sandbox fixtures above and outside the official payment fields", () => {
    const html = renderToStaticMarkup(<SandboxTestPaymentHelpersV1 />)

    expect(html).toContain("Public sandbox cards")
    expect(html).toContain("4242 4242 4242 4242")
    expect(html).toContain("4000 0000 0000 0002")
    expect(html).toContain("COPY SUCCESS CARD")
    expect(html).toContain("COPY DECLINE CARD")
    expect(html).toContain("Klarna and Affirm test flows work here too")
    expect(html).toContain("Returned server state remains authoritative")
    expect(html).not.toContain("<input")
  })

  it("uses the official appearance variables to soften the billing details container", () => {
    const source = readFileSync(
      new URL("../../src/HyperswitchCheckoutClient.tsx", import.meta.url),
      "utf8",
    )

    expect(source).toContain('borderColor: "rgba(0,109,249,0.24)"')
    expect(source).toContain('borderRadius: "8px"')
    expect(source).toContain('spacingGridRow: "16px"')
    expect(source).toContain('spacingGridColumn: "16px"')
  })
})
