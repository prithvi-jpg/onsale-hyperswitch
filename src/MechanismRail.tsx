import { useEffect, useRef, useState } from 'react'

import PaymentTraceMapV1, {
  paymentTraceConnectorIsObservedV1,
  paymentTraceTicketProofIsValidV1,
  paymentTraceVisibleAttemptsV1,
  type PaymentTraceAttemptV1,
  type PaymentTraceEdgeIdV1,
  type PaymentTraceEdgeV1,
  type PaymentTraceFactProofV1,
  type PaymentTraceFrameV1,
  type PaymentTraceHandoffV1,
  type PaymentTraceNodeIdV1,
  type PaymentTraceNodeV1,
  type PaymentTraceNodeStateV1,
  type PaymentTraceOrchestrationV1,
  type PaymentTracePlaybackV1,
} from "./PaymentTraceMap"
import type { RecordedRunRefV1 } from "./onsale/contracts/recorded-run-v1"

// ─── Types ─────────────────────────────────────────────────────────────────
export interface InventoryRailEvidence {
  mode: "inventory"
  state: "loading" | "preview" | "draft" | "quoting" | "quoted" | "claiming" | "held" | "releasing" | "expiry_required" | "expiring" | "blocked"
  selectedSeatCount: number
  heldSeatCount: number
  totalMinor: number | null
  currency: string
  expiresAt: string | null
  revision: string | null
  serverTime?: string | null
  message?: string
  onReconcile?: () => void
  checkout?: CheckoutRailEvidence
}

export interface CheckoutRailEvidence {
  stage: "checkout_ready" | "checking_same_payment" | "action_required" | "processing" | "declined" | "recoverable_failure" | "fulfilled" | "expired" | "review_required"
  orderState: "awaiting_payment" | "payment_pending" | "paid" | "fulfilled" | "canceled"
  itemCount: number
  ticketCount: number
  totalMinor: number
  currency: string
  paymentDeadlineAt: string
  canonicalState: "requires_method" | "action_required" | "processing" | "succeeded" | "exhausted" | "uncertain"
  integrityState: "clear" | "review_required"
  observationSource: "create" | "retrieve" | null
  selectedMethod: { family: string | null; type: string | null } | null
  observedConnector: string | null
  attempts: readonly {
    ordinal: number
    state: "requires_method" | "action_required" | "processing" | "hard_decline" | "technical_failure" | "uncertain" | "succeeded"
    charged: boolean
    hardDecline: boolean
    connector: string | null
  }[]
  chargedAttemptCount: number
  evidenceGeneration: number
  evidenceRevision: string
  retryPermitted: boolean
  retryReason: string
  requestState: "idle" | "preparing" | "reconciling" | "confirming" | "blocked"
  recordedRunRef?: RecordedRunRefV1 | null
  onReconcile?: () => void
}

// ─── Tokens ────────────────────────────────────────────────────────────────
const B    = '#006DF9'
const B05  = 'rgba(0,109,249,0.05)'
const GREEN  = '#22C55E'
const RED    = '#EF4444'
const AMBER  = '#F59E0B'
const MONO   = "'JetBrains Mono', monospace"

// ─── Shared panel atoms ────────────────────────────────────────────────────
function InfoRow({ label, value, color,
}: { label: string
  value: string
  color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6, padding: '3px 0', borderBottom: '1px solid rgba(0,109,249,0.05)',
      }}
    >
      <span style={{ fontFamily: MONO, fontSize: 8.5, color: 'rgba(0,0,0,0.32)', letterSpacing: '0.08em', flexShrink: 0,
        }}
      >
        {label}
      </span>
      <span style={{ fontFamily: MONO, fontSize: 9, color: color ?? '#1a1a1a', textAlign: 'right', letterSpacing: '0.03em', wordBreak: 'break-all',
        }}
      >
        {value}
      </span>
    </div>
  )
}

function Panel({ title, badge, badgeColor = B, children, active,
}: {
  title: string
  badge?: string
  badgeColor?: string
  children: React.ReactNode
  active?: boolean
}) {
  const [open, setOpen] = useState(true)
  return (
    <div style={{ border: `1px solid ${active ? B : 'rgba(0,109,249,0.10)'}`, marginBottom: 6, transition: 'border-color 0.4s',
      }}
    >
      <button type="button" data-mechanism-panel aria-expanded={open}
        onClick={() => setOpen((o) => !o)} style={{
        width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '6px 10px', background: active ? B05 : '#fafcff',
        borderTop: 'none', borderLeft: 'none', borderRight: 'none',
        borderBottom: open ? `1px solid ${
                active ? 'rgba(0,109,249,0.1)' : 'rgba(0,109,249,0.05)'
              }` : 'none',
        cursor: 'pointer',
      }}
      >
        <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 600, color: active ? B : 'rgba(0,109,249,0.35)', letterSpacing: '0.12em',
          }}
        >
          {title}
        </span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {badge && (
            <span style={{ fontFamily: MONO, fontSize: 7.5, color: badgeColor, border: `1px solid ${badgeColor}50`, padding: '1px 5px', letterSpacing: '0.1em',
              }}
            >
              {badge}
            </span>
          )}
          <span style={{ fontFamily: MONO, fontSize: 9, color: '#ccc' }}>
            {open ? '−' : '+'}
          </span>
        </div>
      </button>
      {open && <div style={{ padding: '8px 10px' }}>{children}</div>}
    </div>
  )
}

