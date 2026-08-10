export type PaymentTraceNodeIdV1 =
  | "buyer"
  | "merchant"
  | "hyperswitch"
  | "connector"
  | "reconcile"
  | "tickets"

export const PAYMENT_TRACE_NODE_IDS_V1 = [
  "buyer",
  "merchant",
  "hyperswitch",
  "connector",
  "reconcile",
  "tickets",
] satisfies readonly PaymentTraceNodeIdV1[]

export type PaymentTraceEdgeIdV1 =
  | "buyer_merchant"
  | "merchant_hyperswitch"
  | "hyperswitch_connector"
  | "connector_hyperswitch"
  | "hyperswitch_retrieve"
  | "reconcile_merchant"
  | "merchant_tickets"

export const PAYMENT_TRACE_EDGE_IDS_V1 = [
  "buyer_merchant",
  "merchant_hyperswitch",
  "hyperswitch_connector",
  "connector_hyperswitch",
  "hyperswitch_retrieve",
  "reconcile_merchant",
  "merchant_tickets",
] satisfies readonly PaymentTraceEdgeIdV1[]

export type PaymentTraceFactProofV1 =
  | "server_create"
  | "server_retrieve"
  | "merchant_db"
  | "browser_handoff"
  | "merchant_rule"
  | "recorded_sandbox"
  | "simulation"
  | "source_determined"
  | "unproven"

export type PaymentTraceNodeStateV1 =
  | "future"
  | "traversed"
  | "current"
  | "action_required"
  | "processing"
  | "declined"
  | "succeeded"
  | "integrity_review"

export type PaymentTraceStateV1 = PaymentTraceNodeStateV1

export type PaymentTraceEdgeStateV1 =
  | "possible"
  | "traversed"
  | "current"
  | "failure"
  | "success"

export interface PaymentTraceNodeV1 {
  readonly id: PaymentTraceNodeIdV1
  readonly label: string
  readonly detail: string
  readonly state: PaymentTraceNodeStateV1
  readonly proof: PaymentTraceFactProofV1
}

export interface PaymentTraceEdgeV1 {
  readonly id: PaymentTraceEdgeIdV1
  readonly state: PaymentTraceEdgeStateV1
  readonly attemptOrdinal: number | null
  readonly proof: PaymentTraceFactProofV1
}

export type PaymentTraceAttemptOutcomeV1 =
  | "requires_method"
  | "action_required"
  | "processing"
  | "hard_decline"
  | "technical_failure"
  | "uncertain"
  | "succeeded"

export type PaymentTraceFailureClassV1 =
  | "hard_decline"
  | "technical"
  | "payment_method"
  | "integrity"
  | "unknown"

export interface PaymentTraceMethodFactV1 {
  readonly family: string | null
  readonly type: string | null
  readonly proof: PaymentTraceFactProofV1
}

export interface PaymentTraceAttemptV1 {
  readonly ordinal: number
  readonly methodAtAttempt: PaymentTraceMethodFactV1 | null
  readonly connector: string | null
  readonly outcome: PaymentTraceAttemptOutcomeV1
  readonly charged: boolean
  readonly retryKind: "initial" | "automatic" | "manual" | "not_observed"
  readonly failureClass: PaymentTraceFailureClassV1 | null
  readonly proof: PaymentTraceFactProofV1
}

export interface PaymentTraceOrchestrationV1 {
  readonly selectedMethod: PaymentTraceMethodFactV1 | null
  readonly attempts: readonly PaymentTraceAttemptV1[]
  readonly chargedAttemptCount: number
  readonly winningAttemptOrdinal: number | null
  readonly terminal:
    | "action_required"
    | "processing"
    | "declined"
    | "uncertain"
    | "succeeded"
    | "integrity_review"
    | null
  /** True only when chronology is retained, not merely when display ordinals exist. */
  readonly orderRetained: boolean
}

export interface PaymentTraceMerchantV1 {
  readonly itemCount: number
  readonly ticketCount: number
  readonly orderState: "held" | "payment_pending" | "paid" | "fulfilled" | "review"
}

export interface PaymentTraceFrameV1 {
  readonly revision: string | number
  readonly nodes: readonly PaymentTraceNodeV1[]
  readonly edges: readonly PaymentTraceEdgeV1[]
  readonly orchestration: PaymentTraceOrchestrationV1
  readonly merchant: PaymentTraceMerchantV1
  readonly ariaLabel: string
}

export type PaymentTraceToneV1 =
  | "progress"
  | "action"
  | "unknown"
  | "failure"
  | "success"

interface PaymentTraceHandoffBaseV1<
  C extends "live" | "recorded_sandbox" | "simulation",
  P extends PaymentTraceFactProofV1,
