import {
  summarizeRecordedRunV1,
  type RecordedRunAttemptOutcomeV1,
  type RecordedRunEventV1,
  type RecordedRunOutcomeV1,
  type RecordedRunPopulationV1,
  type RecordedRunSummaryV1,
  type RecordedRunTraceV1,
} from "../../src/onsale/contracts/recorded-run-v1"
import type {
  RecordedRunSummary,
  ReplayActor,
  ReplayAttempt,
  ReplayFlow,
  ReplayStep,
} from "./replay"

export interface RecordedRunProjectionV1 {
  readonly run: RecordedRunSummary
  readonly flow: ReplayFlow
}

const OUTCOME_COPY: Readonly<
  Record<RecordedRunOutcomeV1, {
    readonly problem: string
    readonly importance: string
  }>
> = {
  fulfilled: {
    problem:
      "A browser result cannot safely authorize ticket fulfillment on its own.",
    importance:
      "The retained server facts reconcile exact money and ticket issuance for this run.",
  },
  action_required: {
    problem:
      "Provider-owned customer action interrupts checkout without proving payment completion.",
    importance:
      "The held order can remain pending while the same payment is retrieved after the action.",
  },
  declined: {
    problem:
      "A terminal payment failure must not be mistaken for a fulfilled order.",
    importance:
      "The retained facts keep an uncharged failure separate from ticket issuance.",
  },
  recoverable_failure: {
    problem:
      "A technical payment failure may be recoverable, but retained facts do not prove a retry policy.",
    importance:
      "The run preserves the observed failure without inventing a connector cascade.",
  },
  processing: {
    problem:
      "An in-flight payment cannot yet authorize a ticket or a final buyer claim.",
    importance:
      "The run remains pending until a later server observation resolves the same payment.",
  },
  uncertain: {
    problem:
      "A missing or ambiguous response leaves the merchant without a safe terminal decision.",
    importance:
      "A retained retrieve operation can resolve the existing payment without creating another one.",
  },
  integrity_review: {
    problem:
      "The retained money or fulfillment tuple is internally inconsistent.",
    importance:
      "The product withholds a success claim and exposes the run for integrity review.",
  },
}

export function recordedRunPopulationLabelV1(
  population: RecordedRunPopulationV1,
): "LOCAL BROWSER RECORD" | "RETAINED HOSTED RECORD" {
  return population === "local_browser"
    ? "LOCAL BROWSER RECORD"
    : "RETAINED HOSTED RECORD"
}

