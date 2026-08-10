import { readFile } from "node:fs/promises"

import { Pool } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  createEphemeralSchemaRun,
  createInventoryNeonSchema,
  dropInventoryNeonSchema,
  quoteEphemeralSchema,
} from "../../src/server/inventory-neon-schema"
import {
  AccessGrantDeniedError,
  HoldNotActiveError,
  IdempotencyConflictError,
  MAX_HOLD_DURATION_MS,
  MAX_SAFE_MONEY_MINOR,
  MoneyInvariantError,
  NeonInventoryRepository,
  OrderAlreadyExistsError,
  SaleWindowDeniedError,
  SeatUnavailableError,
} from "../../src/server/inventory-neon"
import { loadPrivateDatabaseUrl } from "../../scripts/db/private-neon-env"

const TEST_TIMEOUT_MS = 120_000
const runNeonIntegration = process.env.ONSALE_RUN_NEON_INTEGRATION === "1"
const neonDescribe = runNeonIntegration ? describe.sequential : describe.skip

async function rejectedValue(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected the operation to reject.")
}

describe("Neon migration safety contract", () => {
  it("DB-SCHEMA-01 declares a database barrier against order-item UPDATE and DELETE", async () => {
    const migration = await readFile(
      new URL("../../db/migrations/0001_inventory_v1.sql", import.meta.url),
      "utf8",
    )
    expect(migration).toContain(
      "create trigger order_item_immutable_before_update_or_delete",
    )
    expect(migration).toContain("before update or delete")
    expect(migration).toContain("order items are immutable after creation")
  })
})

