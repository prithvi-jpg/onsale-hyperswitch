import { describe, expect, it, vi } from "vitest"

import {
  bindHyperswitchV1Evidence,
  type HyperswitchV1AdapterPort,
} from "../../src/server/hyperswitch-v1"
import type {
  OwnedCheckoutOrderSnapshot,
  CreateOrderResult,
} from "../../src/server/inventory-neon"
import type {
  ApplyPaymentObservationResult,
  BeginReconciliationResult,
  PaymentAggregateInspection,
  PrepareCheckoutResult,
  RecordPreCreateNotFoundResult,
  ServerCheckoutOperationHandleV1,
  CheckoutExecutionDirectiveV1,
} from "../../src/server/payment-neon"
import {
  OnsaleCheckoutCoordinatorV1,
  OnsaleCheckoutRetrieveOnlyCoordinatorV1,
  type CheckoutCoordinatorDependenciesV1,
  type CheckoutPaymentPortV1,
} from "../../src/server/onsale-checkout-coordinator"
import { createOnsaleOrderPointerV1 } from "../../src/server/onsale-checkout-route-runtime"

const BUYER_REF = `sess_${"a".repeat(64)}`
const HOLD_REF = "00000000-0000-4000-8000-000000000501"
const ORDER_REF = "00000000-0000-4000-8000-000000000701"
const COMMAND_A = "00000000-0000-4000-8000-000000000901"
const COMMAND_B = "00000000-0000-4000-8000-000000000902"
const ENSURE_OPERATION = "00000000-0000-4000-8000-000000000801"
const SUCCESSOR_OPERATION = "00000000-0000-4000-8000-000000000802"
const RECONCILE_OPERATION = "00000000-0000-4000-8000-000000000803"
const PROVIDER_PAYMENT_REF = `pay_${"a".repeat(26)}`
const NOW = new Date("2026-08-08T20:00:00.000Z")

function handle(
  operationId: string,
  operationKey = operationId,
): ServerCheckoutOperationHandleV1 {
  return Object.defineProperties({}, {
    operationId: { value: operationId, enumerable: false },
    operationKey: { value: operationKey, enumerable: false },
  }) as ServerCheckoutOperationHandleV1
}

function ownedOrder(
  overrides: Partial<OwnedCheckoutOrderSnapshot> = {},
): OwnedCheckoutOrderSnapshot {
  return {
    id: ORDER_REF,
    holdId: HOLD_REF,
    eventId: "00000000-0000-4000-8000-000000000301",
    state: "payment_pending",
    paymentDeadlineAt: "2026-08-08T20:05:00.000Z",
    serverObservedAt: NOW.toISOString(),
    totals: {
      currency: "USD",
      subtotalMinor: 18_000,
      feeMinor: 2_000,
      taxMinor: 500,
      totalMinor: 20_500,
    },
    items: [
      {
        id: "00000000-0000-4000-8000-000000000601",
        seatId: "00000000-0000-4000-8000-000000000101",
        sectionName: "Orchestra",
        rowLabel: "A",
        seatLabel: "1",
        priceTierName: "Standard",
        faceValueMinor: 18_000,
        feeMinor: 2_000,
        taxMinor: 500,
        totalMinor: 20_500,
        currency: "USD",
      },
    ],
    ...overrides,
  }
}

function createdOrder(): CreateOrderResult {
  const order = ownedOrder({ state: "awaiting_payment" })
  return {
    replayed: false,
    orderId: order.id,
    holdId: order.holdId,
    eventId: order.eventId,
    state: "awaiting_payment",
    seatIds: order.items.map((item) => item.seatId),
    totals: order.totals,
    items: order.items,
  }
}

function prepareResult(
  execution: Pick<PrepareCheckoutResult, "directive" | "operation" | "onNotFound" | "reason"> = {
    directive: "retrieve_same_identity",
    operation: handle(ENSURE_OPERATION),
    onNotFound: "authorize_create_once",
    reason: null,
  },
): PrepareCheckoutResult {
  return {
    replayed: false,
    paymentId: "00000000-0000-4000-8000-000000000901",
    orderId: ORDER_REF,
    providerPaymentRef: PROVIDER_PAYMENT_REF,
    createState: "reconcile_required",
    amountMinor: 20_500,
    currency: "USD",
    itemCount: 1,
    ...execution,
  }
}

