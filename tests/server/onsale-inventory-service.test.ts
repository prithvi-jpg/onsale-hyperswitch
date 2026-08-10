import { describe, expect, it } from "vitest"

import { InventoryRepositoryError } from "../../src/server/inventory-neon"
import {
  OnsaleInventoryServiceV1,
  type OnsaleSnapshotReadV1,
} from "../../src/server/onsale-inventory-service"
import { uuidV4 } from "../fixtures/onsale-public-v1"

function projectionRead(): OnsaleSnapshotReadV1 {
  const serverTime = "2026-08-08T12:00:00.000Z"
  const datasetId = uuidV4(1)
  const eventId = uuidV4(2)
  const presaleId = uuidV4(3)
  const generalId = uuidV4(4)
  const seats = Array.from({ length: 60 }, (_, index) => {
    const standard = index < 30
    return {
      seat_id: uuidV4(100 + index),
      section_name: "SECTION A",
      section_ordinal: 1,
      row_label: String.fromCharCode(65 + Math.floor(index / 10)),
      row_ordinal: Math.floor(index / 10) + 1,
      seat_label: String((index % 10) + 1),
      seat_ordinal: (index % 10) + 1,
      lifecycle_state: "sellable" as const,
      price_tier_name: standard ? "STANDARD" : "PREMIUM",
      face_value_minor: standard ? 15_000 : 18_000,
      fee_minor: standard ? 1_500 : 2_000,
      tax_minor: standard ? 1_960 : 2_000,
      total_minor: standard ? 18_460 : 22_000,
      currency: "USD",
      price_effective: true,
      allocation_state: null,
      allocation_buyer_ref: null,
      allocation_hold_state: null,
      allocation_expires_at: null,
      allocation_price_tier_name: null,
      allocation_face_value_minor: null,
      allocation_fee_minor: null,
      allocation_tax_minor: null,
      allocation_total_minor: null,
      allocation_currency: null,
    }
  })

  return {
    serverTime,
    event: {
      dataset_id: datasetId,
      event_id: eventId,
      slug: "phantom-circuit-terminal-5",
      name: "PHANTOM CIRCUIT",
      venue_name: "Terminal 5",
      venue_timezone: "America/New_York",
      starts_at: "2026-08-10T00:00:00.000Z",
      currency: "USD",
      seating_mode: "assigned",
      display_metadata: {
        tour_name: "Liminal Frequencies Tour 2026",
        city_label: "New York, NY",
        hero_asset_ref: "https://images.example.test/phantom-circuit.jpg",
      },
    },
    saleWindows: [
      {
        id: presaleId,
        kind: "presale",
        opens_at: "2026-08-01T00:00:00.000Z",
        closes_at: "2026-08-20T00:00:00.000Z",
        access_policy_kind: "local_prototype_cardmember",
        seat_limit: 4,
        configured_state: "open",
      },
      {
        id: generalId,
        kind: "general",
        opens_at: "2026-08-01T00:00:00.000Z",
        closes_at: "2026-08-20T00:00:00.000Z",
        access_policy_kind: "prototype_open",
        seat_limit: 4,
        configured_state: "open",
      },
    ],
    seats,
    currentHold: null,
    holdItems: [],
  }
}

describe("C2 inventory service projection", () => {
  it("projects the real six-by-ten seed shape and keeps presale unproven", () => {
    const snapshot = OnsaleInventoryServiceV1.projectSnapshot(
      projectionRead(),
      "buyer:test",
    )

    expect(snapshot.seatMap.rows).toHaveLength(6)
    expect(snapshot.seatMap.rows.flatMap((row) => row.seats)).toHaveLength(60)
    expect(snapshot.event.saleWindows[0]).toMatchObject({
      kind: "presale",
      canEnter: false,
      access: {
        state: "unproven",
        evidenceClass: "unproven",
      },
    })
    expect(snapshot.event.saleWindows[1]).toMatchObject({
      kind: "general",
      canEnter: true,
      access: {
        state: "not_required",
        evidenceClass: "merchant_rule",
      },
    })
  })

  it("uses immutable allocation money for a session-owned hold", () => {
    const read = projectionRead()
    const held = read.seats[0]
    const buyerRef = "buyer:held-price"
    const holdRef = uuidV4(900)
    const saleWindowRef = read.saleWindows[1].id
    const heldSeat = {
      ...held,
      price_tier_name: "REPRICED",
      face_value_minor: 18_000,
      fee_minor: 2_000,
      tax_minor: 2_000,
      total_minor: 22_000,
      allocation_state: "held" as const,
      allocation_buyer_ref: buyerRef,
      allocation_hold_state: "active" as const,
      allocation_expires_at: "2026-08-08T12:10:00.000Z",
      allocation_price_tier_name: "STANDARD",
      allocation_face_value_minor: 15_000,
      allocation_fee_minor: 1_500,
      allocation_tax_minor: 1_960,
      allocation_total_minor: 18_460,
      allocation_currency: "USD",
    }
    const snapshot = OnsaleInventoryServiceV1.projectSnapshot(
      {
        ...read,
        seats: [heldSeat, ...read.seats.slice(1)],
        currentHold: {
          id: holdRef,
          sale_window_id: saleWindowRef,
          expires_at: "2026-08-08T12:10:00.000Z",
        },
        holdItems: [
          {
            seat_id: held.seat_id,
            section_name: held.section_name,
            row_label: held.row_label,
            seat_label: held.seat_label,
            row_ordinal: held.row_ordinal,
            seat_ordinal: held.seat_ordinal,
            price_tier_name: "STANDARD",
            face_value_minor: 15_000,
            fee_minor: 1_500,
            tax_minor: 1_960,
            total_minor: 18_460,
            currency: "USD",
            allocation_state: "held",
          },
        ],
      },
      buyerRef,
    )

    expect(snapshot.currentHold?.totals.totalMinor).toBe(18_460)
    expect(snapshot.seatMap.rows[0].seats[0]).toMatchObject({
      availability: "held_by_session",
      priceTier: "STANDARD",
      price: { totalMinor: 18_460 },
    })
  })

  it("classifies malformed database timestamps as inventory integrity", () => {
    const read = projectionRead()
    expect(() =>
      OnsaleInventoryServiceV1.projectSnapshot(
        {
          ...read,
          event: { ...read.event, starts_at: "not-a-timestamp" },
        },
        "buyer:test",
      ),
    ).toThrowError(
      expect.objectContaining<Partial<InventoryRepositoryError>>({
        code: "INVENTORY_INTEGRITY",
      }),
    )
  })
})
