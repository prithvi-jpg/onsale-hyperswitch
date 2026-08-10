import { describe, expect, it } from "vitest"

import {
  PublicContractParseError,
  canonicalJsonUtf8V1,
  canonicalJsonV1,
  canonicalSeatRefsV1,
  checkedAddMinorV1,
  parseClaimSeatsRequestV1,
  parseHoldSelectorCommandV1,
  parseOnsaleInventorySnapshotV1,
  parsePublicRefV1,
  parseQuoteSeatsRequestV1,
  parseQuoteSeatsResponseV1,
  sumMoneyBreakdownsV1,
} from "../../src/domain/onsale-public-contract"
import { money, snapshotFixtureV1, uuidV4 } from "../fixtures/onsale-public-v1"

describe("C2 public inventory snapshot schema", () => {
  it("accepts one exact ordered six-by-ten assigned-seat snapshot", () => {
    const snapshot = parseOnsaleInventorySnapshotV1(snapshotFixtureV1())

    expect(snapshot.schema).toBe("onsale.inventory.v1")
    expect(snapshot.seatMap.rows.map((row) => row.label)).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
    ])
    expect(snapshot.seatMap.rows.flatMap((row) => row.seats)).toHaveLength(60)
    expect(
      new Set(
        snapshot.seatMap.rows.flatMap((row) =>
          row.seats.map((seat) => seat.publicRef),
        ),
      ).size,
    ).toBe(60)
  })

  it("rejects unknown keys, duplicate refs, malformed row order, and incoherent money", () => {
    const unknownKey = snapshotFixtureV1()
    Object.assign(unknownKey.event.saleWindows[0], { buyerRef: "private" })

    const duplicateRef = snapshotFixtureV1()
    duplicateRef.seatMap.rows[0].seats[1].publicRef =
      duplicateRef.seatMap.rows[0].seats[0].publicRef

    const wrongOrder = snapshotFixtureV1()
    wrongOrder.seatMap.rows.reverse()

    const wrongMoney = snapshotFixtureV1()
    wrongMoney.seatMap.rows[0].seats[0].price.totalMinor += 1

    for (const candidate of [
      unknownKey,
      duplicateRef,
      wrongOrder,
      wrongMoney,
    ]) {
      expect(() => parseOnsaleInventorySnapshotV1(candidate)).toThrow(
        PublicContractParseError,
      )
    }
  })

  it("rejects contradictory ownership, inventory state, and selectability", () => {
    const contradictory = snapshotFixtureV1()
    contradictory.session.ownsActiveHold = true
    contradictory.inventoryState = "held"
    contradictory.seatMap.rows[0].seats[0].availability = "held_by_other"
    contradictory.seatMap.rows[0].seats[0].selectable = true

    expect(() => parseOnsaleInventorySnapshotV1(contradictory)).toThrow(
      PublicContractParseError,
    )
  })
})