function recordResult(
  execution: CheckoutExecutionDirectiveV1 = {
    directive: "create_same_identity",
    operation: handle(SUCCESSOR_OPERATION),
    onNotFound: "block_recreate",
    reason: null,
    providerSessionExpirySeconds: 137,
  },
): RecordPreCreateNotFoundResult {
  return {
    replayed: false,
    paymentId: "00000000-0000-4000-8000-000000000901",
    orderId: ORDER_REF,
    providerPaymentRef: PROVIDER_PAYMENT_REF,
    createState: "reconcile_required",
    ...execution,
  }
}

function beginResult(
  execution: Pick<BeginReconciliationResult, "directive" | "operation" | "onNotFound" | "reason"> = {
    directive: "retrieve_same_identity",
    operation: handle(RECONCILE_OPERATION),
    onNotFound: "block_recreate",
    reason: null,
  },
): BeginReconciliationResult {
  return {
    replayed: false,
    paymentId: "00000000-0000-4000-8000-000000000901",
    orderId: ORDER_REF,
    providerPaymentRef: PROVIDER_PAYMENT_REF,
    ...execution,
  }
}

function applied(
  overrides: Partial<ApplyPaymentObservationResult> = {},
): ApplyPaymentObservationResult {
  return {
    replayed: false,
    paymentId: "00000000-0000-4000-8000-000000000901",
    orderId: ORDER_REF,
    canonicalState: "requires_method",
    integrityState: "clear",
    orderState: "payment_pending",
    observationPublicRef: "00000000-0000-4000-8000-000000000951",
    successfulChargedAttemptCount: 0,
    retainedTerminalSuccess: false,
    cascadeObserved: false,
    integrityIssues: [],
    fulfillmentId: null,
    ticketCount: 0,
    ...overrides,
  }
}

function aggregate(
  overrides: Partial<PaymentAggregateInspection> = {},
): PaymentAggregateInspection {
  return {
    order: {
      id: ORDER_REF,
      state: "payment_pending",
      amountMinor: 20_500,
      currency: "USD",
      itemCount: 1,
    },
    paymentCount: 1,
    payment: {
      id: "00000000-0000-4000-8000-000000000901",
      providerPaymentRef: PROVIDER_PAYMENT_REF,
      createState: "created",
      canonicalState: "requires_method",
      integrityState: "clear",
      amountMinor: 20_500,
      currency: "USD",
      successfulAttemptId: null,
    },
    operations: [],
    observations: [
      {
        publicRef: "00000000-0000-4000-8000-000000000951",
        source: "create",
        providerStatus: "requires_payment_method",
        canonicalState: "requires_method",
        selectedPaymentMethod: "credit",
        observedConnector: null,
        amountMinor: 20_500,
        currency: "USD",
        successfulChargedAttemptCount: 0,
      },
    ],
    attempts: [
      {
        id: "00000000-0000-4000-8000-000000000952",
        providerAttemptRef: `sha256:${"b".repeat(64)}`,
        canonicalState: "requires_method",
        observedConnector: null,
      },
    ],
    fulfillment: null,
    tickets: [],
    ...overrides,
  }
}

function aggregateInProgress(
  canonicalState: "action_required" | "processing" | "uncertain",
): PaymentAggregateInspection {
  const base = aggregate()
  return {
    ...base,
    payment: {
      ...base.payment,
      canonicalState,
    },
    observations: [
      {
        ...base.observations[0]!,
        source: "retrieve",
        canonicalState,
        providerStatus:
          canonicalState === "action_required"
            ? "requires_customer_action"
            : canonicalState,
      },
    ],
    attempts: [
      {
        ...base.attempts[0]!,
        canonicalState,
      },
    ],
  }
}

function providerObservation(source: "create" | "retrieve") {
  return {
    schema: "onsale.payment-observation.v1" as const,
    source,
    providerPaymentRef: `sha256:${"c".repeat(64)}` as const,
    providerStatus: "requires_payment_method",
    canonicalState: "requires_method" as const,
    amountMinor: 20_500,
    currency: "USD",
    selectedPaymentMethod: { family: "card", type: "credit" },
    observedConnector: null,
    nextAction: { present: false, kind: null },
    attempts: [
      {
        index: 1,
        providerAttemptRef: `sha256:${"d".repeat(64)}` as const,
        providerStatus: "requires_payment_method",
        canonicalState: "requires_method" as const,
        charged: false,
        hardDecline: false,
        observedConnector: null,
        amountMinor: 20_500,
        currency: "USD",
        error: null,
      },
    ],
    successfulChargedAttemptCount: 0,
    hardDeclineObserved: false,
    error: null,
    observationHash: `sha256:${"e".repeat(64)}` as const,
  }
}

