import { createHash } from "node:crypto"

import type {
  AttestedHyperswitchV1AdapterPort,
  AttestedHyperswitchV1RetrieveResult,
  HyperswitchV1CreateInput,
  HyperswitchV1CheckoutGrant,
} from "./hyperswitch-v1"
import { HyperswitchV1AdapterError } from "./hyperswitch-v1"
import type {
  CreateOrderInput,
  CreateOrderResult,
  NeonInventoryRepository,
  OwnedCheckoutOrderSnapshot,
} from "./inventory-neon"
import type {
  ApplyPaymentObservationResult,
  BeginReconciliationInput,
  BeginReconciliationResult,
  NeonPaymentRepository,
  PaymentAggregateInspection,
  PrepareCheckoutInput,
  PrepareCheckoutResult,
  RecordPreCreateNotFoundInput,
  RecordPreCreateNotFoundResult,
} from "./payment-neon"
import { PaymentRepositoryError } from "./payment-neon"
import {
  CheckoutRouteBoundaryErrorV1,
  createOnsaleOrderPointerV1,
  type CheckoutCoordinatorProjectionV1,
  type CheckoutReconcileTriggerV1,
  type OnsaleOrderPointerV1,
  type PrepareCheckoutBoundaryInputV1,
  type PreparedCheckoutBoundaryResultV1,
  type ReconcileCheckoutBoundaryInputV1,
} from "./onsale-checkout-route-runtime"

type InventoryCreateOrderV1 = (
  input: CreateOrderInput,
) => Promise<CreateOrderResult>
type InventoryOwnedOrderV1 = (
  orderId: string,
  buyerRef: string,
) => Promise<OwnedCheckoutOrderSnapshot | undefined>

export interface CheckoutInventoryPortV1 {
  readonly createOrder: InventoryCreateOrderV1
  readonly getOwnedCheckoutOrder: InventoryOwnedOrderV1
}

export interface CheckoutPaymentPortV1 {
  readonly prepareCheckout: NeonPaymentRepository["prepareCheckout"]
  readonly recordPreCreateNotFound: NeonPaymentRepository["recordPreCreateNotFound"]
  readonly beginReconciliation: NeonPaymentRepository["beginReconciliation"]
  readonly applyObservation: NeonPaymentRepository["applyObservation"]
  readonly inspectPaymentAggregate: NeonPaymentRepository["inspectPaymentAggregate"]
}

export interface CheckoutRetrievePaymentPortV1 {
  readonly beginReconciliation: CheckoutPaymentPortV1["beginReconciliation"]
  readonly applyObservation: CheckoutPaymentPortV1["applyObservation"]
  readonly inspectPaymentAggregate: CheckoutPaymentPortV1["inspectPaymentAggregate"]
}

interface CheckoutRetrieveProviderPortV1 {
  readonly configuration: AttestedHyperswitchV1AdapterPort["configuration"]
  readonly retrievePayment: AttestedHyperswitchV1AdapterPort["retrievePayment"]
}

export interface CheckoutCoordinatorDependenciesV1 {
  readonly inventory: CheckoutInventoryPortV1
  readonly payments: CheckoutPaymentPortV1
  readonly provider: AttestedHyperswitchV1AdapterPort
  /** Exact server-configured URL. Request Host and browser input never enter it. */
  readonly returnUrl: string
}

export interface CheckoutRetrieveOnlyDependenciesV1 {
  readonly inventory: Pick<CheckoutInventoryPortV1, "getOwnedCheckoutOrder">
  readonly payments: CheckoutRetrievePaymentPortV1
  readonly provider: CheckoutRetrieveProviderPortV1
}

function domainDigestV1(domain: string, ...values: readonly string[]): string {
  const hash = createHash("sha256").update(domain, "utf8")
  for (const value of values) {
    hash.update("\0", "utf8").update(value, "utf8")
  }
  return hash.digest("hex")
}

