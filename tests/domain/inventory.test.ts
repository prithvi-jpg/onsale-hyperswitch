import { describe, expect, it } from "vitest"

import {
  checkDomainInvariants,
  createInventoryState,
  executeInventoryCommand,
  type InventoryDomainState,
} from "../../src/domain/inventory"

const NOW = 1_800_000_000_000

function fixture(): InventoryDomainState {
  return createInventoryState({
    eventId: "phantom-circuit-la",
    currency: "USD",
    seats: [
      { id: "A-1", row: "A", number: 1, unitPriceMinor: 18_460 },
      { id: "A-2", row: "A", number: 2, unitPriceMinor: 18_460 },
      { id: "A-3", row: "A", number: 3, unitPriceMinor: 20_000 },
      { id: "A-4", row: "A", number: 4, unitPriceMinor: 20_000 },
      { id: "A-5", row: "A", number: 5, unitPriceMinor: 20_000 },
      {
        id: "A-6",
        row: "A",
        number: 6,
        unitPriceMinor: 20_000,
        unavailable: true,
      },
    ],
  })
}

function claim(
  state = fixture(),
  overrides: Partial<Parameters<typeof executeInventoryCommand>[1]> = {},
) {
  return executeInventoryCommand(state, {
    type: "claim_seats",
    operationId: "op-claim-1",
    now: NOW,
    holdId: "hold-1",
    buyerId: "buyer-1",
    seatIds: ["A-1", "A-2"],
    holdForMs: 10 * 60 * 1_000,
    ...overrides,
  } as Parameters<typeof executeInventoryCommand>[1])
}

describe("authoritative multi-seat claims", () => {
  it("claims up to four seats as one unit and computes the total from inventory", () => {
    const result = claim()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toEqual({
      kind: "seats_claimed",
      holdId: "hold-1",
      seatIds: ["A-1", "A-2"],
      total: { currency: "USD", amountMinor: 36_920 },
      expiresAt: NOW + 10 * 60 * 1_000,
    })
    expect(result.state.seats["A-1"]).toMatchObject({
      availability: "held",
      holdId: "hold-1",
    })
    expect(checkDomainInvariants(result.state)).toEqual([])
  })

  it("rejects the whole claim when any requested seat is unavailable", () => {
    const result = claim(fixture(), {
      operationId: "op-unavailable",
      holdId: "hold-unavailable",
      seatIds: ["A-1", "A-6"],
    })

    expect(result).toMatchObject({ ok: false, code: "SEAT_NOT_AVAILABLE" })
    expect(result.state.seats["A-1"].availability).toBe("available")
    expect(result.state.holds["hold-unavailable"]).toBeUndefined()
  })

  it("rejects duplicate selections and orders above the four-seat cap", () => {
    const duplicate = claim(fixture(), {
      operationId: "op-duplicate",
      holdId: "hold-duplicate",
      seatIds: ["A-1", "A-1"],
    })
    const tooMany = claim(fixture(), {
      operationId: "op-too-many",
      holdId: "hold-too-many",
      seatIds: ["A-1", "A-2", "A-3", "A-4", "A-5"],
    })

    expect(duplicate).toMatchObject({ ok: false, code: "INVALID_COMMAND" })
    expect(tooMany).toMatchObject({ ok: false, code: "INVALID_COMMAND" })
  })

  it("does not partially claim seats after a competing atomic claim wins", () => {
    const winner = claim()
    const loser = claim(winner.state, {
      operationId: "op-competing",
      holdId: "hold-competing",
      buyerId: "buyer-2",
      seatIds: ["A-2", "A-3"],
    })

    expect(loser).toMatchObject({ ok: false, code: "SEAT_NOT_AVAILABLE" })
    expect(loser.state.seats["A-3"].availability).toBe("available")
    expect(loser.state.holds["hold-competing"]).toBeUndefined()
  })
})

describe("idempotent operation semantics", () => {
  it("replays the recorded outcome without creating another hold", () => {
    const first = claim()
    const second = claim(first.state, { now: NOW + 60_000 })

    expect(first.ok).toBe(true)
    expect(second).toMatchObject({ ok: true, replayed: true })
    expect(Object.keys(second.state.holds)).toEqual(["hold-1"])
    expect(Object.keys(second.state.operations)).toEqual(["op-claim-1"])
  })

  it("rejects reuse of an operation ID with a different semantic payload", () => {
    const first = claim()
    const conflict = claim(first.state, { seatIds: ["A-3"] })

    expect(conflict).toMatchObject({
      ok: false,
      replayed: false,
      code: "IDEMPOTENCY_CONFLICT",
    })
    expect(conflict.state).toBe(first.state)
  })

  it("also records and replays deterministic failures", () => {
    const first = claim(fixture(), {
      operationId: "op-failed",
      holdId: "hold-failed",
      seatIds: ["missing"],
    })
    const second = claim(first.state, {
      operationId: "op-failed",
      holdId: "hold-failed",
      seatIds: ["missing"],
    })

    expect(first).toMatchObject({
      ok: false,
      replayed: false,
      code: "SEAT_NOT_FOUND",
    })
    expect(second).toMatchObject({
      ok: false,
      replayed: true,
      code: "SEAT_NOT_FOUND",
    })
  })
})

