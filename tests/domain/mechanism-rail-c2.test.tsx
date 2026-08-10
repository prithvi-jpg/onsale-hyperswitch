import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"


import {
	ProductionMechanismRail,
	deriveApprovedProductionTraceV1,
	productionHandoffPresentationV1,
	productionLivePlaybackV1,
	type CheckoutRailEvidence,
	type InventoryRailEvidence,
} from "../../src/MechanismRail"

function inventoryEvidence(
  overrides: Partial<InventoryRailEvidence> = {},
): InventoryRailEvidence {
  return {
    mode: "inventory",
    state: "held",
    selectedSeatCount: 0,
    heldSeatCount: 4,
    totalMinor: 73_840,
    currency: "USD",
    expiresAt: "2026-08-08T20:10:00.000Z",
    revision: `sha256:${"a".repeat(64)}`,
    serverTime: "2026-08-08T20:01:12.345Z",
    ...overrides,
  }
}

function renderInventoryRail(
  overrides: Partial<InventoryRailEvidence> = {},
): string {
  return renderToStaticMarkup(
    <ProductionMechanismRail
      inventory={inventoryEvidence(overrides)}
      revision={1}
    />,
  )
}

function checkoutEvidence(
  overrides: Partial<CheckoutRailEvidence> = {},
): CheckoutRailEvidence {
  return {
    stage: "checkout_ready",
    orderState: "payment_pending",
    itemCount: 2,
    ticketCount: 0,
    totalMinor: 41_000,
    currency: "USD",
    paymentDeadlineAt: "2026-08-08T20:10:00.000Z",
    canonicalState: "requires_method",
    integrityState: "clear",
    observationSource: "create",
    selectedMethod: { family: "card", type: "credit" },
    observedConnector: "stripe",
    attempts: [
      {
        ordinal: 1,
        state: "requires_method",
        charged: false,
        hardDecline: false,
        connector: "stripe",
      },
    ],
    chargedAttemptCount: 0,
    evidenceGeneration: 1,
    evidenceRevision: `sha256:${"c".repeat(64)}`,
    retryPermitted: true,
    retryReason: "official_checkout_submission_available",
    requestState: "idle",
    ...overrides,
  }
}

describe("production mechanism-rail module boundary", () => {
  it("keeps the frozen simulator only in the Git-object parity runtime", () => {
    const railSource = readFileSync(
      resolve(process.cwd(), "src/MechanismRail.tsx"),
      "utf8",
    )
    const paritySource = readFileSync(
      resolve(process.cwd(), "tests/parity/baseline-contract.mjs"),
      "utf8",
    )

    expect(railSource).not.toContain("export default function MechanismRail")
    expect(railSource).not.toContain("Payment orchestration flow diagram")
    expect(railSource).not.toContain("type FlowState")
    expect(paritySource).not.toContain("const railDeclarations")
    expect(paritySource).not.toContain("current/src/MechanismRail.tsx")
    expect(paritySource).toContain(
      '"src/MechanismRail.tsx": baselineSources["src/MechanismRail.tsx"]',
    )
  })
})

