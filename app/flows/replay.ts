export const replayProofValues = [
  "live_sandbox_recorded",
  "source_determined",
  "configuration_block",
  "local_simulation",
] as const

export const replayEvidenceValues = [
  "live_sandbox_recorded",
  "source_determined",
  "merchant_rule",
  "configuration_block",
  "local_simulation",
] as const

export const replayActors = [
  "buyer",
  "merchant",
  "hyperswitch",
  "processor",
  "reconcile",
  "ticket",
] as const

export type ReplayProof = typeof replayProofValues[number]
export type ReplayEvidenceClass = typeof replayEvidenceValues[number]
export type ReplayActor = typeof replayActors[number]

export type ReplayAttemptOutcome =
  | "requires_method"
  | "action_required"
  | "processing"
  | "hard_decline"
  | "technical_failure"
  | "uncertain"
  | "succeeded"

export interface ReplayAttempt {
  readonly ordinal: number
  readonly method: string | null
  readonly connector: string | null
  readonly outcome: ReplayAttemptOutcome
  readonly charged: boolean
  readonly retryRelation: "initial" | "not_observed" | "local_simulation"
  readonly failureClass:
    | "hard_decline"
    | "technical"
    | "payment_method"
    | "unknown"
    | null
  readonly evidenceClass: ReplayEvidenceClass
  readonly evidenceRef: string
}

export interface ReplayStep {
  id: string
  actor: ReplayActor
  title: string
  canonicalStatus: string
  attemptStatus: string | null
  connector: string | null
  attemptCount: number | null
  amountReceivedMinor: number | null
  annotation: string
  evidenceClass: ReplayEvidenceClass
  evidenceRef: string
  /** Present only when the retained operation can authorize causal replay. */
  motion?: {
    readonly edgeId: PaymentTraceEdgeIdV1
    readonly authorityProof: "server_create" | "server_retrieve" | "merchant_db" | "simulation"
    readonly attemptOrdinal: number | null
  }
}

export interface ReplayFlow {
  id: string
  label: string
  kicker: string
  matrixCaseIds: readonly string[]
  proof: ReplayProof
  observedAt: string
  problem: string
  productRule: string
  limitation: string
  notice: string
  attempts: readonly ReplayAttempt[]
  steps: readonly ReplayStep[]
}

export interface RecordedRunSummary {
  readonly id: string
  readonly flowId: string
  readonly orderLabel: null
  readonly observedAt: string
  readonly observedTime: string | null
  readonly amountMinor: number
  readonly currency: string
  readonly itemCount: number
  readonly outcome:
    | "fulfilled"
    | "action_required"
    | "declined"
    | "recovered"
    | "recoverable_failure"
    | "processing"
    | "uncertain"
    | "integrity_review"
  readonly proof: "live_sandbox_recorded"
  readonly method: string
  readonly connector: string | null
  readonly attemptCount: number
  readonly chargedAttemptCount: number
  readonly ticketCount: number
  readonly canonicalPaymentState: string
  readonly attemptState: string
  readonly evidenceSource: string
  readonly operationSemantics: string
  readonly proofLabel: string
  readonly problem: string
  readonly hyperswitchRole: string
  readonly importance: string
  readonly limitation: string
  readonly attempts: readonly ReplayAttempt[]
}

const RECEIPT = "20260808-hyperswitch-v1-recon/RECEIPT.md"
const MATRIX = "20260808-hyperswitch-v1-matrix/matrix.json"
const SOURCE_PIN = "juspay/hyperswitch@d731652d6e8a"
const LIVE_RECOVERY_SUPPLEMENT =
  "outputs/ONSALE_C3_SANDBOX_FIRST_REBUILD_RECEIPT_v1.0.md"