function harness(
  options: {
    readonly retrieveResults?: readonly ({ readonly kind: "not_found" } | {
      readonly kind: "uncertain"
    } | { readonly kind: "found" })[]
    readonly createUncertain?: boolean
    readonly prepareResults?: readonly PrepareCheckoutResult[]
    readonly recordResults?: readonly RecordPreCreateNotFoundResult[]
    readonly beginResults?: readonly BeginReconciliationResult[]
    readonly aggregates?: readonly PaymentAggregateInspection[]
    readonly order?: OwnedCheckoutOrderSnapshot
    readonly orders?: readonly OwnedCheckoutOrderSnapshot[]
    readonly now?: Date
  } = {},
) {
  const calls: string[] = []
  const retrieveResults = [
    ...(options.retrieveResults ?? [{ kind: "not_found" }]),
  ]
  const delegate: HyperswitchV1AdapterPort = {
    configuration: () => ({
      kind: "ready",
      provider: "hyperswitch",
      apiVersion: "v1",
      environment: "sandbox",
      publishableKeyScope: "explicit_v1_env_only",
    }),
    retrievePayment: vi.fn(async () => {
      calls.push("provider.retrieve")
      const next = retrieveResults.shift() ?? { kind: "uncertain" as const }
      if (next.kind === "not_found") {
        return { kind: "not_found", observedAt: NOW.toISOString() }
      }
      if (next.kind === "uncertain") {
        return {
          kind: "uncertain",
          observedAt: NOW.toISOString(),
          error: {
            code: "hyperswitch_outcome_uncertain",
            message:
              "The provider outcome is unknown. Retrieve the same payment before retrying.",
            httpStatus: null,
          },
        }
      }
      return {
        kind: "found",
        observedAt: NOW.toISOString(),
        observation: providerObservation("retrieve"),
        checkoutGrant: {
          clientSecret: "secret_client_canary_123456",
          publishableKey: "pk_snd_publishable_canary_123456",
        },
      }
    }),
    createPayment: vi.fn(async () => {
      calls.push("provider.create")
      if (options.createUncertain) {
        return {
          kind: "uncertain",
          observedAt: NOW.toISOString(),
          error: {
            code: "hyperswitch_outcome_uncertain",
            message:
              "The provider outcome is unknown. Retrieve the same payment before retrying.",
            httpStatus: null,
          },
        }
      }
      return {
        kind: "ready",
        observedAt: NOW.toISOString(),
        observation: providerObservation("create"),
        checkoutGrant: {
          clientSecret: "secret_client_canary_123456",
          publishableKey: "pk_snd_publishable_canary_123456",
        },
      }
    }),
  }
  const pair = bindHyperswitchV1Evidence(delegate)
  const prepareResults = [...(options.prepareResults ?? [prepareResult()])]
  const recordResults = [...(options.recordResults ?? [recordResult()])]
  const beginResults = [...(options.beginResults ?? [beginResult()])]
  const aggregates = [...(options.aggregates ?? [aggregate()])]
  const orders = [...(options.orders ?? [])]
  const inventory = {
    createOrder: vi.fn(async () => {
      calls.push("inventory.createOrder")
      return createdOrder()
    }),
    getOwnedCheckoutOrder: vi.fn(async () => {
      calls.push("inventory.getOwnedCheckoutOrder")
      return (
        orders.shift() ??
        options.order ??
        ownedOrder({ serverObservedAt: (options.now ?? NOW).toISOString() })
      )
    }),
  }
  const payments: CheckoutPaymentPortV1 = {
    prepareCheckout: vi.fn(async () => {
      calls.push("payments.prepareCheckout")
      return prepareResults.shift() ?? prepareResult()
    }),
    recordPreCreateNotFound: vi.fn(async (input) => {
      calls.push("payments.recordPreCreateNotFound")
      expect(pair.verifier.require(input.evidence).kind).toBe(
        "retrieve_not_found",
      )
      return recordResults.shift() ?? recordResult()
    }),
    beginReconciliation: vi.fn(async () => {
      calls.push("payments.beginReconciliation")
      return beginResults.shift() ?? beginResult()
    }),
    applyObservation: vi.fn(async (input) => {
      calls.push("payments.applyObservation")
      expect(pair.verifier.require(input.observation).kind).toMatch(
        /_observation$/u,
      )
      return applied()
    }),
    inspectPaymentAggregate: vi.fn(async () => {
      calls.push("payments.inspectPaymentAggregate")
      return aggregates.shift() ?? aggregate()
    }),
  }
  const dependencies: CheckoutCoordinatorDependenciesV1 = {
    inventory,
    payments,
    provider: pair.adapter,
    returnUrl: "https://onsale.example/api/onsale/return",
  }
  return { calls, delegate, pair, inventory, payments, dependencies }
}