> {
  readonly context: C
  readonly eventId: string
  readonly sequence: number
  readonly edgeId: PaymentTraceEdgeIdV1
  readonly source: PaymentTraceNodeIdV1
  readonly target: PaymentTraceNodeIdV1
  readonly attemptOrdinal: number | null
  readonly label: string
  readonly tone: PaymentTraceToneV1
  readonly authorityProof: P
  readonly evidenceRevision: string | number
}

export type PaymentTraceLiveHandoffV1 = PaymentTraceHandoffBaseV1<
  "live",
  "server_create" | "server_retrieve" | "merchant_db" | "browser_handoff"
>

export type PaymentTraceRecordedHandoffV1 = PaymentTraceHandoffBaseV1<
  "recorded_sandbox",
  "server_create" | "server_retrieve" | "merchant_db"
>

export type PaymentTraceSimulatedHandoffV1 = PaymentTraceHandoffBaseV1<
  "simulation",
  "simulation"
>

export type PaymentTraceHandoffV1 =
  | PaymentTraceLiveHandoffV1
  | PaymentTraceRecordedHandoffV1
  | PaymentTraceSimulatedHandoffV1

export type PaymentTraceStaticReasonV1 =
  | "idle"
  | "hydrate"
  | "catch_up"
  | "historical_selection"
  | "previous_step"

export type PaymentTracePlaybackV1 =
  | { readonly kind: "static"; readonly reason: PaymentTraceStaticReasonV1 }
  | { readonly kind: "live_event"; readonly handoff: PaymentTraceLiveHandoffV1 }
  | {
      readonly kind: "replay_event"
      readonly replayId: string
      readonly handoff: PaymentTraceRecordedHandoffV1 | PaymentTraceSimulatedHandoffV1
    }

export type PaymentTracePresentationPhaseV1 =
  | "static"
  | "source"
  | "drawing"
  | "handoff"
  | "travelling"
  | "arrived"
  | "terminal"

export type PaymentTracePlaybackControlV1 =
  | { readonly kind: "playing" }
  | { readonly kind: "paused" }

export interface PaymentTraceMotionDurationsV1 {
  readonly drawMs: number
  readonly handoffPauseMs: number
  readonly travelMs: number
  readonly terminalSettleMs: number
}

type PaymentTraceTimedMotionPhaseV1 =
  | "drawing"
  | "handoff"
  | "travelling"
  | "arrived"

export type PaymentTraceMotionCursorV1 =
  | {
      readonly kind: "static"
      readonly eventKey: null
      readonly phase: "static"
      readonly phaseProgress: 1
    }
  | {
      readonly kind: "active"
      readonly eventKey: string
      readonly phase: PaymentTraceTimedMotionPhaseV1
      readonly phaseProgress: number
      readonly control: PaymentTracePlaybackControlV1["kind"]
    }
  | {
      readonly kind: "settled"
      readonly eventKey: string
      readonly phase: "arrived" | "terminal"
      readonly phaseProgress: 1
    }

export interface PaymentTraceMotionRetargetResultV1 {
  readonly cursor: PaymentTraceMotionCursorV1
  readonly settlePrevious: boolean
}

const STATIC_MOTION_CURSOR_V1: PaymentTraceMotionCursorV1 = {
  kind: "static",
  eventKey: null,
  phase: "static",
  phaseProgress: 1,
}

function clampMotionProgressV1(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value >= 1) return 1
  return value
}

export function paymentTraceCreateMotionCursorV1(
  eventKey: string | null,
  control: PaymentTracePlaybackControlV1,
): PaymentTraceMotionCursorV1 {
  if (eventKey === null) return STATIC_MOTION_CURSOR_V1
  return {
    kind: "active",
    eventKey,
    phase: "drawing",
    phaseProgress: 0,
    control: control.kind,
  }
}

export function paymentTraceMotionHasArrivedV1(
  cursor: PaymentTraceMotionCursorV1,
): boolean {
  switch (cursor.kind) {
    case "static":
      return false
    case "active":
      return cursor.phase === "arrived"
    case "settled":
      return true
    default: {
      const exhaustive: never = cursor
      return exhaustive
    }
  }
}

export function paymentTraceSetMotionControlV1(
  cursor: PaymentTraceMotionCursorV1,
  control: PaymentTracePlaybackControlV1,
): PaymentTraceMotionCursorV1 {
  if (cursor.kind !== "active" || cursor.control === control.kind) return cursor
  return { ...cursor, control: control.kind }
}