function formatRailMoney(amountMinor: number | null, currency: string): string {
  if (amountMinor === null) return "—"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amountMinor / 100)
}

function countedRailNounV1(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`
}

interface ApprovedProductionTraceV1 {
  readonly frame: PaymentTraceFrameV1
  readonly headline: string
  readonly handoffSource: PaymentTraceNodeIdV1
  readonly handoffLabel: string
  readonly handoffMeaning: string
  readonly sequence: readonly string[]
  readonly integrityClear: boolean
}

function productionProofV1(
  checkout: CheckoutRailEvidence,
): PaymentTraceFactProofV1 {
  if (checkout.observationSource === "retrieve") return "server_retrieve"
  if (checkout.observationSource === "create") return "server_create"
  return "unproven"
}

function productionMerchantStateV1(
  checkout: CheckoutRailEvidence,
): PaymentTraceFrameV1["merchant"]["orderState"] {
  if (
    checkout.integrityState === "review_required" ||
    checkout.stage === "review_required"
  ) return "review"
  if (checkout.orderState === "fulfilled") return "fulfilled"
  if (checkout.orderState === "paid") return "paid"
  if (checkout.orderState === "payment_pending") return "payment_pending"
  return "held"
}

function productionAttemptStateV1(
  attempt: PaymentTraceAttemptV1 | undefined,
): PaymentTraceNodeStateV1 {
  if (!attempt) return "future"
  switch (attempt.outcome) {
    case "requires_method": return "current"
    case "action_required": return "action_required"
    case "processing":
    case "uncertain": return "processing"
    case "hard_decline":
    case "technical_failure": return "declined"
    case "succeeded": return "succeeded"
  }
}

function productionTerminalV1(
  checkout: CheckoutRailEvidence,
  integrityClear: boolean,
): PaymentTraceOrchestrationV1["terminal"] {
  if (!integrityClear) return "integrity_review"
  if (checkout.stage === "action_required") return "action_required"
  if (checkout.stage === "processing") return "processing"
  if (checkout.stage === "declined") return "declined"
  if (checkout.stage === "checking_same_payment") return "uncertain"
  if (checkout.canonicalState === "succeeded") return "succeeded"
  if (checkout.canonicalState === "uncertain") return "uncertain"
  return null
}

export function deriveApprovedProductionTraceV1(
	checkout: CheckoutRailEvidence,
	revision: string | number,
	merchantToHyperswitchCreated = checkout.observationSource === "create",
): ApprovedProductionTraceV1 {
  const proof = productionProofV1(checkout)
  const attempts: PaymentTraceAttemptV1[] = [...checkout.attempts]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((attempt) => ({
      ordinal: attempt.ordinal,
      methodAtAttempt: null,
      connector: attempt.connector,
      outcome: attempt.state,
      charged: attempt.charged,
      retryKind: "not_observed",
      failureClass: attempt.hardDecline
        ? "hard_decline"
        : attempt.state === "technical_failure"
          ? "technical"
          : null,
      proof,
    }))
  const chargedWinner = checkout.chargedAttemptCount === 1
    ? attempts.find((attempt) => attempt.charged && attempt.outcome === "succeeded")
    : undefined
  const selectedMethod = checkout.selectedMethod
    ? { ...checkout.selectedMethod, proof }
    : null
  const orchestration: PaymentTraceOrchestrationV1 = {
    selectedMethod,
    attempts,
    chargedAttemptCount: checkout.chargedAttemptCount,
    winningAttemptOrdinal: chargedWinner?.ordinal ?? null,
    terminal: null,
    orderRetained: false,
  }
  const merchant = {
    itemCount: checkout.itemCount,
    ticketCount: checkout.ticketCount,
    orderState: productionMerchantStateV1(checkout),
  } satisfies PaymentTraceFrameV1["merchant"]
  const latestAttempt = attempts.at(-1)
  const observedConnectorAttempts = attempts.filter(
    paymentTraceConnectorIsObservedV1,
  )
  const latestObservedConnectorAttempt = observedConnectorAttempts.at(-1)
  const retrieving =
    checkout.observationSource === "retrieve" ||
    checkout.stage === "checking_same_payment" ||
    checkout.requestState === "reconciling"
  const initiallyClear =
    checkout.integrityState === "clear" &&
    checkout.chargedAttemptCount <= 1
  const provisionalFrame: PaymentTraceFrameV1 = {
    revision,
    ariaLabel: "Live payment trace",
    merchant,
    orchestration,
    nodes: [],
    edges: [],
  }
  const fulfilledProofValid = paymentTraceTicketProofIsValidV1(provisionalFrame)
  const integrityClear =
    initiallyClear &&
    (checkout.stage !== "fulfilled" || fulfilledProofValid)
  const exactFulfillment = checkout.stage === "fulfilled" && integrityClear
  const settledOrchestration: PaymentTraceOrchestrationV1 = {
    ...orchestration,
    terminal: productionTerminalV1(checkout, integrityClear),
  }

  const headline = exactFulfillment
    ? `${checkout.ticketCount} TICKETS ISSUED · CHARGED ONCE`
    : !integrityClear
      ? "INTEGRITY REVIEW REQUIRED"
      : checkout.stage === "checkout_ready"
        ? "CHOOSE A PAYMENT METHOD"
        : checkout.stage === "checking_same_payment"
          ? "CHECKING THIS SAME PAYMENT"
          : checkout.stage === "action_required"
            ? "OFFICIAL APPROVAL REQUIRED"
            : checkout.stage === "processing"
              ? "PAYMENT IS STILL PROCESSING"
              : checkout.stage === "declined"
                ? "PAYMENT NOT APPROVED"
                : checkout.stage === "expired"
                  ? "CHECKOUT EXPIRED"
                  : "OUTCOME UNKNOWN · DO NOT RESUBMIT"

  const nodes: PaymentTraceNodeV1[] = [
    {
      id: "buyer",
      label: "BUYER",
      detail: `${checkout.itemCount} seat order`,
      state: "traversed",
      proof: "merchant_db",
    },
    {
      id: "merchant",
      label: "ONSALE / MERCHANT",
      detail: merchant.orderState.replace(/_/gu, " "),
      state: integrityClear ? "traversed" : "integrity_review",
      proof: "merchant_db",
    },
    {
      id: "hyperswitch",
      label: "HYPERSWITCH",
      detail: checkout.canonicalState.replace(/_/gu, " "),
      state: checkout.stage === "checkout_ready" ? "current" : "traversed",
      proof,
    },
    {
      id: "connector",
      label: "OBSERVED CONNECTOR",
      detail: latestObservedConnectorAttempt
        ? `${observedConnectorAttempts.length} observed attempt${
            observedConnectorAttempts.length === 1 ? "" : "s"
          }`
        : "no attempt observed",
      state: productionAttemptStateV1(latestObservedConnectorAttempt),
      proof: latestObservedConnectorAttempt?.proof ?? "unproven",
    },
    {
      id: "reconcile",
      label: "RECONCILE",
      detail: retrieving ? "same payment observed" : "same payment only",
      state: checkout.stage === "checking_same_payment"
        ? "current"
        : checkout.observationSource === "retrieve"
          ? "traversed"
          : "future",
      proof: checkout.observationSource === "retrieve"
        ? "server_retrieve"
        : "unproven",
    },
    {
      id: "tickets",
      label: "TICKETS",
      detail: `${checkout.ticketCount} of ${checkout.itemCount}`,
      state: exactFulfillment
        ? "succeeded"
        : integrityClear
          ? "future"
          : "integrity_review",
      proof: exactFulfillment ? "merchant_db" : "unproven",
    },
  ]
  const attemptOrdinal = latestObservedConnectorAttempt?.ordinal ?? null
  const attemptEdgeState = latestObservedConnectorAttempt
    ? latestObservedConnectorAttempt.outcome === "hard_decline" ||
      latestObservedConnectorAttempt.outcome === "technical_failure"
      ? "failure"
      : latestObservedConnectorAttempt.outcome === "succeeded"
        ? "traversed"
        : "current"
    : "possible"
  const edges: PaymentTraceEdgeV1[] = [
    { id: "buyer_merchant", state: "traversed", attemptOrdinal: null, proof: "merchant_db" },
    {
      id: "merchant_hyperswitch",
      state: merchantToHyperswitchCreated ? "traversed" : "possible",
      attemptOrdinal: null,
      proof: merchantToHyperswitchCreated ? "server_create" : "unproven",
    },
    { id: "hyperswitch_connector", state: attemptEdgeState, attemptOrdinal, proof: latestObservedConnectorAttempt?.proof ?? "unproven" },
    {
      id: "connector_hyperswitch",
      state: latestObservedConnectorAttempt
        ? latestObservedConnectorAttempt.outcome === "hard_decline" || latestObservedConnectorAttempt.outcome === "technical_failure"
          ? "failure"
          : latestObservedConnectorAttempt.outcome === "action_required" || latestObservedConnectorAttempt.outcome === "processing"
            ? "possible"
            : "traversed"
        : "possible",
      attemptOrdinal,
      proof: latestObservedConnectorAttempt?.proof ?? "unproven",
    },
    {
      id: "hyperswitch_retrieve",
      state: checkout.stage === "checking_same_payment"
        ? "current"
        : checkout.observationSource === "retrieve"
          ? "traversed"
          : "possible",
      attemptOrdinal: null,
      proof: checkout.observationSource === "retrieve" ? "server_retrieve" : "unproven",
    },
    {
      id: "reconcile_merchant",
      state: exactFulfillment || checkout.observationSource === "retrieve"
        ? "traversed"
        : "possible",
      attemptOrdinal: null,
      proof: checkout.observationSource === "retrieve" ? "server_retrieve" : "unproven",
    },
    {
      id: "merchant_tickets",
      state: exactFulfillment ? "success" : "possible",
      attemptOrdinal: null,
      proof: exactFulfillment ? "merchant_db" : "unproven",
    },
  ]
  const sequence = [
    "BUYER → ONSALE · ORDER RETAINED",
    `ONSALE → HYPERSWITCH · ${checkout.observationSource === "retrieve" ? "SAME PAYMENT RETRIEVED" : "PAYMENT CREATED"}`,
    ...(latestObservedConnectorAttempt
      ? [`HYPERSWITCH ↔ OBSERVED CONNECTOR · ATTEMPT ${String(latestObservedConnectorAttempt.ordinal).padStart(2, "0")}`]
      : latestAttempt
        ? [`HYPERSWITCH · ${productionDisplayTokenV1(latestAttempt.outcome)}`]
      : []),
    ...(retrieving ? ["HYPERSWITCH → RECONCILE · SAME PAYMENT"] : []),
    ...(exactFulfillment
      ? [`ONSALE → TICKETS · ${checkout.ticketCount} OF ${checkout.itemCount}`]
      : []),
  ]
  const handoffSource: PaymentTraceNodeIdV1 = exactFulfillment
    ? "merchant"
    : !integrityClear
      ? "reconcile"
      : checkout.stage === "checking_same_payment"
        ? "hyperswitch"
        : latestAttempt
          ? "hyperswitch"
          : "merchant"
  const handoffLabel = exactFulfillment
    ? `ONSALE → TICKETS · ${checkout.ticketCount} OF ${checkout.itemCount} ISSUED`
    : !integrityClear
      ? "RECONCILE → ONSALE · INTEGRITY REVIEW"
      : checkout.stage === "checking_same_payment"
        ? "HYPERSWITCH → RECONCILE · SAME PAYMENT"
        : latestObservedConnectorAttempt
          ? `HYPERSWITCH ↔ OBSERVED CONNECTOR · ATTEMPT ${String(latestObservedConnectorAttempt.ordinal).padStart(2, "0")}`
          : latestAttempt
            ? `HYPERSWITCH · ${productionDisplayTokenV1(latestAttempt.outcome)}`
          : "ONSALE → HYPERSWITCH · METHOD REQUIRED"
  const handoffMeaning = exactFulfillment
    ? "One authoritative charge and exact ticket cardinality are present."
    : !integrityClear
      ? "Ticket completion is withheld because the money and order facts do not reconcile."
      : checkout.stage === "checking_same_payment"
        ? "The existing Hyperswitch payment is retrieved before any new submission."
        : "Only the observed payment state is shown; no causal explanation is inferred."

  return {
    frame: {
      revision,
      ariaLabel: `Live payment trace. ${headline}`,
      merchant,
      orchestration: settledOrchestration,
      nodes,
      edges,
    },
    headline,
    handoffSource,
    handoffLabel,
    handoffMeaning,
    sequence,
    integrityClear,
  }
}

export interface ProductionHandoffPresentationV1 {
	readonly authority: "frame" | "in_flight" | "arrived"
	readonly authorityNode: PaymentTraceNodeIdV1
	readonly label: string
	readonly meaning: string
}

export function productionHandoffPresentationV1(
	derived: ApprovedProductionTraceV1,
	playback: PaymentTracePlaybackV1,
	arrived: PaymentTraceHandoffV1 | null,
): ProductionHandoffPresentationV1 {
	if (
		playback.kind === "live_event" &&
		playback.handoff.evidenceRevision === derived.frame.revision
	) {
		const arrivedForPlayback =
			arrived?.context === "live" &&
			arrived.eventId === playback.handoff.eventId &&
			arrived.evidenceRevision === playback.handoff.evidenceRevision
				? arrived
				: null
		if (playback.handoff.authorityProof === "browser_handoff") {
			return arrivedForPlayback
				? {
						authority: "arrived",
						authorityNode: playback.handoff.target,
						label: "OFFICIAL CHECKOUT ACTIVATION REACHED ONSALE",
						meaning:
							"ONSALE handed control to the official checkout. Payment outcome remains unknown.",
					}
				: {
						authority: "in_flight",
						authorityNode: playback.handoff.source,
						label: playback.handoff.label,
						meaning:
							"Only the buyer activation is known. Payment outcome remains unknown.",
					}
		}
		if (playback.handoff.edgeId === "merchant_tickets") {
			return arrivedForPlayback
				? {
						authority: "arrived",
						authorityNode: "tickets",
						label: "ONSALE → TICKETS · VERIFIED TICKETS ISSUED",
						meaning:
							"One authoritative charge and exact ticket cardinality reached the ticket result.",
					}
				: {
						authority: "in_flight",
						authorityNode: "merchant",
						label: playback.handoff.label,
						meaning:
							"ONSALE is revealing the verified ticket result. No extra charge or ticket is inferred.",
					}
		}
		if (arrivedForPlayback) {
			return {
				authority: "arrived",
				authorityNode: arrivedForPlayback.target,
				label: "RECONCILE → ONSALE · SAME PAYMENT RETURNED",
				meaning:
					"One new authoritative retrieve response arrived without changing the retained payment facts.",
			}
		}
		return {
			authority: "in_flight",
			authorityNode: playback.handoff.source,
			label: "HYPERSWITCH → RECONCILE · CHECKING SAME PAYMENT",
			meaning:
				"The existing payment is being checked. No result is announced until the retrieve arrives.",
		}
	}

	return {
		authority: "frame",
		authorityNode: derived.handoffSource,
		label: derived.handoffLabel,
		meaning: derived.handoffMeaning,
	}
}

function productionDisplayTokenV1(value: string | null): string {
  if (!value) return "NOT OBSERVED"
  return value.replace(/_/gu, " ").toUpperCase()
}

export function productionLivePlaybackV1(
  previous: CheckoutRailEvidence | null,
  current: CheckoutRailEvidence,
  frameRevision: string | number,
): PaymentTracePlaybackV1 {
  if (previous === null) return { kind: "static", reason: "hydrate" }
  if (
    previous.requestState !== "confirming" &&
    current.requestState === "confirming"
  ) {
    const revisionToken = current.evidenceRevision
      .replace(/^sha256:/u, "")
      .slice(0, 24)
    if (!/^[a-f0-9]{24}$/u.test(revisionToken)) {
      return { kind: "static", reason: "catch_up" }
    }
    return {
      kind: "live_event",
      handoff: {
        context: "live",
        eventId: `evt_${revisionToken}`,
        sequence: current.evidenceGeneration,
        edgeId: "buyer_merchant",
        source: "buyer",
        target: "merchant",
        attemptOrdinal: null,
        label: "Buyer activated official checkout",
        tone: "progress",
        authorityProof: "browser_handoff",
        evidenceRevision: frameRevision,
      },
    }
  }
  if (
    previous.evidenceRevision === current.evidenceRevision ||
    current.evidenceGeneration !== previous.evidenceGeneration + 1
  ) {
    return { kind: "static", reason: "catch_up" }
  }
  if (current.observationSource !== "retrieve") {
    return { kind: "static", reason: "catch_up" }
  }
  const revisionToken = current.evidenceRevision
    .replace(/^sha256:/u, "")
    .slice(0, 24)
  if (!/^[a-f0-9]{24}$/u.test(revisionToken)) {
    return { kind: "static", reason: "catch_up" }
  }
  const tone: PaymentTraceHandoffV1["tone"] =
    current.stage === "fulfilled"
      ? "success"
      : current.stage === "declined"
        ? "failure"
        : current.stage === "action_required"
          ? "action"
          : current.stage === "processing"
            ? "progress"
            : "unknown"
  const exactFulfillment =
    current.stage === "fulfilled" &&
    current.orderState === "fulfilled" &&
    current.itemCount > 0 &&
    current.ticketCount === current.itemCount &&
    current.chargedAttemptCount === 1 &&
    current.attempts.filter(
      (attempt) => attempt.charged && attempt.state === "succeeded",
    ).length === 1
  return {
    kind: "live_event",
    handoff: {
      context: "live",
      eventId: `evt_${revisionToken}`,
      sequence: current.evidenceGeneration,
      edgeId: exactFulfillment ? "merchant_tickets" : "reconcile_merchant",
      source: exactFulfillment ? "merchant" : "reconcile",
      target: exactFulfillment ? "tickets" : "merchant",
      attemptOrdinal: null,
      label: exactFulfillment
        ? "ONSALE issued the verified tickets"
        : "Same-payment retrieve returned",
      tone,
      authorityProof: exactFulfillment ? "merchant_db" : "server_retrieve",
      evidenceRevision: frameRevision,
    },
  }
}

function ApprovedProductionPanels({
	checkout,
	derived,
	attemptInspectorId,
	attemptsOpen,
	onToggleAttempts,
}: {
	checkout: CheckoutRailEvidence
	derived: ApprovedProductionTraceV1
	attemptInspectorId: string
	attemptsOpen: boolean
	onToggleAttempts: () => void
}) {
  const amount = formatRailMoney(checkout.totalMinor, checkout.currency)
  const attempts = derived.frame.orchestration.attempts
  const exactFulfillment = paymentTraceTicketProofIsValidV1(derived.frame)
  return (
    <>
      <Panel title="01 · POLICY" badge="SERVER CONTRACT" badgeColor={B} active>
        <InfoRow label="order" value={`${checkout.itemCount} immutable seats`} />
        <InfoRow label="amount" value={`${amount} all-in`} />
        <InfoRow label="payment surface" value="official HyperElements" />
        <InfoRow label="same-payment check" value="required before resubmission" />
      </Panel>
      <Panel
        title="02 · DECISION"
        badge={derived.integrityClear ? "OBSERVED" : "REVIEW"}
        badgeColor={derived.integrityClear ? B : RED}
        active
      >
        <InfoRow label="stage" value={checkout.stage.replace(/_/gu, " ")} />
        <InfoRow label="canonical" value={checkout.canonicalState.replace(/_/gu, " ")} />
        <InfoRow
          label="integrity"
          value={derived.integrityClear ? "CLEAR" : "REVIEW REQUIRED"}
          color={derived.integrityClear ? GREEN : RED}
        />
        <InfoRow label="retry eligible" value={checkout.retryPermitted ? "yes" : "no"} />
      </Panel>
		<section id={attemptInspectorId} className="production-attempt-disclosure">
			<button
				aria-controls={`${attemptInspectorId}-content`}
				aria-expanded={attemptsOpen}
				className="production-attempt-disclosure-toggle"
				data-testid="production-attempt-disclosure"
				id={`${attemptInspectorId}-toggle`}
				onClick={onToggleAttempts}
				type="button"
			>
				<span>03 · ATTEMPTS</span>
				<span>{attempts.length} OBSERVED · {attemptsOpen ? "HIDE" : "VIEW"}</span>
			</button>
			<div id={`${attemptInspectorId}-content`} hidden={!attemptsOpen}>
				{attempts.length === 0 ? (
					<InfoRow label="attempts" value="none observed" />
          ) : attempts.map((attempt) => (
            <InfoRow
              key={attempt.ordinal}
              label={`attempt ${String(attempt.ordinal).padStart(2, "0")}`}
              value={`${productionDisplayTokenV1(attempt.connector)} · ${attempt.outcome.replace(/_/gu, " ")} · ${attempt.charged ? "charged" : "not charged"} · ${attempt.proof.replace(/_/gu, " ")}`}
            />
          ))}
				{!derived.frame.orchestration.orderRetained && attempts.length > 1 && (
					<InfoRow label="chronology" value="attempt order not retained" color={AMBER} />
				)}
			</div>
		</section>
      <Panel
        title="04 · STATE"
        badge={exactFulfillment ? "ISSUED" : undefined}
        badgeColor={GREEN}
        active
      >
        <InfoRow label="order" value={derived.frame.merchant.orderState.replace(/_/gu, " ")} />
        <InfoRow
          label="money"
          value={checkout.chargedAttemptCount === 0
            ? `${amount} NOT CHARGED`
            : checkout.chargedAttemptCount === 1
              ? `${amount} CHARGED ONCE`
              : `${amount} · ${checkout.chargedAttemptCount} CHARGED ATTEMPTS`}
          color={checkout.chargedAttemptCount > 1 ? RED : checkout.chargedAttemptCount === 1 ? GREEN : undefined}
        />
        <InfoRow
          label="tickets"
          value={exactFulfillment
            ? `${checkout.ticketCount} OF ${checkout.itemCount} TICKETS ISSUED`
            : `${checkout.ticketCount} OF ${checkout.itemCount} · NOT PROVEN COMPLETE`}
          color={exactFulfillment ? GREEN : undefined}
        />
        <InfoRow
          label="integrity"
          value={`INTEGRITY · ${derived.integrityClear ? "CLEAR" : "REVIEW REQUIRED"}`}
          color={derived.integrityClear ? GREEN : RED}
        />
      </Panel>
      <Panel title="05 · EVIDENCE" badge="SANITIZED" badgeColor={B} active>
        <InfoRow label="source" value={checkout.observationSource ?? "not observed"} />
        <InfoRow label="revision" value={checkout.evidenceRevision} />
        <InfoRow label="generation" value={String(checkout.evidenceGeneration)} />
        <InfoRow label="ticket authority" value={exactFulfillment ? "merchant database" : "not proven"} />
      </Panel>
    </>
  )
}

function productionPreparingTraceFrameV1(
  inventory: InventoryRailEvidence,
  revision: string | number,
): PaymentTraceFrameV1 {
  const itemCount = Math.max(
    inventory.selectedSeatCount,
    inventory.heldSeatCount,
  )
  return {
    revision,
    ariaLabel:
      "Checkout preparation trace. Buyer asked ONSALE to secure the held order.",
    merchant: {
      itemCount,
      ticketCount: 0,
      orderState: "held",
    },
    orchestration: {
      selectedMethod: null,
      attempts: [],
      chargedAttemptCount: 0,
      winningAttemptOrdinal: null,
      terminal: null,
      orderRetained: false,
    },
    nodes: [
      {
        id: "buyer",
        label: "BUYER",
        detail: `${countedRailNounV1(itemCount, "held seat")} submitted`,
        state: "traversed",
        proof: "browser_handoff",
      },
      {
        id: "merchant",
        label: "ONSALE / MERCHANT",
        detail: "securing held order",
        state: "current",
        proof: "browser_handoff",
      },
      {
        id: "hyperswitch",
        label: "HYPERSWITCH",
        detail: "waiting for payment evidence",
        state: "future",
        proof: "unproven",
      },
      {
        id: "connector",
        label: "OBSERVED CONNECTOR",
        detail: "no attempt observed",
        state: "future",
        proof: "unproven",
      },
      {
        id: "reconcile",
        label: "RECONCILE",
        detail: "same-payment retrieve",
        state: "future",
        proof: "unproven",
      },
      {
        id: "tickets",
        label: "TICKETS",
        detail: "not issued",
        state: "future",
        proof: "unproven",
      },
    ],
    edges: [
      {
        id: "buyer_merchant",
        state: "current",
        attemptOrdinal: null,
        proof: "browser_handoff",
      },
      ...([
        "merchant_hyperswitch",
        "hyperswitch_connector",
        "connector_hyperswitch",
        "hyperswitch_retrieve",
        "reconcile_merchant",
        "merchant_tickets",
      ] satisfies readonly PaymentTraceEdgeIdV1[]).map((id) => ({
        id,
        state: "possible" as const,
        attemptOrdinal: null,
        proof: "unproven" as const,
      })),
    ],
  }
}

function ApprovedProductionMechanismRail({
  inventory,
  revision,
}: {
  inventory: InventoryRailEvidence
  revision: string | number
}) {
	const checkout = inventory.checkout
	const merchantToHyperswitchCreated = useRef(false)
	const derived = checkout
		? deriveApprovedProductionTraceV1(
			checkout,
			checkout.evidenceRevision || revision,
			merchantToHyperswitchCreated.current ||
				checkout.observationSource === "create",
		)
    : null
  const attemptInspectorId = "production-attempt-inspector"
  const nodeInspectorId = "production-trace-inspector"
	const [manualPin, setManualPin] = useState<PaymentTraceNodeIdV1 | null>(null)
	const [arrivedHandoff, setArrivedHandoff] =
		useState<PaymentTraceHandoffV1 | null>(null)
	const [attemptsOpen, setAttemptsOpen] = useState(false)
  const [playback, setPlayback] = useState<PaymentTracePlaybackV1>({
    kind: "static",
    reason: "hydrate",
  })
  const previousCheckout = useRef<CheckoutRailEvidence | null>(null)
  const processedRevision = useRef<string | null>(null)

  useEffect(() => {
		if (!checkout || !derived) {
			previousCheckout.current = null
			processedRevision.current = null
			merchantToHyperswitchCreated.current = false
			setPlayback({ kind: "static", reason: "idle" })
			setArrivedHandoff(null)
			setManualPin(null)
			setAttemptsOpen(false)
			return
    }
    const requestPlayback = productionLivePlaybackV1(
      previousCheckout.current,
      checkout,
      derived.frame.revision,
    )
    if (
      requestPlayback.kind === "live_event" &&
      requestPlayback.handoff.authorityProof === "browser_handoff"
    ) {
      previousCheckout.current = checkout
      setPlayback(requestPlayback)
      setArrivedHandoff(null)
      return
    }
    if (processedRevision.current === checkout.evidenceRevision) return
    const nextPlayback = productionLivePlaybackV1(
      previousCheckout.current,
      checkout,
      derived.frame.revision,
    )
		previousCheckout.current = checkout
		processedRevision.current = checkout.evidenceRevision
		merchantToHyperswitchCreated.current =
			merchantToHyperswitchCreated.current ||
			checkout.observationSource === "create"
		setPlayback(nextPlayback)
		setArrivedHandoff(null)
	}, [checkout?.evidenceRevision, checkout?.requestState])

  const landing = ["loading", "preview"].includes(inventory.state) && !checkout
  if (landing) {
    return (
      <div className="production-mechanism-rail is-idle" data-testid="production-payment-rail">
        <header className="production-rail-header">
          <span>PAYMENT TRACE</span>
          <strong>Starts at checkout</strong>
        </header>
        <div className="production-rail-idle-graphic" aria-hidden="true">
          <span /><i /><span /><i /><span />
        </div>
        <p>Choose and hold seats first. The payment trace appears only when Hyperswitch begins.</p>
        <div className="production-rail-idle-labels" aria-hidden="true">
          <span>BUYER</span><span>ONSALE</span><span>PAYMENT</span>
        </div>
      </div>
    )
  }

  if (!checkout) {
    const seatCount = Math.max(inventory.selectedSeatCount, inventory.heldSeatCount)
    const amount = formatRailMoney(inventory.totalMinor, inventory.currency)
    const held = inventory.heldSeatCount > 0 && ["held", "releasing", "expiry_required", "expiring"].includes(inventory.state)
    const preparing = inventory.message === "checkout_preparing" && held
    if (preparing) {
      const frameRevision = `checkout-preparing:${String(revision)}`
      const frame = productionPreparingTraceFrameV1(inventory, frameRevision)
      const preparingPlayback: PaymentTracePlaybackV1 = {
        kind: "live_event",
        handoff: {
          context: "live",
          eventId: "evt_checkoutprepare",
          sequence: 1,
          edgeId: "buyer_merchant",
          source: "buyer",
          target: "merchant",
          attemptOrdinal: null,
          label: "Buyer asked ONSALE to secure the held order",
          tone: "progress",
          authorityProof: "browser_handoff",
          evidenceRevision: frameRevision,
        },
      }
      return (
        <div className="production-mechanism-rail" data-testid="production-payment-rail">
          <header className="production-rail-header">
            <span>LIVE PAYMENT TRACE</span>
            <strong>SECURING THE HELD ORDER</strong>
          </header>
          <PaymentTraceMapV1 frame={frame} playback={preparingPlayback} />
          <section className="production-rail-transition" data-authority="in_flight">
            <span>CURRENT HANDOFF</span>
            <strong>Buyer asked ONSALE to secure the held order</strong>
            <small>
              Command sent. Outcome remains unknown until the server responds.
            </small>
          </section>
        </div>
      )
    }
    return (
      <div className="production-mechanism-rail" data-testid="production-payment-rail">
        <header className="production-rail-header">
          <span>INVENTORY PRELUDE</span>
          <strong>
            {held
              ? `${inventory.heldSeatCount} SEAT${inventory.heldSeatCount === 1 ? "" : "S"} HELD`
              : `${seatCount} SEAT${seatCount === 1 ? "" : "S"} SELECTED`}
          </strong>
        </header>
        <section className="production-rail-observation" aria-label="Seat selection and hold prelude before payment" role="group">
          <header><span>ONSALE HOLD</span><i data-tone={held ? "clear" : "pending"}>{held ? "HELD" : "PENDING"}</i></header>
          <dl>
            <div><dt>Inventory</dt><dd>{held ? `${countedRailNounV1(inventory.heldSeatCount, "seat")} held` : `${countedRailNounV1(seatCount, "seat")} selected`}</dd></div>
            <div><dt>Money</dt><dd>{`${amount} ${held ? "HELD" : "QUOTED"} · NOT CHARGED`}</dd></div>
            <div><dt>Next boundary</dt><dd>PAYMENT STARTS AT CHECKOUT</dd></div>
          </dl>
        </section>
      </div>
    )
  }

	if (!derived) return null
	const handoffPresentation = productionHandoffPresentationV1(
		derived,
		playback,
		arrivedHandoff,
	)
	const browserIntentInFlight =
		playback.kind === "live_event" &&
		playback.handoff.authorityProof === "browser_handoff"
	const ticketHandoffInFlight =
		playback.kind === "live_event" &&
		playback.handoff.edgeId === "merchant_tickets" &&
		arrivedHandoff?.eventId !== playback.handoff.eventId
	const displayedFrame = browserIntentInFlight
			? {
					...derived.frame,
					edges: derived.frame.edges.map((edge) =>
						edge.id === "buyer_merchant"
							? {
									...edge,
									state: "current" as const,
									proof: "browser_handoff" as const,
								}
							: edge,
					),
				}
			: ticketHandoffInFlight
				? {
						...derived.frame,
						nodes: derived.frame.nodes.map((node) =>
							node.id === "tickets"
								? {
										...node,
										state: "future" as const,
										proof: "unproven" as const,
									}
								: node,
						),
						edges: derived.frame.edges.map((edge) =>
							edge.id === "merchant_tickets"
								? { ...edge, state: "current" as const }
								: edge,
						),
					}
				: derived.frame
	const selectedNode = manualPin ?? handoffPresentation.authorityNode
	const selected = displayedFrame.nodes.find((node) => node.id === selectedNode)
	const visibleAttempts = paymentTraceVisibleAttemptsV1(displayedFrame.orchestration)
	const onArrive = (handoff: PaymentTraceHandoffV1) => {
		if (
			playback.kind === "live_event" &&
			handoff.context === "live" &&
			handoff.eventId === playback.handoff.eventId &&
			handoff.evidenceRevision === playback.handoff.evidenceRevision
		) {
			setArrivedHandoff(handoff)
		}
	}
	const inspectAttempts = () => {
		if (typeof document === "undefined") return
		setAttemptsOpen(true)
		window.requestAnimationFrame(() => {
			document
				.getElementById(`${attemptInspectorId}-toggle`)
				?.focus()
		})
	}

  return (
    <div className="production-mechanism-rail" data-testid="production-payment-rail">
      <header className="production-rail-header">
        <span>LIVE PAYMENT TRACE</span>
        <strong>{derived.headline}</strong>
      </header>
      <PaymentTraceMapV1
        attemptInspectorId={attemptInspectorId}
        frame={displayedFrame}
        nodeInspectorId={nodeInspectorId}
        onArrive={onArrive}
        onInspectAttempts={inspectAttempts}
        onSelectNode={setManualPin}
        playback={playback}
        selectedNode={selectedNode}
      />
		<section
			className="production-rail-transition"
			data-authority={handoffPresentation.authority}
		>
			<span>CURRENT HANDOFF</span>
			<strong>{handoffPresentation.label}</strong>
			<small>{handoffPresentation.meaning}</small>
      </section>
      <section aria-label="Observed payment message sequence" style={{ marginTop: 12, marginBottom: 12 }}>
        <div style={{ color: B, fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.12em", marginBottom: 7 }}>MESSAGE SEQUENCE</div>
        {derived.sequence.map((message) => (
          <div key={message} style={{ display: "flex", gap: 7, alignItems: "center", padding: "2.5px 0" }}>
            <div aria-hidden="true" style={{ width: 18, height: 1.5, background: B, flexShrink: 0 }} />
            <span style={{ fontFamily: MONO, fontSize: 8.5 }}>{message}</span>
          </div>
        ))}
      </section>
      <details className="production-rail-inspector" id={nodeInspectorId} open>
        <summary>TRACE INSPECTOR · {selected?.label ?? "CURRENT"}</summary>
        <div className="production-rail-observation">
			<header>
				<span>
					{manualPin
						? "MANUAL PIN"
						: handoffPresentation.authority === "in_flight"
							? "SOURCE PINNED"
							: handoffPresentation.authority === "arrived"
								? "ARRIVED AUTHORITATIVELY"
								: "FOLLOWING TRACE"}
				</span>
				<i data-tone={manualPin ? "manual" : "clear"}>
					{manualPin ? "MANUAL" : handoffPresentation.authority === "in_flight" ? "IN FLIGHT" : "FOLLOWING"}
				</i>
			</header>
          <dl>
            <div><dt>Actor</dt><dd>{selected?.label ?? "CURRENT"}</dd></div>
            <div><dt>State</dt><dd>{selected?.state.replace(/_/gu, " ") ?? "current"}</dd></div>
            <div><dt>Fact</dt><dd>{selected?.detail ?? "—"}</dd></div>
            <div><dt>Proof</dt><dd>{selected?.proof.replace(/_/gu, " ") ?? "unproven"}</dd></div>
            <div><dt>Visible attempts</dt><dd>{visibleAttempts.attempts.length} + {visibleAttempts.overflowCount} hidden</dd></div>
          </dl>
			<button className="production-rail-follow" type="button" disabled={manualPin === null} onClick={() => setManualPin(null)}>FOLLOW LIVE TRACE</button>
		</div>
	</details>
		<ApprovedProductionPanels
			attemptInspectorId={attemptInspectorId}
			attemptsOpen={attemptsOpen}
			checkout={checkout}
			derived={derived}
			onToggleAttempts={() => setAttemptsOpen((open) => !open)}
		/>
      <a
        className="production-rail-replay"
        href="/flows"
      >
        OPEN FLOWS →
      </a>
    </div>
  )
}

// The frozen nine-state simulator is loaded only by the Git-object parity runtime.
export function ProductionMechanismRail({
  inventory,
  revision,
}: {
  readonly inventory: InventoryRailEvidence
  readonly revision: string | number
}) {
  return (
    <ApprovedProductionMechanismRail
      inventory={inventory}
      revision={revision}
    />
  )
}
