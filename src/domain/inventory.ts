/**
 * Authoritative inventory, hold, and order transitions for ONSALE.
 *
 * This module deliberately has no clock, database, HTTP, or UI dependencies.
 * A server adapter supplies timestamps and entity IDs, persists the returned
 * state atomically, and exposes only the resulting snapshot to the client.
 */

export const MAX_SEATS_PER_ORDER = 4

export type SeatId = string
export type BuyerId = string
export type HoldId = string
export type OrderId = string
export type PaymentId = string
export type OperationId = string

export interface Money {
  readonly currency: string
  readonly amountMinor: number
}

export type SeatAvailability = "available" | "held" | "reserved" | "unavailable"

export interface SeatInventoryItem {
  readonly id: SeatId
  readonly row: string
  readonly number: number
  readonly unitPriceMinor: number
  readonly availability: SeatAvailability
  readonly holdId?: HoldId
  readonly orderId?: OrderId
}

export type HoldStatus = "active" | "converted" | "released" | "expired"

export interface SeatHold {
  readonly id: HoldId
  readonly buyerId: BuyerId
  readonly seatIds: readonly SeatId[]
  readonly total: Money
  readonly createdAt: number
  readonly expiresAt: number
  readonly status: HoldStatus
  readonly orderId?: OrderId
  readonly endedAt?: number
  readonly endReason?: "buyer_released" | "operator_released" | "expired" | "converted_to_order"
}

export type OrderStatus = "pending_payment" | "cancelled"
export type PaymentPlaceholderStatus = "not_started"

export interface PaymentIdentityPlaceholder {
  readonly id: PaymentId
  readonly status: PaymentPlaceholderStatus
}

export interface TicketOrder {
  readonly id: OrderId
  readonly holdId: HoldId
  readonly buyerId: BuyerId
  readonly seatIds: readonly SeatId[]
  readonly total: Money
  readonly payment: PaymentIdentityPlaceholder
  readonly status: OrderStatus
  readonly createdAt: number
  readonly cancelledAt?: number
  readonly cancellationReason?: "hold_released" | "hold_expired"
}

export type DomainErrorCode = "INVALID_COMMAND" | "IDEMPOTENCY_CONFLICT" | "ENTITY_ID_CONFLICT" | "SEAT_NOT_FOUND" | "SEAT_NOT_AVAILABLE" | "HOLD_NOT_FOUND" | "HOLD_NOT_ACTIVE" | "HOLD_OWNERSHIP_MISMATCH" | "ORDER_ALREADY_EXISTS"

export interface ClaimSeatsData {
  readonly kind: "seats_claimed"
  readonly holdId: HoldId
  readonly seatIds: readonly SeatId[]
  readonly total: Money
  readonly expiresAt: number
}

export interface ReleaseHoldData {
  readonly kind: "hold_released"
  readonly holdId: HoldId
  readonly releasedSeatIds: readonly SeatId[]
}

export interface ExpireHoldsData {
  readonly kind: "holds_expired"
  readonly holdIds: readonly HoldId[]
  readonly releasedSeatIds: readonly SeatId[]
}

export interface CreateOrderData {
  readonly kind: "order_created"
  readonly orderId: OrderId
  readonly holdId: HoldId
  readonly paymentId: PaymentId
  readonly seatIds: readonly SeatId[]
  readonly total: Money
}

export type CommandData = ClaimSeatsData | ReleaseHoldData | ExpireHoldsData | CreateOrderData

interface StoredSuccess {
  readonly ok: true
  readonly data: CommandData
}

interface StoredFailure {
  readonly ok: false
  readonly code: DomainErrorCode
  readonly message: string
}

type StoredOutcome = StoredSuccess | StoredFailure

export interface ProcessedOperation {
  readonly operationId: OperationId
  readonly commandType: InventoryCommand["type"]
  readonly fingerprint: string
  readonly outcome: StoredOutcome
}

