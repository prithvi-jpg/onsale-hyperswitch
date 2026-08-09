import { randomUUID } from "node:crypto"

import { Pool } from "@neondatabase/serverless"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  createEphemeralSchemaRun,
  createInventoryNeonSchema,
  dropInventoryNeonSchema,
  quoteEphemeralSchema,
} from "../../src/server/inventory-neon-schema"
import {
  ActiveHoldExistsError,
  HoldNotActiveError,
  IdempotencyConflictError,
  InventoryRepositoryError,
  NeonInventoryRepository,
  ONSALE_FIGMA_SEED_V1,
  QuoteStaleError,
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

describe("C2 inventory repository source contract", () => {
  it("C2-SEED-01 binds the deterministic dataset to the Figma presentation and server money truth", () => {
    expect(ONSALE_FIGMA_SEED_V1).toEqual({
      eventName: "PHANTOM CIRCUIT",
      tourName: "Liminal Frequencies Tour 2026",
      venueName: "Terminal 5",
      venueTimezone: "America/New_York",
      cityLabel: "New York, NY",
      startsAt: "2026-08-10T00:00:00.000Z",
      seatingMode: "assigned",
      sectionName: "SECTION A",
      heroAssetRef:
        "https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=1400&h=560&fit=crop&auto=format&q=80",
      allInPriceRangeMinor: {
        minimum: 18_460,
        maximum: 22_000,
      },
    })
  })
})

neonDescribe("C2 Neon inventory atomicity contract", () => {
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
    "C2-QTE-01 recomputes the exact locked quote and durably replays a stale failure",
    async () => {
      const seed = await repository.seedDeterministicInventory({
        seedKey: "c2-qte-01",
      })
      const seatIds = seed.adjacentSeatIds.slice(0, 2)
      const quoteInput = {
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef: "c2-quote-buyer",
        seatIds,
      } as const
      const forward = await repository.quoteSeats(quoteInput)
      const reverse = await repository.quoteSeats({
        ...quoteInput,
        seatIds: [...seatIds].reverse(),
      })

      expect(reverse.quoteRevision).toBe(forward.quoteRevision)
      expect(reverse.seatIds).toEqual(forward.seatIds)
      expect(forward.quoteRevision).toMatch(/^sha256:[0-9a-f]{64}$/u)
      expect(forward.totals.totalMinor).toBe(36_920)

      await repository.updatePriceTier({
        priceTierId: seed.priceTierIds.standard,
        faceValueMinor: 50_000,
        feeMinor: 5_000,
        taxMinor: 5_000,
      })
      const staleCommand = {
        operationKey: "c2-qte-01-stale",
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef: "c2-quote-buyer",
        seatIds,
        holdForMs: 30_000,
        quoteRevision: forward.quoteRevision,
      } as const
      const firstFailure = await rejectedValue(
        repository.claimQuotedSeats(staleCommand),
      )
      expect(firstFailure).toBeInstanceOf(QuoteStaleError)
      expect(firstFailure).toMatchObject({ code: "QUOTE_STALE" })
      expect(await repository.getOperation(staleCommand.operationKey)).toEqual({
        commandKind: "claim_seats",
        state: "failed",
        errorCode: "QUOTE_STALE",
      })
      expect(await repository.getAllocationsForEvent(seed.eventId)).toEqual([])

      await repository.updatePriceTier({
        priceTierId: seed.priceTierIds.standard,
        faceValueMinor: 15_000,
        feeMinor: 1_500,
        taxMinor: 1_960,
      })
      const replayFailure = await rejectedValue(
        repository.claimQuotedSeats(staleCommand),
      )
      expect(replayFailure).toBeInstanceOf(QuoteStaleError)

      const payloadConflict = await rejectedValue(
        repository.claimQuotedSeats({
          ...staleCommand,
          seatIds: [seed.adjacentSeatIds[2]],
        }),
      )
      expect(payloadConflict).toBeInstanceOf(IdempotencyConflictError)

      const currentQuote = await repository.quoteSeats(quoteInput)
      const claim = await repository.claimQuotedSeats({
        ...staleCommand,
        operationKey: "c2-qte-01-current",
        quoteRevision: currentQuote.quoteRevision,
      })
      expect(claim.seatIds).toEqual(currentQuote.seatIds)
      expect(claim.totals).toEqual(currentQuote.totals)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "C2-HOLD-01 permits one effective current hold per buyer/event and replays the conflict",
    async () => {
      const seed = await repository.seedDeterministicInventory({
        seedKey: "c2-hold-01",
      })
      const buyerRef = "c2-current-hold-buyer"
      const firstSeatIds = [seed.adjacentSeatIds[0]] as const
      const secondSeatIds = [seed.adjacentSeatIds[1]] as const
      const firstQuote = await repository.quoteSeats({
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef,
        seatIds: firstSeatIds,
      })
      const first = await repository.claimQuotedSeats({
        operationKey: "c2-hold-01-first",
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef,
        seatIds: firstSeatIds,
        holdForMs: 30_000,
        quoteRevision: firstQuote.quoteRevision,
      })
      const secondQuote = await repository.quoteSeats({
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef,
        seatIds: secondSeatIds,
      })
      const secondCommand = {
        operationKey: "c2-hold-01-second",
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef,
        seatIds: secondSeatIds,
        holdForMs: 30_000,
        quoteRevision: secondQuote.quoteRevision,
      } as const

      const firstConflict = await rejectedValue(
        repository.claimQuotedSeats(secondCommand),
      )
      expect(firstConflict).toBeInstanceOf(ActiveHoldExistsError)
      expect(firstConflict).toMatchObject({ code: "ACTIVE_HOLD_EXISTS" })
      expect(await repository.getOperation(secondCommand.operationKey)).toEqual(
        {
          commandKind: "claim_seats",
          state: "failed",
          errorCode: "ACTIVE_HOLD_EXISTS",
        },
      )

      await repository.releaseHold({
        operationKey: "c2-hold-01-release",
        holdId: first.holdId,
        buyerRef,
      })
      const replayedConflict = await rejectedValue(
        repository.claimQuotedSeats(secondCommand),
      )
      expect(replayedConflict).toBeInstanceOf(ActiveHoldExistsError)

      const changedPayload = await rejectedValue(
        repository.claimQuotedSeats({
          ...secondCommand,
          seatIds: [seed.adjacentSeatIds[2]],
        }),
      )
      expect(changedPayload).toBeInstanceOf(IdempotencyConflictError)

      const second = await repository.claimQuotedSeats({
        ...secondCommand,
        operationKey: "c2-hold-01-after-release",
      })
      expect(second.seatIds).toEqual([...secondSeatIds])
      expect(await repository.inspectEvent(seed.eventId)).toMatchObject({
        activeAllocationCount: 1,
        partialHoldCount: 0,
      })
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "C2-HOLD-02 commits stale-hold cleanup before durably rejecting a remaining current hold",
    async () => {
      const seed = await repository.seedDeterministicInventory({
        seedKey: "c2-hold-02",
      })
      const buyerRef = "c2-legacy-current-hold-buyer"
      const currentSeatIds = [seed.adjacentSeatIds[0]] as const
      const currentQuote = await repository.quoteSeats({
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef,
        seatIds: currentSeatIds,
      })
      const current = await repository.claimQuotedSeats({
        operationKey: "c2-hold-02-current",
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef,
        seatIds: currentSeatIds,
        holdForMs: 30_000,
        quoteRevision: currentQuote.quoteRevision,
      })

      const staleHoldId = randomUUID()
      const staleAllocationId = randomUUID()
      const staleSeatId = seed.adjacentSeatIds[1]
      const pool = new Pool({ connectionString: databaseUrl, max: 1 })
      const client = await pool.connect()
      try {
        const schema = quoteEphemeralSchema(schemaRun.schema)
        await client.query("begin")
        await client.query(
          `insert into ${schema}.hold (
             id, dataset_id, event_id, sale_window_id, buyer_ref, state,
             expires_at, created_at
           ) values (
             $1, $2, $3, $4, $5, 'active',
             clock_timestamp() - interval '1 second',
             clock_timestamp() - interval '2 seconds'
           )`,
          [
            staleHoldId,
            seed.datasetId,
            seed.eventId,
            seed.saleWindowId,
            buyerRef,
          ],
        )
        await client.query(
          `insert into ${schema}.seat_allocation (
             id, dataset_id, event_id, seat_id, hold_id, state,
             price_tier_name, face_value_minor, fee_minor, tax_minor,
             total_minor, currency
           )
           select
             $1, s.dataset_id, s.event_id, s.id, $2, 'held',
             pt.name, pt.face_value_minor, pt.fee_minor, pt.tax_minor,
             pt.all_in_minor, pt.currency
           from ${schema}.seat s
           join ${schema}.price_tier pt on pt.id = s.price_tier_id
           where s.id = $3`,
          [staleAllocationId, staleHoldId, staleSeatId],
        )
        await client.query("commit")
      } catch (error) {
        await client.query("rollback").catch(() => undefined)
        throw error
      } finally {
        client.release()
        await pool.end()
      }

      const requestedSeatIds = [seed.adjacentSeatIds[2]] as const
      const quote = await repository.quoteSeats({
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef,
        seatIds: requestedSeatIds,
      })
      const failure = await rejectedValue(
        repository.claimQuotedSeats({
          operationKey: "c2-hold-02-rejected",
          eventId: seed.eventId,
          saleWindowId: seed.saleWindowId,
          buyerRef,
          seatIds: requestedSeatIds,
          holdForMs: 30_000,
          quoteRevision: quote.quoteRevision,
        }),
      )

      expect(failure).toBeInstanceOf(ActiveHoldExistsError)
      expect(await repository.getHold(current.holdId)).toMatchObject({
        state: "active",
      })
      expect(await repository.getHold(staleHoldId)).toMatchObject({
        state: "expired",
      })
      expect(
        (await repository.getAllocationsForEvent(seed.eventId)).find(
          (allocation) => allocation.id === staleAllocationId,
        ),
      ).toMatchObject({
        holdId: staleHoldId,
        seatId: staleSeatId,
        state: "expired",
      })
      expect(await repository.getOperation("c2-hold-02-rejected")).toEqual({
        commandKind: "claim_seats",
        state: "failed",
        errorCode: "ACTIVE_HOLD_EXISTS",
      })
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "C2-OWN-01 binds expiry ownership inside the transaction and operation identity",
    async () => {
      const seed = await repository.seedDeterministicInventory({
        seedKey: "c2-own-01",
      })
      const ownerRef = "c2-expiry-owner"
      const seatIds = seed.adjacentSeatIds.slice(0, 2)
      const quote = await repository.quoteSeats({
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef: ownerRef,
        seatIds,
      })
      const claim = await repository.claimQuotedSeats({
        operationKey: "c2-own-01-claim",
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef: ownerRef,
        seatIds,
        holdForMs: 30_000,
        quoteRevision: quote.quoteRevision,
      })
      const holdBefore = await repository.getHold(claim.holdId)
      const allocationsBefore = await repository.getAllocationsForEvent(
        seed.eventId,
      )
      const foreignCommand = {
        operationKey: "c2-own-01-foreign-expiry",
        holdId: claim.holdId,
        buyerRef: "c2-expiry-intruder",
      } as const

      const foreignFailure = await rejectedValue(
        repository.expireHold(foreignCommand),
      )
      expect(foreignFailure).toBeInstanceOf(InventoryRepositoryError)
      expect(foreignFailure).toMatchObject({
        code: "HOLD_OWNERSHIP_MISMATCH",
      })
      const foreignReplay = await rejectedValue(
        repository.expireHold(foreignCommand),
      )
      expect(foreignReplay).toMatchObject({
        code: "HOLD_OWNERSHIP_MISMATCH",
      })
      const identityConflict = await rejectedValue(
        repository.expireHold({
          ...foreignCommand,
          buyerRef: ownerRef,
        }),
      )
      expect(identityConflict).toBeInstanceOf(IdempotencyConflictError)
      expect(await repository.getHold(claim.holdId)).toEqual(holdBefore)
      expect(await repository.getAllocationsForEvent(seed.eventId)).toEqual(
        allocationsBefore,
      )

      const ownerResult = await repository.expireHold({
        operationKey: "c2-own-01-owner-expiry",
        holdId: claim.holdId,
        buyerRef: ownerRef,
      })
      expect(ownerResult).toMatchObject({
        holdId: claim.holdId,
        state: "active",
        releasedSeatIds: [],
      })
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "C2-EXP-01 reports expired seats exactly and refuses false expiry after release",
    async () => {
      const seed = await repository.seedDeterministicInventory({
        seedKey: "c2-exp-01",
      })
      const buyerRef = "c2-expiry-semantics-buyer"
      const expiringSeatIds = [seed.adjacentSeatIds[0]] as const
      const expiringQuote = await repository.quoteSeats({
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef,
        seatIds: expiringSeatIds,
      })
      const expiring = await repository.claimQuotedSeats({
        operationKey: "c2-exp-01-claim-expiring",
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef,
        seatIds: expiringSeatIds,
        holdForMs: 500,
        quoteRevision: expiringQuote.quoteRevision,
      })
      await repository.waitForDatabaseTimeAfter(expiring.expiresAt, 10_000)

      const expired = await repository.expireHold({
        operationKey: "c2-exp-01-expire",
        holdId: expiring.holdId,
        buyerRef,
      })
      expect(expired).toMatchObject({
        state: "expired",
        releasedSeatIds: expiringSeatIds,
      })
      const expiredAgain = await repository.expireHold({
        operationKey: "c2-exp-01-expire-again",
        holdId: expiring.holdId,
        buyerRef,
      })
      expect(expiredAgain).toMatchObject({
        state: "expired",
        releasedSeatIds: expiringSeatIds,
      })

      const releasedSeatIds = [seed.adjacentSeatIds[1]] as const
      const releasedQuote = await repository.quoteSeats({
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef,
        seatIds: releasedSeatIds,
      })
      const releasable = await repository.claimQuotedSeats({
        operationKey: "c2-exp-01-claim-releasable",
        eventId: seed.eventId,
        saleWindowId: seed.saleWindowId,
        buyerRef,
        seatIds: releasedSeatIds,
        holdForMs: 30_000,
        quoteRevision: releasedQuote.quoteRevision,
      })
      await repository.releaseHold({
        operationKey: "c2-exp-01-release",
        holdId: releasable.holdId,
        buyerRef,
      })

      const falseExpiry = await rejectedValue(
        repository.expireHold({
          operationKey: "c2-exp-01-false-expiry",
          holdId: releasable.holdId,
          buyerRef,
        }),
      )
      expect(falseExpiry).toBeInstanceOf(HoldNotActiveError)
      expect(falseExpiry).toMatchObject({ code: "HOLD_NOT_ACTIVE" })
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "C2-SEED-02 persists the exact Figma event metadata and all-in price range",
    async () => {
      const seed = await repository.seedDeterministicInventory({
        seedKey: "c2-seed-02",
      })
      const pool = new Pool({ connectionString: databaseUrl, max: 1 })
      try {
        const schema = quoteEphemeralSchema(schemaRun.schema)
        const result = await pool.query<{
          name: string
          venue_name: string
          venue_timezone: string
          starts_at: Date | string
          seating_mode: string
          display_metadata: Record<string, unknown>
          section_name: string
          minimum_minor: string | number
          maximum_minor: string | number
        }>(
          `select
             e.name,
             e.venue_name,
             e.venue_timezone,
             e.starts_at,
             e.seating_mode,
             e.display_metadata,
             sec.name as section_name,
             min(pt.all_in_minor) as minimum_minor,
             max(pt.all_in_minor) as maximum_minor
           from ${schema}.event e
           join ${schema}.section sec on sec.event_id = e.id
           join ${schema}.price_tier pt on pt.event_id = e.id
           where e.id = $1
           group by e.id, sec.name`,
          [seed.eventId],
        )
        const row = result.rows[0]
        expect(row).toBeDefined()
        expect({
          eventName: row.name,
          tourName: row.display_metadata.tour_name,
          venueName: row.venue_name,
          venueTimezone: row.venue_timezone,
          cityLabel: row.display_metadata.city_label,
          startsAt: new Date(row.starts_at).toISOString(),
          seatingMode: row.seating_mode,
          sectionName: row.section_name,
          heroAssetRef: row.display_metadata.hero_asset_ref,
          allInPriceRangeMinor: {
            minimum: Number(row.minimum_minor),
            maximum: Number(row.maximum_minor),
          },
        }).toEqual(ONSALE_FIGMA_SEED_V1)
      } finally {
        await pool.end()
      }
    },
    TEST_TIMEOUT_MS,
  )
})