export const replayFlowCatalog = [
  {
    id: "confirmed-payment",
    label: "Confirmed payment",
    kicker: "ONE PAYMENT · ONE CHARGED ATTEMPT",
    matrixCaseIds: ["HS-01", "HS-02"],
    proof: "live_sandbox_recorded",
    observedAt: "2026-08-08",
    problem:
      "A buyer-facing success is unsafe until the merchant can join the held order to the provider's canonical money state.",
    productRule:
      "Issue exactly one ticket only after server retrieval proves succeeded, USD 184.60 received, and one charged attempt.",
    limitation:
      "The sandbox observation proves StripeTest lifecycle behavior, not production authorization rate, uptime, a card network, or a second processor.",
    notice:
      "Watch the authority move from merchant intent to provider result and back to merchant fulfillment.",
    attempts: [
      {
        ordinal: 1,
        method: "card",
        connector: "stripe_test",
        outcome: "succeeded",
        charged: true,
        retryRelation: "initial",
        failureClass: null,
        evidenceClass: "live_sandbox_recorded",
        evidenceRef: `${RECEIPT} · successful-card`,
      },
    ],
    steps: [
      {
        id: "success-held-order",
        actor: "merchant",
        title: "Reuse the held order",
        canonicalStatus: "not_created",
        attemptStatus: null,
        connector: null,
        attemptCount: 0,
        amountReceivedMinor: null,
        annotation:
          "ONSALE owns the seat, price, hold, and private payment identity before Hyperswitch is called.",
        evidenceClass: "merchant_rule",
        evidenceRef: "buyer-v1 invariant T0.01",
      },
      {
        id: "success-intent-created",
        actor: "hyperswitch",
        title: "Intent awaits payment method",
        canonicalStatus: "requires_payment_method",
        attemptStatus: "payment_method_awaited",
        connector: null,
        attemptCount: 1,
        amountReceivedMinor: null,
        annotation:
          "The same server-owned payment remains retrievable before confirmation.",
        evidenceClass: "live_sandbox_recorded",
        evidenceRef: `${MATRIX} · HS-01 · case 2ff551dadf4c`,
        motion: {
          edgeId: "merchant_hyperswitch",
          authorityProof: "server_create",
          attemptOrdinal: null,
        },
      },
      {
        id: "success-connector-result",
        actor: "processor",
        title: "One connector attempt is charged",
        canonicalStatus: "succeeded",
        attemptStatus: "charged",
        connector: "stripe_test",
        attemptCount: 1,
        amountReceivedMinor: null,
        annotation:
          "The returned connector is stripe_test. The response does not establish a trusted card network.",
        evidenceClass: "live_sandbox_recorded",
        evidenceRef: `${MATRIX} · HS-02 · case 65ae3c34231d`,
      },
      {
        id: "success-retrieved",
        actor: "reconcile",
        title: "Server retrieval confirms money",
        canonicalStatus: "succeeded",
        attemptStatus: "charged",
        connector: "stripe_test",
        attemptCount: 1,
        amountReceivedMinor: 18_460,
        annotation:
          "The browser result is not the authority. Retrieval confirms the canonical status, amount, and attempt count.",
        evidenceClass: "live_sandbox_recorded",
        evidenceRef: `${RECEIPT} · successful-card`,
        motion: {
          edgeId: "hyperswitch_retrieve",
          authorityProof: "server_retrieve",
          attemptOrdinal: null,
        },
      },
      {
        id: "success-ticket-permitted",
        actor: "ticket",
        title: "Ticket transition is permitted",
        canonicalStatus: "succeeded",
        attemptStatus: "charged",
        connector: "stripe_test",
        attemptCount: 1,
        amountReceivedMinor: 18_460,
        annotation:
          "This is the merchant rule derived from the hosted result: one reconciled success may issue one ticket once.",
        evidenceClass: "merchant_rule",
        evidenceRef: "buyer-v1 exactly-once fulfillment invariant",
      },
    ],
  },
  {
    id: "action-required",
    label: "Action required",
    kicker: "3DS STARTED · COMPLETION UNPROVEN",
    matrixCaseIds: ["HS-10", "HS-11", "HS-12", "HS-13"],
    proof: "live_sandbox_recorded",
    observedAt: "2026-08-08",
    problem:
      "A challenge can move the buyer through provider-controlled UI while the merchant must preserve the order and avoid claiming success.",
    productRule:
      "Keep checkout context mounted, follow only the official action surface, and retrieve the same payment after return.",
    limitation:
      "Action initiation and the provider-owned page were observed. Approval, rejection, and a completed browser return remain unproven in this recorded run.",
    notice:
      "The live receipt stops at action initiation. Every later state is intentionally withheld.",
    attempts: [
      {
        ordinal: 1,
        method: "klarna",
        connector: "stripe_test",
        outcome: "action_required",
        charged: false,
        retryRelation: "initial",
        failureClass: null,
        evidenceClass: "live_sandbox_recorded",
        evidenceRef: `${MATRIX} · HS-10 · case 2e41730c5c8f`,
      },
    ],
    steps: [
      {
        id: "action-confirm-once",
        actor: "merchant",
        title: "Confirm the existing payment once",
        canonicalStatus: "requires_payment_method",
        attemptStatus: "payment_method_awaited",
        connector: null,
        attemptCount: 1,
        amountReceivedMinor: null,
        annotation:
          "The merchant reuses one payment identity and supplies a return path for official authentication.",
        evidenceClass: "merchant_rule",
        evidenceRef: "buyer-v1 confirm-once boundary",
      },
      {
        id: "action-authentication-pending",
        actor: "hyperswitch",
        title: "Authentication becomes pending",
        canonicalStatus: "requires_customer_action",
        attemptStatus: "authentication_pending",
        connector: "stripe_test",
        attemptCount: 1,
        amountReceivedMinor: null,
        annotation:
          "Hyperswitch returns a redirect next action. No money success and no ticket are established.",
        evidenceClass: "live_sandbox_recorded",
        evidenceRef: `${MATRIX} · HS-10 · case 2e41730c5c8f`,
      },
      {
        id: "action-official-surface",
        actor: "processor",
        title: "Official action surface is required",
        canonicalStatus: "requires_customer_action",
        attemptStatus: "authentication_pending",
        connector: "stripe_test",
        attemptCount: 1,
        amountReceivedMinor: null,
        annotation:
          "ONSALE must not draw a fake bank challenge. The real provider flow owns completion or rejection.",
        evidenceClass: "source_determined",
        evidenceRef: `${SOURCE_PIN} · dummy connector completion route`,
      },
      {
        id: "action-return-means-retrieve",
        actor: "reconcile",
        title: "Return means retrieve",
        canonicalStatus: "requires_customer_action",
        attemptStatus: "authentication_pending",
        connector: "stripe_test",
        attemptCount: 1,
        amountReceivedMinor: 0,
        annotation:
          "Browser return is navigation, not a success event. The server must retrieve before changing fulfillment.",
        evidenceClass: "merchant_rule",
        evidenceRef: "buyer-v1 callback-not-authority invariant",
      },
    ],
  },
  {
    id: "terminal-decline",
    label: "Terminal decline",
    kicker: "FAILED · NO BLIND CASCADE",
    matrixCaseIds: ["HS-03", "HS-05", "HS-06"],
    proof: "live_sandbox_recorded",
    observedAt: "2026-08-08",
    problem:
      "A failed authorization must become a clear buyer action without turning a real decline into an unsafe connector cascade.",
    productRule:
      "Issue no ticket, expose a safe next action, and never retry an ambiguous, risk, or terminal decline automatically.",
    limitation:
      "The receipt proves StripeTest failure fixtures, not the issuer semantics or retry eligibility of a production decline.",
    notice:
      "The important behavior is what does not happen: no second connector attempt and no ticket.",
    attempts: [
      {
        ordinal: 1,
        method: "card",
        connector: "stripe_test",
        outcome: "hard_decline",
        charged: false,
        retryRelation: "initial",
        failureClass: "hard_decline",
        evidenceClass: "live_sandbox_recorded",
        evidenceRef: `${RECEIPT} · generic-decline`,
      },
    ],
    steps: [
      {
        id: "decline-intent",
        actor: "merchant",
        title: "Submit the existing intent",
        canonicalStatus: "requires_payment_method",
        attemptStatus: "payment_method_awaited",
        connector: null,
        attemptCount: 1,
        amountReceivedMinor: null,
        annotation:
          "The held order remains separate from provider authorization state.",
        evidenceClass: "merchant_rule",
        evidenceRef: "buyer-v1 payment-domain boundary",
      },
      {
        id: "decline-failed",
        actor: "processor",
        title: "Connector reports failure",
        canonicalStatus: "failed",
        attemptStatus: "failure",
        connector: "stripe_test",
        attemptCount: 1,
        amountReceivedMinor: null,
        annotation:
          "The dated receipt contains one failed connector attempt and no charged amount.",
        evidenceClass: "live_sandbox_recorded",
        evidenceRef: `${RECEIPT} · generic-decline`,
      },
      {
        id: "decline-no-cascade",
        actor: "reconcile",
        title: "Failure remains terminal",
        canonicalStatus: "failed",
        attemptStatus: "failure",
        connector: "stripe_test",
        attemptCount: 1,
        amountReceivedMinor: 0,
        annotation:
          "The product does not infer that another processor should see the same payment.",
        evidenceClass: "merchant_rule",
        evidenceRef: "safe-retry boundary",
      },
      {
        id: "decline-no-ticket",
        actor: "ticket",
        title: "Fulfillment remains blocked",
        canonicalStatus: "failed",
        attemptStatus: "failure",
        connector: "stripe_test",
        attemptCount: 1,
        amountReceivedMinor: 0,
        annotation: "No reconciled payment success means no ticket transition.",
        evidenceClass: "merchant_rule",
        evidenceRef: "buyer-v1 exactly-once fulfillment invariant",
      },
    ],
  },
  {
    id: "lost-response-recovery",
    label: "Lost response recovery",
    kicker: "UNKNOWN TRANSPORT · RETRIEVE SAME PAYMENT",
    matrixCaseIds: ["HS-16"],
    proof: "live_sandbox_recorded",
    observedAt: "2026-08-08",
    problem:
      "When confirm reaches the provider but its response is lost, treating silence as failure can create a second charge.",
    productRule:
      "Freeze new submission, retrieve the same payment identity, and map only the returned canonical state.",
    limitation:
      "The sandbox harness deliberately lost the transport response. It does not estimate production timeout frequency.",
    notice:
      "Watch the order remain unresolved until retrieval proves what already happened.",
    attempts: [
      {
        ordinal: 1,
        method: "card",
        connector: "stripe_test",
        outcome: "succeeded",
        charged: true,
        retryRelation: "initial",
        failureClass: null,
        evidenceClass: "live_sandbox_recorded",
        evidenceRef: `${MATRIX} · HS-16 · case 4e12ba62ccb2`,
      },
    ],
    steps: [
      {
        id: "unknown-confirm-sent",
        actor: "merchant",
        title: "Confirm is sent once",
        canonicalStatus: "requires_payment_method",
        attemptStatus: "payment_method_awaited",
        connector: null,
        attemptCount: 1,
        amountReceivedMinor: null,
        annotation:
          "One stable payment identity already exists before the transport becomes uncertain.",
        evidenceClass: "merchant_rule",
        evidenceRef: "buyer-v1 stable payment identity invariant",
      },
      {
        id: "unknown-response-lost",
        actor: "hyperswitch",
        title: "Transport response is unknown",
        canonicalStatus: "unknown",
        attemptStatus: "unknown",
        connector: null,
        attemptCount: 1,
        amountReceivedMinor: null,
        annotation:
          "Unknown is a safety state. It does not mean declined and it does not authorize another confirm.",
        evidenceClass: "live_sandbox_recorded",
        evidenceRef: `${RECEIPT} · lost-confirm-response`,
      },
      {
        id: "unknown-retrieve",
        actor: "reconcile",
        title: "Retrieve resolves the same identity",
        canonicalStatus: "succeeded",
        attemptStatus: "charged",
        connector: "stripe_test",
        attemptCount: 1,
        amountReceivedMinor: 18_460,
        annotation:
          "Retrieval returns succeeded with one charged attempt. No second connector attempt was created.",
        evidenceClass: "live_sandbox_recorded",
        evidenceRef: `${MATRIX} · HS-16 · case 4e12ba62ccb2`,
        motion: {
          edgeId: "hyperswitch_retrieve",
          authorityProof: "server_retrieve",
          attemptOrdinal: null,
        },
      },
      {
        id: "unknown-ticket-permitted",
        actor: "ticket",
        title: "Fulfillment can now resolve",
        canonicalStatus: "succeeded",
        attemptStatus: "charged",
        connector: "stripe_test",
        attemptCount: 1,
        amountReceivedMinor: 18_460,
        annotation:
          "Only the reconciled success permits the merchant's exactly-once ticket rule.",
        evidenceClass: "merchant_rule",
        evidenceRef: "buyer-v1 retrieve-before-retry invariant",
      },
    ],
  },
  {
    id: "fixture-label-counterexample",
    label: "Fixture label counterexample",
    kicker: "INPUT LABEL ≠ RETURNED STATE",
    matrixCaseIds: ["HS-04"],
    proof: "live_sandbox_recorded",
    observedAt: "2026-08-08",
    problem:
      "A test fixture name can be wrong for a connector variant. Building UI state from the label creates a convincing but false demo.",
    productRule:
      "Render and fulfill from the returned provider state, never from fixture names, request labels, or expected prose.",
    limitation:
      "This is an intentional StripeTest source special case. It does not describe how a production Stripe connector handles insufficient funds.",
    notice:
      "This negative control should look surprising: the label implies failure, the provider result is success.",
    attempts: [
      {
        ordinal: 1,
        method: "card",
        connector: "stripe_test",
        outcome: "succeeded",
        charged: true,
        retryRelation: "initial",
        failureClass: null,
        evidenceClass: "live_sandbox_recorded",
        evidenceRef: `${RECEIPT} · insufficient-funds-labelled`,
      },
    ],
    steps: [
      {
        id: "label-input",
        actor: "merchant",
        title: "Fixture carries a decline label",
        canonicalStatus: "unconfirmed",
        attemptStatus: null,
        connector: null,
        attemptCount: 0,
        amountReceivedMinor: null,
        annotation:
          "The public fixture description implies insufficient funds. That description is only test input metadata.",
        evidenceClass: "source_determined",
        evidenceRef: `${SOURCE_PIN} · StripeTest special-case branch`,
      },
      {
        id: "label-returned-success",
        actor: "processor",
        title: "Returned state is succeeded",
        canonicalStatus: "succeeded",
        attemptStatus: "charged",
        connector: "stripe_test",
        attemptCount: 1,
        amountReceivedMinor: null,
        annotation:
          "The hosted result is succeeded and charged despite the fixture label.",
        evidenceClass: "live_sandbox_recorded",
        evidenceRef: `${RECEIPT} · insufficient-funds-labelled`,
      },
      {
        id: "label-rule",
        actor: "reconcile",
        title: "Returned state wins",
        canonicalStatus: "succeeded",
        attemptStatus: "charged",
        connector: "stripe_test",
        attemptCount: 1,
        amountReceivedMinor: 18_460,
        annotation:
          "The UI, rail, ticket rule, and evidence report must all follow the canonical response.",
        evidenceClass: "merchant_rule",
        evidenceRef: "F2.03 consequential negative control",
      },
    ],
  },
  {
    id: "checkout-configuration-boundary",
    label: "Checkout configuration boundary",
    kicker: "NO ELIGIBLE METHODS · NO FAKE CHECKOUT",
    matrixCaseIds: ["HS-20"],
    proof: "configuration_block",
    observedAt: "2026-08-08",
    problem:
      "The payment server lifecycle can work while browser method discovery still fails because the key, profile, and API generation do not form one valid checkout contract.",
    productRule:
      "Keep the held order uncharged and render an operator correction receipt in the official checkout slot.",
    limitation:
      "This receipt diagnoses the supplied private configuration. It does not mean Unified Checkout or Klarna is generally unavailable.",
    notice:
      "The correct product behavior is an honest block, not a hand-drawn card, bank, OTP, or Klarna experience.",
    attempts: [
      {
        ordinal: 1,
        method: null,
        connector: null,
        outcome: "requires_method",
        charged: false,
        retryRelation: "initial",
        failureClass: "unknown",
        evidenceClass: "configuration_block",
        evidenceRef: `${MATRIX} · HS-20 · method discovery diagnostics`,
      },
    ],
    steps: [
      {
        id: "config-server-healthy",
        actor: "hyperswitch",
        title: "Server payment lifecycle is healthy",
        canonicalStatus: "requires_payment_method",
        attemptStatus: "payment_method_awaited",
        connector: null,
        attemptCount: 1,
        amountReceivedMinor: 0,
        annotation:
          "Create, confirm, retrieve, duplicate handling, and action initiation worked with the V1 server key.",
        evidenceClass: "live_sandbox_recorded",
        evidenceRef: `${MATRIX} · hosted server cases`,
      },
      {
        id: "config-v1-discovery-blocked",
        actor: "hyperswitch",
        title: "V1 method discovery returns no methods",
        canonicalStatus: "requires_payment_method",
        attemptStatus: null,
        connector: null,
        attemptCount: 1,
        amountReceivedMinor: 0,
        annotation:
          "The public-key path returned HE_00. The server-key diagnostic returned IR_06.",
        evidenceClass: "configuration_block",
        evidenceRef: `${MATRIX} · HS-20 · cases d1d559a5ad1b and 488c169a34b3`,
      },
      {
        id: "config-v2-discovery-blocked",
        actor: "hyperswitch",
        title: "V2 authorization is rejected",
        canonicalStatus: "requires_payment_method",
        attemptStatus: null,
        connector: null,
        attemptCount: 1,
        amountReceivedMinor: 0,
        annotation:
          "Both documented and diagnostic V2 authorization returned IR_01 before customer creation.",
        evidenceClass: "configuration_block",
        evidenceRef: `${MATRIX} · HS-20 · cases f5a819e90a7b and e5744c4b760f`,
      },
      {
        id: "config-merchant-block",
        actor: "merchant",
        title: "Checkout remains unmounted",
        canonicalStatus: "not_created",
        attemptStatus: null,
        connector: null,
        attemptCount: 0,
        amountReceivedMinor: 0,
        annotation:
          "ONSALE preserves the hold, shows the correction owner, and exposes no payment-entry fields.",
        evidenceClass: "merchant_rule",
        evidenceRef: "buyer-v1 configuration-block contract",
      },
    ],
  },
] satisfies readonly ReplayFlow[]

