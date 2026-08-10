"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
} from "react"

import PaymentTraceMapV1, {
  type PaymentTraceAttemptV1,
  type PaymentTraceHandoffV1,
  type PaymentTraceNodeIdV1,
} from "../../src/PaymentTraceMap"
import {
  parseRecordedRunRefV1,
  type RecordedRunRefV1,
  type RecordedRunSummaryV1,
} from "../../src/onsale/contracts/recorded-run-v1"
import { fetchCurrentRecordedRunV1 } from "../../src/onsale/flows/recorded-runs-client-v1"
import { subscribeCompletedRunsV1 } from "../../src/onsale/flows/completed-run-signal-v1"
import {
  useRecordedRunsV1,
} from "../../src/onsale/flows/use-recorded-runs-v1"
import type { RecordedRunsSeedV1 } from "../../src/onsale/flows/recorded-runs-client-v1"
import styles from "./flows.module.css"

import {
  createReplayStateForFlow,
  createReplayTraceSnapshot,
  replayFlowById,
  replayFlowCatalog,
  storyLabFlowCatalog,
  transitionReplayForFlow,
  type ReplayEvidenceClass,
  type ReplayFlow,
  type ReplayMerchantFacts,
  type ReplayProof,
} from "./replay"
import { projectRecordedRunV1 } from "./recorded-run-adapter-v1"

const proofLabels = {
  live_sandbox_recorded: "RECORDED SANDBOX",
  source_determined: "PINNED SOURCE",
  merchant_rule: "ONSALE RULE",
  configuration_block: "HISTORICAL BLOCK",
  local_simulation: "LOCAL SIMULATION",
} as const satisfies Record<ReplayEvidenceClass, string>

export function replayProofBannerV1(
  flow: Pick<ReplayFlow, "proof" | "observedAt">,
): string {
  return `${proofLabels[flow.proof]} · ${flow.observedAt} · READ-ONLY · NO LIVE REQUESTS`
}

const actorLabels = {
  buyer: "BUYER",
  merchant: "ONSALE",
  hyperswitch: "HYPERSWITCH",
  processor: "CONNECTOR",
  reconcile: "RETRIEVE",
  ticket: "TICKETS",
} as const

const evidenceLabFlows = replayFlowCatalog.filter(
  (flow) => !storyLabFlowCatalog.some((story) => story.id === flow.id),
)

const scenarioGuide: Record<string, {
  readonly label: string
  readonly instrument: string
  readonly significance: string
}> = {
  "confirmed-payment": {
    label: "DUMMY SUCCESS",
    instrument:
      "OFFICIAL PROVIDER TEST FIXTURE · ENTER ONLY IN UNIFIED CHECKOUT",
    significance:
      "The card number is never copied into this workbench. The returned provider state and same-payment retrieve remain authoritative.",
  },
  "action-required": {
    label: "PROVIDER ACTION",
    instrument: "KLARNA · OFFICIAL PROVIDER-OWNED ACTION SURFACE",
    significance:
      "This story has no card fixture. Approval, rejection, and terminal return stay unproven until a retained provider result exists.",
  },
  "terminal-decline": {
    label: "HARD DECLINE",
    instrument: "OFFICIAL GENERIC-DECLINE FIXTURE · PROVIDER FIELD ONLY",
    significance:
      "A fixture requests the scenario; it does not decide the UI. ONSALE follows the returned attempt and does not cascade a hard decline.",
  },
  "lost-response-recovery": {
    label: "SUCCESS + TRANSPORT LOSS",
    instrument: "APPROVAL FIXTURE + INDUCED RESPONSE LOSS",
    significance:
      "The transport fault creates uncertainty. Recovery retrieves the same payment instead of submitting a second confirmation.",
  },
  "multi-attempt-recovery-simulation": {
    label: "LOCAL RETRY LAB",
    instrument: "NO CARD NUMBER · DETERMINISTIC FAUXPAY → STRIPETEST FIXTURE",
    significance:
      "This is the only two-attempt story. It demonstrates the rail and attempt inspector without claiming that the dated sandbox account routed across connectors.",
  },
}

type WorkspaceView = "runs" | "stories"

const LOADING_RECORDED_RUNS_SEED_V1: RecordedRunsSeedV1 = {
  kind: "loading",
}

export const REDUCED_MOTION_REPLAY_ARRIVAL_DWELL_MS_V1 = 700

interface ReplayArrivalTimerV1 {
  readonly set: (callback: () => void, delayMs: number) => unknown
  readonly clear: (handle: unknown) => void
}

export interface ReplayArrivalDwellControllerV1 {
  readonly arrive: (
    eventId: string,
    delayMs: number,
    advance: () => void,
  ) => boolean
  readonly clear: () => void
}

