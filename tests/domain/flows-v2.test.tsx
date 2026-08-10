import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

import FlowsGallery, {
  REDUCED_MOTION_REPLAY_ARRIVAL_DWELL_MS_V1,
  createReplayArrivalDwellControllerV1,
  replayProofBannerV1,
} from "../../app/flows/FlowsGallery"
import PaymentTraceMapV1, {
  paymentTracePlaybackIsAuthorizedV1,
} from "../../src/PaymentTraceMap"
import {
  createReplayState,
  createReplayTraceSnapshot,
  multiAttemptSimulation,
  recordedReplayFlows,
  recordedRunCatalog,
  replayFlowCatalog,
  storyLabFlowCatalog,
  transitionReplay,
} from "../../app/flows/replay"
import {
  parseRecordedRunTraceV1,
  recordedRunLimitationV1,
  summarizeRecordedRunV1,
} from "../../src/onsale/contracts/recorded-run-v1"

function durableFlowsSeed() {
  const trace = parseRecordedRunTraceV1({
    schema: "onsale.recorded-run.v1",
    runRef: "run_aaaaaaaaaaaaaaaaaaaaaaaa",
    population: "local_browser",
    integrityRevision: `sha256:${"a".repeat(64)}`,
    order: { state: "fulfilled", itemCount: 1 },
    payment: {
      state: "succeeded",
      selectedMethod: { family: "card", type: null },
    },
    money: {
      currency: "USD",
      amountDueMinor: 18_460,
      amountReceivedMinor: 18_460,
    },
    attempts: [
      {
        ordinal: 1,
        method: { family: "card", type: null },
        connector: "stripe_test",
        outcome: "succeeded",
        charged: true,
        failureClass: null,
        evidenceRef: "ev_aaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ],
    events: [
      {
        eventRef: "evt_aaaaaaaaaaaaaaaaaaaaaaaa",
        sequence: 1,
        occurredAt: "2026-08-09T12:00:00.000Z",
        kind: "create_requested",
        edge: "merchant_hyperswitch",
        replayable: true,
        attemptOrdinal: null,
        authority: "merchant_server",
        evidenceRef: "ev_bbbbbbbbbbbbbbbbbbbbbbbb",
      },
      {
        eventRef: "evt_bbbbbbbbbbbbbbbbbbbbbbbb",
        sequence: 2,
        occurredAt: "2026-08-09T12:00:01.000Z",
        kind: "tickets_issued",
        edge: null,
        replayable: false,
        attemptOrdinal: null,
        authority: "merchant_database",
        evidenceRef: "ev_cccccccccccccccccccccccc",
      },
    ],
    consequence: { chargeCount: 1, ticketCount: 1, ticketState: "issued" },
    replay: { eligible: true, basis: "retained_operation_order" },
    limitations: [
      recordedRunLimitationV1("METHOD_TYPE_NOT_RETAINED"),
      recordedRunLimitationV1("STATIC_FACTS_NOT_CAUSAL"),
    ],
  })
  const recordedAt = "2026-08-09T12:00:01.000Z"
  return {
    kind: "ready" as const,
    page: {
      schema: "onsale.recorded-runs.v1" as const,
      items: [summarizeRecordedRunV1(trace, recordedAt)],
      page: { limit: 20, nextCursor: null },
    },
    trace,
  }
}

describe("ONSALE recorded flow replay", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("keeps the workbench proof banner aligned with the selected flow class", () => {
    expect(replayProofBannerV1(multiAttemptSimulation)).toBe(
      "LOCAL SIMULATION · 2026-08-09 · READ-ONLY · NO LIVE REQUESTS",
    )
    expect(replayProofBannerV1(replayFlowCatalog[0])).toBe(
      "RECORDED SANDBOX · 2026-08-08 · READ-ONLY · NO LIVE REQUESTS",
    )
  })

  it("dwells on a reduced-motion arrival once and cancels stale replay advances", () => {
    vi.useFakeTimers()
    const advance = vi.fn()
    const controller = createReplayArrivalDwellControllerV1({
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      set: (callback, delayMs) => setTimeout(callback, delayMs),
    })

    expect(REDUCED_MOTION_REPLAY_ARRIVAL_DWELL_MS_V1).toBeGreaterThanOrEqual(
      600,
    )
    expect(REDUCED_MOTION_REPLAY_ARRIVAL_DWELL_MS_V1).toBeLessThanOrEqual(800)

    controller.arrive(
      "evt_reducedarrival01",
      REDUCED_MOTION_REPLAY_ARRIVAL_DWELL_MS_V1,
      advance,
    )
    controller.arrive(
      "evt_reducedarrival01",
      REDUCED_MOTION_REPLAY_ARRIVAL_DWELL_MS_V1,
      advance,
    )
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(REDUCED_MOTION_REPLAY_ARRIVAL_DWELL_MS_V1 - 1)
    expect(advance).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(advance).toHaveBeenCalledTimes(1)

    controller.arrive(
      "evt_reducedarrival01",
      REDUCED_MOTION_REPLAY_ARRIVAL_DWELL_MS_V1,
      advance,
    )
    expect(vi.getTimerCount()).toBe(0)
    expect(advance).toHaveBeenCalledTimes(1)

    controller.arrive(
      "evt_reducedarrival02",
      REDUCED_MOTION_REPLAY_ARRIVAL_DWELL_MS_V1,
      advance,
    )
    controller.clear()
    vi.runAllTimers()
    expect(advance).toHaveBeenCalledTimes(1)

    controller.arrive("evt_normalarrival01", 0, advance)
    expect(advance).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("keeps six evidence stories pinned to the recorded sandbox date", () => {
    expect(replayFlowCatalog).toHaveLength(6)
    expect(new Set(replayFlowCatalog.map((flow) => flow.id)).size).toBe(6)

    for (const flow of replayFlowCatalog) {
      expect(flow.observedAt).toBe("2026-08-08")
      expect(flow.matrixCaseIds.length).toBeGreaterThan(0)
      expect(flow.steps.length).toBeGreaterThan(1)
      for (const step of flow.steps)
        expect(step.evidenceRef.trim()).not.toBe("")
    }
  })

  it("isolates one deterministic multi-attempt simulation inside Story Lab", () => {
    expect(storyLabFlowCatalog.map((flow) => flow.id)).toEqual([
      "confirmed-payment",
      "action-required",
      "terminal-decline",
      "lost-response-recovery",
      "fixture-label-counterexample",
      "checkout-configuration-boundary",
    ])
    const methodConnectorLab = storyLabFlowCatalog[4]!
    expect(methodConnectorLab.proof).toBe("local_simulation")
    expect(methodConnectorLab.attempts).toEqual([
      expect.objectContaining({
        ordinal: 1,
        connector: "fauxpay",
        outcome: "technical_failure",
        charged: false,
      }),
      expect.objectContaining({
        ordinal: 2,
        connector: "stripe_test",
        outcome: "succeeded",
        charged: true,
      }),
    ])
    expect(methodConnectorLab.notice).toContain("LOCAL SIMULATION")

    for (const run of recordedRunCatalog) {
      expect(run.proof).toBe("live_sandbox_recorded")
      expect(run.attempts).toHaveLength(1)
      expect(run.attempts.map((attempt) => attempt.connector)).not.toContain(
        "fauxpay",
      )
    }
  })

  it("keeps success, action-required, and the HS-04 counterexample consequential", () => {
    const confirmed = replayFlowCatalog.find(
      (flow) => flow.id === "confirmed-payment",
    )
    const action = replayFlowCatalog.find(
      (flow) => flow.id === "action-required",
    )
    const counterexample = replayFlowCatalog.find(
      (flow) => flow.id === "fixture-label-counterexample",
    )

    expect(confirmed?.steps.at(-1)).toMatchObject({
      actor: "ticket",
      canonicalStatus: "succeeded",
      attemptStatus: "charged",
      attemptCount: 1,
    })
    expect(
      action?.steps.some((step) => step.canonicalStatus === "succeeded"),
    ).toBe(false)
    expect(action?.steps.some((step) => step.actor === "ticket")).toBe(false)
    expect(counterexample?.matrixCaseIds).toEqual(["HS-04"])
    expect(
      counterexample?.steps.some(
        (step) => step.canonicalStatus === "succeeded",
      ),
    ).toBe(true)
    expect(
      counterexample?.steps.some((step) => step.canonicalStatus === "failed"),
    ).toBe(false)
  })

  it("keeps the live four-ticket recovery separate from one-seat story fixtures", () => {
    expect(recordedRunCatalog).toHaveLength(4)
    expect(recordedRunCatalog[0]).toMatchObject({
      amountMinor: 73_840,
      itemCount: 4,
      ticketCount: 4,
      flowId: "live-widget-recovery",
    })
    const live = recordedReplayFlows[0]
    expect(
      live.steps.slice(0, 3).map((step) => step.amountReceivedMinor),
    ).toEqual([null, null, null])
    expect(live.steps.slice(3).map((step) => step.amountReceivedMinor)).toEqual(
      [73_840, 73_840],
    )
    expect(JSON.stringify(live)).not.toContain("order pointer")
  })

  it("gives every featured run a safe presenter-facing operational summary", () => {
    for (const run of recordedRunCatalog) {
      expect(run.observedTime).toBeNull()
      expect(run.currency).toBe("USD")
      expect(run.canonicalPaymentState.trim()).not.toBe("")
      expect(run.attemptState.trim()).not.toBe("")
      expect(run.evidenceSource.trim()).not.toBe("")
      expect(run.operationSemantics.trim()).not.toBe("")
      expect(run.attemptCount).toBeGreaterThanOrEqual(run.chargedAttemptCount)
      expect(run.attemptCount).toBe(run.attempts.length)
      expect(run.attempts.filter((attempt) => attempt.charged)).toHaveLength(
        run.chargedAttemptCount,
      )
    }

    const serialized = JSON.stringify(recordedRunCatalog)
    expect(serialized).not.toMatch(/(?:pay|attempt|ord)_[A-Za-z0-9]{8,}/i)
  })

  it("bounds Previous, Play, Pause, Next, and Restart deterministically", () => {
    let state = createReplayState("confirmed-payment")

    expect(state).toEqual({
      flowId: "confirmed-payment",
      stepIndex: 4,
      mode: "static",
    })

    state = transitionReplay(state, { type: "previous" })
    expect(state).toEqual({
      flowId: "confirmed-payment",
      stepIndex: 3,
      mode: "paused",
    })
    state = createReplayState("confirmed-payment")
    state = transitionReplay(state, { type: "play" })
    expect(state.stepIndex).toBe(0)
    expect(state.mode).toBe("playing")
    state = transitionReplay(state, { type: "pause" })
    expect(state.mode).toBe("paused")
    state = transitionReplay(state, { type: "next" })
    expect(state.stepIndex).toBe(1)
    state = transitionReplay(state, { type: "restart" })
    expect(state).toEqual({
      flowId: "confirmed-payment",
      stepIndex: 0,
      mode: "paused",
    })

    state = transitionReplay(state, { type: "seek", stepIndex: 2 })
    expect(state).toEqual({
      flowId: "confirmed-payment",
      stepIndex: 2,
      mode: "paused",
    })

    state = transitionReplay(state, { type: "complete" })
    expect(state.mode).toBe("complete")
    expect(state.stepIndex).toBe(4)

    state = transitionReplay(state, { type: "play" })
    for (let tick = 0; tick < 20; tick += 1) {
      state = transitionReplay(state, { type: "tick" })
    }
    expect(state).toEqual({
      flowId: "confirmed-payment",
      stepIndex: 4,
      mode: "complete",
    })
  })

  it("keeps historical selection still and authorizes only retained replay handoffs", () => {
    const flow = recordedReplayFlows[0]
    const merchant = { itemCount: 4, ticketCount: 4 }
    const selected = createReplayTraceSnapshot(
      flow,
      flow.steps.length - 1,
      "static",
      merchant,
      "replay-01",
    )
    expect(selected.playback).toEqual({
      kind: "static",
      reason: "historical_selection",
    })
    expect(
      renderToStaticMarkup(
        <PaymentTraceMapV1
          frame={selected.frame}
          playback={selected.playback}
        />,
      ),
    ).not.toContain('class="payment-trace-token"')

    const create = createReplayTraceSnapshot(
      flow,
      1,
      "playing",
      merchant,
      "replay-02",
    )
    expect(create.playback.kind).toBe("replay_event")
    expect(
      paymentTracePlaybackIsAuthorizedV1(create.frame, create.playback),
    ).toBe(true)
    expect(
      renderToStaticMarkup(
        <PaymentTraceMapV1 frame={create.frame} playback={create.playback} />,
      ),
    ).toContain('class="payment-trace-token"')

    const browserGap = createReplayTraceSnapshot(
      flow,
      2,
      "playing",
      merchant,
      "replay-02",
    )
    expect(browserGap).toMatchObject({
      playback: { kind: "static", reason: "catch_up" },
      motionTruth: "operation_link_missing",
    })
  })

  it("replays the local two-attempt circuit without revealing received money early", () => {
    const retrieveIndex = multiAttemptSimulation.steps.findIndex(
      (step) => step.id === "sim-retrieve-confirms",
    )
    expect(retrieveIndex).toBeGreaterThan(0)
    expect(
      multiAttemptSimulation.steps
        .slice(0, retrieveIndex)
        .every((step) => step.amountReceivedMinor === null),
    ).toBe(true)

    const firstAttemptRequest = multiAttemptSimulation.steps.findIndex(
      (step) => step.id === "sim-attempt-one-sent",
    )
    const snapshot = createReplayTraceSnapshot(
      multiAttemptSimulation,
      firstAttemptRequest,
      "playing",
      { itemCount: 1, ticketCount: 1 },
      "simulation-01",
    )
    expect(snapshot.playback.kind).toBe("replay_event")
    expect(
      paymentTracePlaybackIsAuthorizedV1(snapshot.frame, snapshot.playback),
    ).toBe(true)
    expect(snapshot.frame.orchestration.selectedMethod?.family).toBe("card")
    expect(snapshot.frame.orchestration.attempts[0]?.connector).toBe("fauxpay")
  })

  it("renders the read-only proof boundary and reusable V2 testids without network I/O", () => {
    const fetchMock = vi.fn(() => {
      throw new Error("recorded replay must not make live requests")
    })
    vi.stubGlobal("fetch", fetchMock)

    const markup = renderToStaticMarkup(
      <FlowsGallery initialSeed={durableFlowsSeed()} />,
    )

    expect(markup).toContain("RECORDED SANDBOX · 2026-08-09")
    expect(markup).toContain("READ-ONLY · NO LIVE REQUESTS")
    expect(markup).toContain('data-testid="flows-replay"')
    expect(markup).toContain('data-testid="replay-previous"')
    expect(markup).toContain('data-testid="replay-play"')
    expect(markup).toContain('data-testid="replay-next"')
    expect(markup).toContain('data-testid="replay-restart"')
    expect(markup).toContain('data-layout="wide"')
    expect(markup).toContain('data-mobile-layout="stack"')
    expect(markup).toContain('data-containment="trace"')
    expect(markup).toContain('data-contained-scroll="operations"')
    expect(markup).toContain("1 seat · 1 ticket issued")
    expect(markup).toContain("SANITIZED OPERATION LOG")
    expect(markup).toContain("CANONICAL PAYMENT")
    expect(markup).toContain("12:00 UTC")
    expect(markup).toContain("REPLAY TRACE")
    expect(markup).toContain("ATTEMPT CHAIN")
    expect(markup).toContain("NO SECOND ATTEMPT OBSERVED")
    expect(markup).toContain("RECORDED MULTI-ATTEMPT RUNS")
    expect(markup).not.toContain("AUTH RATE")
    expect(markup).toContain('data-replay-mode="static"')
    expect(markup).not.toContain('class="payment-trace-token"')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("contains no secret-shaped values, raw card material, or write controls", () => {
    const serialized = JSON.stringify(replayFlowCatalog)
    expect(serialized).not.toMatch(
      /\b(?:sk|pk)_(?:live|test|sandbox)_[A-Za-z0-9_-]+\b/i,
    )
    expect(serialized).not.toMatch(/client[_ -]?secret|api[_ -]?key\s*[:=]/i)
    expect(serialized).not.toMatch(/\b\d{13,19}\b/)

    const markup = renderToStaticMarkup(<FlowsGallery />)
    expect(markup).toContain("Loading runs")
    expect(markup).toContain("Awaiting retained payment evidence")
    expect(markup).toContain('data-testid="flows-run-skeleton"')
    expect(markup).not.toContain("The recorded ledger has not been loaded")
    expect(markup).not.toContain("RETRY DURABLE LEDGER")
    expect(markup).not.toContain("No retained run is selected")
    expect(markup).not.toMatch(/<form|type="submit"|method="post"/i)
  })
})
