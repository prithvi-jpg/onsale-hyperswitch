import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react"

import {
  PAYMENT_TRACE_EDGE_IDS_V1,
  PAYMENT_TRACE_NODE_IDS_V1,
  paymentTraceConnectorIsObservedV1,
  paymentTraceEdgeIsObservedV1,
  paymentTraceLabelIsSafeV1,
  paymentTraceAdvanceMotionCursorV1,
  paymentTraceCreateMotionCursorV1,
  paymentTraceMotionHasArrivedV1,
  paymentTraceOutcomeLabelV1,
  paymentTracePlaybackIsAuthorizedV1,
  paymentTraceRetargetMotionCursorV1,
  paymentTraceSettleMotionCursorV1,
  paymentTraceTicketProofIsValidV1,
  paymentTraceTokenIsSafeV1,
  paymentTraceTravelDurationMsV1,
  paymentTraceVisibleAttemptsV1,
  type PaymentTraceAttemptV1,
  type PaymentTraceEdgeIdV1,
  type PaymentTraceEdgeStateV1,
  type PaymentTraceFrameV1,
  type PaymentTraceHandoffV1,
  type PaymentTraceMotionCursorV1,
  type PaymentTraceMotionDurationsV1,
  type PaymentTraceNodeIdV1,
  type PaymentTraceNodeStateV1,
  type PaymentTraceNodeV1,
  type PaymentTracePlaybackV1,
  type PaymentTracePlaybackControlV1,
  type PaymentTracePresentationPhaseV1,
} from "./payment-trace/model"
import {
  paymentTraceEasedTravelProgressV1,
  paymentTraceGeometryV1,
  paymentTracePointOnEdgeV1,
} from "./payment-trace/trace-geometry"

export * from "./payment-trace/model"

export interface PaymentTraceMapPropsV1 {
  readonly frame: PaymentTraceFrameV1
  readonly playback?: PaymentTracePlaybackV1
  readonly playbackControl?: PaymentTracePlaybackControlV1
  readonly selectedNode?: PaymentTraceNodeIdV1 | null
  readonly onSelectNode?: (node: PaymentTraceNodeIdV1) => void
  readonly onInspectAttempts?: () => void
  readonly onArrive?: (handoff: PaymentTraceHandoffV1) => void
  readonly attemptInspectorId?: string
  readonly nodeInspectorId?: string
  readonly reducedMotion?: boolean
  readonly className?: string
  readonly layout?: "rail" | "wide"
}

const DEFAULT_PLAYBACK_V1: PaymentTracePlaybackV1 = {
  kind: "static",
  reason: "idle",
}

const DEFAULT_PLAYBACK_CONTROL_V1: PaymentTracePlaybackControlV1 = {
  kind: "playing",
}

const DEFAULT_NODE_COPY_V1: Record<
  PaymentTraceNodeIdV1,
  readonly [string, string]
> = {
  buyer: ["BUYER", "intent"],
  merchant: ["ONSALE / MERCHANT", "held order"],
  hyperswitch: ["HYPERSWITCH", "payment orchestration"],
  connector: ["OBSERVED CONNECTOR", "no attempt observed"],
  reconcile: ["RECONCILE", "same-payment retrieve"],
  tickets: ["TICKETS", "not issued"],
}

function fallbackNodeV1(id: PaymentTraceNodeIdV1): PaymentTraceNodeV1 {
  const copy = DEFAULT_NODE_COPY_V1[id]
  return {
    id,
    label: copy[0],
    detail: copy[1],
    state: "future",
    proof: "unproven",
  }
}

function nodePositionStyleV1(
  id: PaymentTraceNodeIdV1,
  layout: "rail" | "wide",
): CSSProperties {
  const geometry = paymentTraceGeometryV1(layout)
  const node = geometry.nodes[id]
  return {
    left: `${(node.x / geometry.width) * 100}%`,
    top: `${node.y}px`,
    width: `${(node.w / geometry.width) * 100}%`,
    height: `${node.h}px`,
  }
}