describe("C3 checkout coordinator", () => {
  it("converts deterministically, retrieves first, authorizes one create only from attested 404, and applies create evidence", async () => {
    const test = harness()
    const coordinator = new OnsaleCheckoutCoordinatorV1(test.dependencies)
    const result = await coordinator.prepare({
      buyerRef: BUYER_REF,
      commandId: COMMAND_A,
      holdRef: HOLD_REF,
    })

    expect(test.calls).toEqual([
      "inventory.createOrder",
      "inventory.getOwnedCheckoutOrder",
      "payments.prepareCheckout",
      "provider.retrieve",
      "payments.recordPreCreateNotFound",
      "provider.create",
      "payments.applyObservation",
      "payments.inspectPaymentAggregate",
      "inventory.getOwnedCheckoutOrder",
    ])
    expect(test.inventory.createOrder).toHaveBeenCalledWith({
      operationKey: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      holdId: HOLD_REF,
      buyerRef: BUYER_REF,
    })
    expect(test.payments.applyObservation).toHaveBeenCalledWith(
      expect.objectContaining({ operationKey: SUCCESSOR_OPERATION }),
    )
    expect(test.delegate.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantPaymentId: PROVIDER_PAYMENT_REF,
        sessionExpirySeconds: 137,
        returnUrl: "https://onsale.example/api/onsale/return",
        metadata: { item_count: "1", product: "live_event_ticketing" },
      }),
    )
    expect(result.projection.stage).toBe("checkout_ready")
    expect(result.projection.order).not.toHaveProperty("orderRef")
    expect(JSON.stringify(result.orderPointer)).not.toContain(ORDER_REF)
  })

  it("applies an attested retrieve result without calling create or 404 recording", async () => {
    const test = harness({ retrieveResults: [{ kind: "found" }] })
    const coordinator = new OnsaleCheckoutCoordinatorV1(test.dependencies)
    const result = await coordinator.prepare({
      buyerRef: BUYER_REF,
      commandId: COMMAND_A,
      holdRef: HOLD_REF,
    })

    expect(test.delegate.createPayment).not.toHaveBeenCalled()
    expect(test.payments.recordPreCreateNotFound).not.toHaveBeenCalled()
    expect(test.payments.applyObservation).toHaveBeenCalledWith(
      expect.objectContaining({ operationKey: ENSURE_OPERATION }),
    )
    expect(result.projection.stage).toBe("checkout_ready")
  })

  it("re-reads the database clock after provider I/O and suppresses a grant that crossed the deadline", async () => {
    const test = harness({
      retrieveResults: [{ kind: "found" }],
      orders: [
        ownedOrder({ serverObservedAt: "2026-08-08T20:04:59.900Z" }),
        ownedOrder({ serverObservedAt: "2026-08-08T20:05:00.001Z" }),
      ],
    })
    const coordinator = new OnsaleCheckoutCoordinatorV1(test.dependencies)

    const result = await coordinator.prepare({
      buyerRef: BUYER_REF,
      commandId: COMMAND_A,
      holdRef: HOLD_REF,
    })

    expect(result.projection.stage).toBe("expired")
    expect(result.projection.grant).toBeNull()
    expect(test.inventory.getOwnedCheckoutOrder).toHaveBeenCalledTimes(2)
    expect(test.delegate.createPayment).not.toHaveBeenCalled()
  })

  it("stops on retrieve uncertainty and never creates or records a synthetic observation", async () => {
    const test = harness({ retrieveResults: [{ kind: "uncertain" }] })
    const coordinator = new OnsaleCheckoutCoordinatorV1(test.dependencies)
    const result = await coordinator.prepare({
      buyerRef: BUYER_REF,
      commandId: COMMAND_A,
      holdRef: HOLD_REF,
    })

    expect(result.projection.stage).toBe("checking_same_payment")
    expect(test.delegate.createPayment).not.toHaveBeenCalled()
    expect(test.payments.recordPreCreateNotFound).not.toHaveBeenCalled()
    expect(test.payments.applyObservation).not.toHaveBeenCalled()
  })

  it("recovers a lost create response by retrieving the same successor and never dispatching a second POST", async () => {
    const successorRetrieve = prepareResult({
      directive: "retrieve_same_identity",
      operation: handle(SUCCESSOR_OPERATION),
      onNotFound: "block_recreate",
      reason: null,
    })
    const test = harness({
      retrieveResults: [{ kind: "not_found" }, { kind: "found" }],
      createUncertain: true,
      prepareResults: [prepareResult(), successorRetrieve],
      aggregates: [aggregate({ observations: [], attempts: [] }), aggregate()],
    })
    const coordinator = new OnsaleCheckoutCoordinatorV1(test.dependencies)
    const first = await coordinator.prepare({
      buyerRef: BUYER_REF,
      commandId: COMMAND_A,
      holdRef: HOLD_REF,
    })
    const second = await coordinator.prepare({
      buyerRef: BUYER_REF,
      commandId: COMMAND_B,
      holdRef: HOLD_REF,
    })

    expect(first.projection.stage).toBe("checking_same_payment")
    expect(second.projection.stage).toBe("checkout_ready")
    expect(test.delegate.createPayment).toHaveBeenCalledTimes(1)
    expect(test.delegate.retrievePayment).toHaveBeenCalledTimes(2)
    const orderOperationKeys = test.inventory.createOrder.mock.calls.map(
      ([input]) => input.operationKey,
    )
    const ensureOperationKeys = test.payments.prepareCheckout.mock.calls.map(
      ([input]) => input.operationKey,
    )
    expect(new Set(orderOperationKeys).size).toBe(1)
    expect(new Set(ensureOperationKeys).size).toBe(1)
  })

  it("uses a fresh retrieve-only reconciliation after terminal ensure replay to remount a lost grant", async () => {
    const terminal = prepareResult({
      directive: "replay_terminal",
      operation: null,
      onNotFound: null,
      reason: null,
    })
    const test = harness({
      prepareResults: [terminal],
      retrieveResults: [{ kind: "found" }],
    })
    const coordinator = new OnsaleCheckoutCoordinatorV1(test.dependencies)
    const result = await coordinator.prepare({
      buyerRef: BUYER_REF,
      commandId: COMMAND_A,
      holdRef: HOLD_REF,
    })

    expect(test.payments.beginReconciliation).toHaveBeenCalledTimes(1)
    expect(test.delegate.retrievePayment).toHaveBeenCalledTimes(1)
    expect(test.delegate.createPayment).not.toHaveBeenCalled()
    expect(test.payments.applyObservation).toHaveBeenCalledWith(
      expect.objectContaining({ operationKey: RECONCILE_OPERATION }),
    )
    expect(result.projection.stage).toBe("checkout_ready")
  })

  it("is structurally retrieve-only for resume/refresh and treats 404 or uncertainty as same-payment checking", async () => {
    const test = harness({
      retrieveResults: [{ kind: "not_found" }, { kind: "uncertain" }],
      aggregates: [aggregate(), aggregate()],
    })
    const coordinator = new OnsaleCheckoutRetrieveOnlyCoordinatorV1({
      inventory: test.dependencies.inventory,
      payments: {
        beginReconciliation: test.payments.beginReconciliation,
        applyObservation: test.payments.applyObservation,
        inspectPaymentAggregate: test.payments.inspectPaymentAggregate,
      },
      provider: {
        configuration: test.pair.adapter.configuration,
        retrievePayment: test.pair.adapter.retrievePayment,
      },
    })

    const first = await coordinator.reconcile({
      buyerRef: BUYER_REF,
      commandId: COMMAND_A,
      orderPointer: createOnsaleOrderPointerV1(ORDER_REF),
      trigger: "resume",
    })
    const second = await coordinator.reconcile({
      buyerRef: BUYER_REF,
      commandId: COMMAND_B,
      orderPointer: createOnsaleOrderPointerV1(ORDER_REF),
      trigger: "refresh",
    })

    expect(first.stage).toBe("checking_same_payment")
    expect(second.stage).toBe("checking_same_payment")
    expect(test.delegate.createPayment).not.toHaveBeenCalled()
    expect(test.payments.recordPreCreateNotFound).not.toHaveBeenCalled()
    const reconcileKeys = test.payments.beginReconciliation.mock.calls.map(
      ([input]) => input.operationKey,
    )
    expect(new Set(reconcileKeys).size).toBe(2)
  })

  it.each([
    ["before", new Date("2026-08-08T20:04:59.999Z"), "checkout_ready"],
    ["at", new Date("2026-08-08T20:05:00.000Z"), "expired"],
    ["after", new Date("2026-08-08T20:05:00.001Z"), "expired"],
  ] as const)(
    "suppresses a remounted grant %s the immutable deadline on prepare replay",
    async (_boundary, now, expectedStage) => {
      const test = harness({
        now,
        prepareResults: [
          prepareResult({
            directive: "replay_terminal",
            operation: null,
            onNotFound: null,
            reason: null,
          }),
        ],
        retrieveResults: [{ kind: "found" }],
      })
      const coordinator = new OnsaleCheckoutCoordinatorV1(test.dependencies)

      const result = await coordinator.prepare({
        buyerRef: BUYER_REF,
        commandId: COMMAND_A,
        holdRef: HOLD_REF,
      })

      expect(result.projection.stage).toBe(expectedStage)
      expect(result.projection.grant === null).toBe(expectedStage === "expired")
      expect(test.delegate.createPayment).not.toHaveBeenCalled()
    },
  )

  it.each([
    ["before", new Date("2026-08-08T20:04:59.999Z"), "checkout_ready"],
    ["at", new Date("2026-08-08T20:05:00.000Z"), "expired"],
    ["after", new Date("2026-08-08T20:05:00.001Z"), "expired"],
  ] as const)(
    "suppresses a remounted grant %s the immutable deadline on cookie-bound reconcile",
    async (_boundary, now, expectedStage) => {
      const test = harness({ now, retrieveResults: [{ kind: "found" }] })
      const coordinator = new OnsaleCheckoutRetrieveOnlyCoordinatorV1({
        inventory: test.dependencies.inventory,
        payments: {
          beginReconciliation: test.payments.beginReconciliation,
          applyObservation: test.payments.applyObservation,
          inspectPaymentAggregate: test.payments.inspectPaymentAggregate,
        },
        provider: {
          configuration: test.pair.adapter.configuration,
          retrievePayment: test.pair.adapter.retrievePayment,
        },
      })

      const result = await coordinator.reconcile({
        buyerRef: BUYER_REF,
        commandId: COMMAND_A,
        orderPointer: createOnsaleOrderPointerV1(ORDER_REF),
        trigger: "resume",
      })

      expect(result.stage).toBe(expectedStage)
      expect(result.grant === null).toBe(expectedStage === "expired")
      expect(test.delegate.createPayment).not.toHaveBeenCalled()
    },
  )

  it.each([
    ["action_required", "found", "action_required"],
    ["processing", "found", "processing"],
    ["uncertain", "uncertain", "checking_same_payment"],
  ] as const)(
    "keeps a late existing %s payment retrieve-only instead of mislabeling it expired",
    async (canonicalState, providerResult, expectedStage) => {
      const test = harness({
        now: new Date("2026-08-08T20:05:00.001Z"),
        retrieveResults: [{ kind: providerResult }],
        aggregates: [aggregateInProgress(canonicalState)],
      })
      const coordinator = new OnsaleCheckoutRetrieveOnlyCoordinatorV1({
        inventory: test.dependencies.inventory,
        payments: {
          beginReconciliation: test.payments.beginReconciliation,
          applyObservation: test.payments.applyObservation,
          inspectPaymentAggregate: test.payments.inspectPaymentAggregate,
        },
        provider: {
          configuration: test.pair.adapter.configuration,
          retrievePayment: test.pair.adapter.retrievePayment,
        },
      })

      const result = await coordinator.reconcile({
        buyerRef: BUYER_REF,
        commandId: COMMAND_A,
        orderPointer: createOnsaleOrderPointerV1(ORDER_REF),
        trigger: "refresh",
      })

      expect(result.stage).toBe(expectedStage)
      expect(result.grant).toBeNull()
      expect(test.delegate.createPayment).not.toHaveBeenCalled()
    },
  )
})