export interface InventoryDomainState {
  readonly eventId: string
  readonly currency: string
  readonly seats: Readonly<Record<SeatId, SeatInventoryItem>>
  readonly holds: Readonly<Record<HoldId, SeatHold>>
  readonly orders: Readonly<Record<OrderId, TicketOrder>>
  readonly operations: Readonly<Record<OperationId, ProcessedOperation>>
}

interface CommandEnvelope {
  readonly operationId: OperationId
  /** Unix epoch milliseconds supplied by the trusted server boundary. */
  readonly now: number
}

export interface ClaimSeatsCommand extends CommandEnvelope {
  readonly type: "claim_seats"
  readonly holdId: HoldId
  readonly buyerId: BuyerId
  readonly seatIds: readonly SeatId[]
  readonly holdForMs: number
}

export interface ReleaseHoldCommand extends CommandEnvelope {
  readonly type: "release_hold"
  readonly holdId: HoldId
  readonly buyerId: BuyerId
  readonly reason?: "buyer_released" | "operator_released"
}

export interface ExpireHoldsCommand extends CommandEnvelope {
  readonly type: "expire_holds"
}

export interface CreateOrderCommand
  extends CommandEnvelope {
  /** IDs are minted by the trusted server adapter, never accepted from a browser. */
  readonly type: "create_order"
  readonly holdId: HoldId
  readonly buyerId: BuyerId
  readonly orderId: OrderId
  readonly paymentId: PaymentId
}

export type InventoryCommand = ClaimSeatsCommand | ReleaseHoldCommand | ExpireHoldsCommand | CreateOrderCommand

export interface CommandSuccess {
  readonly ok: true
  readonly operationId: OperationId
  readonly commandType: InventoryCommand["type"]
  readonly replayed: boolean
  readonly data: CommandData
  readonly state: InventoryDomainState
}

export interface CommandFailure {
  readonly ok: false
  readonly operationId: OperationId
  readonly commandType: InventoryCommand["type"]
  readonly replayed: boolean
  readonly code: DomainErrorCode
  readonly message: string
  readonly state: InventoryDomainState
}

export type CommandResult = CommandSuccess | CommandFailure

export interface InitialSeat {
  readonly id: SeatId
  readonly row: string
  readonly number: number
  readonly unitPriceMinor: number
  readonly unavailable?: boolean
}

export interface CreateInventoryStateInput {
  readonly eventId: string
  readonly currency: string
  readonly seats: readonly InitialSeat[]
}

export interface InvariantViolation {
  readonly path: string
  readonly message: string
}

export class DomainInvariantError extends Error {
  readonly violations: readonly InvariantViolation[]

  constructor(violations: readonly InvariantViolation[]) {
    super(
      `Inventory domain invariant violation: ${violations
        .map((violation) => `${violation.path}: ${violation.message}`)
        .join("; ")}`,
    )
    this.name = "DomainInvariantError"
    this.violations = violations
  }
}

export function createInventoryState(
  input: CreateInventoryStateInput,
): InventoryDomainState {
  const seats: Record<SeatId, SeatInventoryItem> = {}

  for (const seat of input.seats) {
    if (seats[seat.id]) {
      throw new Error(`Duplicate initial seat ID: ${seat.id}`)
    }
    seats[seat.id] = {
      id: seat.id,
      row: seat.row,
      number: seat.number,
      unitPriceMinor: seat.unitPriceMinor,
      availability: seat.unavailable ? "unavailable" : "available",
    }
  }

  const state: InventoryDomainState = {
    eventId: input.eventId,
    currency: input.currency,
    seats,
    holds: {},
    orders: {},
    operations: {},
  }
  assertDomainInvariants(state)
  return state
}

/**
 * Applies one server command. Persist the returned state with compare-and-swap
 * or inside a database transaction; this pure function cannot itself lock rows.
 */