export const recordedReplayFlows = [
  {
    id: "live-widget-recovery",
    label: "Live widget recovery",
    kicker: "ONE CONFIRM · SAME-PAYMENT RETRIEVE · FOUR TICKETS",
    matrixCaseIds: ["LIVE-RECOVERY-01"],
    proof: "live_sandbox_recorded",
    observedAt: "2026-08-08",
    problem:
      "The browser lost its payment response, so another confirmation would have risked a duplicate charge.",
    productRule:
      "Keep the stable Hyperswitch identity, retrieve it server-side, and fulfill only from the returned canonical payment state.",
    limitation:
      "This bounded sandbox receipt proves one recovery. It does not establish a browser return, production reliability, or a population success rate.",
    notice:
      "The trace stops at the retained evidence: one retrieved success, one charged attempt, and four durable tickets.",
    attempts: [
      {
        ordinal: 1,
        method: null,
        connector: null,
        outcome: "succeeded",
        charged: true,
        retryRelation: "initial",
        failureClass: null,
        evidenceClass: "live_sandbox_recorded",
        evidenceRef: `${LIVE_RECOVERY_SUPPLEMENT} · retrieve observation`,
      },
    ],
    steps: [
      {
        id: "live-held-order",
        actor: "merchant",
        title: "ONSALE preserves one held order",
        canonicalStatus: "payment_pending",
        attemptStatus: null,
        connector: null,
        attemptCount: 0,
        amountReceivedMinor: null,
        annotation:
          "Four assigned seats and their $738.40 all-in total are bound before payment begins.",
        evidenceClass: "live_sandbox_recorded",
        evidenceRef: `${LIVE_RECOVERY_SUPPLEMENT} · order projection`,
      },
      {
        id: "live-create-observed",
        actor: "hyperswitch",
        title: "One payment identity is created",
        canonicalStatus: "requires_payment_method",
        attemptStatus: "payment_method_awaited",
        connector: null,
        attemptCount: 0,
        amountReceivedMinor: null,
        annotation:
          "The create observation records the expected amount without a charge or ticket.",
        evidenceClass: "live_sandbox_recorded",
        evidenceRef: `${LIVE_RECOVERY_SUPPLEMENT} · create observation`,
        motion: {
          edgeId: "merchant_hyperswitch",
          authorityProof: "server_create",
          attemptOrdinal: null,
        },
      },
      {
        id: "live-browser-response-lost",
        actor: "buyer",
        title: "The browser has no authoritative result",
        canonicalStatus: "unknown",
        attemptStatus: "unknown",
        connector: null,
        attemptCount: 0,
        amountReceivedMinor: null,
        annotation:
          "One browser confirmation met a local-server interruption. ONSALE does not infer success or submit again.",
        evidenceClass: "live_sandbox_recorded",
        evidenceRef: `${LIVE_RECOVERY_SUPPLEMENT} · browser authority boundary`,
      },
      {
        id: "live-server-retrieve",
        actor: "reconcile",
        title: "Server retrieval resolves the same payment",
        canonicalStatus: "succeeded",
        attemptStatus: "charged",
        connector: null,
        attemptCount: 1,
        amountReceivedMinor: 73_840,
        annotation:
          "A retrieve observation proves one succeeded attempt and one charged attempt on the existing identity.",
        evidenceClass: "live_sandbox_recorded",
        evidenceRef: `${LIVE_RECOVERY_SUPPLEMENT} · retrieve observation`,
        motion: {
          edgeId: "hyperswitch_retrieve",
          authorityProof: "server_retrieve",
          attemptOrdinal: null,
        },
      },
      {
        id: "live-four-tickets",
        actor: "ticket",
        title: "Four durable tickets are issued",
        canonicalStatus: "succeeded",
        attemptStatus: "charged",
        connector: null,
        attemptCount: 1,
        amountReceivedMinor: 73_840,
        annotation:
          "The fulfilled order contains four tickets covering four distinct order items after one verified charge.",
        evidenceClass: "merchant_rule",
        evidenceRef: `${LIVE_RECOVERY_SUPPLEMENT} · fulfillment projection`,
      },
    ],
  },
] satisfies readonly ReplayFlow[]