describe("hold lifecycle and stable checkout identity", () => {
  it("releases all seats before checkout without a partial remainder", () => {
    const held = claim()
    const released = executeInventoryCommand(held.state, {
      type: "release_hold",
      operationId: "op-release-active",
      now: NOW + 1_000,
      holdId: "hold-1",
      buyerId: "buyer-1",
    })

    expect(released).toMatchObject({
      ok: true,
      data: {
        kind: "hold_released",
        holdId: "hold-1",
        releasedSeatIds: ["A-1", "A-2"],
      },
    })
    expect(released.state.holds["hold-1"].status).toBe("released")
    expect(released.state.seats["A-1"].availability).toBe("available")
    expect(released.state.seats["A-2"].availability).toBe("available")
    expect(checkDomainInvariants(released.state)).toEqual([])
  })

  it("converts a hold into a non-expirable order reservation", () => {
    const held = claim()
    const ordered = executeInventoryCommand(held.state, {
      type: "create_order",
      operationId: "op-order-1",
      now: NOW + 1_000,
      holdId: "hold-1",
      buyerId: "buyer-1",
      orderId: "order-1",
      paymentId: "payment-1",
    })
    const released = executeInventoryCommand(ordered.state, {
      type: "release_hold",
      operationId: "op-release-1",
      now: NOW + 2_000,
      holdId: "hold-1",
      buyerId: "buyer-1",
    })

    expect(ordered).toMatchObject({
      ok: true,
      data: {
        kind: "order_created",
        orderId: "order-1",
        paymentId: "payment-1",
        total: { currency: "USD", amountMinor: 36_920 },
      },
    })
    expect(ordered.state.holds["hold-1"]).toMatchObject({
      status: "converted",
      orderId: "order-1",
      endReason: "converted_to_order",
    })
    expect(ordered.state.seats["A-1"]).toMatchObject({
      availability: "reserved",
      orderId: "order-1",
    })
    expect(released).toMatchObject({ ok: false, code: "HOLD_NOT_ACTIVE" })
    expect(released.state.seats["A-1"].availability).toBe("reserved")
    expect(released.state.orders["order-1"].status).toBe("pending_payment")
    expect(checkDomainInvariants(released.state)).toEqual([])
  })

  it("does not expire or erase a converted order reservation", () => {
    const held = claim()
    const ordered = executeInventoryCommand(held.state, {
      type: "create_order",
      operationId: "op-order-converted",
      now: NOW + 1_000,
      holdId: "hold-1",
      buyerId: "buyer-1",
      orderId: "order-converted",
      paymentId: "payment-converted",
    })
    const muchLater = executeInventoryCommand(ordered.state, {
      type: "expire_holds",
      operationId: "op-expire-after-order",
      now: NOW + 24 * 60 * 60 * 1_000,
    })

    expect(muchLater).toMatchObject({
      ok: true,
      data: { kind: "holds_expired", holdIds: [], releasedSeatIds: [] },
    })
    expect(muchLater.state.holds["hold-1"].status).toBe("converted")
    expect(muchLater.state.orders["order-converted"].status).toBe(
      "pending_payment",
    )
    expect(muchLater.state.seats["A-1"]).toMatchObject({
      availability: "reserved",
      orderId: "order-converted",
    })
    expect(checkDomainInvariants(muchLater.state)).toEqual([])
  })

  it("expires holds at the server timestamp and makes their seats claimable", () => {
    const held = claim()
    const expired = executeInventoryCommand(held.state, {
      type: "expire_holds",
      operationId: "op-expire-1",
      now: NOW + 10 * 60 * 1_000,
    })
    const reclaimed = claim(expired.state, {
      operationId: "op-claim-2",
      holdId: "hold-2",
      buyerId: "buyer-2",
      now: NOW + 10 * 60 * 1_000,
    })

    expect(expired).toMatchObject({
      ok: true,
      data: {
        kind: "holds_expired",
        holdIds: ["hold-1"],
        releasedSeatIds: ["A-1", "A-2"],
      },
    })
    expect(reclaimed).toMatchObject({ ok: true })
    expect(reclaimed.state.holds["hold-1"].status).toBe("expired")
    expect(reclaimed.state.holds["hold-2"].status).toBe("active")
  })

  it("does not allow a buyer to release or order another buyer's hold", () => {
    const held = claim()
    const release = executeInventoryCommand(held.state, {
      type: "release_hold",
      operationId: "op-wrong-release",
      now: NOW + 1,
      holdId: "hold-1",
      buyerId: "buyer-2",
    })
    const order = executeInventoryCommand(release.state, {
      type: "create_order",
      operationId: "op-wrong-order",
      now: NOW + 2,
      holdId: "hold-1",
      buyerId: "buyer-2",
      orderId: "order-wrong",
      paymentId: "payment-wrong",
    })

    expect(release).toMatchObject({
      ok: false,
      code: "HOLD_OWNERSHIP_MISMATCH",
    })
    expect(order).toMatchObject({ ok: false, code: "HOLD_OWNERSHIP_MISMATCH" })
    expect(order.state.holds["hold-1"].status).toBe("active")
  })
})
