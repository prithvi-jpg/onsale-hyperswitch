import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import PaymentTraceMapV1, {
  PAYMENT_TRACE_EDGE_IDS_V1,
  PAYMENT_TRACE_NODE_IDS_V1,
  paymentTraceAdvanceMotionCursorV1,
  paymentTraceCreateMotionCursorV1,
  paymentTraceMotionHasArrivedV1,
  paymentTraceRetargetMotionCursorV1,
  paymentTraceSetMotionControlV1,
  paymentTraceTravelDurationMsV1,
  type PaymentTraceFrameV1,
  type PaymentTraceMotionDurationsV1,
  type PaymentTracePlaybackV1,
} from "../../src/PaymentTraceMap"
import {
  paymentTraceProjectedGeometryV1,
  type PaymentTraceProjectedNodeGeometryV1,
} from "../../src/payment-trace/trace-geometry"

const revision = `sha256:${"a".repeat(64)}`

function frameV1(
  overrides: Partial<PaymentTraceFrameV1> = {},
): PaymentTraceFrameV1 {
  return {
    revision,
    ariaLabel: "Recorded payment trace",
    merchant: {
      itemCount: 2,
      ticketCount: 0,
      orderState: "payment_pending",
    },
    orchestration: {
      selectedMethod: {
        family: "pay_later",
        type: "klarna",
        proof: "server_create",
      },
      attempts: [
        {
          ordinal: 1,
          methodAtAttempt: null,
          connector: "stripe_test",
          outcome: "action_required",
          charged: false,
          retryKind: "initial",
          failureClass: null,
          proof: "server_retrieve",
        },
      ],
      chargedAttemptCount: 0,
      winningAttemptOrdinal: null,
      terminal: "action_required",
      orderRetained: false,
    },
    nodes: [
      { id: "buyer", label: "BUYER", detail: "method ready", state: "traversed", proof: "server_create" },
      { id: "merchant", label: "ONSALE", detail: "order held", state: "traversed", proof: "merchant_db" },
      { id: "hyperswitch", label: "HYPERSWITCH", detail: "orchestrating", state: "current", proof: "server_retrieve" },
      { id: "connector", label: "OBSERVED CONNECTOR", detail: "attempt zone", state: "action_required", proof: "server_retrieve" },
      { id: "reconcile", label: "RECONCILE", detail: "same payment", state: "future", proof: "unproven" },
      { id: "tickets", label: "TICKETS", detail: "0 of 2", state: "future", proof: "unproven" },
    ],
    edges: [
      { id: "buyer_merchant", state: "traversed", attemptOrdinal: null, proof: "server_create" },
      { id: "merchant_hyperswitch", state: "traversed", attemptOrdinal: null, proof: "server_create" },
      { id: "hyperswitch_connector", state: "current", attemptOrdinal: 1, proof: "server_retrieve" },
      { id: "connector_hyperswitch", state: "possible", attemptOrdinal: 1, proof: "unproven" },
      { id: "hyperswitch_retrieve", state: "possible", attemptOrdinal: null, proof: "unproven" },
      { id: "reconcile_merchant", state: "possible", attemptOrdinal: null, proof: "unproven" },
      { id: "merchant_tickets", state: "possible", attemptOrdinal: null, proof: "unproven" },
    ],
    ...overrides,
  }
}

function authoritativeLivePlayback(): PaymentTracePlaybackV1 {
  return {
    kind: "live_event",
    handoff: {
      context: "live",
      eventId: "evt_attempt01observed",
      sequence: 3,
      edgeId: "hyperswitch_connector",
      source: "hyperswitch",
      target: "connector",
      attemptOrdinal: 1,
      label: "Attempt 01 reached an observed connector",
      tone: "action",
      authorityProof: "server_retrieve",
      evidenceRevision: revision,
    },
  }
}