export const multiAttemptSimulation = {
  id: "multi-attempt-recovery-simulation",
  label: "Multi-attempt recovery lab",
  kicker: "LOCAL SIMULATION · TWO ATTEMPTS · ONE CHARGE",
  matrixCaseIds: ["LOCAL-SIM-01"],
  proof: "local_simulation",
  observedAt: "2026-08-09",
  problem:
    "A recoverable technical connector failure can strand a valid ticket order unless a second attempt remains bound to the same logical payment.",
  productRule:
    "Hyperswitch keeps one logical payment while the deterministic lab records a failed FauxPay attempt and a succeeding StripeTest attempt separately.",
  limitation:
    "This is a local deterministic simulation. It does not prove that the dated sandbox account used Smart Retry, FauxPay, or multi-connector routing.",
  notice:
    "LOCAL SIMULATION · NO SANDBOX REQUEST. Watch the method stay Card while the observed connector changes between two simulated attempts.",
  attempts: [
    {
      ordinal: 1,
      method: "card",
      connector: "fauxpay",
      outcome: "technical_failure",
      charged: false,
      retryRelation: "initial",
      failureClass: "technical",
      evidenceClass: "local_simulation",
      evidenceRef: "LOCAL-SIM-01 · deterministic attempt 01",
    },
    {
      ordinal: 2,
      method: "card",
      connector: "stripe_test",
      outcome: "succeeded",
      charged: true,
      retryRelation: "local_simulation",
      failureClass: null,
      evidenceClass: "local_simulation",
      evidenceRef: "LOCAL-SIM-01 · deterministic attempt 02",
    },
  ],
  steps: [
    {
      id: "sim-held-order",
      actor: "merchant",
      title: "One held order enters the lab",
      canonicalStatus: "payment_pending",
      attemptStatus: null,
      connector: null,
      attemptCount: 0,
      amountReceivedMinor: null,
      annotation:
        "The simulation begins with one immutable USD 184.60 ticket order and no provider attempt.",
      evidenceClass: "local_simulation",
      evidenceRef: "LOCAL-SIM-01 · deterministic merchant fixture",
      motion: {
        edgeId: "buyer_merchant",
        authorityProof: "simulation",
        attemptOrdinal: null,
      },
    },
    {
      id: "sim-payment-created",
      actor: "hyperswitch",
      title: "One logical payment is created",
      canonicalStatus: "requires_payment_method",
      attemptStatus: "payment_method_awaited",
      connector: null,
      attemptCount: 0,
      amountReceivedMinor: null,
      annotation:
        "Card is the selected method. No connector or charge exists before the first simulated attempt.",
      evidenceClass: "local_simulation",
      evidenceRef: "LOCAL-SIM-01 · deterministic create",
      motion: {
        edgeId: "merchant_hyperswitch",
        authorityProof: "simulation",
        attemptOrdinal: null,
      },
    },
    {
      id: "sim-attempt-one-sent",
      actor: "processor",
      title: "Attempt 01 is sent to FauxPay",
      canonicalStatus: "processing",
      attemptStatus: "processing",
      connector: "fauxpay",
      attemptCount: 1,
      amountReceivedMinor: null,
      annotation:
        "The deterministic router opens attempt 01 for FauxPay. No charge result exists at send time.",
      evidenceClass: "local_simulation",
      evidenceRef: "LOCAL-SIM-01 · deterministic attempt 01 request",
      motion: {
        edgeId: "hyperswitch_connector",
        authorityProof: "simulation",
        attemptOrdinal: 1,
      },
    },
    {
      id: "sim-attempt-one-fails",
      actor: "processor",
      title: "Attempt 01 returns a technical failure",
      canonicalStatus: "processing",
      attemptStatus: "technical_failure",
      connector: "fauxpay",
      attemptCount: 1,
      amountReceivedMinor: null,
      annotation:
        "FauxPay returns a local technical failure and remains uncharged. That explicit class—not a hard decline—permits the simulated policy to consider attempt 02.",
      evidenceClass: "local_simulation",
      evidenceRef: "LOCAL-SIM-01 · deterministic attempt 01 response",
      motion: {
        edgeId: "connector_hyperswitch",
        authorityProof: "simulation",
        attemptOrdinal: 1,
      },
    },
    {
      id: "sim-attempt-two-sent",
      actor: "processor",
      title: "Attempt 02 is sent to StripeTest",
      canonicalStatus: "processing",
      attemptStatus: "processing",
      connector: "stripe_test",
      attemptCount: 2,
      amountReceivedMinor: null,
      annotation:
        "The selected method stays Card while a second connector attempt is opened under the same simulated logical payment.",
      evidenceClass: "local_simulation",
      evidenceRef: "LOCAL-SIM-01 · deterministic attempt 02 request",
      motion: {
        edgeId: "hyperswitch_connector",
        authorityProof: "simulation",
        attemptOrdinal: 2,
      },
    },
    {
      id: "sim-attempt-two-succeeds",
      actor: "processor",
      title: "Attempt 02 returns one charged success",
      canonicalStatus: "succeeded",
      attemptStatus: "charged",
      connector: "stripe_test",
      attemptCount: 2,
      amountReceivedMinor: null,
      annotation:
        "StripeTest returns the one successful charged result. Exact received money remains unobserved until the simulated retrieve.",
      evidenceClass: "local_simulation",
      evidenceRef: "LOCAL-SIM-01 · deterministic attempt 02 response",
      motion: {
        edgeId: "connector_hyperswitch",
        authorityProof: "simulation",
        attemptOrdinal: 2,
      },
    },
    {
      id: "sim-retrieve-confirms",
      actor: "reconcile",
      title: "Simulated retrieve confirms exact money",
      canonicalStatus: "succeeded",
      attemptStatus: "charged",
      connector: "stripe_test",
      attemptCount: 2,
      amountReceivedMinor: 18_460,
      annotation:
        "The deterministic receipt resolves to USD 184.60 and one charged attempt across two attempts.",
      evidenceClass: "local_simulation",
      evidenceRef: "LOCAL-SIM-01 · deterministic retrieve",
      motion: {
        edgeId: "hyperswitch_retrieve",
        authorityProof: "simulation",
        attemptOrdinal: null,
      },
    },
    {
      id: "sim-merchant-reconciles",
      actor: "merchant",
      title: "ONSALE accepts the reconciled result",
      canonicalStatus: "succeeded",
      attemptStatus: "charged",
      connector: "stripe_test",
      attemptCount: 2,
      amountReceivedMinor: 18_460,
      annotation:
        "The simulated merchant projection receives exact money and a single charged winner before any ticket state changes.",
      evidenceClass: "local_simulation",
      evidenceRef: "LOCAL-SIM-01 · deterministic merchant projection",
      motion: {
        edgeId: "reconcile_merchant",
        authorityProof: "simulation",
        attemptOrdinal: null,
      },
    },
    {
      id: "sim-ticket-issued",
      actor: "ticket",
      title: "One simulated ticket is permitted",
      canonicalStatus: "succeeded",
      attemptStatus: "charged",
      connector: "stripe_test",
      attemptCount: 2,
      amountReceivedMinor: 18_460,
      annotation:
        "The simulated merchant rule sees exact money and exactly one charged attempt before the ticket result.",
      evidenceClass: "local_simulation",
      evidenceRef: "LOCAL-SIM-01 · deterministic fulfillment",
      motion: {
        edgeId: "merchant_tickets",
        authorityProof: "simulation",
        attemptOrdinal: null,
      },
    },
  ],
} satisfies ReplayFlow