export function executeInventoryCommand(
  currentState: InventoryDomainState,
  command: InventoryCommand,
): CommandResult {
  assertDomainInvariants(currentState)

  const fingerprint = commandFingerprint(command)
  const prior = currentState.operations[command.operationId]
  if (prior) {
    if (prior.fingerprint !== fingerprint) {
      return failure(
        currentState,
        command,
        "IDEMPOTENCY_CONFLICT",
        `Operation ${command.operationId} was already used for a different command payload.`,
        false,
      )
    }
    return resultFromStored(currentState, prior, true)
  }

  // An invalid idempotency envelope is never added to the operation ledger.
  // Otherwise an empty ID could poison all later malformed requests.
  if (!isNonEmpty(command.operationId) || !isValidTimestamp(command.now)) {
    return failure(
      currentState,
      command,
      "INVALID_COMMAND",
      "A command requires a non-empty operation ID and a valid server timestamp.",
      false,
    )
  }

  const prepared = expireActiveHolds(currentState, command.now)
  let transition: Transition

  switch (command.type) {
    case "claim_seats":
      transition = claimSeats(prepared.state, command)
      break
    case "release_hold":
      transition = releaseHold(prepared.state, command)
      break
    case "expire_holds":
      transition = {
        state: prepared.state,
        outcome: {
          ok: true,
          data: {
            kind: "holds_expired",
            holdIds: prepared.expiredHoldIds,
            releasedSeatIds: prepared.releasedSeatIds,
          },
        },
      }
      break
    case "create_order":
      transition = createOrder(prepared.state, command)
      break
    default:
      transition = assertNever(command)
  }

  const operation: ProcessedOperation = {
    operationId: command.operationId,
    commandType: command.type,
    fingerprint,
    outcome: transition.outcome,
  }
  const nextState: InventoryDomainState = {
    ...transition.state,
    operations: {
      ...transition.state.operations,
      [command.operationId]: operation,
    },
  }
  assertDomainInvariants(nextState)
  return resultFromStored(nextState, operation, false)
}

interface Transition {
  readonly state: InventoryDomainState
  readonly outcome: StoredOutcome
}

function claimSeats(
  state: InventoryDomainState,
  command: ClaimSeatsCommand,
): Transition {
  const seatIds = [...command.seatIds]
  const uniqueSeatIds = new Set(seatIds)

  if (
    !isNonEmpty(command.operationId) ||
    !isNonEmpty(command.holdId) ||
    !isNonEmpty(command.buyerId) ||
    !isValidTimestamp(command.now) ||
    !Number.isSafeInteger(command.holdForMs) ||
    command.holdForMs <= 0 ||
    !Number.isSafeInteger(command.now + command.holdForMs) ||
    seatIds.length === 0 ||
    seatIds.length > MAX_SEATS_PER_ORDER ||
    uniqueSeatIds.size !== seatIds.length
  ) {
    return rejected(
      state,
      "INVALID_COMMAND",
      `A claim requires 1-${MAX_SEATS_PER_ORDER} unique seats, trusted IDs, and a positive integer hold duration.`,
    )
  }
  if (state.holds[command.holdId]) {
    return rejected(
      state,
      "ENTITY_ID_CONFLICT",
      `Hold ID ${command.holdId} already exists.`,
    )
  }

  for (const seatId of seatIds) {
    const seat = state.seats[seatId]
    if (!seat) {
      return rejected(state, "SEAT_NOT_FOUND", `Seat ${seatId} does not exist.`)
    }
    if (seat.availability !== "available") {
      return rejected(
        state,
        "SEAT_NOT_AVAILABLE",
        `Seat ${seatId} is not available. No seats were claimed.`,
      )
    }
  }

  const canonicalSeatIds = [...seatIds].sort()
  const amountMinor = canonicalSeatIds.reduce(
    (sum, seatId) => sum + state.seats[seatId].unitPriceMinor,
    0,
  )
  const total: Money = { currency: state.currency, amountMinor }
  const hold: SeatHold = {
    id: command.holdId,
    buyerId: command.buyerId,
    seatIds: canonicalSeatIds,
    total,
    createdAt: command.now,
    expiresAt: command.now + command.holdForMs,
    status: "active",
  }
  const seats = { ...state.seats }
  for (const seatId of canonicalSeatIds) {
    seats[seatId] = {
      ...seats[seatId],
      availability: "held",
      holdId: hold.id,
    }
  }

  return {
    state: {
      ...state,
      seats,
      holds: { ...state.holds, [hold.id]: hold },
    },
    outcome: {
      ok: true,
      data: {
        kind: "seats_claimed",
        holdId: hold.id,
        seatIds: hold.seatIds,
        total: hold.total,
        expiresAt: hold.expiresAt,
      },
    },
  }
}

