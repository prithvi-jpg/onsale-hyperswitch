import { describe, expect, it } from "vitest"

import { parseOnsaleInventorySnapshotV1 } from "../../src/domain/onsale-public-contract"
import {
  canonicalSha256V1,
  createQuoteRevisionV1,
  createSnapshotRevisionV1,
} from "../../src/server/onsale-canonical-hash"
import { snapshotFixtureV1, uuidV4 } from "../fixtures/onsale-public-v1"

describe("C2 canonical revisions", () => {
  it("hashes equivalent object key orders identically and array orders differently", () => {
    expect(canonicalSha256V1({ b: 2, a: 1 })).toBe(
      canonicalSha256V1({ a: 1, b: 2 }),
    )
    expect(canonicalSha256V1([1, 2])).not.toBe(canonicalSha256V1([2, 1]))
    expect(canonicalSha256V1({ a: 1 })).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it("excludes snapshot revision/serverTime but includes visible inventory facts", () => {
    const firstRaw = snapshotFixtureV1()
    const secondRaw = snapshotFixtureV1()
    secondRaw.revision = `sha256:${"f".repeat(64)}`
    secondRaw.serverTime = "2026-08-08T19:01:00.000Z"

    const first = parseOnsaleInventorySnapshotV1(firstRaw)
    const second = parseOnsaleInventorySnapshotV1(secondRaw)
    expect(createSnapshotRevisionV1(first)).toBe(
      createSnapshotRevisionV1(second),
    )

    const changedRaw = snapshotFixtureV1()
    changedRaw.seatMap.rows[0].seats[0].availability = "held_by_other"
    changedRaw.seatMap.rows[0].seats[0].selectable = false
    const changed = parseOnsaleInventorySnapshotV1(changedRaw)
    expect(createSnapshotRevisionV1(changed)).not.toBe(
      createSnapshotRevisionV1(first),
    )
  })

  it("orders quote seat facts by server display position, never click order", () => {
    const facts = {
      schema: "onsale.quote.v1" as const,
      datasetRef: uuidV4(800),
      eventRef: uuidV4(1),
      saleWindowRef: uuidV4(3),
      saleWindowState: "open" as const,
      accessState: "not_required" as const,
      seats: [
        {
          publicRef: uuidV4(102),
          rowOrdinal: 1,
          seatOrdinal: 2,
          lifecycle: "sellable" as const,
          price: {
            currency: "USD" as const,
            faceValueMinor: 18_000,
            feeMinor: 2_000,
            taxMinor: 500,
            totalMinor: 20_500,
          },
        },
        {
          publicRef: uuidV4(101),
          rowOrdinal: 1,
          seatOrdinal: 1,
          lifecycle: "sellable" as const,
          price: {
            currency: "USD" as const,
            faceValueMinor: 18_000,
            feeMinor: 2_000,
            taxMinor: 500,
            totalMinor: 20_500,
          },
        },
      ],
    }

    expect(createQuoteRevisionV1(facts)).toBe(
      createQuoteRevisionV1({ ...facts, seats: [...facts.seats].reverse() }),
    )
  })
})