export const primaryReplayFlowIds = [
  "confirmed-payment",
  "action-required",
  "terminal-decline",
  "lost-response-recovery",
] as const

const methodConnectorSimulation = {
  ...multiAttemptSimulation,
  id: "fixture-label-counterexample",
  label: "Method versus connector lab",
  kicker: "LOCAL SIMULATION · CARD METHOD · TWO CONNECTORS · ONE CHARGE",
  problem:
    "A buyer-selected method and a routed connector are different facts. Collapsing them hides which attempt failed, which connector succeeded, and whether a second charge occurred.",
  productRule:
    "Keep Card as the selected method while the deterministic lab records a failed FauxPay attempt and a succeeding StripeTest attempt under one logical payment.",
} satisfies ReplayFlow

export const storyLabFlowCatalog: readonly ReplayFlow[] = [
  replayFlowCatalog[0]!,
  replayFlowCatalog[1]!,
  replayFlowCatalog[2]!,
  replayFlowCatalog[3]!,
  methodConnectorSimulation,
  replayFlowCatalog[5]!,
]

export const recordedRunCatalog = [
  {
    id: "RUN-0808-01",
    flowId: "live-widget-recovery",
    orderLabel: null,
    observedAt: "2026-08-08",
    observedTime: null,
    amountMinor: 73_840,
    currency: "USD",
    itemCount: 4,
    outcome: "recovered",
    proof: "live_sandbox_recorded",
    method: "Not retained in receipt",
    connector: null,
    attemptCount: 1,
    chargedAttemptCount: 1,
    ticketCount: 4,
    canonicalPaymentState: "succeeded",
    attemptState: "charged",
    evidenceSource: "C3 WIDGET RECOVERY RECEIPT",
    operationSemantics: "CREATE ONCE → UNKNOWN RETURN → RETRIEVE SAME PAYMENT → FULFILL",
    proofLabel: "LIVE WIDGET RECOVERY SUPPLEMENT",
    problem: "The browser lost its payment response during one confirmation.",
    hyperswitchRole: "Retrieve the already-created payment identity instead of confirming or creating again.",
    importance: "Four tickets were issued after one verified charge, with no second browser confirmation.",
    limitation: "One bounded recovery does not establish browser-return reliability, connector identity, or a population success rate.",
    attempts: recordedReplayFlows[0].attempts,
  },
  {
    id: "RUN-0808-02",
    flowId: "confirmed-payment",
    orderLabel: null,
    observedAt: "2026-08-08",
    observedTime: null,
    amountMinor: 18_460,
    currency: "USD",
    itemCount: 1,
    outcome: "fulfilled",
    proof: "live_sandbox_recorded",
    method: "Card",
    connector: "stripe_test",
    attemptCount: 1,
    chargedAttemptCount: 1,
    ticketCount: 1,
    canonicalPaymentState: "succeeded",
    attemptState: "charged",
    evidenceSource: "HS-01 + HS-02 MATRIX CASES",
    operationSemantics: "CREATE ONCE → CONFIRM ONCE → RETRIEVE → FULFILL",
    proofLabel: "RECORDED SANDBOX · CARD SUCCESS",
    problem: "A return page cannot safely authorize ticket fulfillment on its own.",
    hyperswitchRole: "Expose canonical status, connector, amount, and attempt facts for same-payment retrieval.",
    importance: "ONSALE can issue the exact ticket only after expected money and one charged attempt are proven.",
    limitation: "This proves one StripeTest sandbox lifecycle, not production authorization performance or a second processor.",
    attempts: replayFlowCatalog[0].attempts,
  },
  {
    id: "RUN-0808-03",
    flowId: "action-required",
    orderLabel: null,
    observedAt: "2026-08-08",
    observedTime: null,
    amountMinor: 18_460,
    currency: "USD",
    itemCount: 1,
    outcome: "action_required",
    proof: "live_sandbox_recorded",
    method: "Klarna",
    connector: "stripe_test",
    attemptCount: 1,
    chargedAttemptCount: 0,
    ticketCount: 0,
    canonicalPaymentState: "requires_customer_action",
    attemptState: "authentication_pending",
    evidenceSource: "HS-10 THROUGH HS-13 MATRIX CASES",
    operationSemantics: "CONFIRM ONCE → PROVIDER ACTION → AWAIT RETURN → RETRIEVE REQUIRED",
    proofLabel: "RECORDED SANDBOX · ACTION STARTED",
    problem: "Provider-owned approval interrupts the merchant page without proving payment completion.",
    hyperswitchRole: "Keep one payment identity while Unified Checkout starts the official action surface.",
    importance: "The buyer can return to the same order without a fake bank overlay or premature ticket.",
    limitation: "The retained run stops at action initiation; approval, rejection, and terminal return are not proven.",
    attempts: replayFlowCatalog[1].attempts,
  },
  {
    id: "RUN-0808-04",
    flowId: "terminal-decline",
    orderLabel: null,
    observedAt: "2026-08-08",
    observedTime: null,
    amountMinor: 18_460,
    currency: "USD",
    itemCount: 1,
    outcome: "declined",
    proof: "live_sandbox_recorded",
    method: "Card",
    connector: "stripe_test",
    attemptCount: 1,
    chargedAttemptCount: 0,
    ticketCount: 0,
    canonicalPaymentState: "failed",
    attemptState: "failure",
    evidenceSource: "GENERIC DECLINE RECEIPT",
    operationSemantics: "CONFIRM ONCE → TERMINAL FAILURE → NO CASCADE → NO FULFILLMENT",
    proofLabel: "RECORDED SANDBOX · HARD DECLINE",
    problem: "A hard decline can be mistaken for a retryable technical failure.",
    hyperswitchRole: "Normalize the returned attempt and preserve its terminal meaning separately from merchant retry policy.",
    importance: "No blind connector cascade, duplicate issuer attempt, charge, or ticket follows the decline.",
    limitation: "This proves one StripeTest failure fixture, not production issuer semantics or automatic retry eligibility.",
    attempts: replayFlowCatalog[2].attempts,
  },
] satisfies readonly RecordedRunSummary[]