neonDescribe("Neon inventory transaction contract", () => {
  let databaseUrl: string
  const schemaRun = createEphemeralSchemaRun()
  let schemaCreated = false
  let repository: NeonInventoryRepository

  beforeAll(async () => {
    databaseUrl = loadPrivateDatabaseUrl()
    await createInventoryNeonSchema({
      databaseUrl,
      schema: schemaRun.schema,
      cleanupCapability: schemaRun.cleanupCapability,
    })
    schemaCreated = true
    repository = new NeonInventoryRepository({
      databaseUrl,
      schema: schemaRun.schema,
    })
  }, TEST_TIMEOUT_MS)

  afterAll(async () => {
    try {
      await repository?.close()
    } finally {
      if (schemaCreated) {
        await dropInventoryNeonSchema({
          databaseUrl,
          schema: schemaRun.schema,
          cleanupCapability: schemaRun.cleanupCapability,
        })
      }
    }
  }, TEST_TIMEOUT_MS)

  it(
    "INV-01 gives one concurrent claimant the seat and a typed conflict to the loser",
    async () => {
      const seed = await repository.seedDeterministicInventory({
        seedKey: "inv-01",
      })
      const seatId = seed.adjacentSeatIds[0]
      const commands = [
        {
          operationKey: "inv-01-buyer-a",
          eventId: seed.eventId,
          saleWindowId: seed.saleWindowId,
          buyerRef: "buyer-a",
          seatIds: [seatId],
          holdForMs: 30_000,
        },
        {
          operationKey: "inv-01-buyer-b",
          eventId: seed.eventId,
          saleWindowId: seed.saleWindowId,
          buyerRef: "buyer-b",
          seatIds: [seatId],
          holdForMs: 30_000,
        },
      ] as const

      const outcomes = await Promise.allSettled(
        commands.map((command) => repository.claimSeats(command)),
      )

      expect(
        outcomes.filter((outcome) => outcome.status === "fulfilled"),
      ).toHaveLength(1)
      const loserIndex = outcomes.findIndex(
        (outcome) => outcome.status === "rejected",
      )
      expect(loserIndex).toBeGreaterThanOrEqual(0)
      const rejection = outcomes[loserIndex]
      if (rejection?.status === "rejected") {
        expect(rejection.reason).toBeInstanceOf(SeatUnavailableError)
      }
      expect(
        await repository.getOperation(commands[loserIndex].operationKey),
      ).toMatchObject({
        commandKind: "claim_seats",
        state: "failed",
        errorCode: "SEAT_NOT_AVAILABLE",
      })

      const state = await repository.inspectEvent(seed.eventId)
      expect(state.activeAllocationCount).toBe(1)
      expect(state.partialHoldCount).toBe(0)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "INV-01F replays a recorded seat conflict after the winning hold releases",
    async () => {
      const seed = await repository.seedDeterministicInventory({
        seedKey: "inv-01-failure-replay",
      })
      const seatId = seed.adjacentSeatIds[0]
      const winner = await repository.claimSeats({
        operationKey: "inv-01f-winner",
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef: "winner",
        seatIds: [seatId],
        holdForMs: 30_000,
      })
      const losingCommand = {
        operationKey: "inv-01f-loser",
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef: "loser",
        seatIds: [seatId],
        holdForMs: 30_000,
      } as const

      const firstFailure = await rejectedValue(
        repository.claimSeats(losingCommand),
      )
      expect(firstFailure).toBeInstanceOf(SeatUnavailableError)
      expect(await repository.getOperation(losingCommand.operationKey)).toEqual(
        {
          commandKind: "claim_seats",
          state: "failed",
          errorCode: "SEAT_NOT_AVAILABLE",
        },
      )

      await repository.releaseHold({
        operationKey: "inv-01f-release",
        holdId: winner.holdId,
        buyerRef: "winner",
      })
      expect(
        (await repository.inspectEvent(seed.eventId)).activeAllocationCount,
      ).toBe(0)

      const replayedFailure = await rejectedValue(
        repository.claimSeats(losingCommand),
      )
      expect(replayedFailure).toBeInstanceOf(SeatUnavailableError)
      expect(replayedFailure).toMatchObject({ code: "SEAT_NOT_AVAILABLE" })
      const allocations = await repository.getAllocationsForEvent(seed.eventId)
      expect(allocations).toHaveLength(1)
      expect(allocations[0]).toMatchObject({
        holdId: winner.holdId,
        seatId,
        state: "released",
      })
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "INV-02 commits one overlapping four-seat bundle with no partial loser allocation",
    async () => {
      const seed = await repository.seedDeterministicInventory({
        seedKey: "inv-02",
      })
      const commands = [
        {
          operationKey: "inv-02-bundle-a",
          eventId: seed.eventId,
          saleWindowId: seed.saleWindowId,
          buyerRef: "bundle-a",
          seatIds: seed.adjacentSeatIds,
          holdForMs: 30_000,
        },
        {
          operationKey: "inv-02-bundle-b",
          eventId: seed.eventId,
          saleWindowId: seed.saleWindowId,
          buyerRef: "bundle-b",
          seatIds: [
            seed.adjacentSeatIds[2],
            seed.adjacentSeatIds[3],
            seed.rows[0].seatIds[4],
            seed.rows[0].seatIds[5],
          ],
          holdForMs: 30_000,
        },
      ] as const

      const outcomes = await Promise.allSettled(
        commands.map((command) => repository.claimSeats(command)),
      )

      expect(
        outcomes.filter((outcome) => outcome.status === "fulfilled"),
      ).toHaveLength(1)
      const loserIndex = outcomes.findIndex(
        (outcome) => outcome.status === "rejected",
      )
      expect(loserIndex).toBeGreaterThanOrEqual(0)
      const winner = outcomes.find((outcome) => outcome.status === "fulfilled")
      expect(winner?.status).toBe("fulfilled")
      if (winner?.status !== "fulfilled") return

      const allocations = await repository.getAllocationsForEvent(seed.eventId)
      expect(allocations).toHaveLength(4)
      expect(
        allocations.every((allocation) => allocation.state === "held"),
      ).toBe(true)
      expect(
        new Set(allocations.map((allocation) => allocation.holdId)),
      ).toEqual(new Set([winner.value.holdId]))
      expect(
        await repository.getOperation(commands[loserIndex].operationKey),
      ).toMatchObject({
        state: "failed",
        errorCode: "SEAT_NOT_AVAILABLE",
      })

      const state = await repository.inspectEvent(seed.eventId)
      expect(state.activeAllocationCount).toBe(4)
      expect(state.partialHoldCount).toBe(0)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "INV-04 releases every allocation once and returns the same terminal result on replay",
    async () => {
      const seed = await repository.seedDeterministicInventory({
        seedKey: "inv-04",
      })
      const claim = await repository.claimSeats({
        operationKey: "inv-04-claim",
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef: "release-buyer",
        seatIds: seed.adjacentSeatIds,
        holdForMs: 30_000,
      })

      const first = await repository.releaseHold({
        operationKey: "inv-04-release-a",
        holdId: claim.holdId,
        buyerRef: "release-buyer",
      })
      const second = await repository.releaseHold({
        operationKey: "inv-04-release-b",
        holdId: claim.holdId,
        buyerRef: "release-buyer",
      })

      expect(first.state).toBe("released")
      expect(first.releasedSeatIds).toEqual(seed.adjacentSeatIds)
      expect(second).toMatchObject({
        state: "released",
        terminalReplay: true,
        releasedSeatIds: seed.adjacentSeatIds,
      })
      expect(
        (await repository.getAllocationsForEvent(seed.eventId)).map(
          (allocation) => allocation.state,
        ),
      ).toEqual(["released", "released", "released", "released"])
      const state = await repository.inspectEvent(seed.eventId)
      expect(state.activeAllocationCount).toBe(0)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "INV-05 reclaims an expired allocation across deterministic database-time barriers",
    async () => {
      const seed = await repository.seedDeterministicInventory({
        seedKey: "inv-05",
      })
      const seatIds = seed.adjacentSeatIds.slice(0, 2)
      const first = await repository.claimSeats({
        operationKey: "inv-05-first",
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef: "expiry-a",
        seatIds,
        holdForMs: 8_000,
      })

      expect(await repository.databaseTimeRelation(first.expiresAt)).toBe(
        "before",
      )
      const beforeExpiryFailure = await rejectedValue(
        repository.claimSeats({
          operationKey: "inv-05-before-expiry-competitor",
          eventId: seed.eventId,
          saleWindowId: seed.saleWindowId,
          buyerRef: "expiry-too-early",
          seatIds,
          holdForMs: 30_000,
        }),
      )
      expect(beforeExpiryFailure).toBeInstanceOf(SeatUnavailableError)
      expect(beforeExpiryFailure).toMatchObject({
        code: "SEAT_NOT_AVAILABLE",
      })
      expect(
        await repository.getOperation("inv-05-before-expiry-competitor"),
      ).toEqual({
        commandKind: "claim_seats",
        state: "failed",
        errorCode: "SEAT_NOT_AVAILABLE",
      })
      const beforeExpiryAllocations = await repository.getAllocationsForEvent(
        seed.eventId,
      )
      expect(beforeExpiryAllocations).toHaveLength(2)
      expect(
        beforeExpiryAllocations.every(
          (allocation) =>
            allocation.holdId === first.holdId && allocation.state === "held",
        ),
      ).toBe(true)
      expect(await repository.databaseTimeRelation(first.expiresAt)).toBe(
        "before",
      )

      await repository.waitForDatabaseTimeAfter(first.expiresAt, 15_000)
      expect(await repository.databaseTimeRelation(first.expiresAt)).toBe(
        "after",
      )
      const second = await repository.claimSeats({
        operationKey: "inv-05-second",
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef: "expiry-b",
        seatIds,
        holdForMs: 30_000,
      })

      expect(second.holdId).not.toBe(first.holdId)
      expect(await repository.getHold(first.holdId)).toMatchObject({
        state: "expired",
      })
      const allocations = await repository.getAllocationsForEvent(seed.eventId)
      expect(
        allocations.filter((allocation) => allocation.state === "expired"),
      ).toHaveLength(2)
      expect(
        allocations.filter(
          (allocation) =>
            allocation.state === "held" && allocation.holdId === second.holdId,
        ),
      ).toHaveLength(2)
      const state = await repository.inspectEvent(seed.eventId)
      expect(state.activeAllocationCount).toBe(2)
      expect(state.activeOwnerCountBySeat).toEqual(
        Object.fromEntries(seatIds.map((seatId) => [seatId, 1])),
      )
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "INV-06 resolves both sides of the expiry/conversion boundary without a partial state",
    async () => {
      const seed = await repository.seedDeterministicInventory({
        seedKey: "inv-06",
      })
      const beforeExpiry = await repository.claimSeats({
        operationKey: "inv-06-before-claim",
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef: "before-expiry-buyer",
        seatIds: seed.adjacentSeatIds.slice(0, 2),
        holdForMs: 30_000,
      })
      expect(
        await repository.databaseTimeRelation(beforeExpiry.expiresAt),
      ).toBe("before")

      const beforeOutcomes = await Promise.allSettled([
        repository.createOrder({
          operationKey: "inv-06-before-order",
          holdId: beforeExpiry.holdId,
          buyerRef: "before-expiry-buyer",
        }),
        repository.expireHold({
          operationKey: "inv-06-before-expire",
          holdId: beforeExpiry.holdId,
          buyerRef: "before-expiry-buyer",
        }),
      ])
      expect(beforeOutcomes[0]?.status).toBe("fulfilled")
      const beforeExpiryOutcome = beforeOutcomes[1]
      if (beforeExpiryOutcome?.status === "rejected") {
        expect(beforeExpiryOutcome.reason).toBeInstanceOf(HoldNotActiveError)
      } else {
        expect(beforeExpiryOutcome?.value.state).toBe("active")
      }
      expect(await repository.getHold(beforeExpiry.holdId)).toMatchObject({
        state: "converted",
      })

      const afterExpiry = await repository.claimSeats({
        operationKey: "inv-06-after-claim",
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef: "after-expiry-buyer",
        seatIds: seed.rows[0].seatIds.slice(4, 6),
        holdForMs: 2_000,
      })
      expect(await repository.databaseTimeRelation(afterExpiry.expiresAt)).toBe(
        "before",
      )
      await repository.waitForDatabaseTimeAfter(afterExpiry.expiresAt)
      expect(await repository.databaseTimeRelation(afterExpiry.expiresAt)).toBe(
        "after",
      )

      const afterOutcomes = await Promise.allSettled([
        repository.createOrder({
          operationKey: "inv-06-after-order",
          holdId: afterExpiry.holdId,
          buyerRef: "after-expiry-buyer",
        }),
        repository.expireHold({
          operationKey: "inv-06-after-expire",
          holdId: afterExpiry.holdId,
          buyerRef: "after-expiry-buyer",
        }),
      ])
      expect(
        afterOutcomes.filter((outcome) => outcome.status === "fulfilled"),
      ).toHaveLength(1)
      const rejection = afterOutcomes.find(
        (outcome) => outcome.status === "rejected",
      )
      if (rejection?.status === "rejected") {
        expect(rejection.reason).toBeInstanceOf(HoldNotActiveError)
      }
      expect(await repository.getHold(afterExpiry.holdId)).toMatchObject({
        state: "expired",
      })
      expect(await repository.getOperation("inv-06-after-order")).toMatchObject(
        {
          state: "failed",
          errorCode: "HOLD_NOT_ACTIVE",
        },
      )
      const allocations = await repository.getAllocationsForEvent(seed.eventId)
      const convertedAllocations = allocations.filter(
        (allocation) => allocation.holdId === beforeExpiry.holdId,
      )
      expect(convertedAllocations).toHaveLength(2)
      expect(
        convertedAllocations.every(
          (allocation) => allocation.state === "reserved",
        ),
      ).toBe(true)
      const expiredAllocations = allocations.filter(
        (allocation) => allocation.holdId === afterExpiry.holdId,
      )
      expect(expiredAllocations).toHaveLength(2)
      expect(
        expiredAllocations.every(
          (allocation) => allocation.state === "expired",
        ),
      ).toBe(true)
      const state = await repository.inspectEvent(seed.eventId)
      expect(state).toMatchObject({
        activeAllocationCount: 2,
        reservedAllocationCount: 2,
        partialHoldCount: 0,
        orderCount: 1,
      })
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "ACL-01 requires the exact sale window and a current buyer-bound local prototype grant",
    async () => {
      const seed = await repository.seedDeterministicInventory({
        seedKey: "acl-01",
      })
      const seatId = seed.adjacentSeatIds[0]
      const unknownWindowId = "00000000-0000-7000-8000-000000000001"

      const missingWindow = await rejectedValue(
        repository.claimSeats({
          operationKey: "acl-01-missing-window",
          eventId: seed.eventId,
          saleWindowId: unknownWindowId,
          buyerRef: "general-buyer",
          seatIds: [seatId],
          holdForMs: 30_000,
        }),
      )
      expect(missingWindow).toBeInstanceOf(SaleWindowDeniedError)
      expect(missingWindow).toMatchObject({ code: "SALE_WINDOW_NOT_FOUND" })

      const missingGrant = await rejectedValue(
        repository.claimSeats({
          operationKey: "acl-01-missing-grant",
          eventId: seed.eventId,
          saleWindowId: seed.presaleWindowId,
          buyerRef: "presale-buyer",
          seatIds: [seatId],
          holdForMs: 30_000,
        }),
      )
      expect(missingGrant).toBeInstanceOf(AccessGrantDeniedError)
      expect(missingGrant).toMatchObject({ code: "ACCESS_GRANT_REQUIRED" })

      const buyerGrant = await repository.issueLocalPrototypeAccessGrant({
        eventId: seed.eventId,
        saleWindowId: seed.presaleWindowId,
        buyerRef: "presale-buyer",
        validForMs: 60 * 60 * 1_000,
      })
      expect(buyerGrant).toMatchObject({
        proofKind: "local_prototype",
        state: "verified",
      })
      expect(await repository.getAccessGrant(buyerGrant.id)).toMatchObject({
        buyerRef: "presale-buyer",
        eventId: seed.eventId,
        saleWindowId: seed.presaleWindowId,
        proofKind: "local_prototype",
        state: "verified",
      })

      const wrongBuyer = await rejectedValue(
        repository.claimSeats({
          operationKey: "acl-01-wrong-buyer",
          eventId: seed.eventId,
          saleWindowId: seed.presaleWindowId,
          accessGrantId: buyerGrant.id,
          buyerRef: "different-buyer",
          seatIds: [seatId],
          holdForMs: 30_000,
        }),
      )
      expect(wrongBuyer).toBeInstanceOf(AccessGrantDeniedError)
      expect(wrongBuyer).toMatchObject({ code: "ACCESS_GRANT_DENIED" })

      const generalWindowGrant =
        await repository.issueLocalPrototypeAccessGrant({
          eventId: seed.eventId,
          saleWindowId: seed.saleWindowId,
          buyerRef: "presale-buyer",
          validForMs: 60 * 60 * 1_000,
        })
      const wrongWindow = await rejectedValue(
        repository.claimSeats({
          operationKey: "acl-01-wrong-window",
          eventId: seed.eventId,
          saleWindowId: seed.presaleWindowId,
          accessGrantId: generalWindowGrant.id,
          buyerRef: "presale-buyer",
          seatIds: [seatId],
          holdForMs: 30_000,
        }),
      )
      expect(wrongWindow).toBeInstanceOf(AccessGrantDeniedError)
      expect(wrongWindow).toMatchObject({ code: "ACCESS_GRANT_DENIED" })

      const expiringGrant = await repository.issueLocalPrototypeAccessGrant({
        eventId: seed.eventId,
        saleWindowId: seed.presaleWindowId,
        buyerRef: "expiring-buyer",
        validForMs: 2_000,
      })
      expect(
        await repository.databaseTimeRelation(expiringGrant.expiresAt),
      ).toBe("before")
      await repository.waitForDatabaseTimeAfter(expiringGrant.expiresAt)
      expect(
        await repository.databaseTimeRelation(expiringGrant.expiresAt),
      ).toBe("after")
      expect(await repository.getAccessGrant(expiringGrant.id)).toMatchObject({
        state: "expired",
      })
      const expiredGrant = await rejectedValue(
        repository.claimSeats({
          operationKey: "acl-01-expired-grant",
          eventId: seed.eventId,
          saleWindowId: seed.presaleWindowId,
          accessGrantId: expiringGrant.id,
          buyerRef: "expiring-buyer",
          seatIds: [seatId],
          holdForMs: 30_000,
        }),
      )
      expect(expiredGrant).toBeInstanceOf(AccessGrantDeniedError)
      expect(expiredGrant).toMatchObject({ code: "ACCESS_GRANT_EXPIRED" })

      const claim = await repository.claimSeats({
        operationKey: "acl-01-valid-grant",
        eventId: seed.eventId,
        saleWindowId: seed.presaleWindowId,
        accessGrantId: buyerGrant.id,
        buyerRef: "presale-buyer",
        seatIds: [seatId],
        holdForMs: 30_000,
      })
      expect(claim.seatIds).toEqual([seatId])
      expect(
        await repository.getOperation("acl-01-expired-grant"),
      ).toMatchObject({
        state: "failed",
        errorCode: "ACCESS_GRANT_EXPIRED",
      })
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "PRC-01 keeps hold and order prices immutable after the live tier changes",
    async () => {
      const seed = await repository.seedDeterministicInventory({
        seedKey: "prc-01",
      })
      const claim = await repository.claimSeats({
        operationKey: "prc-01-claim",
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef: "price-buyer",
        seatIds: seed.adjacentSeatIds.slice(0, 2),
        holdForMs: 30_000,
      })
      const heldTotal = claim.totals

      await repository.updatePriceTier({
        priceTierId: seed.priceTierIds.standard,
        faceValueMinor: 50_000,
        feeMinor: 5_000,
        taxMinor: 5_000,
      })
      expect(await repository.getPriceTier(seed.priceTierIds.standard)).toEqual(
        {
          id: seed.priceTierIds.standard,
          currency: "USD",
          faceValueMinor: 50_000,
          feeMinor: 5_000,
          taxMinor: 5_000,
          totalMinor: 60_000,
        },
      )
      const order = await repository.createOrder({
        operationKey: "prc-01-order",
        holdId: claim.holdId,
        buyerRef: "price-buyer",
      })

      expect(order.totals).toEqual(heldTotal)
      expect(order.items).toHaveLength(2)
      expect(order.items.every((item) => item.totalMinor === 18_460)).toBe(true)
      expect(order.totals.totalMinor).toBe(36_920)
      expect(await repository.getOrder(order.orderId)).toMatchObject({
        id: order.orderId,
        holdId: claim.holdId,
        totals: heldTotal,
        items: [
          { seatId: seed.adjacentSeatIds[0], totalMinor: 18_460 },
          { seatId: seed.adjacentSeatIds[1], totalMinor: 18_460 },
        ],
      })
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "PRC-02 rejects component and aggregate overflow without leaking a hold",
    async () => {
      const seed = await repository.seedDeterministicInventory({
        seedKey: "prc-02-overflow",
      })
      const componentOverflow = await rejectedValue(
        repository.updatePriceTier({
          priceTierId: seed.priceTierIds.standard,
          faceValueMinor: MAX_SAFE_MONEY_MINOR,
          feeMinor: 1,
          taxMinor: 0,
        }),
      )
      expect(componentOverflow).toBeInstanceOf(MoneyInvariantError)
      expect(
        await repository.getPriceTier(seed.priceTierIds.standard),
      ).toMatchObject({ totalMinor: 18_460 })

      await repository.updatePriceTier({
        priceTierId: seed.priceTierIds.standard,
        faceValueMinor: 3_000_000_000_000,
        feeMinor: 1,
        taxMinor: 0,
      })
      const aggregateOverflow = await rejectedValue(
        repository.claimSeats({
          operationKey: "prc-02-aggregate-overflow",
          eventId: seed.eventId,
          saleWindowId: seed.saleWindowId,
          buyerRef: "overflow-buyer",
          seatIds: seed.adjacentSeatIds,
          holdForMs: 30_000,
        }),
      )
      expect(aggregateOverflow).toBeInstanceOf(MoneyInvariantError)
      expect(aggregateOverflow).toMatchObject({ code: "MONEY_INVARIANT" })
      expect(
        await repository.getOperation("prc-02-aggregate-overflow"),
      ).toEqual({
        commandKind: "claim_seats",
        state: "failed",
        errorCode: "MONEY_INVARIANT",
      })
      expect(await repository.getAllocationsForEvent(seed.eventId)).toEqual([])
      expect(
        (await repository.inspectEvent(seed.eventId)).activeAllocationCount,
      ).toBe(0)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "INV-GUARD-01 records sane hold-duration failures and replays them deterministically",
    async () => {
      const seed = await repository.seedDeterministicInventory({
        seedKey: "inv-07-duration",
      })
      const tooLongCommand = {
        operationKey: "inv-07-too-long",
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef: "duration-buyer",
        seatIds: [seed.adjacentSeatIds[0]],
        holdForMs: MAX_HOLD_DURATION_MS + 1,
      } as const

      const tooShort = await rejectedValue(
        repository.claimSeats({
          ...tooLongCommand,
          operationKey: "inv-07-too-short",
          holdForMs: 249,
        }),
      )
      expect(tooShort).toMatchObject({ code: "INVALID_COMMAND" })
      const firstTooLong = await rejectedValue(
        repository.claimSeats(tooLongCommand),
      )
      expect(firstTooLong).toMatchObject({ code: "INVALID_COMMAND" })
      const replayTooLong = await rejectedValue(
        repository.claimSeats(tooLongCommand),
      )
      expect(replayTooLong).toMatchObject({ code: "INVALID_COMMAND" })
      expect(
        await repository.getOperation(tooLongCommand.operationKey),
      ).toEqual({
        commandKind: "claim_seats",
        state: "failed",
        errorCode: "INVALID_COMMAND",
      })
      expect(await repository.getAllocationsForEvent(seed.eventId)).toEqual([])
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "INV-07 rotates one validated 6x10 generation and makes duplicate reset keys semantic",
    async () => {
      const firstInput = {
        operationKey: "inv-07-reset-a",
        seedKey: "inv-07-layout-a",
      } as const
      const [first, firstConcurrentReplay] = await Promise.all([
        repository.seedDeterministicInventory(firstInput),
        repository.seedDeterministicInventory(firstInput),
      ])
      expect(firstConcurrentReplay.datasetId).toBe(first.datasetId)
      expect(firstConcurrentReplay.generation).toBe(first.generation)
      expect([first.replayed, firstConcurrentReplay.replayed].sort()).toEqual([
        false,
        true,
      ])
      expect(
        await repository.inspectDatasetGeneration(first.datasetId),
      ).toEqual({
        datasetId: first.datasetId,
        state: "active",
        generation: first.generation,
        rowCount: 6,
        seatCount: 60,
        rowsWithTenSeats: 6,
        hasAdjacentFourAvailable: true,
        activeDatasetCount: 1,
      })
      expect(await repository.getOperation(firstInput.operationKey)).toEqual({
        commandKind: "reset_dataset",
        state: "completed",
      })
      const payloadConflict = await rejectedValue(
        repository.seedDeterministicInventory({
          operationKey: firstInput.operationKey,
          seedKey: "inv-07-different-layout",
        }),
      )
      expect(payloadConflict).toBeInstanceOf(IdempotencyConflictError)

      const secondInput = {
        operationKey: "inv-07-reset-b",
        seedKey: "inv-07-layout-b",
      } as const
      const thirdInput = {
        operationKey: "inv-07-reset-c",
        seedKey: "inv-07-layout-c",
      } as const
      const [second, third] = await Promise.all([
        repository.seedDeterministicInventory(secondInput),
        repository.seedDeterministicInventory(thirdInput),
      ])
      expect(second.datasetId).not.toBe(third.datasetId)
      expect(second.generation).not.toBe(third.generation)
      expect(second.generation).toBeGreaterThan(first.generation)
      expect(third.generation).toBeGreaterThan(first.generation)
      const secondInspection = await repository.inspectDatasetGeneration(
        second.datasetId,
      )
      const thirdInspection = await repository.inspectDatasetGeneration(
        third.datasetId,
      )
      expect([secondInspection?.state, thirdInspection?.state].sort()).toEqual([
        "active",
        "retired",
      ])
      expect(secondInspection?.activeDatasetCount).toBe(1)
      expect(thirdInspection?.activeDatasetCount).toBe(1)
      const activeResult = secondInspection?.state === "active" ? second : third
      const retiredResult =
        secondInspection?.state === "retired" ? second : third
      const retiredInput =
        secondInspection?.state === "retired" ? secondInput : thirdInput

      const historicalReplay =
        await repository.seedDeterministicInventory(retiredInput)
      expect(historicalReplay).toMatchObject({
        datasetId: retiredResult.datasetId,
        generation: retiredResult.generation,
        replayed: true,
      })
      expect(
        await repository.inspectDatasetGeneration(retiredResult.datasetId),
      ).toMatchObject({ state: "retired", activeDatasetCount: 1 })
      expect(
        await repository.inspectDatasetGeneration(activeResult.datasetId),
      ).toMatchObject({
        state: "active",
        rowCount: 6,
        seatCount: 60,
        rowsWithTenSeats: 6,
        hasAdjacentFourAvailable: true,
        activeDatasetCount: 1,
      })
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "ORD-01 replays one order and rejects both payload and second-operation conflicts",
    async () => {
      const seed = await repository.seedDeterministicInventory({
        seedKey: "ord-01",
      })
      const firstClaim = await repository.claimSeats({
        operationKey: "ord-01-claim-a",
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef: "order-buyer",
        seatIds: seed.adjacentSeatIds.slice(0, 2),
        holdForMs: 30_000,
      })
      const secondClaim = await repository.claimSeats({
        operationKey: "ord-01-claim-b",
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef: "other-buyer",
        seatIds: seed.rows[0].seatIds.slice(6, 8),
        holdForMs: 30_000,
      })

      const first = await repository.createOrder({
        operationKey: "ord-01-order",
        holdId: firstClaim.holdId,
        buyerRef: "order-buyer",
      })
      const replay = await repository.createOrder({
        operationKey: "ord-01-order",
        holdId: firstClaim.holdId,
        buyerRef: "order-buyer",
      })

      expect(replay).toMatchObject({ orderId: first.orderId, replayed: true })
      const payloadConflict = await rejectedValue(
        repository.createOrder({
          operationKey: "ord-01-order",
          holdId: secondClaim.holdId,
          buyerRef: "other-buyer",
        }),
      )
      expect(payloadConflict).toBeInstanceOf(IdempotencyConflictError)
      const secondOperation = await rejectedValue(
        repository.createOrder({
          operationKey: "ord-01-another-operation",
          holdId: firstClaim.holdId,
          buyerRef: "order-buyer",
        }),
      )
      expect(secondOperation).toBeInstanceOf(OrderAlreadyExistsError)
      expect(
        await repository.getOperation("ord-01-another-operation"),
      ).toMatchObject({ state: "failed", errorCode: "ORDER_ALREADY_EXISTS" })

      const state = await repository.inspectEvent(seed.eventId)
      expect(state.orderCount).toBe(1)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "ORD-02 creates one immutable order item per allocation and exact durable header sums",
    async () => {
      const seed = await repository.seedDeterministicInventory({
        seedKey: "ord-02",
      })
      const claim = await repository.claimSeats({
        operationKey: "ord-02-claim",
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef: "four-seat-buyer",
        seatIds: seed.adjacentSeatIds,
        holdForMs: 30_000,
      })
      const order = await repository.createOrder({
        operationKey: "ord-02-order",
        holdId: claim.holdId,
        buyerRef: "four-seat-buyer",
      })

      expect(order.items).toHaveLength(4)
      expect(new Set(order.items.map((item) => item.seatId)).size).toBe(4)
      expect(order.totals).toEqual({
        currency: "USD",
        subtotalMinor: order.items.reduce(
          (sum, item) => sum + item.faceValueMinor,
          0,
        ),
        feeMinor: order.items.reduce((sum, item) => sum + item.feeMinor, 0),
        taxMinor: order.items.reduce((sum, item) => sum + item.taxMinor, 0),
        totalMinor: order.items.reduce((sum, item) => sum + item.totalMinor, 0),
      })
      const durableOrder = await repository.getOrder(order.orderId)
      expect(durableOrder).toEqual({
        id: order.orderId,
        holdId: claim.holdId,
        eventId: seed.eventId,
        state: "awaiting_payment",
        totals: order.totals,
        items: order.items,
      })
      const checkoutOrder = await repository.getOwnedCheckoutOrder(
        order.orderId,
        "four-seat-buyer",
      )
      expect(checkoutOrder).toMatchObject({
        id: order.orderId,
        holdId: claim.holdId,
        eventId: seed.eventId,
        state: "awaiting_payment",
        totals: order.totals,
        items: order.items,
      })
      expect(Date.parse(checkoutOrder?.paymentDeadlineAt ?? "")).toBeGreaterThan(
        Date.now(),
      )
      expect(
        Number.isFinite(Date.parse(checkoutOrder?.serverObservedAt ?? "")),
      ).toBe(true)
      expect(
        await repository.getOwnedCheckoutOrder(
          order.orderId,
          "not-the-order-buyer",
        ),
      ).toBeUndefined()
      const allocations = await repository.getAllocationsForEvent(seed.eventId)
      expect(allocations).toHaveLength(4)
      expect(
        allocations.every(
          (allocation) =>
            allocation.state === "reserved" &&
            allocation.orderId === order.orderId &&
            allocation.holdId === claim.holdId,
        ),
      ).toBe(true)
      expect(await repository.getOperation("ord-02-order")).toEqual({
        commandKind: "create_order",
        state: "completed",
      })
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "ORD-03 cancels one unpaid two-seat order without erasing provenance and releases both seats",
    async () => {
      const seed = await repository.seedDeterministicInventory({
        seedKey: "ord-03-cancel-unpaid",
      })
      const seatIds = seed.adjacentSeatIds.slice(0, 2)
      const claim = await repository.claimSeats({
        operationKey: "ord-03-claim",
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef: "canceling-buyer",
        seatIds,
        holdForMs: 30_000,
      })
      const order = await repository.createOrder({
        operationKey: "ord-03-order",
        holdId: claim.holdId,
        buyerRef: "canceling-buyer",
      })
      const beforeCancellation = await repository.getOrder(order.orderId)
      const reservedBefore = await repository.getAllocationsForEvent(
        seed.eventId,
      )
      expect(reservedBefore).toHaveLength(2)
      expect(
        reservedBefore.every(
          (allocation) =>
            allocation.state === "reserved" &&
            allocation.orderId === order.orderId &&
            typeof allocation.reservedAt === "string",
        ),
      ).toBe(true)

      const cancellation = await repository.cancelOrder({
        operationKey: "ord-03-cancel",
        orderId: order.orderId,
        buyerRef: "canceling-buyer",
      })
      expect(cancellation).toMatchObject({
        replayed: false,
        terminalReplay: false,
        orderId: order.orderId,
        state: "canceled",
        releasedSeatIds: seatIds,
      })
      const afterCancellation = await repository.getOrder(order.orderId)
      expect(afterCancellation?.state).toBe("canceled")
      expect(JSON.stringify(afterCancellation?.items)).toBe(
        JSON.stringify(beforeCancellation?.items),
      )
      const releasedReservations = await repository.getAllocationsForEvent(
        seed.eventId,
      )
      expect(releasedReservations).toHaveLength(2)
      expect(
        releasedReservations.map((allocation) => ({
          id: allocation.id,
          orderId: allocation.orderId,
          releasedAt: allocation.releasedAt,
          reservedAt: allocation.reservedAt,
          seatId: allocation.seatId,
          state: allocation.state,
        })),
      ).toEqual(
        reservedBefore.map((allocation) => ({
          id: allocation.id,
          orderId: order.orderId,
          releasedAt: expect.any(String),
          reservedAt: allocation.reservedAt,
          seatId: allocation.seatId,
          state: "reservation_released",
        })),
      )

      const replacement = await repository.claimSeats({
        operationKey: "ord-03-replacement-claim",
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef: "replacement-buyer",
        seatIds,
        holdForMs: 30_000,
      })
      const beforeReplay = await repository.getAllocationsForEvent(seed.eventId)
      const replay = await repository.cancelOrder({
        operationKey: "ord-03-cancel",
        orderId: order.orderId,
        buyerRef: "canceling-buyer",
      })
      expect(replay).toMatchObject({
        replayed: true,
        orderId: order.orderId,
        state: "canceled",
      })
      const afterReplay = await repository.getAllocationsForEvent(seed.eventId)
      expect(afterReplay).toEqual(beforeReplay)
      expect(afterReplay).toHaveLength(4)
      expect(
        afterReplay.filter(
          (allocation) =>
            allocation.holdId === replacement.holdId &&
            allocation.state === "held",
        ),
      ).toHaveLength(2)
      expect(
        JSON.stringify((await repository.getOrder(order.orderId))?.items),
      ).toBe(JSON.stringify(beforeCancellation?.items))
      expect(await repository.inspectEvent(seed.eventId)).toMatchObject({
        activeAllocationCount: 2,
        reservedAllocationCount: 0,
        partialHoldCount: 0,
        orderCount: 1,
        activeOwnerCountBySeat: Object.fromEntries(
          seatIds.map((seatId) => [seatId, 1]),
        ),
      })
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "ORD-04 rejects order-item UPDATE and DELETE at the database boundary",
    async () => {
      const seed = await repository.seedDeterministicInventory({
        seedKey: "ord-04-immutable-items",
      })
      const claim = await repository.claimSeats({
        operationKey: "ord-04-claim",
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef: "immutability-buyer",
        seatIds: seed.adjacentSeatIds.slice(0, 2),
        holdForMs: 30_000,
      })
      const order = await repository.createOrder({
        operationKey: "ord-04-order",
        holdId: claim.holdId,
        buyerRef: "immutability-buyer",
      })
      const before = await repository.getOrder(order.orderId)
      const beforeBytes = JSON.stringify(before)
      const quotedSchema = quoteEphemeralSchema(schemaRun.schema)
      const mutationPool = new Pool({
        connectionString: databaseUrl,
        max: 1,
        connectionTimeoutMillis: 15_000,
        idleTimeoutMillis: 5_000,
      })
      try {
        const updateFailure = await rejectedValue(
          mutationPool.query(
            `update ${quotedSchema}.order_item
             set seat_label = seat_label || '-mutated'
             where order_id = $1`,
            [order.orderId],
          ),
        )
        expect(updateFailure).toMatchObject({ code: "55000" })
        const deleteFailure = await rejectedValue(
          mutationPool.query(
            `delete from ${quotedSchema}.order_item where order_id = $1`,
            [order.orderId],
          ),
        )
        expect(deleteFailure).toMatchObject({ code: "55000" })
      } finally {
        await mutationPool.end()
      }

      const after = await repository.getOrder(order.orderId)
      expect(JSON.stringify(after)).toBe(beforeBytes)
      expect(after?.totals).toEqual(order.totals)
      expect(after?.items).toHaveLength(2)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "DB-01 refuses cleanup without the per-run capability and leaves the schema usable",
    async () => {
      const seed = await repository.seedDeterministicInventory({
        seedKey: "db-01-cleanup-guard",
      })
      const first = schemaRun.cleanupCapability[0]
      const wrongCapability = `${
        first === "0" ? "1" : "0"
      }${schemaRun.cleanupCapability.slice(1)}`

      await expect(
        dropInventoryNeonSchema({
          databaseUrl,
          schema: schemaRun.schema,
          cleanupCapability: wrongCapability,
        }),
      ).rejects.toThrow("cleanup capability or schema control does not match")
      expect(await repository.inspectEvent(seed.eventId)).toMatchObject({
        activeAllocationCount: 0,
        orderCount: 0,
      })
    },
    TEST_TIMEOUT_MS,
  )
})