export function createReplayArrivalDwellControllerV1(
  timer: ReplayArrivalTimerV1,
): ReplayArrivalDwellControllerV1 {
  let pendingEventId: string | null = null
  let pendingTimer: unknown = null

  const clear = () => {
    if (pendingTimer !== null) timer.clear(pendingTimer)
    pendingTimer = null
    pendingEventId = null
  }

  return {
    arrive(eventId, delayMs, advance) {
      if (pendingEventId === eventId) return false
      clear()
      pendingEventId = eventId
      if (delayMs <= 0) {
        advance()
        return true
      }
      pendingTimer = timer.set(() => {
        pendingTimer = null
        if (pendingEventId !== eventId) return
        advance()
      }, delayMs)
      return true
    },
    clear,
  }
}

function formatMoney(amountMinor: number | null, currency = "USD"): string {
  if (amountMinor === null) return "NOT OBSERVED"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amountMinor / 100)
}

function displayValue(value: string | number | null): string {
  if (value === null || value === "") return "NOT OBSERVED"
  return String(value).replace(/_/gu, " ").toUpperCase()
}

function EvidenceBadge({
  proof,
}: {
  proof: ReplayProof | ReplayEvidenceClass
}) {
  return (
    <span className={styles["flows-evidence-badge"]} data-proof-class={proof}>
      {proofLabels[proof]}
    </span>
  )
}

function storyMerchantFacts(flow: ReplayFlow): ReplayMerchantFacts {
  return {
    itemCount: 1,
    ticketCount: flow.proof === "local_simulation" ? 1 : 0,
  }
}

function RunRow({
  run,
  index,
  selected,
  onSelect,
}: {
  readonly run: RecordedRunSummaryV1
  readonly index: number
  readonly selected: boolean
  readonly onSelect: () => void
}) {
  return (
    <button
      aria-label={`${run.runRef}, ${displayValue(run.outcome)}, ${formatMoney(run.amountDueMinor, run.currency)}`}
      aria-pressed={selected}
      className={styles["ops-run-row"]}
      data-outcome={run.outcome}
      onClick={onSelect}
      type="button"
    >
      <span className={styles["ops-run-index"]}>
        TRACE {String(index + 1).padStart(2, "0")} · {run.runRef}
      </span>
      <span className={styles["ops-run-outcome"]}>
        {displayValue(run.outcome)}
      </span>
      <strong>{formatMoney(run.amountDueMinor, run.currency)}</strong>
      <small className={styles["ops-run-id"]}>{run.recordedAt.slice(0, 16).replace("T", " · ")} UTC</small>
      <div className={styles["ops-run-route"]}>
        <span>
          <i>METHOD</i>
          {run.selectedMethod?.type ?? run.selectedMethod?.family ?? "not retained"}
        </span>
        <span>
          <i>OBSERVED CONNECTOR</i>
          {run.observedConnectors.join(" → ") || "not retained"}
        </span>
      </div>
      <small>
        {run.itemCount} seat{run.itemCount === 1 ? "" : "s"} · {run.ticketCount}{" "}
        ticket{run.ticketCount === 1 ? "" : "s"} issued
      </small>
      <small>
        {run.attemptCount} ATTEMPT · {run.chargeCount} CHARGED
      </small>
    </button>
  )
}

function AttemptChain({
  attempts,
  flow,
}: {
  readonly attempts: readonly PaymentTraceAttemptV1[]
  readonly flow: ReplayFlow
}) {
  return (
    <section
      aria-label="Hyperswitch attempt chain"
      className={styles["ops-attempt-chain"]}
      id="flows-attempt-chain"
      tabIndex={-1}
    >
      <header>
        <div>
          <span>ATTEMPT CHAIN</span>
          <h3>Method stays separate from connector routing</h3>
        </div>
        <small>
          {attempts.length} RETAINED ATTEMPT{attempts.length === 1 ? "" : "S"}
        </small>
      </header>
      {attempts.length === 0 ? (
        <p className={styles["ops-attempt-empty"]}>
          NO CONNECTOR ATTEMPT OBSERVED AT THIS STEP
        </p>
      ) : (
        <ol>
          {attempts.map((attempt) => {
            const receiptAttempt = flow.attempts.find(
              (candidate) => candidate.ordinal === attempt.ordinal,
            )
            return (
              <li data-outcome={attempt.outcome} key={attempt.ordinal}>
                <span className={styles["ops-attempt-ordinal"]}>
                  ATTEMPT {String(attempt.ordinal).padStart(2, "0")}
                </span>
                <strong>{displayValue(attempt.outcome)}</strong>
                <dl>
                  <div>
                    <dt>METHOD</dt>
                    <dd>
                      {displayValue(attempt.methodAtAttempt?.family ?? null)}
                    </dd>
                  </div>
                  <div>
                    <dt>CONNECTOR</dt>
                    <dd>{displayValue(attempt.connector)}</dd>
                  </div>
                  <div>
                    <dt>MONEY</dt>
                    <dd>{attempt.charged ? "CHARGED" : "NOT CHARGED"}</dd>
                  </div>
                  <div>
                    <dt>RETRY RELATION</dt>
                    <dd>{displayValue(attempt.retryKind)}</dd>
                  </div>
                </dl>
                <small>
                  {receiptAttempt?.evidenceRef ??
                    `PROOF · ${displayValue(attempt.proof)}`}
                </small>
              </li>
            )
          })}
        </ol>
      )}
      {attempts.length === 1 && (
        <p className={styles["ops-no-second-attempt"]}>
          NO SECOND ATTEMPT OBSERVED
        </p>
      )}
    </section>
  )
}

