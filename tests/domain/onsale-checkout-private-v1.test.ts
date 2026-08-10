import { describe, expect, it } from "vitest"

import {
  CheckoutPrivateContractParseError,
  parseCheckoutPrivateResponseV1,
} from "../../src/domain/onsale-checkout-private-v1"

const EVIDENCE_REVISION = `sha256:${"a".repeat(64)}`

function readyResponse(): unknown {
  return {
    schema: "onsale.checkout-private.v1",
    ok: true,
    stage: "checkout_ready",
    order: {
      state: "payment_pending",
      paymentDeadlineAt: "2026-08-08T20:05:00.000Z",
      currency: "USD",
      subtotalMinor: 36_000,
      feeMinor: 4_000,
      taxMinor: 1_000,
      totalMinor: 41_000,
      itemCount: 2,
      items: [
        {
          sectionLabel: "Orchestra",
          rowLabel: "A",
          seatLabel: "1",
          priceTier: "Standard",
          faceValueMinor: 18_000,
          feeMinor: 2_000,
          taxMinor: 500,
          totalMinor: 20_500,
          currency: "USD",
        },
        {
          sectionLabel: "Orchestra",
          rowLabel: "A",
          seatLabel: "2",
          priceTier: "Standard",
          faceValueMinor: 18_000,
          feeMinor: 2_000,
          taxMinor: 500,
          totalMinor: 20_500,
          currency: "USD",
        },
      ],
      ticketCount: 0,
    },
    payment: {
      canonicalState: "requires_method",
      integrityState: "clear",
      observationSource: "create",
      selectedMethod: null,
      observedConnector: null,
      attempts: [
        {
          ordinal: 1,
          state: "requires_method",
          charged: false,
          hardDecline: false,
          connector: null,
        },
      ],
      chargedAttemptCount: 0,
      evidenceGeneration: 1,
      retryPermitted: true,
      retryReason: "official_checkout_submission_available",
      evidenceRevision: EVIDENCE_REVISION,
    },
    checkout: {
      clientSecret: "secret_client_canary_123456",
      publishableKey: "pk_snd_publishable_canary_123456",
    },
    message: "SECURE CHECKOUT READY",
  }
}

describe("C3 browser-private checkout contract", () => {
  it("parses one immutable two-seat order and its ephemeral checkout grant", () => {
    const parsed = parseCheckoutPrivateResponseV1(readyResponse())

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error("expected success")
    expect(parsed.order.itemCount).toBe(2)
    expect(parsed.order.totalMinor).toBe(41_000)
    expect(parsed.checkout?.publishableKey).toBe(
      "pk_snd_publishable_canary_123456",
    )
    expect(JSON.stringify(parsed)).not.toMatch(
      /orderRef|payment_id|providerPayment|operationKey/iu,
    )
  })

  it("rejects unknown fields instead of leaking provider or order identifiers", () => {
    const candidate = readyResponse() as Record<string, unknown>
    candidate.orderRef = "00000000-0000-4000-8000-000000000701"

    expect(() => parseCheckoutPrivateResponseV1(candidate)).toThrow(
      CheckoutPrivateContractParseError,
    )
  })

  it("rejects a checkout grant outside the only safe checkout-ready tuple", () => {
    const candidate = readyResponse() as {
      stage: string
      message: string
      payment: Record<string, unknown>
    }
    candidate.stage = "processing"
    candidate.message = "PAYMENT PROCESSING"
    candidate.payment.canonicalState = "processing"
    candidate.payment.retryPermitted = false
    candidate.payment.retryReason = "same_payment_status_check_only"

    expect(() => parseCheckoutPrivateResponseV1(candidate)).toThrow(
      CheckoutPrivateContractParseError,
    )
  })

  it("accepts fulfilled only for one charged attempt and all durable tickets", () => {
    const candidate = readyResponse() as {
      stage: string
      message: string
      checkout: unknown
      order: Record<string, unknown>
      payment: Record<string, unknown>
    }
    candidate.stage = "fulfilled"
    candidate.message = "TICKETS ISSUED"
    candidate.checkout = null
    candidate.order.state = "fulfilled"
    candidate.order.ticketCount = 2
    candidate.payment.canonicalState = "succeeded"
    candidate.payment.observationSource = "retrieve"
    candidate.payment.attempts = [
      {
        ordinal: 1,
        state: "succeeded",
        charged: true,
        hardDecline: false,
        connector: "stripe",
      },
    ]
    candidate.payment.chargedAttemptCount = 1
    candidate.payment.retryPermitted = false
    candidate.payment.retryReason = "payment_already_fulfilled"

    const parsed = parseCheckoutPrivateResponseV1(candidate)
    expect(parsed.ok && parsed.stage).toBe("fulfilled")
  })

  it("rejects a hard-decline projection that fabricates a ticket or charge", () => {
    const candidate = readyResponse() as {
      stage: string
      message: string
      checkout: unknown
      order: Record<string, unknown>
      payment: Record<string, unknown>
    }
    candidate.stage = "declined"
    candidate.message = "PAYMENT NOT COMPLETED"
    candidate.checkout = null
    candidate.order.ticketCount = 1
    candidate.payment.canonicalState = "exhausted"
    candidate.payment.attempts = [
      {
        ordinal: 1,
        state: "hard_decline",
        charged: false,
        hardDecline: true,
        connector: "stripe",
      },
    ]
    candidate.payment.retryPermitted = false
    candidate.payment.retryReason = "hard_decline_no_automatic_retry"

    expect(() => parseCheckoutPrivateResponseV1(candidate)).toThrow(
      CheckoutPrivateContractParseError,
    )
  })

  it.each([
    {
      name: "ready state carrying a terminal attempt",
      mutate(candidate: ReturnType<typeof readyResponse>) {
        const value = candidate as {
          payment: Record<string, unknown>
        }
        value.payment.attempts = [
          {
            ordinal: 1,
            state: "hard_decline",
            charged: false,
            hardDecline: true,
            connector: "stripe",
          },
        ]
      },
    },
    {
      name: "observed action state without provider evidence",
      mutate(candidate: ReturnType<typeof readyResponse>) {
        const value = candidate as {
          stage: string
          message: string
          checkout: unknown
          payment: Record<string, unknown>
        }
        value.stage = "action_required"
        value.message = "PROVIDER ACTION REQUIRED"
        value.checkout = null
        value.payment.canonicalState = "action_required"
        value.payment.observationSource = null
        value.payment.attempts = []
        value.payment.evidenceGeneration = 0
        value.payment.retryPermitted = false
        value.payment.retryReason = "same_payment_status_check_only"
      },
    },
    {
      name: "clear state with an uncharged succeeded attempt",
      mutate(candidate: ReturnType<typeof readyResponse>) {
        const value = candidate as {
          stage: string
          message: string
          checkout: unknown
          payment: Record<string, unknown>
        }
        value.stage = "processing"
        value.message = "PAYMENT PROCESSING"
        value.checkout = null
        value.payment.canonicalState = "processing"
        value.payment.attempts = [
          {
            ordinal: 1,
            state: "succeeded",
            charged: false,
            hardDecline: false,
            connector: "stripe",
          },
        ]
        value.payment.retryPermitted = false
        value.payment.retryReason = "same_payment_status_check_only"
      },
    },
  ])("rejects $name", ({ mutate }) => {
    const candidate = readyResponse()
    mutate(candidate)

    expect(() => parseCheckoutPrivateResponseV1(candidate)).toThrow(
      CheckoutPrivateContractParseError,
    )
  })
})