export function paymentTraceSettleMotionCursorV1(
  cursor: PaymentTraceMotionCursorV1,
  terminal: boolean,
): PaymentTraceMotionCursorV1 {
  if (cursor.kind === "static") return cursor
  return {
    kind: "settled",
    eventKey: cursor.eventKey,
    phase: terminal ? "terminal" : "arrived",
    phaseProgress: 1,
  }
}

export function paymentTraceRetargetMotionCursorV1({
  cursor,
  eventKey,
  control,
}: {
  readonly cursor: PaymentTraceMotionCursorV1
  readonly eventKey: string | null
  readonly control: PaymentTracePlaybackControlV1
}): PaymentTraceMotionRetargetResultV1 {
  if (cursor.eventKey === eventKey) {
    return {
      cursor: paymentTraceSetMotionControlV1(cursor, control),
      settlePrevious: false,
    }
  }
  const settlePrevious = cursor.kind === "active" &&
    !paymentTraceMotionHasArrivedV1(cursor)
  return {
    cursor: paymentTraceCreateMotionCursorV1(eventKey, control),
    settlePrevious,
  }
}

function durationForMotionPhaseV1(
  phase: PaymentTraceTimedMotionPhaseV1,
  durations: PaymentTraceMotionDurationsV1,
): number {
  switch (phase) {
    case "drawing":
      return Math.max(0, durations.drawMs)
    case "handoff":
      return Math.max(0, durations.handoffPauseMs)
    case "travelling":
      return Math.max(0, durations.travelMs)
    case "arrived":
      return Math.max(0, durations.terminalSettleMs)
    default: {
      const exhaustive: never = phase
      return exhaustive
    }
  }
}

function nextMotionPhaseV1(
  cursor: Extract<PaymentTraceMotionCursorV1, { readonly kind: "active" }>,
  terminal: boolean,
): PaymentTraceMotionCursorV1 {
  switch (cursor.phase) {
    case "drawing":
      return { ...cursor, phase: "handoff", phaseProgress: 0 }
    case "handoff":
      return { ...cursor, phase: "travelling", phaseProgress: 0 }
    case "travelling":
      return terminal
        ? { ...cursor, phase: "arrived", phaseProgress: 0 }
        : {
            kind: "settled",
            eventKey: cursor.eventKey,
            phase: "arrived",
            phaseProgress: 1,
          }
    case "arrived":
      return {
        kind: "settled",
        eventKey: cursor.eventKey,
        phase: "terminal",
        phaseProgress: 1,
      }
    default: {
      const exhaustive: never = cursor.phase
      return exhaustive
    }
  }
}

export function paymentTraceAdvanceMotionCursorV1(
  cursor: PaymentTraceMotionCursorV1,
  elapsedMs: number,
  durations: PaymentTraceMotionDurationsV1,
  terminal: boolean,
): PaymentTraceMotionCursorV1 {
  if (
    cursor.kind !== "active" ||
    cursor.control === "paused" ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs <= 0
  ) return cursor

  let current: PaymentTraceMotionCursorV1 = cursor
  let remainingMs = elapsedMs
  while (current.kind === "active") {
    const durationMs = durationForMotionPhaseV1(current.phase, durations)
    const phaseRemainingMs = (1 - clampMotionProgressV1(current.phaseProgress)) *
      durationMs
    if (durationMs > 0 && remainingMs < phaseRemainingMs) {
      return {
        ...current,
        phaseProgress: clampMotionProgressV1(
          current.phaseProgress + remainingMs / durationMs,
        ),
      }
    }
    remainingMs = Math.max(0, remainingMs - phaseRemainingMs)
    current = nextMotionPhaseV1(current, terminal)
    if (remainingMs === 0) return current
  }
  return current
}

export interface PaymentTraceVisibleAttemptsV1 {
  readonly attempts: readonly PaymentTraceAttemptV1[]
  readonly overflowCount: number
}

const PAYMENT_TRACE_ENDPOINTS_V1 = {
  buyer_merchant: ["buyer", "merchant"],
  merchant_hyperswitch: ["merchant", "hyperswitch"],
  hyperswitch_connector: ["hyperswitch", "connector"],
  connector_hyperswitch: ["connector", "hyperswitch"],
  hyperswitch_retrieve: ["hyperswitch", "reconcile"],
  reconcile_merchant: ["reconcile", "merchant"],
  merchant_tickets: ["merchant", "tickets"],
} satisfies Record<
  PaymentTraceEdgeIdV1,
  readonly [PaymentTraceNodeIdV1, PaymentTraceNodeIdV1]
>