describe("ONSALE v0.1 shared payment trace", () => {
  it.each([320, 360, 390, 768, 1186])(
    "keeps every rail and wide edge socket on its actor boundary at %ipx",
    (renderedWidth) => {
      const endpoints = {
        buyer_merchant: ["buyer", "merchant"],
        merchant_hyperswitch: ["merchant", "hyperswitch"],
        hyperswitch_connector: ["hyperswitch", "connector"],
        connector_hyperswitch: ["connector", "hyperswitch"],
        hyperswitch_retrieve: ["hyperswitch", "reconcile"],
        reconcile_merchant: ["reconcile", "merchant"],
        merchant_tickets: ["merchant", "tickets"],
      } as const
      const isOnBoundary = (
        point: readonly [number, number],
        node: PaymentTraceProjectedNodeGeometryV1,
      ) => {
        const epsilon = 0.000_001
        const withinX = point[0] >= node.x - epsilon &&
          point[0] <= node.x + node.w + epsilon
        const withinY = point[1] >= node.y - epsilon &&
          point[1] <= node.y + node.h + epsilon
        const onVerticalSide = Math.abs(point[0] - node.x) <= epsilon ||
          Math.abs(point[0] - (node.x + node.w)) <= epsilon
        const onHorizontalSide = Math.abs(point[1] - node.y) <= epsilon ||
          Math.abs(point[1] - (node.y + node.h)) <= epsilon
        return withinX && withinY && (onVerticalSide || onHorizontalSide)
      }

      for (const layout of ["rail", "wide"] as const) {
        const projected = paymentTraceProjectedGeometryV1(layout, renderedWidth)
        expect(projected.width).toBe(renderedWidth)
        expect(projected.height).toBe(layout === "rail" ? 396 : 300)

        for (const edgeId of PAYMENT_TRACE_EDGE_IDS_V1) {
          const [sourceId, targetId] = endpoints[edgeId]
          expect(isOnBoundary(projected.edges[edgeId].source, projected.nodes[sourceId]))
            .toBe(true)
          expect(isOnBoundary(projected.edges[edgeId].target, projected.nodes[targetId]))
            .toBe(true)
        }
      }
    },
  )

  it("retains normalized motion progress through pause, resume, layout timing changes, and interruption", () => {
    const railDurations: PaymentTraceMotionDurationsV1 = {
      drawMs: 420,
      handoffPauseMs: 70,
      travelMs: 520,
      terminalSettleMs: 180,
    }
    const wideDurations: PaymentTraceMotionDurationsV1 = {
      ...railDurations,
      travelMs: 480,
    }
    let cursor = paymentTraceCreateMotionCursorV1("evt_trace_a", {
      kind: "playing",
    })
    cursor = paymentTraceAdvanceMotionCursorV1(cursor, 420, railDurations, false)
    cursor = paymentTraceAdvanceMotionCursorV1(cursor, 70, railDurations, false)
    cursor = paymentTraceAdvanceMotionCursorV1(cursor, 260, railDurations, false)
    expect(cursor).toMatchObject({
      kind: "active",
      phase: "travelling",
      phaseProgress: 0.5,
    })

    cursor = paymentTraceSetMotionControlV1(cursor, { kind: "paused" })
    const paused = paymentTraceAdvanceMotionCursorV1(
      cursor,
      10_000,
      railDurations,
      false,
    )
    expect(paused).toEqual(cursor)

    cursor = paymentTraceSetMotionControlV1(paused, { kind: "playing" })
    const sameEventAfterLayoutChange = paymentTraceRetargetMotionCursorV1({
      cursor,
      eventKey: "evt_trace_a",
      control: { kind: "playing" },
    })
    expect(sameEventAfterLayoutChange.settlePrevious).toBe(false)
    expect(sameEventAfterLayoutChange.cursor).toMatchObject({
      phase: "travelling",
      phaseProgress: 0.5,
    })
    cursor = paymentTraceAdvanceMotionCursorV1(
      sameEventAfterLayoutChange.cursor,
      48,
      wideDurations,
      false,
    )
    expect(cursor).toMatchObject({
      phase: "travelling",
      phaseProgress: 0.6,
    })

    const interrupted = paymentTraceRetargetMotionCursorV1({
      cursor,
      eventKey: "evt_trace_b",
      control: { kind: "playing" },
    })
    expect(interrupted.settlePrevious).toBe(true)
    expect(interrupted.cursor).toMatchObject({
      kind: "active",
      eventKey: "evt_trace_b",
      phase: "drawing",
      phaseProgress: 0,
    })
    expect(paymentTraceMotionHasArrivedV1(interrupted.cursor)).toBe(false)
  })

  it("renders fixed-height responsive geometry and exposes a backward-compatible pause control", () => {
    const html = renderToStaticMarkup(
      <PaymentTraceMapV1
        frame={frameV1()}
        playback={authoritativeLivePlayback()}
        playbackControl={{ kind: "paused" }}
      />,
    )

    expect(html).toContain('preserveAspectRatio="none"')
    expect(html).toContain('data-playback-control="paused"')
    expect(html).toContain('height:396px')
    expect(html).toContain('max-height:396px')
    expect(html).not.toContain("<animateMotion")
  })

  it("locks the fixed six-actor circuit and excludes inherited transient actors", () => {
    expect(PAYMENT_TRACE_NODE_IDS_V1).toEqual([
      "buyer",
      "merchant",
      "hyperswitch",
      "connector",
      "reconcile",
      "tickets",
    ])
    expect(PAYMENT_TRACE_EDGE_IDS_V1).toEqual([
      "buyer_merchant",
      "merchant_hyperswitch",
      "hyperswitch_connector",
      "connector_hyperswitch",
      "hyperswitch_retrieve",
      "reconcile_merchant",
      "merchant_tickets",
    ])

    const html = renderToStaticMarkup(
      <PaymentTraceMapV1
        frame={frameV1()}
        playback={{ kind: "static", reason: "hydrate" }}
      />,
    )

    for (const actor of PAYMENT_TRACE_NODE_IDS_V1) {
      expect(html).toContain(`data-node="${actor}"`)
    }
    expect(html).not.toContain("provider_action")
    expect(html).not.toContain("seat_hold")
    expect(html).not.toContain("webhook")
    expect(html).not.toContain("marker-end")
  })

  it("keeps a deterministic four-band lens while separating method from connector", () => {
    const html = renderToStaticMarkup(
      <PaymentTraceMapV1
        frame={frameV1()}
        onInspectAttempts={() => undefined}
        attemptInspectorId="trace-attempt-inspector"
        playback={{ kind: "static", reason: "historical_selection" }}
      />,
    )

    const heading = html.indexOf('data-lens-band="heading"')
    const method = html.indexOf('data-lens-band="method"')
    const attempts = html.indexOf('data-lens-band="attempts"')
    const inspect = html.indexOf('data-lens-band="inspect"')

    expect(heading).toBeGreaterThan(-1)
    expect(method).toBeGreaterThan(heading)
    expect(attempts).toBeGreaterThan(method)
    expect(inspect).toBeGreaterThan(attempts)
    expect(html).toContain("ATTEMPTS")
    expect(html).toContain('data-attempt-count="1">01</i>')
    expect(html).toContain('title="METHOD · PAY LATER / KLARNA"')
    expect(html).toContain("METHOD · KLARNA")
    expect(html).toContain('title="CONNECTOR · STRIPE_TEST"')
    expect(html).toContain("01 · STRIPE_TEST")
    expect(html).toContain("ACTION REQUIRED")
    expect(html).not.toContain("KLARNA · STRIPE_TEST")
    expect(html).toContain('aria-controls="trace-attempt-inspector"')
    expect(html).toContain("retry relation initial")
    expect(html).toContain("proof server_retrieve")
    expect(html).toContain("OPEN ATTEMPTS")
  })

  it("keeps hydration and historical selection static, then replays only on an explicit replay branch", () => {
    const hydrated = renderToStaticMarkup(
      <PaymentTraceMapV1
        frame={frameV1()}
        playback={{ kind: "static", reason: "hydrate" }}
      />,
    )
    const selected = renderToStaticMarkup(
      <PaymentTraceMapV1
        frame={frameV1()}
        playback={{ kind: "static", reason: "historical_selection" }}
      />,
    )
    const replayed = renderToStaticMarkup(
      <PaymentTraceMapV1
        frame={frameV1()}
        playback={{
          kind: "replay_event",
          replayId: "replay_trace03_01",
          handoff: {
            context: "recorded_sandbox",
            eventId: "evt_attempt01observed",
            sequence: 3,
            edgeId: "hyperswitch_connector",
            source: "hyperswitch",
            target: "connector",
            attemptOrdinal: 1,
            label: "Attempt 01 reached an observed connector",
            tone: "action",
            authorityProof: "server_retrieve",
            evidenceRevision: revision,
          },
        }}
      />,
    )

    expect(hydrated).not.toContain("payment-trace-token")
    expect(selected).not.toContain("payment-trace-token")
    expect(replayed).toContain('data-playback="replay"')
    expect(replayed.match(/class="payment-trace-token"/gu)).toHaveLength(1)
    expect(replayed).toContain('data-motion-engine="interruptible"')
    expect(replayed).not.toContain("<animateMotion")
  })

  it("renders one slow amber core-and-halo signal only for a valid evidence-linked handoff", () => {
    const retrieveFrame = frameV1({
      edges: frameV1().edges.map((edge) =>
        edge.id === "hyperswitch_retrieve"
          ? {
              ...edge,
              state: "current",
              proof: "server_retrieve",
            }
          : edge,
      ),
    })
    const html = renderToStaticMarkup(
      <PaymentTraceMapV1
        frame={retrieveFrame}
        playback={{
          kind: "live_event",
          handoff: {
            context: "live",
            eventId: "evt_retrievesamepayment",
            sequence: 4,
            edgeId: "hyperswitch_retrieve",
            source: "hyperswitch",
            target: "reconcile",
            attemptOrdinal: null,
            label: "Retrieve the same payment",
            tone: "progress",
            authorityProof: "server_retrieve",
            evidenceRevision: revision,
          },
        }}
      />,
    )

    expect(html.match(/class="payment-trace-token"/gu)).toHaveLength(1)
    expect(html).toContain('data-token-tone="amber"')
    expect(html).toContain('class="payment-trace-token-halo"')
    expect(html).toContain('class="payment-trace-token-core"')
    expect(html).toContain('data-motion-progress="0.000"')
    expect(paymentTraceTravelDurationMsV1("hyperswitch_retrieve", "rail"))
      .toBe(1_300)
    expect(html).not.toContain("<animateMotion")
  })

  it("fails closed when an event tuple or attempt evidence does not match the fixed topology", () => {
    const invalid = authoritativeLivePlayback()
    const html = renderToStaticMarkup(
      <PaymentTraceMapV1
        frame={frameV1()}
        playback={{
          ...invalid,
          handoff: {
            ...invalid.handoff,
            source: "buyer",
          },
        }}
      />,
    )

    expect(html).toContain('data-motion="evidence-rejected"')
    expect(html).not.toContain("payment-trace-token")
  })

  it("provides a no-travel reduced-motion equivalent at the proven destination", () => {
    const html = renderToStaticMarkup(
      <PaymentTraceMapV1
        frame={frameV1()}
        playback={authoritativeLivePlayback()}
        reducedMotion
      />,
    )

    expect(html).toContain('data-motion="reduced"')
    expect(html.match(/class="payment-trace-token"/gu)).toHaveLength(1)
    expect(html).not.toContain("<animateMotion")
    expect(html).toContain("Step 3, Hyperswitch to Observed connector")
  })

  it("refuses a successful ticket terminal when exact cardinality and one charge are absent", () => {
    const html = renderToStaticMarkup(
      <PaymentTraceMapV1
        frame={frameV1({
          nodes: frameV1().nodes.map((node) =>
            node.id === "tickets"
              ? { ...node, state: "succeeded", proof: "merchant_db" }
              : node,
          ),
          edges: frameV1().edges.map((edge) =>
            edge.id === "merchant_tickets"
              ? { ...edge, state: "success", proof: "merchant_db" }
              : edge,
          ),
        })}
        playback={{ kind: "static", reason: "hydrate" }}
      />,
    )

    expect(html).toContain('data-ticket-proof="rejected"')
    expect(html).toMatch(/data-node="tickets"[^>]*data-state="integrity_review"/u)
    expect(html).not.toMatch(/data-edge="merchant_tickets"[^>]*data-state="success"/u)
  })

  it("exposes node selection without coupling inspection to playback", () => {
    const html = renderToStaticMarkup(
      <PaymentTraceMapV1
        frame={frameV1()}
        onSelectNode={() => undefined}
        playback={{ kind: "static", reason: "historical_selection" }}
        selectedNode="hyperswitch"
      />,
    )

    expect(html).toMatch(/<button[^>]*data-node="hyperswitch"/u)
    expect(html).toMatch(
      /<button[^>]*aria-pressed="true"[^>]*data-node="hyperswitch"[^>]*data-selected="true"/u,
    )
    expect(html).not.toContain("payment-trace-token")
  })

  it("compresses three attempts to the lowest retained ordinal and winning attempt", () => {
    const attempts: PaymentTraceFrameV1["orchestration"]["attempts"] = [
      frameV1().orchestration.attempts[0],
      {
        ...frameV1().orchestration.attempts[0],
        ordinal: 2,
        connector: "fauxpay",
        outcome: "technical_failure",
        retryKind: "not_observed",
      },
      {
        ...frameV1().orchestration.attempts[0],
        ordinal: 3,
        connector: "stripe_test",
        outcome: "succeeded",
        charged: true,
      },
    ]
    const html = renderToStaticMarkup(
      <PaymentTraceMapV1
        frame={frameV1({
          orchestration: {
            ...frameV1().orchestration,
            attempts,
            chargedAttemptCount: 1,
            winningAttemptOrdinal: 3,
            terminal: "succeeded",
            orderRetained: false,
          },
        })}
        playback={{ kind: "static", reason: "historical_selection" }}
      />,
    )

    expect(html).toContain('data-attempt="1"')
    expect(html).toContain('data-attempt="3"')
    expect(html).not.toContain('data-attempt="2"')
    expect(html).toContain("OPEN 3 ATTEMPTS")
  })

  it("withholds connector identity and its edge when proof is unproven", () => {
    const html = renderToStaticMarkup(
      <PaymentTraceMapV1
        frame={frameV1({
          orchestration: {
            ...frameV1().orchestration,
            attempts: [
              {
                ...frameV1().orchestration.attempts[0],
                connector: "paypal",
                proof: "unproven",
              },
            ],
          },
          edges: frameV1().edges.map((edge) =>
            edge.id === "hyperswitch_connector"
              ? { ...edge, proof: "unproven" }
              : edge,
          ),
        })}
        playback={{ kind: "static", reason: "hydrate" }}
      />,
    )

    expect(html).not.toContain("CONNECTOR · PAYPAL")
    expect(html).toContain("CONNECTOR · NONE")
    expect(html).toContain("NO CONNECTOR OBSERVED")
    expect(html).toMatch(
      /data-edge="hyperswitch_connector"[^>]*data-state="possible"/u,
    )
  })

  it("does not allow raw provider-shaped identifiers or URLs into visible trace copy", () => {
    const hostileFrame = frameV1({
      nodes: frameV1().nodes.map((node) =>
        node.id === "buyer"
          ? { ...node, detail: "pay_abcdefghijklmnop" }
          : node,
      ),
      orchestration: {
        ...frameV1().orchestration,
        attempts: [
          {
            ...frameV1().orchestration.attempts[0],
            connector: "https://provider.example/attempt",
          },
        ],
      },
    })
    const html = renderToStaticMarkup(
      <PaymentTraceMapV1
        frame={hostileFrame}
        playback={{ kind: "static", reason: "hydrate" }}
      />,
    )

    expect(html).not.toContain("pay_abcdefghijklmnop")
    expect(html).not.toContain("provider.example")
    expect(html).toContain("NOT RETAINED")
  })

  it("accepts the terminal ticket edge only with one authoritative charge and exact tickets", () => {
    const successFrame = frameV1({
      merchant: { itemCount: 2, ticketCount: 2, orderState: "fulfilled" },
      orchestration: {
        ...frameV1().orchestration,
        attempts: [
          {
            ...frameV1().orchestration.attempts[0],
            outcome: "succeeded",
            charged: true,
            proof: "server_retrieve",
          },
        ],
        chargedAttemptCount: 1,
        winningAttemptOrdinal: 1,
        terminal: "succeeded",
      },
      nodes: frameV1().nodes.map((node) =>
        node.id === "tickets"
          ? { ...node, state: "succeeded", proof: "merchant_db" }
          : node,
      ),
      edges: frameV1().edges.map((edge) =>
        edge.id === "merchant_tickets"
          ? {
              ...edge,
              state: "success",
              proof: "merchant_db",
            }
          : edge,
      ),
    })
    const html = renderToStaticMarkup(
      <PaymentTraceMapV1
        frame={successFrame}
        playback={{ kind: "static", reason: "hydrate" }}
      />,
    )

    expect(html).toContain('data-ticket-proof="accepted"')
    expect(html).toMatch(/data-node="tickets"[^>]*data-state="succeeded"/u)
    expect(html).toMatch(
      /data-edge="merchant_tickets"[^>]*data-state="success"/u,
    )
  })
})