export interface ReplayMerchantFacts {
  readonly itemCount: number
  readonly ticketCount: number
}

export interface ReplayTraceSnapshot {
  readonly frame: PaymentTraceFrameV1
  readonly playback: PaymentTracePlaybackV1
  readonly motionTruth: "authorized" | "static_selection" | "operation_link_missing"
}

function traceProofForEvidence(
  evidenceClass: ReplayEvidenceClass,
): PaymentTraceFactProofV1 {
  switch (evidenceClass) {
    case "live_sandbox_recorded":
    case "configuration_block":
      return "recorded_sandbox"
    case "source_determined":
      return "source_determined"
    case "merchant_rule":
      return "merchant_rule"
    case "local_simulation":
      return "simulation"
    default: {
      const exhaustive: never = evidenceClass
      return exhaustive
    }
  }
}

function traceOutcomeForStep(step: ReplayStep): ReplayAttempt["outcome"] {
  switch (step.attemptStatus) {
    case "authentication_pending":
      return "action_required"
    case "technical_failure":
      return "technical_failure"
    case "failure":
      return "hard_decline"
    case "unknown":
      return "uncertain"
    case "charged":
      return "succeeded"
    case "processing":
      return "processing"
    case "payment_method_awaited":
    case null:
      return step.canonicalStatus === "processing"
        ? "processing"
        : "requires_method"
    default:
      return step.canonicalStatus === "succeeded"
        ? "succeeded"
        : "requires_method"
  }
}

function traceAttemptsAtStep(
  flow: ReplayFlow,
  step: ReplayStep,
): readonly PaymentTraceAttemptV1[] {
  const count = Math.max(0, step.attemptCount ?? 0)
  const visible = flow.attempts.slice(0, count)
  return visible.map((attempt, index) => {
    const isCurrentAttempt = index === visible.length - 1
    const outcome = isCurrentAttempt ? traceOutcomeForStep(step) : attempt.outcome
    const methodProof = traceProofForEvidence(attempt.evidenceClass)
    return {
      ordinal: attempt.ordinal,
      methodAtAttempt: attempt.method === null
        ? null
        : { family: attempt.method, type: null, proof: methodProof },
      connector: isCurrentAttempt ? step.connector : attempt.connector,
      outcome,
      charged: isCurrentAttempt ? outcome === "succeeded" && step.attemptStatus === "charged" : attempt.charged,
      retryKind: attempt.ordinal === 1
        ? "initial"
        : flow.proof === "local_simulation"
          ? "automatic"
          : "not_observed",
      failureClass: outcome === "hard_decline"
        ? "hard_decline"
        : outcome === "technical_failure"
          ? "technical"
          : attempt.failureClass,
      proof: methodProof,
    }
  })
}

function terminalForStep(
  flow: ReplayFlow,
  step: ReplayStep,
): PaymentTraceFrameV1["orchestration"]["terminal"] {
  if (flow.proof === "configuration_block") return "integrity_review"
  if (step.canonicalStatus === "requires_customer_action") return "action_required"
  if (step.canonicalStatus === "processing") return "processing"
  if (step.canonicalStatus === "failed") return "declined"
  if (step.canonicalStatus === "unknown") return "uncertain"
  if (step.canonicalStatus === "succeeded") return "succeeded"
  return null
}

function toneForStep(step: ReplayStep): PaymentTraceHandoffV1["tone"] {
  if (step.canonicalStatus === "failed" || step.attemptStatus === "technical_failure") return "failure"
  if (step.canonicalStatus === "succeeded") return "success"
  if (step.canonicalStatus === "requires_customer_action") return "action"
  if (step.canonicalStatus === "unknown") return "unknown"
  return "progress"
}

function replayEventId(flow: ReplayFlow, step: ReplayStep): string {
  const value = `${flow.id}:${step.id}`
  let left = 2_166_136_261
  let right = 5381
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    left = Math.imul(left ^ code, 16_777_619) >>> 0
    right = (Math.imul(right, 33) ^ code) >>> 0
  }
  return `evt_${left.toString(36).padStart(7, "0")}${right.toString(36).padStart(7, "0")}`
}

