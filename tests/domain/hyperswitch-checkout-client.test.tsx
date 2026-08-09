import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import type { Element as HyperElement, HyperInstance } from "@juspay-tech/hyper-js"

import HyperswitchCheckoutClient, {
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
})