function statePaintV1(state: PaymentTraceNodeStateV1): CSSProperties {
  switch (state) {
    case "future":
      return { opacity: 0.38 }
    case "traversed":
      return { borderColor: "rgba(0, 109, 249, 0.45)", opacity: 0.82 }
    case "current":
      return {
        borderColor: "#006DF9",
        boxShadow: "0 0 0 3px rgba(0,109,249,.10), 0 8px 18px rgba(0,74,170,.09)",
        opacity: 1,
      }
    case "action_required":
    case "processing":
      return {
        borderColor: "#F59E0B",
        background: "#FFFBEB",
        opacity: 1,
      }
    case "declined":
      return {
        borderColor: "#EF4444",
        background: "#FFF5F5",
        opacity: 1,
      }
    case "succeeded":
      return {
        borderColor: "#22C55E",
        background: "#F1FFF5",
        opacity: 1,
      }
    case "integrity_review":
      return {
        borderColor: "#F59E0B",
        background: "#FFF7E6",
        boxShadow: "inset 3px 0 0 #F59E0B",
        opacity: 1,
      }
    default: {
      const exhaustive: never = state
      return exhaustive
    }
  }
}

function edgePaintV1(state: PaymentTraceEdgeStateV1): CSSProperties {
  switch (state) {
    case "possible":
      return {
        stroke: "rgba(0,109,249,.22)",
        strokeDasharray: "4 5",
        strokeWidth: 1.25,
      }
    case "traversed":
      return { stroke: "rgba(0,109,249,.70)", strokeWidth: 1.75 }
    case "current":
      return { stroke: "#006DF9", strokeWidth: 2.25 }
    case "failure":
      return { stroke: "#EF4444", strokeWidth: 2.25 }
    case "success":
      return { stroke: "#22C55E", strokeWidth: 2.25 }
    default: {
      const exhaustive: never = state
      return exhaustive
    }
  }
}

function displayTokenV1(value: string | null): string {
  if (!paymentTraceTokenIsSafeV1(value)) return "NOT OBSERVED"
  return value.trim().replace(/_/gu, " ").toUpperCase()
}

function displayConnectorV1(value: string | null): string {
  if (!paymentTraceTokenIsSafeV1(value)) return "NOT OBSERVED"
  return value.trim().toUpperCase()
}

function safeNodeTextV1(value: string, fallback: string): string {
  return paymentTraceLabelIsSafeV1(value) ? value : fallback
}

function selectedMethodLabelV1(frame: PaymentTraceFrameV1): string {
  const method = frame.orchestration.selectedMethod
  if (!method || method.proof === "unproven") return "METHOD · NOT OBSERVED"
  const family = displayTokenV1(method.family)
  const type = displayTokenV1(method.type)
  return family === type
    ? `METHOD · ${family}`
    : `METHOD · ${family} / ${type}`
}

function compactSelectedMethodLabelV1(frame: PaymentTraceFrameV1): string {
  const method = frame.orchestration.selectedMethod
  if (!method || method.proof === "unproven") return "METHOD · NONE"
  return `METHOD · ${displayTokenV1(method.type)}`
}

function attemptAccessibleLabelV1(attempt: PaymentTraceAttemptV1): string {
  const connector = paymentTraceConnectorIsObservedV1(attempt)
    ? displayConnectorV1(attempt.connector)
    : "NO CONNECTOR OBSERVED"
  const method = attempt.methodAtAttempt
    ? `${displayTokenV1(attempt.methodAtAttempt.family)} ${displayTokenV1(attempt.methodAtAttempt.type)}`
    : "attempt method not retained"
  const retry = attempt.retryKind === "not_observed"
    ? "retry decision not observed"
    : `retry relation ${attempt.retryKind}`
  return [
    `Attempt ${attempt.ordinal}`,
    method,
    `connector ${connector}`,
    paymentTraceOutcomeLabelV1(attempt.outcome),
    attempt.charged ? "charged" : "not charged",
    retry,
    `proof ${attempt.proof}`,
  ].join(", ")
}

function actorAnnouncementLabelV1(id: PaymentTraceNodeIdV1): string {
  switch (id) {
    case "buyer":
      return "Buyer"
    case "merchant":
      return "ONSALE merchant"
    case "hyperswitch":
      return "Hyperswitch"
    case "connector":
      return "Observed connector"
    case "reconcile":
      return "Reconcile"
    case "tickets":
      return "Tickets"
    default: {
      const exhaustive: never = id
      return exhaustive
    }
  }
}