function nodeForActor(actor: ReplayActor): PaymentTraceNodeIdV1 {
  switch (actor) {
    case "buyer":
      return "buyer"
    case "merchant":
      return "merchant"
    case "hyperswitch":
      return "hyperswitch"
    case "processor":
      return "connector"
    case "reconcile":
      return "reconcile"
    case "ticket":
      return "tickets"
    default: {
      const exhaustive: never = actor
      return exhaustive
    }
  }
}

function merchantAtStep(
  flow: ReplayFlow,
  stepIndex: number,
  facts: ReplayMerchantFacts,
): PaymentTraceMerchantV1 {
  const reached = flow.steps.slice(0, stepIndex + 1)
  const step = reached[reached.length - 1]
  const fulfilled =
    step.actor === "ticket" &&
    step.canonicalStatus === "succeeded" &&
    facts.itemCount > 0 &&
    facts.ticketCount === facts.itemCount
  const paid = !fulfilled && step.canonicalStatus === "succeeded" && step.amountReceivedMinor !== null
  const review = flow.proof === "configuration_block"
  const paymentStarted = reached.some((candidate) =>
    candidate.actor === "hyperswitch" ||
    candidate.actor === "processor" ||
    candidate.actor === "reconcile"
  )
  return {
    itemCount: facts.itemCount,
    ticketCount: fulfilled ? facts.ticketCount : 0,
    orderState: fulfilled
      ? "fulfilled"
      : paid
        ? "paid"
        : review
          ? "review"
          : paymentStarted
            ? "payment_pending"
            : "held",
  }
}

function reachedEdgesAtStep(
  flow: ReplayFlow,
  stepIndex: number,
): ReadonlySet<PaymentTraceEdgeIdV1> {
  const reached = new Set<PaymentTraceEdgeIdV1>()
  for (const step of flow.steps.slice(0, stepIndex + 1)) {
    if (step.motion) reached.add(step.motion.edgeId)
    switch (step.actor) {
      case "merchant":
        if (stepIndex === 0 || step.id.includes("held")) reached.add("buyer_merchant")
        break
      case "hyperswitch":
        reached.add("merchant_hyperswitch")
        break
      case "processor":
        if (step.connector !== null) {
          reached.add("hyperswitch_connector")
          if (step.attemptStatus !== "processing") reached.add("connector_hyperswitch")
        }
        break
      case "reconcile":
        reached.add("hyperswitch_retrieve")
        break
      case "ticket":
        reached.add("reconcile_merchant")
        reached.add("merchant_tickets")
        break
      case "buyer":
        break
      default: {
        const exhaustive: never = step.actor
        return exhaustive
      }
    }
  }
  return reached
}

function retainedMotionForEdge(
  flow: ReplayFlow,
  stepIndex: number,
  edgeId: PaymentTraceEdgeIdV1,
): ReplayStep["motion"] {
  for (let index = Math.min(stepIndex, flow.steps.length - 1); index >= 0; index -= 1) {
    const motion = flow.steps[index]?.motion
    if (motion?.edgeId === edgeId) return motion
  }
  return undefined
}

function traceNodeState(
  id: PaymentTraceNodeIdV1,
  currentNode: PaymentTraceNodeIdV1 | null,
  reachedActors: ReadonlySet<PaymentTraceNodeIdV1>,
  terminal: PaymentTraceFrameV1["orchestration"]["terminal"],
  merchant: PaymentTraceMerchantV1,
): PaymentTraceNodeStateV1 {
  if (id === currentNode) return "current"
  if (id === "tickets" && merchant.orderState === "fulfilled") return "succeeded"
  if (id === "reconcile" && terminal === "succeeded" && reachedActors.has(id)) return "succeeded"
  if (id === "connector" && reachedActors.has(id)) {
    if (terminal === "declined") return "declined"
    if (terminal === "action_required") return "action_required"
    if (terminal === "processing") return "processing"
    if (terminal === "succeeded") return "succeeded"
  }
  if (id === "hyperswitch" && terminal === "integrity_review") return "integrity_review"
  return reachedActors.has(id) ? "traversed" : "future"
}