function displayToken(value: string): string {
  return value
    .split(/[_.:-]+/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ")
}

function canonicalStatus(trace: RecordedRunTraceV1): string {
  switch (trace.payment.state) {
    case "requires_method":
      return "requires_payment_method"
    case "action_required":
      return "requires_customer_action"
    case "exhausted":
      return "failed"
    default:
      return trace.payment.state
  }
}

function attemptStatus(outcome: RecordedRunAttemptOutcomeV1 | null): string | null {
  switch (outcome) {
    case "requires_method":
      return "payment_method_awaited"
    case "action_required":
      return "authentication_pending"
    case "processing":
      return "processing"
    case "hard_decline":
      return "failure"
    case "technical_failure":
      return "technical_failure"
    case "uncertain":
      return "unknown"
    case "succeeded":
      return "charged"
    case null:
      return null
  }
}

function actorForEvent(event: RecordedRunEventV1): ReplayActor {
  switch (event.kind) {
    case "create_requested":
      return "merchant"
    case "retrieve_requested":
      return "reconcile"
    case "create_observed":
    case "webhook_observed":
      return "hyperswitch"
    case "retrieve_observed":
      return "reconcile"
    case "tickets_issued":
      return "ticket"
    case "state_recorded":
      return "merchant"
  }
}

function titleForEvent(event: RecordedRunEventV1): string {
  switch (event.kind) {
    case "create_requested":
      return "Create operation retained"
    case "retrieve_requested":
      return "Retrieve operation retained"
    case "create_observed":
      return "Create result recorded"
    case "retrieve_observed":
      return "Retrieve result recorded"
    case "webhook_observed":
      return "Webhook fact recorded"
    case "tickets_issued":
      return "Ticket consequence recorded"
    case "state_recorded":
      return "Merchant state recorded"
  }
}

function annotationForEvent(event: RecordedRunEventV1): string {
  switch (event.kind) {
    case "create_requested":
      return "The merchant retained the create operation. This operation alone does not prove a provider result."
    case "retrieve_requested":
      return "The merchant retained a retrieval of the existing payment. The operation does not create or confirm another payment."
    case "create_observed":
      return "A provider result was retained as a static fact because this row is not linked to a replayable causal edge."
    case "retrieve_observed":
      return "A retrieval result was retained as a static fact. Only the linked request can animate the causal edge."
    case "webhook_observed":
      return "A webhook observation was retained as a static fact; delivery ordering is not inferred."
    case "tickets_issued":
      return "The merchant database retained the ticket consequence after payment reconciliation."
    case "state_recorded":
      return "The merchant database retained this terminal or pending state without inventing an upstream operation."
  }
}

function stepForEvent(
  event: RecordedRunEventV1,
  trace: RecordedRunTraceV1,
): ReplayStep {
  const attempt = event.attemptOrdinal === null
    ? trace.attempts.at(-1) ?? null
    : trace.attempts[event.attemptOrdinal - 1] ?? null
  const isOperation =
    event.kind === "create_requested" || event.kind === "retrieve_requested"
  const isConsequence =
    event.kind === "retrieve_observed" ||
    event.kind === "tickets_issued" ||
    event.kind === "state_recorded"
  const motion = event.replayable && event.edge !== null
    ? {
        edgeId: event.edge,
        authorityProof: event.kind === "create_requested"
          ? "server_create" as const
          : "server_retrieve" as const,
        attemptOrdinal: event.attemptOrdinal,
      }
    : undefined

  return {
    id: event.eventRef,
    actor: actorForEvent(event),
    title: titleForEvent(event),
    canonicalStatus: isOperation ? "operation_recorded" : canonicalStatus(trace),
    attemptStatus: isOperation ? null : attemptStatus(attempt?.outcome ?? null),
    connector: isOperation ? null : attempt?.connector ?? null,
    attemptCount: isOperation ? null : trace.attempts.length,
    amountReceivedMinor: isConsequence
      ? trace.money.amountReceivedMinor
      : null,
    annotation: annotationForEvent(event),
    evidenceClass: "live_sandbox_recorded",
    evidenceRef: event.evidenceRef,
    ...(motion === undefined ? {} : { motion }),
  }
}

function projectAttempt(attempt: RecordedRunTraceV1["attempts"][number]): ReplayAttempt {
  return {
    ordinal: attempt.ordinal,
    method: attempt.method?.type ?? attempt.method?.family ?? null,
    connector: attempt.connector,
    outcome: attempt.outcome,
    charged: attempt.charged,
    retryRelation: attempt.ordinal === 1 ? "initial" : "not_observed",
    failureClass:
      attempt.failureClass === "configuration" ||
      attempt.failureClass === "integration"
        ? "unknown"
        : attempt.failureClass,
    evidenceClass: "live_sandbox_recorded",
    evidenceRef: attempt.evidenceRef,
  }
}

function operationSemantics(trace: RecordedRunTraceV1): string {
  const retained = trace.events
    .filter((event) => event.replayable)
    .map((event) =>
      event.kind === "create_requested" ? "CREATE RETAINED" : "RETRIEVE RETAINED",
    )
  return retained.length === 0
    ? "STATIC RETAINED FACTS · NO CAUSAL REPLAY"
    : retained.join(" → ")
}

function assertMatchingSummary(
  summary: RecordedRunSummaryV1,
  trace: RecordedRunTraceV1,
): void {
  const expected = summarizeRecordedRunV1(trace, summary.recordedAt)
  if (JSON.stringify(summary) !== JSON.stringify(expected)) {
    throw new TypeError("Recorded run summary does not match its retained trace")
  }
}

export function projectRecordedRunV1(
  summary: RecordedRunSummaryV1,
  trace: RecordedRunTraceV1,
): RecordedRunProjectionV1 {
  if (
    (summary as { readonly population?: unknown }).population ===
      "local_simulation" ||
    (trace as { readonly population?: unknown }).population ===
      "local_simulation"
  ) {
    throw new TypeError("A simulation cannot enter Recorded Runs")
  }
  assertMatchingSummary(summary, trace)

  const label = recordedRunPopulationLabelV1(trace.population)
  const outcome = OUTCOME_COPY[summary.outcome]
  const attempts = trace.attempts.map(projectAttempt)
  const steps = trace.events.map((event) => stepForEvent(event, trace))
  const method = trace.payment.selectedMethod === null
    ? "Not retained"
    : displayToken(
        trace.payment.selectedMethod.type ?? trace.payment.selectedMethod.family!,
      )
  const connector = summary.observedConnectors[0] ?? null
  const recordedDate = summary.recordedAt.slice(0, 10)
  const recordedTime = `${summary.recordedAt.slice(11, 16)} UTC`
  const limitation = trace.limitations.map((item) => item.message).join(" ")
  const flow: ReplayFlow = {
    id: trace.runRef,
    label: `Run ${trace.runRef.slice(-6).toUpperCase()}`,
    kicker: `${label} · ${trace.events.length} RETAINED EVENTS`,
    matrixCaseIds: [],
    proof: "live_sandbox_recorded",
    observedAt: recordedDate,
    problem: outcome.problem,
    productRule:
      "Treat retained server observations as authority; animate only create or retrieve operations whose ordering is durably linked.",
    limitation,
    notice:
      trace.replay.eligible
        ? "Replay follows retained create and retrieve operation order. Unlinked facts remain static."
        : "No retained operation authorizes causal motion. All facts remain static.",
    attempts,
    steps,
  }
  return {
    flow,
    run: {
      id: trace.runRef,
      flowId: trace.runRef,
      orderLabel: null,
      observedAt: recordedDate,
      observedTime: recordedTime,
      amountMinor: trace.money.amountDueMinor,
      currency: trace.money.currency,
      itemCount: trace.order.itemCount,
      outcome: summary.outcome,
      proof: "live_sandbox_recorded",
      method,
      connector,
      attemptCount: trace.attempts.length,
      chargedAttemptCount: trace.consequence.chargeCount,
      ticketCount: trace.consequence.ticketCount,
      canonicalPaymentState: trace.payment.state,
      attemptState: attemptStatus(trace.attempts.at(-1)?.outcome ?? null) ?? "not_observed",
      evidenceSource: `${label} · SANITIZED DURABLE READ MODEL`,
      operationSemantics: operationSemantics(trace),
      proofLabel: label,
      problem: outcome.problem,
      hyperswitchRole:
        "Expose canonical payment observations while the merchant retains order, fulfillment, and ticket authority.",
      importance: outcome.importance,
      limitation,
      attempts,
    },
  }
}