export function paymentTraceEndpointsV1(
  edgeId: PaymentTraceEdgeIdV1,
): readonly [PaymentTraceNodeIdV1, PaymentTraceNodeIdV1] {
  return PAYMENT_TRACE_ENDPOINTS_V1[edgeId]
}

export function paymentTraceTokenIsSafeV1(
  value: string | null,
): value is string {
  if (value === null) return false
  return /^[a-z0-9][a-z0-9_]{0,31}$/iu.test(value)
}

export function paymentTraceLabelIsSafeV1(value: string): boolean {
  if (value.length === 0 || value.length > 80) return false
  if (!/^[a-z0-9 .,:;/()&+'·_\-]+$/iu.test(value)) return false
  if (/https?:|client[_ -]?secret|redirect[_ -]?url/iu.test(value)) return false
  if (/\b(?:pay|order|attempt|pi)_[a-z0-9]{8,}\b/iu.test(value)) return false
  if (/(?:\d[ -]?){12,19}/u.test(value)) return false
  return true
}

export function paymentTraceConnectorIsObservedV1(
  attempt: PaymentTraceAttemptV1,
): boolean {
  if (!paymentTraceTokenIsSafeV1(attempt.connector)) return false
  switch (attempt.proof) {
    case "server_create":
    case "server_retrieve":
    case "recorded_sandbox":
    case "simulation":
      return true
    case "merchant_db":
    case "browser_handoff":
    case "merchant_rule":
    case "source_determined":
    case "unproven":
      return false
    default: {
      const exhaustive: never = attempt.proof
      return exhaustive
    }
  }
}

export function paymentTraceChargeIsAuthoritativeV1(
  attempt: PaymentTraceAttemptV1,
): boolean {
  if (!attempt.charged) return true
  switch (attempt.proof) {
    case "server_retrieve":
    case "recorded_sandbox":
    case "simulation":
      return true
    case "server_create":
    case "merchant_db":
    case "browser_handoff":
    case "merchant_rule":
    case "source_determined":
    case "unproven":
      return false
    default: {
      const exhaustive: never = attempt.proof
      return exhaustive
    }
  }
}

export function paymentTraceTicketProofIsValidV1(
  frame: PaymentTraceFrameV1,
): boolean {
  if (frame.merchant.orderState !== "fulfilled") return false
  if (frame.merchant.itemCount <= 0) return false
  if (frame.merchant.ticketCount !== frame.merchant.itemCount) return false
  if (frame.orchestration.chargedAttemptCount !== 1) return false

  const chargedAttempts = frame.orchestration.attempts.filter(
    (attempt) =>
      attempt.charged && paymentTraceChargeIsAuthoritativeV1(attempt),
  )
  return chargedAttempts.length === 1
}

function proofAuthorizesEdgeV1(
  edgeId: PaymentTraceEdgeIdV1,
  proof: PaymentTraceFactProofV1,
): boolean {
  switch (edgeId) {
    case "buyer_merchant":
      return (
        proof === "server_create" ||
        proof === "merchant_db" ||
        proof === "browser_handoff" ||
        proof === "recorded_sandbox" ||
        proof === "simulation"
      )
    case "merchant_hyperswitch":
      return (
        proof === "server_create" ||
        proof === "recorded_sandbox" ||
        proof === "simulation"
      )
    case "hyperswitch_connector":
    case "connector_hyperswitch":
      return (
        proof === "server_create" ||
        proof === "server_retrieve" ||
        proof === "recorded_sandbox" ||
        proof === "simulation"
      )
    case "hyperswitch_retrieve":
    case "reconcile_merchant":
      return (
        proof === "server_retrieve" ||
        proof === "recorded_sandbox" ||
        proof === "simulation"
      )
    case "merchant_tickets":
      return (
        proof === "merchant_db" ||
        proof === "recorded_sandbox" ||
        proof === "simulation"
      )
    default: {
      const exhaustive: never = edgeId
      return exhaustive
    }
  }
}

export function paymentTraceEdgeIsObservedV1(
  frame: PaymentTraceFrameV1,
  edge: PaymentTraceEdgeV1,
): boolean {
  if (edge.state === "possible") return false
  if (!proofAuthorizesEdgeV1(edge.id, edge.proof)) return false

  if (
    edge.id === "hyperswitch_connector" ||
    edge.id === "connector_hyperswitch"
  ) {
    if (edge.attemptOrdinal === null) return false
    const attempt = frame.orchestration.attempts.find(
      (candidate) => candidate.ordinal === edge.attemptOrdinal,
    )
    return Boolean(attempt && paymentTraceConnectorIsObservedV1(attempt))
  }

  if (edge.attemptOrdinal !== null) return false
  if (edge.id === "merchant_tickets" && edge.state === "success") {
    return paymentTraceTicketProofIsValidV1(frame)
  }
  return true
}

function handoffContextMatchesPlaybackV1(
  playback: PaymentTracePlaybackV1,
): boolean {
  switch (playback.kind) {
    case "static":
      return false
    case "live_event":
      return playback.handoff.context === "live"
    case "replay_event":
      return (
        playback.handoff.context === "recorded_sandbox" ||
        playback.handoff.context === "simulation"
      )
    default: {
      const exhaustive: never = playback
      return exhaustive
    }
  }
}

export function paymentTracePlaybackIsAuthorizedV1(
  frame: PaymentTraceFrameV1,
  playback: PaymentTracePlaybackV1,
): playback is Exclude<PaymentTracePlaybackV1, { readonly kind: "static" }> {
  if (!handoffContextMatchesPlaybackV1(playback)) return false
  if (playback.kind === "static") return false

  const handoff = playback.handoff
  if (!/^evt_[a-z0-9]{12,40}$/u.test(handoff.eventId)) return false
  if (!paymentTraceLabelIsSafeV1(handoff.label)) return false
  const endpoints = paymentTraceEndpointsV1(handoff.edgeId)
  if (endpoints[0] !== handoff.source || endpoints[1] !== handoff.target) {
    return false
  }
  if (handoff.evidenceRevision !== frame.revision) return false

  const edge = frame.edges.find((candidate) => candidate.id === handoff.edgeId)
  if (!edge || !paymentTraceEdgeIsObservedV1(frame, edge)) return false
  if (edge.attemptOrdinal !== handoff.attemptOrdinal) return false
  if (edge.proof !== handoff.authorityProof) return false

  if (
    handoff.edgeId === "hyperswitch_connector" ||
    handoff.edgeId === "connector_hyperswitch"
  ) {
    if (handoff.attemptOrdinal === null) return false
    const attempt = frame.orchestration.attempts.find(
      (candidate) => candidate.ordinal === handoff.attemptOrdinal,
    )
    if (!attempt || !paymentTraceConnectorIsObservedV1(attempt)) return false
  } else if (handoff.attemptOrdinal !== null) {
    return false
  }

  if (
    handoff.edgeId === "merchant_tickets" &&
    !paymentTraceTicketProofIsValidV1(frame)
  ) {
    return false
  }

  return true
}

export function paymentTraceVisibleAttemptsV1(
  orchestration: PaymentTraceOrchestrationV1,
): PaymentTraceVisibleAttemptsV1 {
  if (orchestration.attempts.length <= 2) {
    return { attempts: orchestration.attempts, overflowCount: 0 }
  }

  const lowest = orchestration.attempts.reduce((candidate, attempt) =>
    attempt.ordinal < candidate.ordinal ? attempt : candidate,
  )
  const terminal = orchestration.winningAttemptOrdinal === null
    ? orchestration.attempts[orchestration.attempts.length - 1]
    : orchestration.attempts.find(
        (attempt) => attempt.ordinal === orchestration.winningAttemptOrdinal,
      ) ?? orchestration.attempts[orchestration.attempts.length - 1]

  if (lowest.ordinal === terminal.ordinal) {
    return {
      attempts: [lowest],
      overflowCount: orchestration.attempts.length - 1,
    }
  }
  return {
    attempts: [lowest, terminal],
    overflowCount: orchestration.attempts.length - 2,
  }
}

export function paymentTraceTravelDurationMsV1(
  edgeId: PaymentTraceEdgeIdV1,
  layout: "rail" | "wide",
): number {
  if (
    edgeId === "hyperswitch_connector" ||
    edgeId === "connector_hyperswitch"
  ) {
    return layout === "rail" ? 520 : 480
  }
  if (
    edgeId === "hyperswitch_retrieve" ||
    edgeId === "reconcile_merchant" ||
    edgeId === "merchant_tickets"
  ) {
    return layout === "rail" ? 1_300 : 1_200
  }
  return layout === "rail" ? 620 : 560
}

export function paymentTraceOutcomeLabelV1(
  outcome: PaymentTraceAttemptOutcomeV1,
): string {
  switch (outcome) {
    case "requires_method":
      return "REQUIRES METHOD"
    case "action_required":
      return "ACTION REQUIRED"
    case "processing":
      return "PROCESSING"
    case "hard_decline":
      return "HARD DECLINE"
    case "technical_failure":
      return "TECHNICAL FAIL"
    case "uncertain":
      return "UNCERTAIN"
    case "succeeded":
      return "SUCCEEDED"
    default: {
      const exhaustive: never = outcome
      return exhaustive
    }
  }
}