function handoffAnnouncementV1(handoff: PaymentTraceHandoffV1): string {
  return [
    `Step ${handoff.sequence}`,
    `${actorAnnouncementLabelV1(handoff.source)} to ${actorAnnouncementLabelV1(handoff.target)}`,
    handoff.label,
    `proof ${handoff.authorityProof.replace(/_/gu, " ")}`,
  ].join(", ")
}

function playbackKeyV1(playback: PaymentTracePlaybackV1): string | null {
  switch (playback.kind) {
    case "static":
      return null
    case "live_event":
      return `live:${playback.handoff.eventId}:${playback.handoff.evidenceRevision}`
    case "replay_event":
      return `replay:${playback.replayId}:${playback.handoff.eventId}`
    default: {
      const exhaustive: never = playback
      return exhaustive
    }
  }
}

function settledEdgeStateV1(
  handoff: PaymentTraceHandoffV1,
): PaymentTraceEdgeStateV1 {
  switch (handoff.tone) {
    case "failure":
      return "failure"
    case "success":
      return "success"
    case "progress":
    case "action":
    case "unknown":
      return "traversed"
    default: {
      const exhaustive: never = handoff.tone
      return exhaustive
    }
  }
}

function arrivalNodeStateV1(
  frameState: PaymentTraceNodeStateV1,
): PaymentTraceNodeStateV1 {
  switch (frameState) {
    case "action_required":
    case "processing":
    case "declined":
    case "succeeded":
    case "integrity_review":
      return frameState
    case "future":
    case "traversed":
    case "current":
      return "current"
    default: {
      const exhaustive: never = frameState
      return exhaustive
    }
  }
}