function releaseHold(
  state: InventoryDomainState,
  command: ReleaseHoldCommand,
): Transition {
  if (
    !isNonEmpty(command.operationId) ||
    !isNonEmpty(command.holdId) ||
    !isNonEmpty(command.buyerId) ||
    !isValidTimestamp(command.now)
  ) {
    return rejected(
      state,
      "INVALID_COMMAND",
      "Release command fields are invalid.",
    )
  }

  const hold = state.holds[command.holdId]
  if (!hold) {
    return rejected(
      state,
      "HOLD_NOT_FOUND",
      `Hold ${command.holdId} does not exist.`,
    )
  }
  if (hold.buyerId !== command.buyerId) {
    return rejected(
      state,
      "HOLD_OWNERSHIP_MISMATCH",
      `Buyer does not own hold ${command.holdId}.`,
    )
  }
  if (hold.status !== "active") {
    return rejected(
      state,
      "HOLD_NOT_ACTIVE",
      `Hold ${command.holdId} is ${hold.status}.`,
    )
  }

  const reason = command.reason ?? "buyer_released"
  return endHold(state, hold, command.now, "released", reason)
}

function createOrder(
  state: InventoryDomainState,
  command: CreateOrderCommand,
): Transition {
  if (
    !isNonEmpty(command.operationId) ||
    !isNonEmpty(command.holdId) ||
    !isNonEmpty(command.buyerId) ||
    !isNonEmpty(command.orderId) ||
    !isNonEmpty(command.paymentId) ||
    !isValidTimestamp(command.now)
  ) {
    return rejected(
      state,
      "INVALID_COMMAND",
      "Order command fields are invalid.",
    )
  }

  const hold = state.holds[command.holdId]
  if (!hold) {
    return rejected(
      state,
      "HOLD_NOT_FOUND",
      `Hold ${command.holdId} does not exist.`,
    )
  }
  if (hold.buyerId !== command.buyerId) {
    return rejected(
      state,
      "HOLD_OWNERSHIP_MISMATCH",
      `Buyer does not own hold ${command.holdId}.`,
    )
  }
  if (hold.status !== "active") {
    return rejected(
      state,
      "HOLD_NOT_ACTIVE",
      `Hold ${command.holdId} is ${hold.status}.`,
    )
  }
  if (hold.orderId) {
    return rejected(
      state,
      "ORDER_ALREADY_EXISTS",
      `Hold ${command.holdId} already belongs to order ${hold.orderId}.`,
    )
  }
  if (
    state.orders[command.orderId] ||
    Object.values(state.orders).some(
      (order) => order.payment.id === command.paymentId,
    )
  ) {
    return rejected(
      state,
      "ENTITY_ID_CONFLICT",
      "The server-provided order or payment identity is already in use.",
    )
  }

  const order: TicketOrder = {
    id: command.orderId,
    holdId: hold.id,
    buyerId: hold.buyerId,
    seatIds: [...hold.seatIds],
    total: { ...hold.total },
    payment: { id: command.paymentId, status: "not_started" },
    status: "pending_payment",
    createdAt: command.now,
  }
  const seats = { ...state.seats }
  for (const seatId of hold.seatIds) {
    const { holdId: _holdId, ...heldSeat } = seats[seatId]
    seats[seatId] = {
      ...heldSeat,
      availability: "reserved",
      orderId: order.id,
    }
  }
  return {
    state: {
      ...state,
      seats,
      holds: {
        ...state.holds,
        [hold.id]: {
          ...hold,
          orderId: order.id,
          status: "converted",
          endedAt: command.now,
          endReason: "converted_to_order",
        },
      },
      orders: { ...state.orders, [order.id]: order },
    },
    outcome: {
      ok: true,
      data: {
        kind: "order_created",
        orderId: order.id,
        holdId: hold.id,
        paymentId: order.payment.id,
        seatIds: order.seatIds,
        total: order.total,
      },
    },
  }
}