describe("production mechanism-rail trace", () => {
  it("animates one buyer intent handoff when Pay activates without claiming an outcome", () => {
    const ready = checkoutEvidence({ requestState: "idle" })
    const confirming = checkoutEvidence({ requestState: "confirming" })

    expect(
      productionLivePlaybackV1(
        ready,
        confirming,
        confirming.evidenceRevision,
      ),
    ).toMatchObject({
      kind: "live_event",
      handoff: {
        edgeId: "buyer_merchant",
        source: "buyer",
        target: "merchant",
        authorityProof: "browser_handoff",
        label: "Buyer activated official checkout",
      },
    })
  })

  it("animates one authoritative retrieve delta even when its retained facts change", () => {
    const previous = checkoutEvidence()
    const retrieved = checkoutEvidence({
      observationSource: "retrieve",
      evidenceGeneration: 2,
      evidenceRevision: `sha256:${"d".repeat(64)}`,
	})

    expect(
      productionLivePlaybackV1(
        previous,
        retrieved,
        retrieved.evidenceRevision,
      ),
    ).toMatchObject({
      kind: "live_event",
      handoff: {
        edgeId: "reconcile_merchant",
        source: "reconcile",
        target: "merchant",
        authorityProof: "server_retrieve",
      },
    })

    const changedFacts = checkoutEvidence({
      stage: "processing",
      canonicalState: "processing",
      observationSource: "retrieve",
      evidenceGeneration: 2,
      evidenceRevision: `sha256:${"e".repeat(64)}`,
    })
    expect(
      productionLivePlaybackV1(
        previous,
        changedFacts,
        changedFacts.evidenceRevision,
      ),
    ).toMatchObject({
      kind: "live_event",
      handoff: {
        edgeId: "reconcile_merchant",
        source: "reconcile",
        target: "merchant",
        authorityProof: "server_retrieve",
      },
    })
    expect(
      productionLivePlaybackV1(null, retrieved, retrieved.evidenceRevision),
    ).toEqual({ kind: "static", reason: "hydrate" })
  })

  it("moves the verified terminal handoff to tickets only with one charge and exact cardinality", () => {
    const previous = checkoutEvidence()
    const fulfilled = checkoutEvidence({
      stage: "fulfilled",
      orderState: "fulfilled",
      ticketCount: 2,
      canonicalState: "succeeded",
      observationSource: "retrieve",
      chargedAttemptCount: 1,
      attempts: [
        {
          ordinal: 1,
          state: "succeeded",
          charged: true,
          hardDecline: false,
          connector: "stripe",
        },
      ],
      evidenceGeneration: 2,
      evidenceRevision: `sha256:${"f".repeat(64)}`,
    })

    expect(
      productionLivePlaybackV1(previous, fulfilled, fulfilled.evidenceRevision),
    ).toMatchObject({
      kind: "live_event",
      handoff: {
        edgeId: "merchant_tickets",
        source: "merchant",
        target: "tickets",
        authorityProof: "merchant_db",
        tone: "success",
      },
    })

    const missingTicket = { ...fulfilled, ticketCount: 1 }
    expect(
      productionLivePlaybackV1(
        previous,
        missingTicket,
        missingTicket.evidenceRevision,
      ),
    ).toMatchObject({
      kind: "live_event",
      handoff: { edgeId: "reconcile_merchant" },
    })
  })

  it("retains the create edge after a retrieve while keeping retrieved attempt facts retrieve-proven", () => {
    const created = checkoutEvidence()
    const retrieved = checkoutEvidence({
      observationSource: "retrieve",
      evidenceGeneration: 2,
      evidenceRevision: `sha256:${"d".repeat(64)}`,
    })
    const trace = deriveApprovedProductionTraceV1(
      retrieved,
      retrieved.evidenceRevision,
      true,
    )
    const createEdge = trace.frame.edges.find(
      (edge) => edge.id === "merchant_hyperswitch",
    )

    expect(created.observationSource).toBe("create")
    expect(createEdge).toMatchObject({
      state: "traversed",
      proof: "server_create",
    })
    expect(trace.frame.orchestration.attempts[0]).toMatchObject({
      proof: "server_retrieve",
    })
  })

  it("does not claim an observed connector before a connector fact exists", () => {
    const checkout = checkoutEvidence({
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
    })
    const trace = deriveApprovedProductionTraceV1(
      checkout,
      checkout.evidenceRevision,
    )

    expect(trace.handoffLabel).toBe("HYPERSWITCH · REQUIRES METHOD")
    expect(trace.sequence).toContain("HYPERSWITCH · REQUIRES METHOD")
    expect(trace.sequence).not.toContain(
      "HYPERSWITCH ↔ OBSERVED CONNECTOR · ATTEMPT 01",
    )
    expect(
      trace.frame.nodes.find((node) => node.id === "connector"),
    ).toMatchObject({
      detail: "no attempt observed",
      proof: "unproven",
      state: "future",
    })
    expect(
      trace.frame.edges.find((edge) => edge.id === "hyperswitch_connector"),
    ).toMatchObject({
      attemptOrdinal: null,
      proof: "unproven",
      state: "possible",
    })
  })

  it("keeps retrieve handoff authority at the source until the map reports arrival", () => {
    const previous = checkoutEvidence()
    const retrieved = checkoutEvidence({
      observationSource: "retrieve",
      evidenceGeneration: 2,
      evidenceRevision: `sha256:${"d".repeat(64)}`,
    })
    const playback = productionLivePlaybackV1(
      previous,
      retrieved,
      retrieved.evidenceRevision,
    )
    if (playback.kind !== "live_event") throw new Error("Expected live retrieve")
    const trace = deriveApprovedProductionTraceV1(
      retrieved,
      retrieved.evidenceRevision,
      true,
    )

    expect(productionHandoffPresentationV1(trace, playback, null)).toMatchObject({
      authority: "in_flight",
      authorityNode: "reconcile",
      label: "HYPERSWITCH → RECONCILE · CHECKING SAME PAYMENT",
    })
    expect(
      productionHandoffPresentationV1(trace, playback, playback.handoff),
    ).toMatchObject({
      authority: "arrived",
      authorityNode: "merchant",
      label: "RECONCILE → ONSALE · SAME PAYMENT RETURNED",
    })
  })

  it("keeps the landing state calm and withholds payment evidence until checkout", () => {
    const html = renderInventoryRail({
      state: "preview",
      selectedSeatCount: 0,
      heldSeatCount: 0,
      totalMinor: null,
      expiresAt: null,
      revision: null,
    })

    expect(html).toContain('data-testid="production-payment-rail"')
    expect(html).toContain("PAYMENT TRACE")
    expect(html).toContain("Starts at checkout")
    expect(html).toContain(
      "Choose and hold seats first. The payment trace appears only when Hyperswitch begins.",
    )
    expect(html).not.toContain('class="payment-trace-map')
    expect(html).not.toContain("LIVE PAYMENT TRACE")
    expect(html).not.toContain("TRACE INSPECTOR")
    expect(html).not.toContain("REFRESH / RECONCILE")
    expect(html).not.toContain("snapshot revision")
  })

  it("keeps the inventory prelude exact and outside the payment topology", () => {
    const html = renderInventoryRail()

    expect(html).toContain(
      'aria-label="Seat selection and hold prelude before payment"',
    )
    expect(html).toContain("4 SEATS HELD")
    expect(html).toContain("$738.40 HELD · NOT CHARGED")
    expect(html).toContain("PAYMENT STARTS AT CHECKOUT")
    expect(html).not.toContain('class="payment-trace-map')
    expect(html).not.toContain('data-node="hyperswitch"')
    expect(html).not.toContain('data-node="connector"')
    expect(html).not.toContain('data-node="tickets"')
  })

  it("uses the accepted trace map while checkout is being prepared", () => {
    const html = renderInventoryRail({
      state: "held",
      heldSeatCount: 1,
      selectedSeatCount: 1,
      message: "checkout_preparing",
    })

    expect(html).toContain('class="payment-trace-map')
    expect(html).toContain("Buyer asked ONSALE to secure the held order")
    expect(html).toContain("Outcome remains unknown")
    expect(html).toContain('data-node="buyer"')
    expect(html).toContain('data-node="merchant"')
    expect(html).not.toContain("1 seats held")
    expect(html).not.toContain("TICKETS READY")
    expect(html).not.toContain("CHARGED")
  })

  it("renders the approved six-role circuit and keeps method separate from observed connector", () => {
    const html = renderInventoryRail({ checkout: checkoutEvidence() })

    expect(html).toContain(
      'aria-label="Live payment trace. CHOOSE A PAYMENT METHOD"',
    )
    for (const node of [
      "buyer",
      "merchant",
      "hyperswitch",
      "connector",
      "reconcile",
      "tickets",
    ]) {
      expect(html).toContain(`data-node="${node}"`)
    }
    expect(html).not.toContain('data-node="onsale_order"')
    expect(html).not.toContain('data-node="seat_hold"')
    expect(html).not.toContain('data-node="provider_action"')
    expect(html).not.toContain('data-node="retrieve"')
    expect(html).not.toContain('data-node="onsale_fulfillment"')
    expect(html).toContain("OBSERVED CONNECTOR")
    expect(html).toContain("METHOD · CARD / CREDIT")
    expect(html).toContain("CONNECTOR · STRIPE")
    expect(html).not.toContain("CARD / CREDIT · STRIPE")
    expect(html).not.toMatch(/pay_[A-Za-z0-9]|orderRef|providerPayment/iu)
  })

	it("puts current handoff and message sequence before the source-pinned inspector", () => {
    const html = renderInventoryRail({
      checkout: checkoutEvidence({
        stage: "checking_same_payment",
        canonicalState: "uncertain",
        observationSource: "retrieve",
        requestState: "reconciling",
        retryPermitted: false,
        retryReason: "same_payment_status_check_only",
      }),
    })

    expect(html).toContain(
      'aria-label="Live payment trace. CHECKING THIS SAME PAYMENT"',
    )
    const handoff = html.indexOf("CURRENT HANDOFF")
    const sequence = html.indexOf("MESSAGE SEQUENCE")
    const inspector = html.indexOf("TRACE INSPECTOR")
    expect(handoff).toBeGreaterThan(-1)
    expect(sequence).toBeGreaterThan(handoff)
    expect(inspector).toBeGreaterThan(sequence)
		expect(html).toContain("FOLLOWING TRACE")
    expect(html).toContain("FOLLOW LIVE TRACE")
		expect(html).toContain('aria-controls="production-attempt-inspector"')
		expect(html).toContain('id="production-attempt-inspector"')
		expect(html).toContain('data-testid="production-attempt-disclosure"')
		expect(html).toContain('aria-expanded="false"')
		expect(html).toContain('id="production-attempt-inspector-content" hidden=""')
		expect(html).not.toContain('class="production-rail-transition" aria-live=')
	})

  it("compresses three or more attempts to the lowest and terminal or winner rows", () => {
    const html = renderInventoryRail({
      checkout: checkoutEvidence({
        attempts: [
          {
            ordinal: 1,
            state: "technical_failure",
            charged: false,
            hardDecline: false,
            connector: "stripe",
          },
          {
            ordinal: 2,
            state: "technical_failure",
            charged: false,
            hardDecline: false,
            connector: "adyen",
          },
          {
            ordinal: 3,
            state: "succeeded",
            charged: true,
            hardDecline: false,
            connector: "checkout_com",
          },
        ],
        chargedAttemptCount: 1,
      }),
    })

    const compactLens = html.slice(0, html.indexOf("CURRENT HANDOFF"))
    expect(compactLens).toContain('data-attempt="1"')
    expect(compactLens).toContain("CONNECTOR · STRIPE")
    expect(compactLens).not.toContain('data-attempt="2"')
    expect(compactLens).not.toContain("CONNECTOR · ADYEN")
    expect(compactLens).toContain('data-attempt="3"')
    expect(compactLens).toContain("CONNECTOR · CHECKOUT_COM")
    expect(compactLens).toContain("OPEN 3 ATTEMPTS")
    expect(html).toContain("attempt 02")
  })

  it("uses checkout money and requires exact one-charge ticket integrity before success", () => {
    const fulfilled = renderInventoryRail({
      checkout: checkoutEvidence({
        stage: "fulfilled",
        orderState: "fulfilled",
        itemCount: 4,
        ticketCount: 4,
        totalMinor: 41_000,
        canonicalState: "succeeded",
        observationSource: "retrieve",
        attempts: [
          {
            ordinal: 1,
            state: "succeeded",
            charged: true,
            hardDecline: false,
            connector: "stripe",
          },
        ],
        chargedAttemptCount: 1,
        retryPermitted: false,
        retryReason: "payment_already_fulfilled",
      }),
    })

    expect(fulfilled).toContain("$410.00 CHARGED ONCE")
    expect(fulfilled).not.toContain("$738.40 CHARGED")
    expect(fulfilled).toContain("4 OF 4 TICKETS ISSUED")
    expect(fulfilled).toContain("INTEGRITY · CLEAR")
    expect(fulfilled).toMatch(/data-node="tickets"[^>]*data-state="succeeded"/u)

    const html = renderInventoryRail({
      checkout: checkoutEvidence({
        stage: "fulfilled",
        orderState: "fulfilled",
        itemCount: 4,
        ticketCount: 4,
        canonicalState: "succeeded",
        integrityState: "clear",
        observationSource: "retrieve",
        attempts: [
          {
            ordinal: 1,
            state: "succeeded",
            charged: true,
            hardDecline: false,
            connector: "stripe",
          },
          {
            ordinal: 2,
            state: "succeeded",
            charged: true,
            hardDecline: false,
            connector: "stripe",
          },
        ],
        chargedAttemptCount: 2,
        retryPermitted: false,
        retryReason: "integrity_review_required",
      }),
    })

    expect(html).toContain("INTEGRITY · REVIEW REQUIRED")
    expect(html).toMatch(/data-node="tickets"[^>]*data-state="integrity_review"/u)
    expect(html).not.toContain("TICKETS ISSUED · CHARGED ONCE")
  })

  it("keeps the stable five panels in order after graph, handoff, sequence, and inspector", () => {
    const html = renderInventoryRail({ checkout: checkoutEvidence() })

    let previousIndex = html.indexOf("TRACE INSPECTOR")
    expect(previousIndex).toBeGreaterThan(html.indexOf("MESSAGE SEQUENCE"))
    for (const title of [
      "01 · POLICY",
      "02 · DECISION",
      "03 · ATTEMPTS",
      "04 · STATE",
      "05 · EVIDENCE",
    ]) {
      const currentIndex = html.indexOf(title)
      expect(currentIndex).toBeGreaterThan(previousIndex)
      previousIndex = currentIndex
    }
  })

  it("omits unproved causal mechanisms and offers only a clearly labeled story analogue", () => {
    const html = renderInventoryRail({
      checkout: checkoutEvidence({
        stage: "declined",
        canonicalState: "exhausted",
        retryReason: "merchant_private_retry_cause",
      }),
    })

    expect(html).not.toMatch(/webhook/iu)
    expect(html).not.toMatch(/routing/iu)
    expect(html).not.toMatch(/failover/iu)
    expect(html).not.toContain("merchant_private_retry_cause")
    expect(html).not.toContain("REPLAY THIS OUTCOME")
    expect(html).toContain("OPEN FLOWS")
    expect(html).toContain('href="/flows"')
  })

  it("links a terminal receipt to its validated exact recorded run", () => {
    const html = renderInventoryRail({
      checkout: checkoutEvidence({
        stage: "fulfilled",
        orderState: "fulfilled",
        recordedRunRef: "run_0123456789abcdef01234567",
      }),
    })

    expect(html).toContain("OPEN FLOWS")
    expect(html).toContain('href="/flows"')
    expect(html).not.toContain("/flows?run=")
    expect(html).not.toContain("?story=confirmed-payment")
  })
})