function deterministicUuidV1(
  domain: string,
  ...values: readonly string[]
): string {
  const chars = domainDigestV1(domain, ...values)
    .slice(0, 32)
    .split("")
  chars[12] = "4"
  chars[16] = (8 + (Number.parseInt(chars[16] ?? "0", 16) % 4)).toString(16)
  const joined = chars.join("")
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`
}

function createOrderOperationKeyV1(buyerRef: string, holdRef: string): string {
  return deterministicUuidV1(
    "onsale-create-order-operation-v1",
    buyerRef,
    holdRef,
  )
}

function ensureCheckoutOperationKeyV1(
  buyerRef: string,
  orderId: string,
): string {
  return deterministicUuidV1(
    "onsale-ensure-checkout-operation-v1",
    buyerRef,
    orderId,
  )
}

function reconcileOperationKeyV1(input: {
  readonly buyerRef: string
  readonly orderId: string
  readonly commandId: string
  readonly trigger: CheckoutReconcileTriggerV1
}): string {
  return deterministicUuidV1(
    "onsale-reconcile-operation-v1",
    input.buyerRef,
    input.orderId,
    input.commandId,
    input.trigger,
  )
}

function checkoutRequestHashV1(
  phase: "ensure" | "reconcile",
  buyerRef: string,
  orderId: string,
  discriminator: string,
): string {
  return domainDigestV1(
    `onsale-${phase}-checkout-request-v1`,
    buyerRef,
    orderId,
    discriminator,
  )
}

function assertProviderConfigurationV1(
  provider: CheckoutRetrieveProviderPortV1,
): void {
  if (provider.configuration().kind !== "ready") {
    throw new CheckoutRouteBoundaryErrorV1("checkout_configuration_blocked")
  }
}

function sameMoneyV1(
  left: OwnedCheckoutOrderSnapshot["totals"],
  right: OwnedCheckoutOrderSnapshot["totals"],
): boolean {
  return (
    left.currency === right.currency &&
    left.subtotalMinor === right.subtotalMinor &&
    left.feeMinor === right.feeMinor &&
    left.taxMinor === right.taxMinor &&
    left.totalMinor === right.totalMinor
  )
}

function sameOrderItemV1(
  left: OwnedCheckoutOrderSnapshot["items"][number],
  right: OwnedCheckoutOrderSnapshot["items"][number],
): boolean {
  return (
    left.id === right.id &&
    left.seatId === right.seatId &&
    left.sectionName === right.sectionName &&
    left.rowLabel === right.rowLabel &&
    left.seatLabel === right.seatLabel &&
    left.priceTierName === right.priceTierName &&
    left.faceValueMinor === right.faceValueMinor &&
    left.feeMinor === right.feeMinor &&
    left.taxMinor === right.taxMinor &&
    left.totalMinor === right.totalMinor &&
    left.currency === right.currency
  )
}

function assertCreatedOrderV1(
  created: CreateOrderResult,
  owned: OwnedCheckoutOrderSnapshot,
  expectedHoldRef: string,
): void {
  if (
    created.orderId !== owned.id ||
    created.holdId !== expectedHoldRef ||
    owned.holdId !== expectedHoldRef ||
    created.eventId !== owned.eventId ||
    !sameMoneyV1(created.totals, owned.totals) ||
    created.items.length !== owned.items.length ||
    created.items.some((item, index) => {
      const durable = owned.items[index]
      return !durable || !sameOrderItemV1(item, durable)
    })
  ) {
    throw new CheckoutRouteBoundaryErrorV1("checkout_integrity_error")
  }
}

function assertPreparedTermsV1(
  prepared: Pick<PrepareCheckoutResult, "orderId" | "amountMinor" | "currency" | "itemCount">,
  order: OwnedCheckoutOrderSnapshot,
): void {
  if (
    prepared.orderId !== order.id ||
    prepared.amountMinor !== order.totals.totalMinor ||
    prepared.currency !== order.totals.currency ||
    prepared.itemCount !== order.items.length
  ) {
    throw new CheckoutRouteBoundaryErrorV1("checkout_integrity_error")
  }
}

function assertRefreshedOrderV1(
  original: OwnedCheckoutOrderSnapshot,
  refreshed: OwnedCheckoutOrderSnapshot,
): void {
  const originalObservedAt = new Date(original.serverObservedAt)
  const refreshedObservedAt = new Date(refreshed.serverObservedAt)
  if (
    refreshed.id !== original.id ||
    refreshed.holdId !== original.holdId ||
    refreshed.eventId !== original.eventId ||
    refreshed.paymentDeadlineAt !== original.paymentDeadlineAt ||
    !sameMoneyV1(refreshed.totals, original.totals) ||
    refreshed.items.length !== original.items.length ||
    refreshed.items.some((item, index) => {
      const expected = original.items[index]
      return !expected || !sameOrderItemV1(item, expected)
    }) ||
    !Number.isFinite(originalObservedAt.getTime()) ||
    originalObservedAt.toISOString() !== original.serverObservedAt ||
    !Number.isFinite(refreshedObservedAt.getTime()) ||
    refreshedObservedAt.toISOString() !== refreshed.serverObservedAt ||
    refreshedObservedAt.getTime() < originalObservedAt.getTime()
  ) {
    throw new CheckoutRouteBoundaryErrorV1("checkout_integrity_error")
  }
}

function termsV1(order: OwnedCheckoutOrderSnapshot) {
  return {
    amountMinor: order.totals.totalMinor,
    currency: order.totals.currency,
    itemCount: order.items.length,
  }
}

function providerItemsV1(
  order: OwnedCheckoutOrderSnapshot,
): HyperswitchV1CreateInput["items"] {
  return order.items.map((item) => ({
    name: `${item.sectionName} / Row ${item.rowLabel} / Seat ${item.seatLabel}`,
    quantity: 1,
    amountMinor: item.totalMinor,
  }))
}

function selectedMethodV1(
  token: string | null,
): CheckoutCoordinatorProjectionV1["payment"]["selectedMethod"] {
  if (token === null) return null
  if (token === "card") return { family: "card", type: null }
  if (token === "credit" || token === "debit") {
    return { family: "card", type: token }
  }
  if (
    token === "klarna" ||
    token === "affirm" ||
    token === "afterpay_clearpay"
  ) {
    return { family: "pay_later", type: token }
  }
  if (token === "paypal" || token === "google_pay" || token === "apple_pay") {
    return { family: "wallet", type: token }
  }
  return { family: null, type: token }
}

function orderProjectionV1(
  order: OwnedCheckoutOrderSnapshot,
  state: CheckoutCoordinatorProjectionV1["order"]["state"],
  ticketCount: number,
): CheckoutCoordinatorProjectionV1["order"] {
  return {
    state,
    paymentDeadlineAt: order.paymentDeadlineAt,
    currency: order.totals.currency,
    subtotalMinor: order.totals.subtotalMinor,
    feeMinor: order.totals.feeMinor,
    taxMinor: order.totals.taxMinor,
    totalMinor: order.totals.totalMinor,
    itemCount: order.items.length,
    items: order.items.map((item) => ({
      sectionLabel: item.sectionName,
      rowLabel: item.rowLabel,
      seatLabel: item.seatLabel,
      priceTier: item.priceTierName,
      faceValueMinor: item.faceValueMinor,
      feeMinor: item.feeMinor,
      taxMinor: item.taxMinor,
      totalMinor: item.totalMinor,
      currency: item.currency,
    })),
    ticketCount,
  }
}

function presentationDeadlineOpenV1(
  order: OwnedCheckoutOrderSnapshot,
): boolean {
  const deadline = new Date(order.paymentDeadlineAt)
  const observedAt = new Date(order.serverObservedAt)
  if (
    !Number.isFinite(deadline.getTime()) ||
    deadline.toISOString() !== order.paymentDeadlineAt ||
    !Number.isFinite(observedAt.getTime()) ||
    observedAt.toISOString() !== order.serverObservedAt
  ) {
    throw new CheckoutRouteBoundaryErrorV1("checkout_integrity_error")
  }
  return observedAt.getTime() < deadline.getTime()
}

function emptyPaymentEvidenceV1(
  canonicalState: CheckoutCoordinatorProjectionV1["payment"]["canonicalState"] = "uncertain",
): CheckoutCoordinatorProjectionV1["payment"] {
  return {
    canonicalState,
    integrityState: "clear",
    observationSource: null,
    selectedMethod: null,
    observedConnector: null,
    attempts: [],
    chargedAttemptCount: 0,
    evidenceGeneration: 0,
  }
}

function assertAggregateV1(
  order: OwnedCheckoutOrderSnapshot,
  aggregate: PaymentAggregateInspection,
): void {
  if (
    aggregate.paymentCount !== 1 ||
    aggregate.order.id !== order.id ||
    aggregate.order.amountMinor !== order.totals.totalMinor ||
    aggregate.order.currency !== order.totals.currency ||
    aggregate.order.itemCount !== order.items.length ||
    aggregate.payment.amountMinor !== order.totals.totalMinor ||
    aggregate.payment.currency !== order.totals.currency ||
    aggregate.tickets.length > order.items.length
  ) {
    throw new CheckoutRouteBoundaryErrorV1("checkout_integrity_error")
  }
}

function paymentEvidenceV1(
  aggregate: PaymentAggregateInspection,
): CheckoutCoordinatorProjectionV1["payment"] {
  const latest = aggregate.observations.at(-1)
  const chargedAttemptCount = latest?.successfulChargedAttemptCount ?? 0
  const succeededAttempts = aggregate.attempts.filter(
    (attempt) => attempt.canonicalState === "succeeded",
  )
  if (
    chargedAttemptCount > succeededAttempts.length ||
    (aggregate.payment.integrityState === "clear" &&
      chargedAttemptCount !== succeededAttempts.length)
  ) {
    throw new CheckoutRouteBoundaryErrorV1("checkout_integrity_error")
  }
  let chargedRemaining = chargedAttemptCount
  const attempts = aggregate.attempts.map((attempt, index) => {
    const charged =
      attempt.canonicalState === "succeeded" && chargedRemaining-- > 0
    return {
      ordinal: index + 1,
      state: attempt.canonicalState,
      charged,
      hardDecline: attempt.canonicalState === "hard_decline",
      connector: attempt.observedConnector,
    }
  })
  return {
    canonicalState: aggregate.payment.canonicalState,
    integrityState: aggregate.payment.integrityState,
    observationSource: latest?.source ?? null,
    selectedMethod: selectedMethodV1(latest?.selectedPaymentMethod ?? null),
    observedConnector: latest?.observedConnector ?? null,
    attempts,
    chargedAttemptCount,
    evidenceGeneration: aggregate.observations.length,
  }
}

function projectionFromAggregateV1(
  order: OwnedCheckoutOrderSnapshot,
  aggregate: PaymentAggregateInspection,
  options: {
    readonly deadlineOpen: boolean
    readonly grant?: HyperswitchV1CheckoutGrant
    readonly checking?: boolean
    readonly forceReview?: boolean
  },
): CheckoutCoordinatorProjectionV1 {
  assertAggregateV1(order, aggregate)
  const payment = paymentEvidenceV1(aggregate)
  const grant = options.grant ?? null
  if (options.forceReview || payment.integrityState === "review_required") {
    return {
      stage: "review_required",
      order: orderProjectionV1(
        order,
        aggregate.order.state,
        aggregate.tickets.length,
      ),
      payment: { ...payment, integrityState: "review_required" },
      grant: null,
    }
  }

  if (!options.deadlineOpen && payment.canonicalState === "requires_method") {
    return expiredProjectionV1(order, aggregate)
  }

  switch (payment.canonicalState) {
    case "requires_method":
      return {
        stage: grant ? "checkout_ready" : "checking_same_payment",
        order: orderProjectionV1(order, aggregate.order.state, 0),
        payment,
        grant,
      }
    case "action_required":
      return {
        stage: "action_required",
        order: orderProjectionV1(order, aggregate.order.state, 0),
        payment,
        grant: null,
      }
    case "processing":
      return {
        stage: options.checking ? "checking_same_payment" : "processing",
        order: orderProjectionV1(order, aggregate.order.state, 0),
        payment,
        grant: null,
      }
    case "exhausted": {
      const hardDecline = payment.attempts.some(
        (attempt) => attempt.hardDecline,
      )
      return {
        stage: hardDecline ? "declined" : "recoverable_failure",
        order: orderProjectionV1(order, aggregate.order.state, 0),
        payment,
        grant: null,
      }
    }
    case "succeeded":
      if (
        aggregate.order.state !== "fulfilled" ||
        aggregate.tickets.length !== order.items.length ||
        payment.chargedAttemptCount !== 1 ||
        payment.observationSource !== "retrieve"
      ) {
        return {
          stage: "review_required",
          order: orderProjectionV1(
            order,
            aggregate.order.state,
            aggregate.tickets.length,
          ),
          payment: { ...payment, integrityState: "review_required" },
          grant: null,
        }
      }
      return {
        stage: "fulfilled",
        order: orderProjectionV1(
          order,
          aggregate.order.state,
          aggregate.tickets.length,
        ),
        payment,
        grant: null,
      }
    case "uncertain":
      return {
        stage: "checking_same_payment",
        order: orderProjectionV1(order, aggregate.order.state, 0),
        payment,
        grant: null,
      }
    default: {
      const exhaustive: never = payment.canonicalState
      return exhaustive
    }
  }
}

async function requiredAggregateV1(
  payments: Pick<CheckoutPaymentPortV1, "inspectPaymentAggregate">,
  order: OwnedCheckoutOrderSnapshot,
): Promise<PaymentAggregateInspection> {
  const aggregate = await payments.inspectPaymentAggregate(order.id)
  if (!aggregate) {
    throw new CheckoutRouteBoundaryErrorV1("checkout_integrity_error")
  }
  assertAggregateV1(order, aggregate)
  return aggregate
}

function expiredProjectionV1(
  order: OwnedCheckoutOrderSnapshot,
  aggregate?: PaymentAggregateInspection,
): CheckoutCoordinatorProjectionV1 {
  const payment = aggregate
    ? paymentEvidenceV1(aggregate)
    : emptyPaymentEvidenceV1()
  const canonicalState = [
    "requires_method",
    "action_required",
    "processing",
    "uncertain",
  ].includes(payment.canonicalState)
    ? payment.canonicalState
    : "uncertain"
  return {
    stage: "expired",
    order: orderProjectionV1(order, aggregate?.order.state ?? order.state, 0),
    payment: {
      ...payment,
      canonicalState,
      integrityState: "clear",
      chargedAttemptCount: 0,
      attempts: payment.attempts.filter((attempt) => !attempt.charged),
    },
    grant: null,
  }
}

function providerFailureIsSafeToReconcileV1(error: unknown): boolean {
  return error instanceof HyperswitchV1AdapterError
}

function paymentErrorV1(error: unknown): never {
  if (error instanceof PaymentRepositoryError) {
    if (
      error.code === "ORDER_NOT_FOUND" ||
      error.code === "ORDER_OWNERSHIP_MISMATCH"
    ) {
      throw new CheckoutRouteBoundaryErrorV1("order_not_found")
    }
    if (error.code === "PAYMENT_DEADLINE_EXPIRED") throw error
    throw new CheckoutRouteBoundaryErrorV1("checkout_integrity_error")
  }
  throw error
}

export class OnsaleCheckoutRetrieveOnlyCoordinatorV1 {
  readonly #inventory: CheckoutRetrieveOnlyDependenciesV1["inventory"]
  readonly #payments: CheckoutRetrieveOnlyDependenciesV1["payments"]
  readonly #provider: CheckoutRetrieveOnlyDependenciesV1["provider"]

  constructor(dependencies: CheckoutRetrieveOnlyDependenciesV1) {
    this.#inventory = dependencies.inventory
    this.#payments = dependencies.payments
    this.#provider = dependencies.provider
  }

  private projectV1(
    order: OwnedCheckoutOrderSnapshot,
    aggregate: PaymentAggregateInspection,
    options: {
      readonly grant?: HyperswitchV1CheckoutGrant
      readonly checking?: boolean
      readonly forceReview?: boolean
    } = {},
  ): CheckoutCoordinatorProjectionV1 {
    return projectionFromAggregateV1(order, aggregate, {
      deadlineOpen: presentationDeadlineOpenV1(order),
      ...options,
    })
  }

  private async projectAfterProviderV1(
    buyerRef: string,
    order: OwnedCheckoutOrderSnapshot,
    aggregate: PaymentAggregateInspection,
    options: {
      readonly grant?: HyperswitchV1CheckoutGrant
      readonly checking?: boolean
      readonly forceReview?: boolean
    } = {},
  ): Promise<CheckoutCoordinatorProjectionV1> {
    const refreshed = await this.#inventory.getOwnedCheckoutOrder(
      order.id,
      buyerRef,
    )
    if (!refreshed) {
      throw new CheckoutRouteBoundaryErrorV1("order_not_found")
    }
    assertRefreshedOrderV1(order, refreshed)
    return this.projectV1(refreshed, aggregate, options)
  }

  async reconcile(
    input: ReconcileCheckoutBoundaryInputV1,
  ): Promise<CheckoutCoordinatorProjectionV1> {
    assertProviderConfigurationV1(this.#provider)
    const orderId = input.orderPointer.orderRef()
    const order = await this.#inventory.getOwnedCheckoutOrder(
      orderId,
      input.buyerRef,
    )
    if (!order) {
      throw new CheckoutRouteBoundaryErrorV1("order_not_found")
    }
    const operationKey = reconcileOperationKeyV1({
      buyerRef: input.buyerRef,
      orderId,
      commandId: input.commandId,
      trigger: input.trigger,
    })
    let execution: BeginReconciliationResult
    try {
      execution = await this.#payments.beginReconciliation({
        operationKey,
        requestHash: checkoutRequestHashV1(
          "reconcile",
          input.buyerRef,
          orderId,
          `${input.commandId}:${input.trigger}`,
        ),
        orderId,
        buyerRef: input.buyerRef,
      })
    } catch (error) {
      return paymentErrorV1(error)
    }

    switch (execution.directive) {
      case "replay_terminal":
        return this.projectV1(
          order,
          await requiredAggregateV1(this.#payments, order),
        )
      case "blocked_integrity":
        return this.projectV1(
          order,
          await requiredAggregateV1(this.#payments, order),
          { forceReview: true },
        )
      case "retrieve_same_identity":
        return this.retrieveAndProjectV1(input, order, execution)
      default: {
        const exhaustive: never = execution
        return exhaustive
      }
    }
  }

  private async retrieveAndProjectV1(
    input: ReconcileCheckoutBoundaryInputV1,
    order: OwnedCheckoutOrderSnapshot,
    execution: Extract<BeginReconciliationResult, {
      readonly directive: "retrieve_same_identity"
    }>,
  ): Promise<CheckoutCoordinatorProjectionV1> {
    let result: AttestedHyperswitchV1RetrieveResult
    try {
      result = await this.#provider.retrievePayment({
        merchantPaymentId: execution.providerPaymentRef,
        terms: termsV1(order),
      })
    } catch (error) {
      if (!providerFailureIsSafeToReconcileV1(error)) throw error
      return this.projectAfterProviderV1(
        input.buyerRef,
        order,
        await requiredAggregateV1(this.#payments, order),
        { checking: true },
      )
    }
    if (result.kind === "not_found" || result.kind === "uncertain") {
      return this.projectAfterProviderV1(
        input.buyerRef,
        order,
        await requiredAggregateV1(this.#payments, order),
        { checking: true },
      )
    }
    try {
      await this.#payments.applyObservation({
        operationKey: execution.operation.operationKey,
        orderId: order.id,
        buyerRef: input.buyerRef,
        observation: result.evidence,
      })
    } catch (error) {
      return paymentErrorV1(error)
    }
    return this.projectAfterProviderV1(
      input.buyerRef,
      order,
      await requiredAggregateV1(this.#payments, order),
      { ...(result.checkoutGrant ? { grant: result.checkoutGrant } : {}) },
    )
  }
}

export class OnsaleCheckoutCoordinatorV1 {
  readonly #inventory: CheckoutCoordinatorDependenciesV1["inventory"]
  readonly #payments: CheckoutCoordinatorDependenciesV1["payments"]
  readonly #provider: CheckoutCoordinatorDependenciesV1["provider"]
  readonly #returnUrl: string
  readonly #retrieveOnly: OnsaleCheckoutRetrieveOnlyCoordinatorV1

  constructor(dependencies: CheckoutCoordinatorDependenciesV1) {
    this.#inventory = dependencies.inventory
    this.#payments = dependencies.payments
    this.#provider = dependencies.provider
    this.#returnUrl = dependencies.returnUrl
    this.#retrieveOnly = new OnsaleCheckoutRetrieveOnlyCoordinatorV1({
      inventory: dependencies.inventory,
      payments: dependencies.payments,
      provider: dependencies.provider,
    })
  }

  private projectV1(
    order: OwnedCheckoutOrderSnapshot,
    aggregate: PaymentAggregateInspection,
    options: {
      readonly grant?: HyperswitchV1CheckoutGrant
      readonly checking?: boolean
      readonly forceReview?: boolean
    } = {},
  ): CheckoutCoordinatorProjectionV1 {
    return projectionFromAggregateV1(order, aggregate, {
      deadlineOpen: presentationDeadlineOpenV1(order),
      ...options,
    })
  }

  private async projectAfterProviderV1(
    buyerRef: string,
    order: OwnedCheckoutOrderSnapshot,
    aggregate: PaymentAggregateInspection,
    options: {
      readonly grant?: HyperswitchV1CheckoutGrant
      readonly checking?: boolean
      readonly forceReview?: boolean
    } = {},
  ): Promise<CheckoutCoordinatorProjectionV1> {
    const refreshed = await this.#inventory.getOwnedCheckoutOrder(
      order.id,
      buyerRef,
    )
    if (!refreshed) {
      throw new CheckoutRouteBoundaryErrorV1("order_not_found")
    }
    assertRefreshedOrderV1(order, refreshed)
    return this.projectV1(refreshed, aggregate, options)
  }

  async prepare(
    input: PrepareCheckoutBoundaryInputV1,
  ): Promise<PreparedCheckoutBoundaryResultV1> {
    assertProviderConfigurationV1(this.#provider)
    const created = await this.#inventory.createOrder({
      operationKey: createOrderOperationKeyV1(input.buyerRef, input.holdRef),
      holdId: input.holdRef,
      buyerRef: input.buyerRef,
    })
    const order = await this.#inventory.getOwnedCheckoutOrder(
      created.orderId,
      input.buyerRef,
    )
    if (!order) {
      throw new CheckoutRouteBoundaryErrorV1("order_not_found")
    }
    assertCreatedOrderV1(created, order, input.holdRef)
    const pointer = createOnsaleOrderPointerV1(order.id)
    let prepared: PrepareCheckoutResult
    try {
      prepared = await this.#payments.prepareCheckout({
        operationKey: ensureCheckoutOperationKeyV1(input.buyerRef, order.id),
        requestHash: checkoutRequestHashV1(
          "ensure",
          input.buyerRef,
          order.id,
          "fixed",
        ),
        orderId: order.id,
        buyerRef: input.buyerRef,
      })
    } catch (error) {
      if (
        error instanceof PaymentRepositoryError &&
        error.code === "PAYMENT_DEADLINE_EXPIRED"
      ) {
        return { orderPointer: pointer, projection: expiredProjectionV1(order) }
      }
      return paymentErrorV1(error)
    }
    assertPreparedTermsV1(prepared, order)

    let projection: CheckoutCoordinatorProjectionV1
    switch (prepared.directive) {
      case "retrieve_same_identity":
        projection = await this.prepareRetrieveV1(input, order, prepared)
        break
      case "replay_terminal":
        projection = await this.#retrieveOnly.reconcile({
          buyerRef: input.buyerRef,
          commandId: input.commandId,
          orderPointer: pointer,
          trigger: "resume",
        })
        break
      case "blocked_integrity": {
        const aggregate = await requiredAggregateV1(this.#payments, order)
        projection =
          prepared.reason === "payment_deadline_expired"
            ? expiredProjectionV1(order, aggregate)
            : this.projectV1(order, aggregate, {
                forceReview: true,
              })
        break
      }
      case "create_same_identity":
        throw new CheckoutRouteBoundaryErrorV1("checkout_integrity_error")
      default: {
        const exhaustive: never = prepared
        return exhaustive
      }
    }
    return { orderPointer: pointer, projection }
  }

  private async prepareRetrieveV1(
    input: PrepareCheckoutBoundaryInputV1,
    order: OwnedCheckoutOrderSnapshot,
    prepared: Extract<PrepareCheckoutResult, {
      readonly directive: "retrieve_same_identity"
    }>,
  ): Promise<CheckoutCoordinatorProjectionV1> {
    let result: AttestedHyperswitchV1RetrieveResult
    try {
      result = await this.#provider.retrievePayment({
        merchantPaymentId: prepared.providerPaymentRef,
        terms: termsV1(order),
      })
    } catch (error) {
      if (!providerFailureIsSafeToReconcileV1(error)) throw error
      return this.projectAfterProviderV1(
        input.buyerRef,
        order,
        await requiredAggregateV1(this.#payments, order),
        { checking: true },
      )
    }
    if (result.kind === "uncertain") {
      return this.projectAfterProviderV1(
        input.buyerRef,
        order,
        await requiredAggregateV1(this.#payments, order),
        { checking: true },
      )
    }
    if (result.kind === "found") {
      try {
        await this.#payments.applyObservation({
          operationKey: prepared.operation.operationKey,
          orderId: order.id,
          buyerRef: input.buyerRef,
          observation: result.evidence,
        })
      } catch (error) {
        return paymentErrorV1(error)
      }
      return this.projectAfterProviderV1(
        input.buyerRef,
        order,
        await requiredAggregateV1(this.#payments, order),
        { ...(result.checkoutGrant ? { grant: result.checkoutGrant } : {}) },
      )
    }
    if (prepared.onNotFound === "block_recreate") {
      return this.projectAfterProviderV1(
        input.buyerRef,
        order,
        await requiredAggregateV1(this.#payments, order),
        { checking: true },
      )
    }

    let authorized: RecordPreCreateNotFoundResult
    try {
      authorized = await this.#payments.recordPreCreateNotFound({
        operationKey: prepared.operation.operationKey,
        orderId: order.id,
        buyerRef: input.buyerRef,
        evidence: result.evidence,
      })
    } catch (error) {
      return paymentErrorV1(error)
    }
    switch (authorized.directive) {
      case "create_same_identity":
        return this.createOnceV1(input, order, authorized)
      case "retrieve_same_identity":
        return this.projectAfterProviderV1(
          input.buyerRef,
          order,
          await requiredAggregateV1(this.#payments, order),
          { checking: true },
        )
      case "replay_terminal":
        return this.#retrieveOnly.reconcile({
          buyerRef: input.buyerRef,
          commandId: input.commandId,
          orderPointer: createOnsaleOrderPointerV1(order.id),
          trigger: "resume",
        })
      case "blocked_integrity": {
        const aggregate = await requiredAggregateV1(this.#payments, order)
        return authorized.reason === "payment_deadline_expired"
          ? expiredProjectionV1(order, aggregate)
          : this.projectAfterProviderV1(input.buyerRef, order, aggregate, {
              forceReview: true,
            })
      }
      default: {
        const exhaustive: never = authorized
        return exhaustive
      }
    }
  }

  private async createOnceV1(
    input: PrepareCheckoutBoundaryInputV1,
    order: OwnedCheckoutOrderSnapshot,
    authorized: Extract<RecordPreCreateNotFoundResult, {
      readonly directive: "create_same_identity"
    }>,
  ): Promise<CheckoutCoordinatorProjectionV1> {
    let result
    try {
      result = await this.#provider.createPayment({
        merchantPaymentId: authorized.providerPaymentRef,
        terms: termsV1(order),
        returnUrl: this.#returnUrl,
        sessionExpirySeconds: authorized.providerSessionExpirySeconds,
        description: "ONSALE live event tickets",
        metadata: {
          item_count: String(order.items.length),
          product: "live_event_ticketing",
        },
        items: providerItemsV1(order),
      })
    } catch (error) {
      if (!providerFailureIsSafeToReconcileV1(error)) throw error
      return this.projectAfterProviderV1(
        input.buyerRef,
        order,
        await requiredAggregateV1(this.#payments, order),
        { checking: true },
      )
    }
    if (result.kind === "uncertain") {
      return this.projectAfterProviderV1(
        input.buyerRef,
        order,
        await requiredAggregateV1(this.#payments, order),
        { checking: true },
      )
    }
    let appliedResult: ApplyPaymentObservationResult
    try {
      appliedResult = await this.#payments.applyObservation({
        operationKey: authorized.operation.operationKey,
        orderId: order.id,
        buyerRef: input.buyerRef,
        observation: result.evidence,
      })
    } catch (error) {
      return paymentErrorV1(error)
    }
    if (appliedResult.orderId !== order.id) {
      throw new CheckoutRouteBoundaryErrorV1("checkout_integrity_error")
    }
    return this.projectAfterProviderV1(
      input.buyerRef,
      order,
      await requiredAggregateV1(this.#payments, order),
      { ...(result.kind === "ready" ? { grant: result.checkoutGrant } : {}) },
    )
  }
}