describe("C2 quote and command request schemas", () => {
  it("accepts repository UUID v7 public refs while command/request IDs stay v4", () => {
    const publicV7 = "018f3f5c-7b42-7abc-8def-0123456789ab"

    expect(parsePublicRefV1(publicV7)).toBe(publicV7)
    expect(() =>
      parseQuoteSeatsRequestV1({
        requestId: publicV7,
        saleWindowRef: uuidV4(3),
        seatRefs: [uuidV4(101)],
      }),
    ).toThrow(PublicContractParseError)
    expect(() =>
      parsePublicRefV1("018f3f5c-7b42-6abc-8def-0123456789ab"),
    ).toThrow(PublicContractParseError)
  })

  it("canonicalizes a one-to-four-seat set independently of browser click order", () => {
    const first = uuidV4(102)
    const second = uuidV4(101)
    const request = parseQuoteSeatsRequestV1({
      requestId: uuidV4(900),
      saleWindowRef: uuidV4(3),
      seatRefs: [first, second],
    })

    expect(request.seatRefs).toEqual([second, first])
    expect(canonicalSeatRefsV1([first, second])).toEqual([second, first])
  })

  it("rejects duplicates, empty/five-seat sets, invalid UUIDs, and unknown keys", () => {
    const base = {
      requestId: uuidV4(900),
      saleWindowRef: uuidV4(3),
    }
    const seat = uuidV4(101)

    for (const candidate of [
      { ...base, seatRefs: [] },
      { ...base, seatRefs: [seat, seat] },
      {
        ...base,
        seatRefs: [1, 2, 3, 4, 5].map((index) => uuidV4(100 + index)),
      },
      { ...base, seatRefs: ["A1"] },
      { ...base, seatRefs: [seat], buyerRef: "must-not-cross" },
    ]) {
      expect(() => parseQuoteSeatsRequestV1(candidate)).toThrow(
        PublicContractParseError,
      )
    }
  })

  it("strictly parses claim and hold-selector commands", () => {
    const commandId = uuidV4(901)
    const seatRef = uuidV4(101)
    const claim = parseClaimSeatsRequestV1({
      commandId,
      saleWindowRef: uuidV4(3),
      seatRefs: [seatRef],
      quoteRevision: `sha256:${"a".repeat(64)}`,
    })
    const selector = parseHoldSelectorCommandV1({ commandId })

    expect(claim.commandId).toBe(commandId)
    expect(selector).toEqual({ commandId })
    expect(() =>
      parseClaimSeatsRequestV1({ ...claim, quoteRevision: "sha256:nope" }),
    ).toThrow(PublicContractParseError)
    expect(() =>
      parseHoldSelectorCommandV1({ commandId, holdRef: uuidV4(99) }),
    ).toThrow(PublicContractParseError)
  })

  it("classifies aggregate quote overflow as a public contract failure", () => {
    const seatRefs = [uuidV4(101), uuidV4(102)]
    const hugeMoney = {
      currency: "USD",
      faceValueMinor: 5_000_000_000_000_000,
      feeMinor: 0,
      taxMinor: 0,
      totalMinor: 5_000_000_000_000_000,
    }

    expect(() =>
      parseQuoteSeatsResponseV1({
        ok: true,
        requestId: uuidV4(900),
        basisRevision: `sha256:${"a".repeat(64)}`,
        quoteRevision: `sha256:${"b".repeat(64)}`,
        saleWindowRef: uuidV4(3),
        seatRefs,
        items: seatRefs.map((seatRef, index) => ({
          seatRef,
          sectionLabel: "SECTION A",
          rowLabel: "A",
          seatLabel: String(index + 1),
          priceTier: "Standard",
          price: hugeMoney,
        })),
        totals: hugeMoney,
      }),
    ).toThrow(PublicContractParseError)
  })
})

describe("canonical JSON and checked money", () => {
  it("sorts object keys, preserves array order, and encodes identical UTF-8", () => {
    const left = { z: 1, a: { y: "✓", x: [3, 2, 1] } }
    const right = { a: { x: [3, 2, 1], y: "✓" }, z: 1 }
    const expected = '{"a":{"x":[3,2,1],"y":"✓"},"z":1}'

    expect(canonicalJsonV1(left)).toBe(expected)
    expect(canonicalJsonV1(right)).toBe(expected)
    expect([...canonicalJsonUtf8V1(left)]).toEqual([
      ...new TextEncoder().encode(expected),
    ])
  })

  it("rejects non-finite, unsupported, sparse, and cyclic values", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const sparse = Array.from({ length: 2 })
    sparse[0] = 1

    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
      1n,
      new Date(),
      sparse,
      cyclic,
    ]) {
      expect(() => canonicalJsonV1(value)).toThrow(TypeError)
    }
  })

  it("uses checked integer addition and verifies breakdown totals", () => {
    expect(checkedAddMinorV1(18_000, 2_000, 500)).toBe(20_500)
    expect(sumMoneyBreakdownsV1([money(), money()])).toEqual({
      currency: "USD",
      faceValueMinor: 36_000,
      feeMinor: 4_000,
      taxMinor: 1_000,
      totalMinor: 41_000,
    })
    expect(() => checkedAddMinorV1(Number.MAX_SAFE_INTEGER, 1)).toThrow(
      RangeError,
    )
    expect(() => checkedAddMinorV1(-1, 1)).toThrow(RangeError)
  })
})