interface ExpirationResult {
  readonly state: InventoryDomainState
  readonly expiredHoldIds: readonly HoldId[]
  readonly releasedSeatIds: readonly SeatId[]
}

function expireActiveHolds(
  state: InventoryDomainState,
  now: number,
): ExpirationResult {
  if (!isValidTimestamp(now)) {
    return { state, expiredHoldIds: [], releasedSeatIds: [] }
  }

  let nextState = state
  const expiredHoldIds: HoldId[] = []
  const releasedSeatIds: SeatId[] = []
  const expiring = Object.values(state.holds)
    .filter((hold) => hold.status === "active" && hold.expiresAt <= now)
    .sort((left, right) => left.id.localeCompare(right.id))

  for (const hold of expiring) {
    const transition = endHold(nextState, hold, now, "expired", "expired")
    if (!transition.outcome.ok) {
      throw new Error(`Unable to expire active hold ${hold.id}.`)
    }
    nextState = transition.state
    expiredHoldIds.push(hold.id)
    releasedSeatIds.push(...hold.seatIds)
  }

  return {
    state: nextState,
    expiredHoldIds,
    releasedSeatIds: releasedSeatIds.sort(),
  }
}

function endHold(
  state: InventoryDomainState,
  hold: SeatHold,
  now: number,
  status: "released" | "expired",
  reason: "buyer_released" | "operator_released" | "expired",
): Transition {
  const seats = { ...state.seats }
  for (const seatId of hold.seatIds) {
    const seat = seats[seatId]
    if (seat.availability === "held" && seat.holdId === hold.id) {
      const { holdId: _holdId, ...availableSeat } = seat
      seats[seatId] = { ...availableSeat, availability: "available" }
    }
  }

  return {
    state: {
      ...state,
      seats,
      holds: {
        ...state.holds,
        [hold.id]: {
          ...hold,
          status,
          endedAt: now,
          endReason: reason,
        },
      },
    },
    outcome: {
      ok: true,
      data: {
        kind: "hold_released",
        holdId: hold.id,
        releasedSeatIds: [...hold.seatIds],
      },
    },
  }
}

function rejected(
  state: InventoryDomainState,
  code: DomainErrorCode,
  message: string,
): Transition {
  return { state, outcome: { ok: false, code, message } }
}

function failure(
  state: InventoryDomainState,
  command: InventoryCommand,
  code: DomainErrorCode,
  message: string,
  replayed: boolean,
): CommandFailure {
  return {
    ok: false,
    operationId: command.operationId,
    commandType: command.type,
    replayed,
    code,
    message,
    state,
  }
}

function resultFromStored(
  state: InventoryDomainState,
  operation: ProcessedOperation,
  replayed: boolean,
): CommandResult {
  if (operation.outcome.ok) {
    return {
      ok: true,
      operationId: operation.operationId,
      commandType: operation.commandType,
      replayed,
      data: operation.outcome.data,
      state,
    }
  }
  return {
    ok: false,
    operationId: operation.operationId,
    commandType: operation.commandType,
    replayed,
    code: operation.outcome.code,
    message: operation.outcome.message,
    state,
  }
}