function useReducedTraceMotionV1(forced: boolean): boolean {
  const [systemPreference, setSystemPreference] = useState(false)
  useEffect(() => {
    if (forced || typeof window.matchMedia !== "function") return
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const update = () => setSystemPreference(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [forced])
  return forced || systemPreference
}

function connectorNodeV1({
  frame,
  node,
  selected,
  state,
  style,
  onSelectNode,
  onInspectAttempts,
  attemptInspectorId,
  nodeInspectorId,
}: {
  readonly frame: PaymentTraceFrameV1
  readonly node: PaymentTraceNodeV1
  readonly selected: boolean
  readonly state: PaymentTraceNodeStateV1
  readonly style: CSSProperties
  readonly onSelectNode: PaymentTraceMapPropsV1["onSelectNode"]
  readonly onInspectAttempts: PaymentTraceMapPropsV1["onInspectAttempts"]
  readonly attemptInspectorId: string | undefined
  readonly nodeInspectorId: string | undefined
}) {
  const visible = paymentTraceVisibleAttemptsV1(frame.orchestration)
  const accessibleAttempts = frame.orchestration.attempts.length === 0
    ? "No connector attempt observed"
    : frame.orchestration.attempts.map(attemptAccessibleLabelV1).join(". ")
  const accessibleMethod = selectedMethodLabelV1(frame)
  const controls = attemptInspectorId ?? nodeInspectorId
  const inspect = () => {
    onSelectNode?.("connector")
    onInspectAttempts?.()
  }

  const content = (
    <>
      <span
        className="payment-trace-lens-heading"
        data-lens-band="heading"
      >
        <b>ATTEMPTS</b>
        <i data-attempt-count={frame.orchestration.attempts.length}>
          {String(frame.orchestration.attempts.length).padStart(2, "0")}
        </i>
      </span>
      <span
        className="payment-trace-method-strip"
        data-lens-band="method"
        title={accessibleMethod}
      >
        {compactSelectedMethodLabelV1(frame)}
      </span>
      <span
        className="payment-trace-attempt-rows"
        aria-hidden="true"
        data-lens-band="attempts"
      >
        {visible.attempts.length === 0 ? (
          <i className="payment-trace-attempt-empty" data-lens-line="connector">
            CONNECTOR · NONE
          </i>
        ) : visible.attempts.map((attempt) => (
          <i
            className="payment-trace-attempt-row"
            data-attempt={attempt.ordinal}
            data-proof={attempt.proof}
            key={attempt.ordinal}
          >
            <span
              data-lens-line="connector"
              title={`CONNECTOR · ${paymentTraceConnectorIsObservedV1(attempt)
                ? displayConnectorV1(attempt.connector)
                : "NONE"}`}
            >
              {String(attempt.ordinal).padStart(2, "0")} · {paymentTraceConnectorIsObservedV1(attempt)
                ? displayConnectorV1(attempt.connector)
                : "NONE"}
            </span>
            <em
              data-outcome={attempt.outcome}
              data-lens-line="outcome"
              style={{
                color: attempt.outcome === "succeeded"
                  ? "#16853B"
                  : attempt.outcome === "hard_decline" || attempt.outcome === "technical_failure"
                    ? "#C72B2B"
                    : "#9A5B00",
              }}
            >
              {paymentTraceOutcomeLabelV1(attempt.outcome)}
              {attempt.charged ? " · CHARGED" : ""}
            </em>
          </i>
        ))}
      </span>
      <span
        className="payment-trace-inspect-label"
        aria-hidden="true"
        data-lens-band="inspect"
      >
        {visible.overflowCount > 0
          ? `OPEN ${frame.orchestration.attempts.length} ATTEMPTS`
          : "OPEN ATTEMPTS"}
      </span>
    </>
  )

  const sharedStyle: CSSProperties = {
    ...style,
    ...statePaintV1(state),
    display: "grid",
    gridTemplateRows: "18px 18px 1fr 18px",
    gap: 0,
    padding: "5px 7px",
    overflow: "hidden",
  }

  if (onSelectNode || onInspectAttempts) {
    return (
      <button
        aria-controls={controls}
        aria-label={`${safeNodeTextV1(node.label, "Observed connector")}. ${accessibleMethod}. ${accessibleAttempts}. Open attempts.`}
        aria-pressed={selected}
        className="payment-trace-node payment-trace-orchestration-lens"
        data-node="connector"
        data-selected={selected ? "true" : "false"}
        data-state={state}
        key="connector"
        onClick={inspect}
        style={sharedStyle}
        type="button"
      >
        {content}
      </button>
    )
  }

  return (
    <div
      aria-label={`${safeNodeTextV1(node.label, "Observed connector")}. ${accessibleMethod}. ${accessibleAttempts}.`}
      className="payment-trace-node payment-trace-orchestration-lens"
      data-node="connector"
      data-selected={selected ? "true" : "false"}
      data-state={state}
      key="connector"
      role="group"
      style={sharedStyle}
    >
      {content}
    </div>
  )
}

export default function PaymentTraceMapV1({
  frame,
  playback = DEFAULT_PLAYBACK_V1,
  playbackControl = DEFAULT_PLAYBACK_CONTROL_V1,
  selectedNode = null,
  onSelectNode,
  onInspectAttempts,
  onArrive,
  attemptInspectorId,
  nodeInspectorId,
  reducedMotion: reducedMotionOverride = false,
  className = "",
  layout = "rail",
}: PaymentTraceMapPropsV1) {
  const filterId = useId()
  const reducedMotion = useReducedTraceMotionV1(reducedMotionOverride)
  const geometry = paymentTraceGeometryV1(layout)
  const ticketProofValid = paymentTraceTicketProofIsValidV1(frame)
  const ticketClaimed = frame.nodes.some(
    (node) => node.id === "tickets" && node.state === "succeeded",
  ) || frame.edges.some(
    (edge) => edge.id === "merchant_tickets" && edge.state === "success",
  )
  const playbackAuthorized = paymentTracePlaybackIsAuthorizedV1(frame, playback)
  const key = playbackKeyV1(playback)
  const handoff = playbackAuthorized ? playback.handoff : null
  const activeKey = handoff && key !== null ? key : null
  const terminalHandoff = handoff?.tone === "success" || handoff?.tone === "failure"
  const onArriveRef = useRef(onArrive)
  onArriveRef.current = onArrive
  const [motionCursor, setMotionCursor] = useState<PaymentTraceMotionCursorV1>(() =>
    paymentTraceCreateMotionCursorV1(activeKey, playbackControl),
  )
  const motionCursorRef = useRef(motionCursor)
  motionCursorRef.current = motionCursor
  const previousKeyRef = useRef(activeKey)
  const previousHandoffRef = useRef(handoff)
  const announcedArrivalKeyRef = useRef<string | null>(null)
  const runtimeRef = useRef({
    activeKey,
    handoff,
    layout,
    playbackControlKind: playbackControl.kind,
    reducedMotion,
  })
  runtimeRef.current = {
    activeKey,
    handoff,
    layout,
    playbackControlKind: playbackControl.kind,
    reducedMotion,
  }

  const notifyArrivalV1 = (
    arrivedHandoff: PaymentTraceHandoffV1,
    arrivedKey: string,
  ) => {
    if (announcedArrivalKeyRef.current === arrivedKey) return
    announcedArrivalKeyRef.current = arrivedKey
    onArriveRef.current?.(arrivedHandoff)
  }

  const phase: PaymentTracePresentationPhaseV1 = handoff
    ? reducedMotion
      ? terminalHandoff
        ? "terminal"
        : "arrived"
      : motionCursor.eventKey === activeKey
        ? motionCursor.phase
        : "drawing"
    : "static"
  const arrived = phase === "arrived" || phase === "terminal"

  useEffect(() => {
    const previousKey = previousKeyRef.current
    const previousHandoff = previousHandoffRef.current
    const transition = paymentTraceRetargetMotionCursorV1({
      cursor: motionCursorRef.current,
      eventKey: activeKey,
      control: playbackControl,
    })
    if (
      transition.settlePrevious &&
      previousKey !== null &&
      previousHandoff
    ) {
      notifyArrivalV1(previousHandoff, previousKey)
    }
    let nextCursor = transition.cursor
    if (reducedMotion && handoff && activeKey !== null) {
      nextCursor = paymentTraceSettleMotionCursorV1(nextCursor, terminalHandoff)
      notifyArrivalV1(handoff, activeKey)
    }
    motionCursorRef.current = nextCursor
    if (nextCursor !== motionCursor) setMotionCursor(nextCursor)
    previousKeyRef.current = activeKey
    previousHandoffRef.current = handoff
  }, [activeKey, playbackControl.kind, reducedMotion])

  useEffect(() => {
    if (
      activeKey === null ||
      !handoff ||
      reducedMotion ||
      playbackControl.kind === "paused"
    ) return

    let animationFrame = 0
    let previousTime: number | null = null
    const tick = (time: number) => {
      const runtime = runtimeRef.current
      if (
        runtime.activeKey !== activeKey ||
        !runtime.handoff ||
        runtime.playbackControlKind === "paused" ||
        runtime.reducedMotion
      ) return
      if (previousTime !== null) {
        const elapsedMs = Math.min(64, Math.max(0, time - previousTime))
        const durations: PaymentTraceMotionDurationsV1 = {
          drawMs: 420,
          handoffPauseMs: 70,
          travelMs: paymentTraceTravelDurationMsV1(
            runtime.handoff.edgeId,
            runtime.layout,
          ),
          terminalSettleMs: 180,
        }
        const before = motionCursorRef.current
        const after = paymentTraceAdvanceMotionCursorV1(
          before,
          elapsedMs,
          durations,
          runtime.handoff.tone === "success" ||
            runtime.handoff.tone === "failure",
        )
        if (after !== before) {
          motionCursorRef.current = after
          setMotionCursor(after)
        }
        if (
          !paymentTraceMotionHasArrivedV1(before) &&
          paymentTraceMotionHasArrivedV1(after)
        ) {
          notifyArrivalV1(runtime.handoff, activeKey)
        }
      }
      previousTime = time
      if (motionCursorRef.current.kind === "active") {
        animationFrame = window.requestAnimationFrame(tick)
      }
    }
    animationFrame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(animationFrame)
  }, [activeKey, playbackControl.kind, reducedMotion])

  const nodeById = new Map(frame.nodes.map((node) => [node.id, node]))
  const edgeById = new Map(frame.edges.map((edge) => [edge.id, edge]))
  const connectorObserved = frame.orchestration.attempts.some(
    paymentTraceConnectorIsObservedV1,
  )

  function effectiveNodeStateV1(
    id: PaymentTraceNodeIdV1,
    frameState: PaymentTraceNodeStateV1,
  ): PaymentTraceNodeStateV1 {
    if (id === "connector" && !connectorObserved) return "future"
    if (id === "tickets" && frameState === "succeeded" && !ticketProofValid) {
      return "integrity_review"
    }
    if (!handoff) return frameState
    if (!arrived && id === handoff.source) return "current"
    if (!arrived && id === handoff.target) return "future"
    if (arrived && id === handoff.source) return "traversed"
    if (arrived && id === handoff.target) return arrivalNodeStateV1(frameState)
    return frameState
  }

  function effectiveEdgeStateV1(
    id: PaymentTraceEdgeIdV1,
    frameState: PaymentTraceEdgeStateV1,
  ): PaymentTraceEdgeStateV1 {
    const suppliedEdge = edgeById.get(id)
    if (
      suppliedEdge &&
      frameState !== "possible" &&
      !paymentTraceEdgeIsObservedV1(frame, suppliedEdge)
    ) {
      return "possible"
    }
    if (id === "merchant_tickets" && frameState === "success" && !ticketProofValid) {
      return "possible"
    }
    if (!handoff || id !== handoff.edgeId) {
      return frameState === "current" ? "traversed" : frameState
    }
    if (reducedMotion || arrived) return settledEdgeStateV1(handoff)
    return "current"
  }

  const playbackMode = playback.kind === "replay_event"
    ? "replay"
    : playback.kind === "live_event"
      ? "live"
      : "static"
  const motionState = playback.kind !== "static" && !playbackAuthorized
    ? "evidence-rejected"
    : handoff && reducedMotion
      ? "reduced"
      : handoff
        ? playbackMode
        : playback.kind === "static"
          ? playback.reason
          : "consumed"
  const travelProgress = handoff && activeKey !== null
    ? reducedMotion || arrived
      ? 1
      : motionCursor.eventKey === activeKey &&
          motionCursor.kind === "active" &&
          motionCursor.phase === "travelling"
        ? motionCursor.phaseProgress
        : 0
    : 0
  const tokenPoint = handoff
    ? paymentTracePointOnEdgeV1(
        layout,
        handoff.edgeId,
        paymentTraceEasedTravelProgressV1(travelProgress),
      )
    : null
  const tokenVisible = Boolean(
    handoff &&
    (reducedMotion || arrived || phase === "travelling"),
  )

  return (
    <div
      aria-label={frame.ariaLabel}
      className={`payment-trace-map ${className}`.trim()}
      data-layout={layout}
      data-motion={motionState}
      data-motion-engine="interruptible"
      data-phase={phase}
      data-playback={playbackMode}
      data-playback-control={playbackControl.kind}
      data-ticket-proof={ticketClaimed
        ? ticketProofValid ? "accepted" : "rejected"
        : "not-applicable"}
      role="group"
      style={{
        aspectRatio: "auto",
        height: `${geometry.height}px`,
        minHeight: `${geometry.height}px`,
        maxHeight: `${geometry.height}px`,
      }}
    >
      <style>{`
        .payment-trace-map button.payment-trace-node[data-hit-target="expanded"]::after {
          content: "";
          position: absolute;
          inset: -7px 0;
        }
        @media (prefers-reduced-motion: reduce) {
          .payment-trace-map .payment-trace-edge { animation: none !important; }
          .payment-trace-map:not([data-motion="reduced"]) [data-token-tone="amber"] { visibility: hidden; }
        }
      `}</style>
      <svg
        aria-hidden="true"
        preserveAspectRatio="none"
        viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      >
        <defs>
          <filter id={filterId} x="-300%" y="-300%" width="700%" height="700%">
            <feGaussianBlur stdDeviation="3.2" />
          </filter>
        </defs>
        {PAYMENT_TRACE_EDGE_IDS_V1.map((edgeId) => {
          const edge = edgeById.get(edgeId)
          const frameState = edge?.state ?? "possible"
          const state = effectiveEdgeStateV1(edgeId, frameState)
          const isCurrentHandoff = handoff?.edgeId === edgeId && activeKey !== null
          return (
            <path
              className="payment-trace-edge"
              d={geometry.edges[edgeId].path}
              data-edge={edgeId}
              data-proof={edge?.proof ?? "unproven"}
              data-state={state}
              key={`${edgeId}:${isCurrentHandoff ? activeKey : "static"}`}
              pathLength="1"
              style={{
                ...edgePaintV1(state),
                animationPlayState: state === "current"
                  ? playbackControl.kind === "paused" ? "paused" : "running"
                  : undefined,
                animationTimingFunction: state === "current"
                  ? "cubic-bezier(0.23, 1, 0.32, 1)"
                  : undefined,
              }}
            />
          )
        })}
        {handoff && tokenPoint && (
          <g
            className="payment-trace-token"
            data-motion-progress={travelProgress.toFixed(3)}
            data-token-tone="amber"
            key={key}
            opacity={tokenVisible ? 1 : 0}
            transform={`translate(${tokenPoint[0]} ${tokenPoint[1]})`}
          >
            <circle
              className="payment-trace-token-halo"
              fill="#F59E0B"
              filter={`url(#${filterId})`}
              opacity="0.28"
              r={layout === "wide" ? 9 : 8}
            />
            <circle
              className="payment-trace-token-core"
              fill="#F59E0B"
              r={layout === "wide" ? 4.5 : 4}
            />
          </g>
        )}
      </svg>

      {PAYMENT_TRACE_NODE_IDS_V1.map((nodeId) => {
        const suppliedNode = nodeById.get(nodeId)
        const node = suppliedNode ?? fallbackNodeV1(nodeId)
        const state = effectiveNodeStateV1(nodeId, node.state)
        const selected = selectedNode === nodeId
        const position = nodePositionStyleV1(nodeId, layout)
        const style = {
          ...position,
          ...statePaintV1(state),
          ...(layout === "rail" ? { padding: "2px 6px" } : {}),
        }

        if (nodeId === "connector") {
          return connectorNodeV1({
            frame,
            node,
            selected,
            state,
            style,
            onSelectNode,
            onInspectAttempts,
            attemptInspectorId,
            nodeInspectorId,
          })
        }

        const content = (
          <>
            <span style={layout === "rail" ? {
              lineHeight: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            } : undefined}>
              {safeNodeTextV1(node.label, DEFAULT_NODE_COPY_V1[nodeId][0])}
            </span>
            <strong style={layout === "rail" ? {
              lineHeight: 1,
              marginTop: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            } : undefined}>
              {safeNodeTextV1(node.detail, "NOT RETAINED")}
            </strong>
          </>
        )
        if (onSelectNode) {
          return (
            <button
              aria-controls={nodeInspectorId}
              aria-label={`${safeNodeTextV1(node.label, DEFAULT_NODE_COPY_V1[nodeId][0])}. ${safeNodeTextV1(node.detail, "Not retained")}. ${state.replace(/_/gu, " ")}. Proof ${node.proof.replace(/_/gu, " ")}.`}
              aria-pressed={selected}
              className="payment-trace-node"
              data-hit-target={geometry.nodes[nodeId].h < 44 ? "expanded" : undefined}
              data-node={nodeId}
              data-selected={selected ? "true" : "false"}
              data-state={state}
              key={nodeId}
              onClick={() => onSelectNode(nodeId)}
              style={style}
              type="button"
            >
              {content}
            </button>
          )
        }
        return (
          <div
            className="payment-trace-node"
            data-node={nodeId}
            data-selected={selected ? "true" : "false"}
            data-state={state}
            key={nodeId}
            style={style}
          >
            {content}
          </div>
        )
      })}

      <span
        aria-atomic="true"
        aria-live="polite"
        className="payment-trace-arrival-announcement"
        style={{
          position: "absolute",
          width: "1px",
          height: "1px",
          padding: 0,
          margin: "-1px",
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {handoff && arrived ? handoffAnnouncementV1(handoff) : ""}
      </span>
    </div>
  )
}