export default function FlowsGallery({
  initialSeed = LOADING_RECORDED_RUNS_SEED_V1,
  requestedRun = null,
}: {
  readonly initialSeed?: RecordedRunsSeedV1
  readonly requestedRun?: string | null
}) {
  let requestedRunRef: RecordedRunRefV1 | null = null
  let requestedRunInvalid = false
  if (requestedRun !== null) {
    try {
      requestedRunRef = parseRecordedRunRefV1(requestedRun, "$.run")
    } catch {
      requestedRunInvalid = true
    }
  }
  const [view, setView] = useState<WorkspaceView>("runs")
  const [traceLayout, setTraceLayout] = useState<"rail" | "wide">("wide")
  const [reducedMotion, setReducedMotion] = useState(false)
  const [selectedStoryId, setSelectedStoryId] = useState(
    storyLabFlowCatalog[0]!.id,
  )
  const [selectedNode, setSelectedNode] = useState<PaymentTraceNodeIdV1 | null>(
    null,
  )
  const [replaySession, setReplaySession] = useState(0)
  const arrivalDwellRef = useRef<ReplayArrivalDwellControllerV1 | null>(null)
  const recordedRuns = useRecordedRunsV1({
    initialSeed,
    initialExactRunRef: requestedRunRef,
  })
  const selectedProjection = useMemo(
    () => requestedRunInvalid || recordedRuns.state.selected === null
      ? null
      : projectRecordedRunV1(
          recordedRuns.state.selected.summary,
          recordedRuns.state.selected.trace,
        ),
    [recordedRuns.state.selected, requestedRunInvalid],
  )
  const runtimeFlowsRef = useRef(new Map<string, ReplayFlow>())
  if (selectedProjection !== null) {
    runtimeFlowsRef.current.set(selectedProjection.flow.id, selectedProjection.flow)
  }
  const [state, dispatch] = useReducer(
    (current, action) => {
      const flowId = action.type === "select_flow" ? action.flowId : current.flowId
      const runtimeFlow = runtimeFlowsRef.current.get(flowId) ?? replayFlowById(flowId)
      return transitionReplayForFlow(runtimeFlow, current, action)
    },
    selectedProjection?.flow ?? storyLabFlowCatalog[0]!,
    createReplayStateForFlow,
  )

  const flow = runtimeFlowsRef.current.get(state.flowId) ?? replayFlowById(state.flowId)
  const step = flow.steps[state.stepIndex]!
  const selectedRun = selectedProjection?.run ?? null
  const visibleRecordedRuns = requestedRunInvalid
    ? []
    : recordedRuns.state.items
  const recordedRunMessage = requestedRunInvalid
    ? "The run reference is invalid. No other run has been substituted."
    : recordedRuns.state.message
  const runSelected =
    view === "runs" && selectedRun !== null && selectedRun.flowId === flow.id
  const merchantFacts = runSelected
    ? { itemCount: selectedRun.itemCount, ticketCount: selectedRun.ticketCount }
    : storyMerchantFacts(flow)
  const replayId = `${flow.id}-session-${replaySession}`
  const snapshot = useMemo(
    () =>
      createReplayTraceSnapshot(
        flow,
        state.stepIndex,
        state.mode,
        merchantFacts,
        replayId,
      ),
    [
      flow,
      merchantFacts.itemCount,
      merchantFacts.ticketCount,
      replayId,
      state.mode,
      state.stepIndex,
    ],
  )
  const finalStep = state.stepIndex === flow.steps.length - 1

  useEffect(() => {
    let active = true
    if (requestedRunInvalid) return () => { active = false }
    if (requestedRunRef !== null) {
      void recordedRuns.resolveExactRun(requestedRunRef)
      return () => { active = false }
    }
    void recordedRuns.reload().then(async () => {
      if (!active) return
      try {
        const current = await fetchCurrentRecordedRunV1()
        if (active && current.terminal && current.runRef !== null) {
          await recordedRuns.refreshCompletedRun(current.runRef)
        }
      } catch {
        // A missing current-order pointer must not replace the durable list.
      }
    })
    const unsubscribe = subscribeCompletedRunsV1((runRef) => {
      void recordedRuns.refreshCompletedRun(runRef)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [
    recordedRuns.refreshCompletedRun,
    recordedRuns.reload,
    recordedRuns.resolveExactRun,
    requestedRunInvalid,
    requestedRunRef,
  ])

  useEffect(() => {
    if (
      view === "runs" &&
      selectedProjection !== null &&
      state.flowId !== selectedProjection.flow.id
    ) {
      dispatch({ type: "select_flow", flowId: selectedProjection.flow.id })
    }
  }, [selectedProjection, state.flowId, view])

  useEffect(() => {
    const search = new URLSearchParams(window.location.search)
    if (search.has("run")) return
    const story = search.get("story")
    const candidate = [...storyLabFlowCatalog, ...evidenceLabFlows].find(
      (item) => item.id === story,
    )
    if (!candidate) return
    setView("stories")
    setSelectedStoryId(candidate.id)
    dispatch({ type: "select_flow", flowId: candidate.id })
  }, [])

  useEffect(() => {
    const compact = window.matchMedia("(max-width: 720px)")
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)")
    const update = () => {
      setTraceLayout(compact.matches ? "rail" : "wide")
      setReducedMotion(reduce.matches)
    }
    update()
    compact.addEventListener("change", update)
    reduce.addEventListener("change", update)
    return () => {
      compact.removeEventListener("change", update)
      reduce.removeEventListener("change", update)
    }
  }, [])

  useEffect(() => {
    if (state.mode !== "playing" || snapshot.motionTruth === "authorized")
      return
    const timer = window.setTimeout(() => dispatch({ type: "tick" }), 880)
    return () => window.clearTimeout(timer)
  }, [snapshot.motionTruth, state.mode, state.stepIndex])

  const clearArrivalDwell = useCallback(() => {
    arrivalDwellRef.current?.clear()
  }, [])

  useEffect(
    () => clearArrivalDwell,
    [
      clearArrivalDwell,
      replaySession,
      state.flowId,
      state.mode,
      state.stepIndex,
    ],
  )

  const handleArrive = useCallback(
    (handoff: PaymentTraceHandoffV1) => {
      if (
        state.mode === "playing" &&
        snapshot.playback.kind === "replay_event" &&
        snapshot.playback.handoff.eventId === handoff.eventId
      ) {
        if (arrivalDwellRef.current === null) {
          arrivalDwellRef.current = createReplayArrivalDwellControllerV1({
            clear: (handle) => window.clearTimeout(handle as number),
            set: (callback, delayMs) => window.setTimeout(callback, delayMs),
          })
        }
        arrivalDwellRef.current.arrive(
          handoff.eventId,
          reducedMotion ? REDUCED_MOTION_REPLAY_ARRIVAL_DWELL_MS_V1 : 0,
          () => dispatch({ type: "tick" }),
        )
      }
    },
    [reducedMotion, snapshot.playback, state.mode],
  )

  const chooseRun = (run: RecordedRunSummaryV1) => {
    setView("runs")
    setSelectedNode(null)
    void recordedRuns.selectRun(run.runRef)
  }

  const chooseStory = (candidate: ReplayFlow) => {
    setView("stories")
    setSelectedStoryId(candidate.id)
    setSelectedNode(null)
    dispatch({ type: "select_flow", flowId: candidate.id })
  }

  const showPreviousRuns = () => {
    setView("runs")
    if (selectedProjection !== null) {
      dispatch({ type: "select_flow", flowId: selectedProjection.flow.id })
    }
  }

  const showStoryLab = () => {
    setView("stories")
    dispatch({ type: "select_flow", flowId: selectedStoryId })
  }

  const togglePlayback = () => {
    if (state.mode === "playing") {
      dispatch({ type: "pause" })
      return
    }
    setReplaySession((value) => value + 1)
    dispatch({ type: "play" })
  }

  const restartReplay = () => {
    setReplaySession((value) => value + 1)
    dispatch({ type: "restart" })
  }

  const attempts = snapshot.frame.orchestration.attempts
  const scenario = scenarioGuide[flow.id]
  const narrative = runSelected
    ? {
        problem: selectedRun.problem,
        role: selectedRun.hyperswitchRole,
        importance: selectedRun.importance,
        limitation: selectedRun.limitation,
      }
    : {
        problem: flow.problem,
        role: flow.productRule,
        importance: flow.notice,
        limitation: flow.limitation,
      }
  const selectedCurrency = runSelected ? selectedRun.currency : "USD"
  const amount = runSelected
    ? formatMoney(selectedRun.amountMinor, selectedRun.currency)
    : formatMoney(flow.steps.at(-1)?.amountReceivedMinor ?? null)
  const finalMethod = runSelected
    ? selectedRun.method
    : (flow.attempts.find((attempt) => attempt.method)?.method ??
      "NOT OBSERVED")
  const finalConnectors = runSelected
    ? (selectedRun.connector ?? "NOT RETAINED")
    : [
        ...new Set(
          flow.attempts.flatMap((attempt) =>
            attempt.connector ? [attempt.connector] : [],
          ),
        ),
      ].join(" → ") || "NOT OBSERVED"
  const traceStatus =
    state.mode === "static"
      ? "RECORDED SNAPSHOT · NO SIGNAL MOVING"
      : state.mode === "complete"
        ? "REPLAY COMPLETE"
        : state.mode === "paused"
          ? "TRACE PAUSED"
          : snapshot.motionTruth === "authorized"
            ? "RETAINED HANDOFF IN MOTION"
            : "EVIDENCE GAP · MOTION WITHHELD"
  const playLabel =
    state.mode === "playing"
      ? "PAUSE TRACE"
      : state.mode === "paused"
        ? "RESUME TRACE"
        : "REPLAY TRACE"

  return (
    <div className={styles["flows-shell"]}>
      <a className={styles["skip-link"]} href="#flows-replay">
        Skip to payment trace
      </a>
      <p aria-atomic="true" aria-live="polite" className={styles["sr-only"]}>
        {flow.label}, step {state.stepIndex + 1} of {flow.steps.length}:{" "}
        {step.title}
      </p>

      <header
        className={`${styles["onsale-header"]} ${styles["flows-header"]}`}
      >
        <a
          aria-label="ONSALE ticket purchase"
          className={styles["onsale-wordmark"]}
          href="/"
        >
          ONSALE
        </a>
        <span className={styles["onsale-divider"]} />
        <span className={styles["flows-surface-label"]}>FLOW WORKBENCH</span>
        <span className={styles["onsale-header-spacer"]} />
        <span className={styles["proof-pill"]} data-testid="flows-proof">
          {replayProofBannerV1(flow)}
        </span>
        <a className={styles["flows-header-link"]} href="/">
          ← RETURN TO EVENT
        </a>
      </header>

      <main
        className={styles["ops-page"]}
        data-testid="flows-replay"
        id="flows-replay"
      >
        <section className={styles["ops-intro"]}>
          <div>
            <span>HYPERSWITCH · TRACEABILITY WORKBENCH</span>
            <h1>Previous runs, exact attempts, causal replay.</h1>
            <p>
              Inspect retained payment truth first. Motion starts only after
              Replay and only across operation-linked handoffs.
            </p>
          </div>
          <div
            aria-label="Payment operations views"
            className={styles["ops-view-switch"]}
            role="group"
          >
            <button
              aria-pressed={view === "runs"}
              onClick={showPreviousRuns}
              type="button"
            >
              <strong>PREVIOUS RUNS</strong>
              <small>Recorded receipts</small>
            </button>
            <button
              aria-pressed={view === "stories"}
              onClick={showStoryLab}
              type="button"
            >
              <strong>STORY LAB</strong>
              <small>Six payment decisions</small>
            </button>
          </div>
        </section>

        <section
          aria-label="Curated receipt coverage"
          className={styles["ops-metrics"]}
        >
          <div>
            <span>RECORDED RUNS</span>
            <strong>{visibleRecordedRuns.length}</strong>
            <small>sanitized receipts</small>
          </div>
          <div>
            <span>OUTCOME COVERAGE</span>
            <strong>
              {new Set(visibleRecordedRuns.map((run) => run.outcome)).size}
            </strong>
            <small>
              {[...new Set(visibleRecordedRuns.map((run) => run.outcome))]
                .map((outcome) => outcome.replace(/_/gu, " "))
                .join(" · ") || "none retained"}
            </small>
          </div>
          <div>
            <span>RECORDED MULTI-ATTEMPT RUNS</span>
            <strong>
              {visibleRecordedRuns.filter((run) => run.attemptCount > 1).length}
            </strong>
            <small>no retry claim in receipts</small>
          </div>
          <div>
            <span>LOCAL RETRY LAB</span>
            <strong>1</strong>
            <small>deterministic · clearly labeled</small>
          </div>
        </section>

        <div className={styles["ops-workspace"]}>
          <aside
            aria-label={
              view === "runs" ? "Previous recorded runs" : "Payment story lab"
            }
            className={styles["ops-ledger"]}
            data-mobile-layout="stack"
            data-testid="flows-ledger"
          >
            <header>
              <span>{view === "runs" ? "PREVIOUS RUNS" : "STORY LAB"}</span>
              <small>
                {view === "runs"
                  ? "SELECT TO INSPECT · REPLAY IS SEPARATE"
                  : "WHY EACH PAYMENT STATE MATTERS"}
              </small>
            </header>
            <div className={styles["ops-ledger-list"]}>
              {view === "runs"
                ? visibleRecordedRuns.map((run, index) => (
                    <RunRow
                      index={index}
                      key={run.runRef}
                      onSelect={() => chooseRun(run)}
                      run={run}
                      selected={
                        run.runRef === recordedRuns.state.selected?.summary.runRef
                      }
                    />
                  ))
                : storyLabFlowCatalog.map((candidate, index) => (
                    <button
                      aria-pressed={candidate.id === flow.id}
                      className={styles["ops-story-row"]}
                      data-proof={candidate.proof}
                      data-testid={`flow-option-${candidate.id}`}
                      key={candidate.id}
                      onClick={() => chooseStory(candidate)}
                      type="button"
                    >
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <strong>{candidate.label}</strong>
                      <small>{candidate.kicker}</small>
                    </button>
                  ))}
            </div>
            {view === "runs" && recordedRunMessage !== null && (
              <p className={styles["ops-attempt-empty"]} role="status">
                {recordedRunMessage}
              </p>
            )}
            {view === "runs" &&
              requestedRunRef === null &&
              recordedRuns.state.status === "loading" && (
              <div className={styles["ops-run-skeletons"]} role="status">
                <span>
                  <strong>Loading runs</strong>
                  <small>Awaiting retained payment evidence</small>
                </span>
                {[0, 1, 2].map((index) => (
                  <div
                    aria-hidden="true"
                    data-testid="flows-run-skeleton"
                    key={index}
                  >
                    <i />
                    <i />
                    <i />
                  </div>
                ))}
              </div>
            )}
            {view === "runs" &&
              requestedRunRef !== null &&
              recordedRuns.state.status === "loading" && (
              <p className={styles["ops-attempt-empty"]} role="status">
                {`RESOLVING ${requestedRunRef}`}
              </p>
            )}
            {view === "runs" &&
              requestedRun === null &&
              recordedRuns.state.status !== "loading" &&
              visibleRecordedRuns.length === 0 && (
              <button
                className={styles["ops-ledger-action"]}
                onClick={() => void recordedRuns.reload()}
                type="button"
              >
                RETRY DURABLE LEDGER
              </button>
            )}
            {view === "runs" && recordedRuns.state.nextCursor !== null && (
              <button
                className={styles["ops-ledger-action"]}
                disabled={recordedRuns.state.loadingMore}
                onClick={() => void recordedRuns.loadMore()}
                type="button"
              >
                {recordedRuns.state.loadingMore ? "LOADING" : "LOAD EARLIER RUNS"}
              </button>
            )}
            {view === "stories" && evidenceLabFlows.length > 0 && (
              <details className={styles["ops-evidence-lab"]}>
                <summary>EVIDENCE BOUNDARIES · {evidenceLabFlows.length}</summary>
                {evidenceLabFlows.map((candidate) => (
                  <button
                    key={candidate.id}
                    onClick={() => chooseStory(candidate)}
                    type="button"
                  >
                    <strong>{candidate.label}</strong>
                    <small>{candidate.kicker}</small>
                  </button>
                ))}
              </details>
            )}
          </aside>

          <article className={styles["ops-detail"]}>
            {view === "runs" && selectedRun === null ? (
              <header className={styles["ops-run-header"]}>
                <div>
                  <span>DURABLE RECORDED RUNS</span>
                  <h2>
                    {requestedRunInvalid || recordedRuns.state.status === "not_found"
                      ? "Requested run is not available"
                      : requestedRunRef !== null && recordedRuns.state.status === "loading"
                        ? "Resolving the requested retained run"
                        : recordedRuns.state.status === "loading"
                          ? "Loading retained payment evidence"
                          : "No retained run is selected"}
                  </h2>
                  <small className={styles["ops-run-proof"]}>
                    {recordedRunMessage ??
                      "Select a retained run to inspect its sanitized trace."}
                  </small>
                </div>
              </header>
            ) : (
            <>
            <header className={styles["ops-run-header"]}>
              <div>
                <span>
                  {runSelected
                    ? `${selectedRun.id} · ${displayValue(selectedRun.outcome)}`
                    : `STORY LAB · ${displayValue(flow.proof)}`}
                </span>
                <h2>{flow.label}</h2>
                <small className={styles["ops-run-proof"]}>
                  {runSelected ? selectedRun.proofLabel : flow.kicker} ·{" "}
                  {flow.observedAt}
                </small>
              </div>
              <EvidenceBadge proof={flow.proof} />
              <dl>
                <div>
                  <dt>AMOUNT / CURRENCY</dt>
                  <dd>{amount} · {selectedCurrency}</dd>
                </div>
                <div>
                  <dt>RECORDED AT</dt>
                  <dd>
                    {runSelected
                      ? `${selectedRun.observedAt} · ${selectedRun.observedTime ?? "TIME NOT RETAINED"}`
                      : `${flow.observedAt} · ${
                          flow.proof === "local_simulation"
                            ? "LOCAL FIXTURE"
                            : "RECORDED"
                        }`}
                  </dd>
                </div>
                <div>
                  <dt>SAFE RUN ALIAS</dt>
                  <dd>
                    {runSelected ? selectedRun.id : flow.id.toUpperCase()}
                  </dd>
                </div>
                <div>
                  <dt>ORDER ID</dt>
                  <dd>
                    {runSelected ? "NOT RETAINED IN RECEIPT" : "NOT APPLICABLE"}
                  </dd>
                </div>
                <div>
                  <dt>ITEMS / TICKETS</dt>
                  <dd>
                    {merchantFacts.itemCount} / {merchantFacts.ticketCount}
                  </dd>
                </div>
                <div>
                  <dt>CANONICAL PAYMENT</dt>
                  <dd>
                    {displayValue(
                      runSelected
                        ? selectedRun.canonicalPaymentState
                        : (flow.steps.at(-1)?.canonicalStatus ?? null),
                    )}
                  </dd>
                </div>
                <div>
                  <dt>SELECTED METHOD</dt>
                  <dd>{displayValue(finalMethod)}</dd>
                </div>
                <div>
                  <dt>OBSERVED CONNECTOR</dt>
                  <dd>{displayValue(finalConnectors)}</dd>
                </div>
                <div>
                  <dt>ATTEMPTS</dt>
                  <dd>
                    {runSelected
                      ? selectedRun.attemptCount
                      : flow.attempts.length}
                  </dd>
                </div>
                <div>
                  <dt>CHARGED ATTEMPTS</dt>
                  <dd>
                    {runSelected
                      ? selectedRun.chargedAttemptCount
                      : flow.attempts.filter((attempt) => attempt.charged)
                          .length}
                  </dd>
                </div>
              </dl>
            </header>

            {runSelected && (
              <section
                aria-label="Run operation semantics"
                className={styles["ops-operation-contract"]}
              >
                <span>OPERATION SEMANTICS</span>
                <strong>{selectedRun.operationSemantics}</strong>
                <small>EVIDENCE SOURCE · {selectedRun.evidenceSource}</small>
              </section>
            )}

            <div className={styles["ops-narrative"]}>
              <section>
                <span>THE PROBLEM</span>
                <p>{narrative.problem}</p>
              </section>
              <section>
                <span>HYPERSWITCH ROLE</span>
                <p>{narrative.role}</p>
              </section>
              <section>
                <span>WHY IT MATTERS</span>
                <p>{narrative.importance}</p>
              </section>
            </div>

            <section
              aria-label="Causal payment trace"
              className={styles["ops-trace"]}
              data-replay-mode={state.mode}
            >
              <div className={styles["ops-trace-heading"]}>
                <div>
                  <span>PAYMENT TRACE · RETAINED CAUSALITY</span>
                  <strong>{step.title}</strong>
                  <small className={styles["ops-signal-state"]}>
                    <i aria-hidden="true" />
                    {traceStatus}
                  </small>
                </div>
                <div className={styles["ops-trace-actions"]}>
                  <output data-testid="replay-step-count">
                    STEP {state.stepIndex + 1} / {flow.steps.length}
                  </output>
                  <button
                    data-testid="replay-play"
                    onClick={togglePlayback}
                    type="button"
                  >
                    {playLabel}
                  </button>
                </div>
              </div>

              <div
                className={styles["ops-map-stage"]}
                data-containment="trace"
                data-testid="trace-viewport"
              >
                <div aria-hidden="true" className={styles["ops-map-legend"]}>
                  <span>
                    <i data-tone="signal" />
                    AMBER HANDOFF
                  </span>
                  <span>
                    <i data-tone="observed" />
                    OBSERVED PATH
                  </span>
                  <span>
                    <i data-tone="possible" />
                    POSSIBLE ONLY
                  </span>
                </div>
                <PaymentTraceMapV1
                  attemptInspectorId="flows-attempt-chain"
                  className={styles["ops-trace-map"]}
                  frame={snapshot.frame}
                  layout={traceLayout}
                  nodeInspectorId="flows-step-inspector"
                  onArrive={handleArrive}
                  onInspectAttempts={() =>
                    document.getElementById("flows-attempt-chain")?.focus()
                  }
                  onSelectNode={setSelectedNode}
                  playback={snapshot.playback}
                  reducedMotion={reducedMotion}
                  selectedNode={selectedNode}
                />
              </div>

              <ol
                aria-label="Trace step inspector"
                className={styles["ops-step-sequence"]}
                style={
                  {
                    "--step-columns": Math.min(flow.steps.length, 6),
                  } as CSSProperties
                }
              >
                {flow.steps.map((candidate, index) => {
                  const visualState =
                    state.mode === "static" ||
                    state.mode === "complete" ||
                    index < state.stepIndex
                      ? "complete"
                      : index === state.stepIndex
                        ? "current"
                        : "future"
                  return (
                    <li key={candidate.id}>
                      <button
                        aria-current={
                          index === state.stepIndex ? "step" : undefined
                        }
                        data-state={visualState}
                        onClick={() =>
                          dispatch({ type: "seek", stepIndex: index })
                        }
                        type="button"
                      >
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        <strong>{candidate.title}</strong>
                        <small>
                          {actorLabels[candidate.actor]} ·{" "}
                          {candidate.motion ? "MOTION LINKED" : "SNAPSHOT ONLY"}
                        </small>
                      </button>
                    </li>
                  )
                })}
              </ol>

              <div
                className={styles["ops-step-card"]}
                data-step-id={step.id}
                data-testid="replay-stage"
                id="flows-step-inspector"
              >
                <header>
                  <span>
                    STEP {String(state.stepIndex + 1).padStart(2, "0")}
                  </span>
                  <strong>{actorLabels[step.actor]}</strong>
                </header>
                <h3>{step.title}</h3>
                <p>{step.annotation}</p>
                <dl>
                  <div>
                    <dt>STATE</dt>
                    <dd>{displayValue(step.canonicalStatus)}</dd>
                  </div>
                  <div>
                    <dt>ATTEMPTS</dt>
                    <dd>{displayValue(step.attemptCount)}</dd>
                  </div>
                  <div>
                    <dt>CONNECTOR</dt>
                    <dd>{displayValue(step.connector)}</dd>
                  </div>
                  <div>
                    <dt>RECEIVED</dt>
                    <dd>{formatMoney(step.amountReceivedMinor, selectedCurrency)}</dd>
                  </div>
                </dl>
                <small className={styles["ops-step-evidence"]}>
                  EVIDENCE · {step.evidenceRef}
                </small>
              </div>
            </section>

            <div
              aria-label="Replay controls"
              className={styles["ops-controls"]}
            >
              <button
                data-testid="replay-previous"
                disabled={state.stepIndex === 0}
                onClick={() => dispatch({ type: "previous" })}
                type="button"
              >
                ← PREVIOUS
              </button>
              <button
                className={styles.primary}
                onClick={togglePlayback}
                type="button"
              >
                {playLabel}
              </button>
              <button
                data-testid="replay-next"
                disabled={finalStep}
                onClick={() => dispatch({ type: "next" })}
                type="button"
              >
                NEXT →
              </button>
              <button
                data-testid="replay-restart"
                onClick={restartReplay}
                type="button"
              >
                RESTART AT STEP 01
              </button>
            </div>

            <AttemptChain attempts={attempts} flow={flow} />

            <section
              aria-label="Sanitized operation log"
              className={styles["ops-operation-log"]}
            >
              <header>
                <div>
                  <span>SANITIZED OPERATION LOG</span>
                  <h3>API and merchant facts retained by the receipt</h3>
                </div>
                <p>
                  No raw order, payment, attempt, client-secret, redirect, or
                  card identifier is shown. Missing operation links remain
                  explicit gaps.
                </p>
              </header>
              <div
                aria-label={`${flow.label} operations`}
                className={styles["ops-operation-table"]}
                data-contained-scroll="operations"
                role="table"
                tabIndex={0}
              >
                <div className={styles["ops-operation-table-head"]} role="row">
                  <span role="columnheader">OPERATION</span>
                  <span role="columnheader">ACTOR</span>
                  <span role="columnheader">CANONICAL</span>
                  <span role="columnheader">ATTEMPT</span>
                  <span role="columnheader">CONNECTOR</span>
                  <span role="columnheader">RECEIVED</span>
                  <span role="columnheader">MOTION PROOF</span>
                  <span role="columnheader">EVIDENCE REFERENCE</span>
                </div>
                {flow.steps.map((candidate, index) => (
                  <button
                    aria-current={
                      index === state.stepIndex ? "step" : undefined
                    }
                    className={styles["ops-operation-row"]}
                    key={candidate.id}
                    onClick={() => dispatch({ type: "seek", stepIndex: index })}
                    role="row"
                    type="button"
                  >
                    <span role="cell">
                      <i>{String(index + 1).padStart(2, "0")}</i>
                      {candidate.title}
                    </span>
                    <span role="cell">{actorLabels[candidate.actor]}</span>
                    <span role="cell">
                      {displayValue(candidate.canonicalStatus)}
                    </span>
                    <span role="cell">
                      {displayValue(candidate.attemptStatus)}
                    </span>
                    <span role="cell">{displayValue(candidate.connector)}</span>
                    <span role="cell">
                      {formatMoney(candidate.amountReceivedMinor, selectedCurrency)}
                    </span>
                    <span role="cell">
                      {candidate.motion
                        ? displayValue(candidate.motion.authorityProof)
                        : "OPERATION LINK MISSING"}
                    </span>
                    <span role="cell">{candidate.evidenceRef}</span>
                  </button>
                ))}
              </div>
            </section>

            <div className={styles["ops-bottom-grid"]}>
              {scenario && (
                <section className={styles["ops-scenario"]}>
                  <span>STORY LAB INSTRUMENT · {scenario.label}</span>
                  <strong>{scenario.instrument}</strong>
                  <p>{scenario.significance}</p>
                  {flow.proof !== "local_simulation" && (
                    <a
                      href="https://docs.hyperswitch.io/explore-hyperswitch/payment-flows-and-management/quickstart/connectors/test-a-payment-with-connector"
                      rel="noreferrer"
                      target="_blank"
                    >
                      OPEN OFFICIAL TEST GUIDE ↗
                    </a>
                  )}
                </section>
              )}
              <details className={styles["ops-proof"]} open>
                <summary>PROOF AND LIMITS</summary>
                <p>{narrative.limitation}</p>
                <p>Active evidence: {step.evidenceRef}</p>
                <p>
                  Replay animates only operation-linked handoffs. Snapshot-only
                  facts remain visible but do not receive a moving token.
                </p>
              </details>
            </div>
            </>
            )}
          </article>
        </div>
      </main>
    </div>
  )
}