function commandFingerprint(command: InventoryCommand): string {
  switch (command.type) {
    case "claim_seats":
      return JSON.stringify({
        type: command.type,
        holdId: command.holdId,
        buyerId: command.buyerId,
        seatIds: [...command.seatIds].sort(),
        holdForMs: command.holdForMs,
      })
    case "release_hold":
      return JSON.stringify({
        type: command.type,
        holdId: command.holdId,
        buyerId: command.buyerId,
        reason: command.reason ?? "buyer_released",
      })
    case "expire_holds":
      return JSON.stringify({ type: command.type })
    case "create_order":
      return JSON.stringify({
        type: command.type,
        holdId: command.holdId,
        buyerId: command.buyerId,
        orderId: command.orderId,
        paymentId: command.paymentId,
      })
    default:
      return assertNever(command)
  }
}

export function checkDomainInvariants(
  state: InventoryDomainState,
): readonly InvariantViolation[] {
  const violations: InvariantViolation[] = []
  const add = (path: string, message: string) =>
    violations.push({ path, message })

  if (!isNonEmpty(state.eventId)) add("eventId", "must be non-empty")
  if (!isNonEmpty(state.currency)) add("currency", "must be non-empty")

  for (const [key, seat] of Object.entries(state.seats)) {
    if (seat.id !== key) add(`seats.${key}.id`, "must match its record key")
    if (!isNonEmpty(seat.id)) add(`seats.${key}.id`, "must be non-empty")
    if (!isNonEmpty(seat.row)) add(`seats.${key}.row`, "must be non-empty")
    if (!Number.isSafeInteger(seat.number) || seat.number <= 0) {
      add(`seats.${key}.number`, "must be a positive safe integer")
    }
    if (!Number.isSafeInteger(seat.unitPriceMinor) || seat.unitPriceMinor < 0) {
      add(`seats.${key}.unitPriceMinor`, "must be a non-negative safe integer")
    }
    if (seat.availability === "held") {
      if (!seat.holdId) {
        add(`seats.${key}.holdId`, "is required while the seat is held")
      } else {
        const hold = state.holds[seat.holdId]
        if (
          !hold ||
          hold.status !== "active" ||
          !hold.seatIds.includes(seat.id)
        ) {
          add(
            `seats.${key}.holdId`,
            "must reference an active hold containing the seat",
          )
        }
      }
      if (seat.orderId) {
        add(`seats.${key}.orderId`, "must be absent while the seat is held")
      }
    } else if (seat.availability === "reserved") {
      if (seat.holdId) {
        add(`seats.${key}.holdId`, "must be absent after order conversion")
      }
      if (!seat.orderId) {
        add(`seats.${key}.orderId`, "is required while the seat is reserved")
      } else {
        const order = state.orders[seat.orderId]
        if (
          !order ||
          order.status !== "pending_payment" ||
          !order.seatIds.includes(seat.id)
        ) {
          add(
            `seats.${key}.orderId`,
            "must reference a pending order containing the seat",
          )
        }
      }
    } else if (seat.holdId || seat.orderId) {
      add(
        `seats.${key}`,
        "hold and order ownership must be absent unless the seat is held or reserved",
      )
    }
  }

  for (const [key, hold] of Object.entries(state.holds)) {
    if (hold.id !== key) add(`holds.${key}.id`, "must match its record key")
    if (
      hold.seatIds.length === 0 ||
      hold.seatIds.length > MAX_SEATS_PER_ORDER ||
      new Set(hold.seatIds).size !== hold.seatIds.length
    ) {
      add(
        `holds.${key}.seatIds`,
        `must contain 1-${MAX_SEATS_PER_ORDER} unique seats`,
      )
    }
    if (hold.expiresAt <= hold.createdAt) {
      add(`holds.${key}.expiresAt`, "must be later than createdAt")
    }
    const expectedAmount = hold.seatIds.reduce((sum, seatId) => {
      const seat = state.seats[seatId]
      if (!seat) {
        add(`holds.${key}.seatIds`, `references missing seat ${seatId}`)
        return sum
      }
      if (
        hold.status === "active" &&
        (seat.availability !== "held" || seat.holdId !== hold.id)
      ) {
        add(`holds.${key}.seatIds`, `active hold does not own seat ${seatId}`)
      }
      if (hold.status === "converted") {
        if (
          !hold.orderId ||
          seat.availability !== "reserved" ||
          seat.orderId !== hold.orderId
        ) {
          add(
            `holds.${key}.seatIds`,
            `converted hold does not reserve seat ${seatId} for its order`,
          )
        }
      } else if (hold.status !== "active" && seat.holdId === hold.id) {
        add(`holds.${key}.seatIds`, `ended hold still owns seat ${seatId}`)
      }
      return sum + seat.unitPriceMinor
    }, 0)
    if (
      hold.total.currency !== state.currency ||
      hold.total.amountMinor !== expectedAmount
    ) {
      add(
        `holds.${key}.total`,
        "must equal the authoritative sum of held seat prices",
      )
    }
    if (
      !Number.isSafeInteger(hold.total.amountMinor) ||
      hold.total.amountMinor < 0
    ) {
      add(
        `holds.${key}.total.amountMinor`,
        "must be a non-negative safe integer",
      )
    }
    if (hold.status === "active" && hold.endedAt !== undefined) {
      add(`holds.${key}.endedAt`, "must be absent for an active hold")
    }
    if (hold.status !== "active" && hold.endedAt === undefined) {
      add(`holds.${key}.endedAt`, "is required for an ended hold")
    }
    if (hold.orderId) {
      const order = state.orders[hold.orderId]
      if (!order || order.holdId !== hold.id) {
        add(
          `holds.${key}.orderId`,
          "must reference the order assigned to this hold",
        )
      }
    }
  }

  const paymentIds = new Set<PaymentId>()
  for (const [key, order] of Object.entries(state.orders)) {
    if (order.id !== key) add(`orders.${key}.id`, "must match its record key")
    const hold = state.holds[order.holdId]
    if (!hold || hold.orderId !== order.id) {
      add(
        `orders.${key}.holdId`,
        "must reference the hold assigned to this order",
      )
      continue
    }
    if (order.buyerId !== hold.buyerId) {
      add(`orders.${key}.buyerId`, "must match the hold owner")
    }
    if (
      order.seatIds.length !== hold.seatIds.length ||
      order.seatIds.some((seatId, index) => seatId !== hold.seatIds[index])
    ) {
      add(`orders.${key}.seatIds`, "must exactly match the hold seat snapshot")
    }
    if (
      order.total.currency !== hold.total.currency ||
      order.total.amountMinor !== hold.total.amountMinor
    ) {
      add(`orders.${key}.total`, "must exactly match the hold total")
    }
    if (paymentIds.has(order.payment.id)) {
      add(`orders.${key}.payment.id`, "must be unique across orders")
    }
    paymentIds.add(order.payment.id)
    if (order.status === "pending_payment" && hold.status !== "converted") {
      add(
        `orders.${key}.status`,
        "requires a converted, non-expirable hold reservation",
      )
    }
    if (order.status === "cancelled" && order.cancelledAt === undefined) {
      add(`orders.${key}.cancelledAt`, "is required for a cancelled order")
    }
    if (order.status === "cancelled" && hold.status === "converted") {
      add(
        `orders.${key}.status`,
        "cannot be cancelled while its reservation remains converted",
      )
    }
  }

  for (const [key, operation] of Object.entries(state.operations)) {
    if (operation.operationId !== key) {
      add(`operations.${key}.operationId`, "must match its record key")
    }
    if (!isNonEmpty(operation.fingerprint)) {
      add(`operations.${key}.fingerprint`, "must be non-empty")
    }
  }

  return violations
}

export function assertDomainInvariants(state: InventoryDomainState): void {
  const violations = checkDomainInvariants(state)
  if (violations.length > 0) throw new DomainInvariantError(violations)
}

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0
}

function isValidTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function assertNever(value: never): never {
  throw new Error(`Unhandled command: ${JSON.stringify(value)}`)
}