export function createReplayTraceSnapshot(
  flow: ReplayFlow,
  stepIndex: number,
  mode: ReplayMode,
  merchantFacts: ReplayMerchantFacts,
  replayId: string,
): ReplayTraceSnapshot {
  const boundedIndex = Math.max(0, Math.min(flow.steps.length - 1, stepIndex))
  const step = flow.steps[boundedIndex]
  const revision = `${flow.id}:${boundedIndex + 1}`
  const attempts = traceAttemptsAtStep(flow, step)
  const selectedAttempt = attempts.find((attempt) => attempt.methodAtAttempt !== null)
  const merchant = merchantAtStep(flow, boundedIndex, merchantFacts)
  const terminal = terminalForStep(flow, step)
  const chargedAttemptCount = attempts.filter((attempt) => attempt.charged).length
  const winner = attempts.find((attempt) => attempt.charged && attempt.outcome === "succeeded")
  const orchestration: PaymentTraceFrameV1["orchestration"] = {
    selectedMethod: selectedAttempt?.methodAtAttempt ?? null,
    attempts,
    chargedAttemptCount,
    winningAttemptOrdinal: winner?.ordinal ?? null,
    terminal,
    orderRetained: attempts.length <= 1 || flow.proof === "local_simulation",
  }
  const reachedActors = new Set<PaymentTraceNodeIdV1>(["buyer", "merchant"])
  for (const candidate of flow.steps.slice(0, boundedIndex + 1)) {
    reachedActors.add(nodeForActor(candidate.actor))
  }
  const currentMotion = mode === "playing" ? step.motion : undefined
  const currentNode = currentMotion
    ? paymentTraceEndpointsV1(currentMotion.edgeId)[1]
    : mode === "playing"
      ? nodeForActor(step.actor)
      : null
  const currentProof = traceProofForEvidence(step.evidenceClass)
  const latestAttempt = attempts.at(-1)
  const nodes = PAYMENT_TRACE_NODE_IDS_V1.map((id) => ({
    id,
    label: id === "buyer"
      ? "BUYER"
      : id === "merchant"
        ? "ONSALE / MERCHANT"
        : id === "hyperswitch"
          ? "HYPERSWITCH"
          : id === "connector"
            ? "ORCHESTRATION"
            : id === "reconcile"
              ? "RECONCILE"
              : "TICKETS",
    detail: id === "buyer"
      ? step.actor === "buyer" ? "result unknown" : "checkout intent"
      : id === "merchant"
        ? `${merchant.itemCount} item${merchant.itemCount === 1 ? "" : "s"} · ${merchant.orderState}`
        : id === "hyperswitch"
          ? step.canonicalStatus.replace(/_/gu, " ")
          : id === "connector"
            ? latestAttempt?.connector ?? "no connector observed"
            : id === "reconcile"
              ? step.amountReceivedMinor === null ? "money not observed" : "same-payment proof"
              : merchant.ticketCount === 0 ? "not issued" : `${merchant.ticketCount} issued`,
    state: traceNodeState(id, currentNode, reachedActors, terminal, merchant),
    proof: id === "merchant" || id === "tickets"
      ? "merchant_rule"
      : id === "connector"
        ? latestAttempt?.proof ?? "unproven"
        : id === "reconcile" && step.amountReceivedMinor !== null
          ? flow.proof === "local_simulation" ? "simulation" : "server_retrieve"
          : currentProof,
  }))
  const reachedEdges = reachedEdgesAtStep(flow, boundedIndex)
  const edges = PAYMENT_TRACE_EDGE_IDS_V1.map((id) => {
    const attemptEdge = id === "hyperswitch_connector" || id === "connector_hyperswitch"
    const current = currentMotion?.edgeId === id
    const terminalEdge = id === "merchant_tickets" && merchant.orderState === "fulfilled"
    const failedEdge = id === "connector_hyperswitch" && terminal === "declined"
    const edgeObserved = reachedEdges.has(id) && (
      id !== "merchant_tickets" || merchant.orderState === "fulfilled"
    )
    const retainedMotion = retainedMotionForEdge(flow, boundedIndex, id)
    return {
      id,
      state: current
        ? "current" as const
        : terminalEdge
          ? "success" as const
          : failedEdge
            ? "failure" as const
            : edgeObserved
              ? "traversed" as const
              : "possible" as const,
      attemptOrdinal: attemptEdge
        ? currentMotion?.attemptOrdinal ?? latestAttempt?.ordinal ?? null
        : null,
      proof: current
        ? currentMotion.authorityProof
        : edgeObserved
          ? retainedMotion?.authorityProof ?? (attemptEdge
            ? latestAttempt?.proof ?? "unproven"
            : id === "hyperswitch_retrieve"
              ? flow.proof === "local_simulation" ? "simulation" : "server_retrieve"
              : id === "merchant_tickets" && merchant.orderState === "fulfilled"
                ? flow.proof === "local_simulation" ? "simulation" : "recorded_sandbox"
                : id === "reconcile_merchant" && merchant.orderState === "fulfilled"
                  ? flow.proof === "local_simulation" ? "simulation" : "recorded_sandbox"
                  : id === "buyer_merchant"
                    ? "merchant_rule"
                    : currentProof)
          : "unproven",
    }
  })
  const frame: PaymentTraceFrameV1 = {
    revision,
    nodes,
    edges,
    orchestration,
    merchant,
    ariaLabel: `${flow.label}, retained step ${boundedIndex + 1} of ${flow.steps.length}`,
  }

  if (mode !== "playing") {
    return {
      frame,
      playback: {
        kind: "static",
        reason: mode === "static" ? "historical_selection" : "previous_step",
      },
      motionTruth: mode === "static" ? "static_selection" : "operation_link_missing",
    }
  }
  if (!step.motion) {
    return {
      frame,
      playback: { kind: "static", reason: "catch_up" },
      motionTruth: "operation_link_missing",
    }
  }

  const [source, target] = paymentTraceEndpointsV1(step.motion.edgeId)
  const common = {
    eventId: replayEventId(flow, step),
    sequence: boundedIndex + 1,
    edgeId: step.motion.edgeId,
    source,
    target,
    attemptOrdinal: step.motion.attemptOrdinal,
    label: step.title,
    tone: toneForStep(step),
    evidenceRevision: revision,
  } as const
  const handoff: PaymentTraceHandoffV1 = step.motion.authorityProof === "simulation"
    ? { ...common, context: "simulation", authorityProof: "simulation" }
    : { ...common, context: "recorded_sandbox", authorityProof: step.motion.authorityProof }
  return {
    frame,
    playback: { kind: "replay_event", replayId, handoff },
    motionTruth: "authorized",
  }
}

export const defaultReplayFlowId = replayFlowCatalog[0].id

export type ReplayMode = "static" | "playing" | "paused" | "complete"

export type ReplayState = {
  flowId: string
  stepIndex: number
  mode: ReplayMode
}

interface SelectReplayFlowAction {
  readonly type: "select_flow"
  readonly flowId: string
}

export type ReplayAction = SelectReplayFlowAction | {
  type: "play"
} | { type: "pause" } | { type: "next" } | { type: "previous" } | {
  type: "restart"
} | { type: "tick" } | { type: "complete" } | { type: "seek"; stepIndex: number }

export function replayFlowById(flowId: string): ReplayFlow {
  return (
    storyLabFlowCatalog.find((flow) => flow.id === flowId) ??
    replayFlowCatalog.find((flow) => flow.id === flowId) ??
    recordedReplayFlows.find((flow) => flow.id === flowId) ??
    replayFlowCatalog[0]!
  )
}

export function createReplayState(flowId = defaultReplayFlowId): ReplayState {
  const flow = replayFlowById(flowId)
  return createReplayStateForFlow(flow)
}

export function createReplayStateForFlow(flow: ReplayFlow): ReplayState {
  return {
    flowId: flow.id,
    stepIndex: Math.max(0, flow.steps.length - 1),
    mode: "static",
  }
}

export function transitionReplay(
  state: ReplayState,
  action: ReplayAction,
): ReplayState {
  const flow = action.type === "select_flow"
    ? replayFlowById(action.flowId)
    : replayFlowById(state.flowId)
  return transitionReplayForFlow(flow, state, action)
}

export function transitionReplayForFlow(
  flow: ReplayFlow,
  state: ReplayState,
  action: ReplayAction,
): ReplayState {
  const lastIndex = flow.steps.length - 1

  switch (action.type) {
    case "select_flow":
      return createReplayStateForFlow(flow)
    case "play":
      return state.mode === "static" || state.mode === "complete"
        ? { ...state, stepIndex: 0, mode: "playing" }
        : { ...state, mode: "playing" }
    case "pause":
      return state.mode === "playing" ? { ...state, mode: "paused" } : state
    case "next": {
      const stepIndex = Math.min(lastIndex, state.stepIndex + 1)
      return {
        ...state,
        stepIndex,
        mode: stepIndex === lastIndex ? "complete" : "paused",
      }
    }
    case "previous":
      return {
        ...state,
        stepIndex: Math.max(0, state.stepIndex - 1),
        mode: "paused",
      }
    case "restart":
      return { ...state, stepIndex: 0, mode: "paused" }
    case "seek":
      return {
        ...state,
        stepIndex: Math.max(0, Math.min(lastIndex, action.stepIndex)),
        mode: action.stepIndex >= lastIndex ? "complete" : "paused",
      }
    case "complete":
      return { ...state, stepIndex: lastIndex, mode: "complete" }
    case "tick": {
      if (state.mode !== "playing") return state
      const stepIndex = Math.min(lastIndex, state.stepIndex + 1)
      return {
        ...state,
        stepIndex,
        mode: stepIndex === lastIndex ? "complete" : "playing",
      }
    }
    default: {
      const exhaustive: never = action
      return exhaustive
    }
  }
}
import type {
  PaymentTraceAttemptV1,
  PaymentTraceEdgeIdV1,
  PaymentTraceFactProofV1,
  PaymentTraceFrameV1,
  PaymentTraceHandoffV1,
  PaymentTraceMerchantV1,
  PaymentTraceNodeIdV1,
  PaymentTraceNodeStateV1,
  PaymentTracePlaybackV1,
} from "../../src/payment-trace/model"
import {
  PAYMENT_TRACE_EDGE_IDS_V1,
  PAYMENT_TRACE_NODE_IDS_V1,
  paymentTraceEndpointsV1,
} from "../../src/payment-trace/model"
