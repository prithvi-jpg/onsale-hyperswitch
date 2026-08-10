import { createHash } from "node:crypto"

import {
  canonicalJsonUtf8V1,
  compareCanonicalStringsV1,
  parseSha256RevisionV1,
  type MoneyBreakdownV1,
  type OnsaleInventorySnapshotV1,
  type PublicRef,
  type PublicSeatV1,
  type Sha256RevisionV1,
} from "../domain/onsale-public-contract"

export function canonicalSha256V1(value: unknown): Sha256RevisionV1 {
  return parseSha256RevisionV1(
    `sha256:${createHash("sha256").update(canonicalJsonUtf8V1(value)).digest("hex")}`,
  )
}

export function createSnapshotRevisionV1(
  snapshot: OnsaleInventorySnapshotV1,
): Sha256RevisionV1 {
  const { revision: _revision, serverTime: _serverTime, ...visibleFacts } =
    snapshot
  return canonicalSha256V1(visibleFacts)
}

export interface QuoteSeatRevisionFactV1 {
  readonly publicRef: PublicRef | string
  readonly rowOrdinal: number
  readonly seatOrdinal: number
  readonly lifecycle: PublicSeatV1["lifecycle"]
  readonly price: MoneyBreakdownV1
}

export interface QuoteRevisionFactsV1 {
  readonly schema: "onsale.quote.v1"
  readonly datasetRef: PublicRef | string
  readonly eventRef: PublicRef | string
  readonly saleWindowRef: PublicRef | string
  readonly saleWindowState: "scheduled" | "open" | "paused" | "closed"
  readonly accessState: PublicSaleAccessStateV1
  readonly seats: readonly QuoteSeatRevisionFactV1[]
}

export type PublicSaleAccessStateV1 = "not_required" | "unproven" | "verified_local_prototype" | "expired" | "revoked"

export function canonicalQuoteFactsV1(
  facts: QuoteRevisionFactsV1,
): QuoteRevisionFactsV1 {
  return {
    ...facts,
    seats: [...facts.seats].sort(
      (left, right) =>
        left.rowOrdinal - right.rowOrdinal ||
        left.seatOrdinal - right.seatOrdinal ||
        compareCanonicalStringsV1(left.publicRef, right.publicRef),
    ),
  }
}

export function createQuoteRevisionV1(
  facts: QuoteRevisionFactsV1,
): Sha256RevisionV1 {
  return canonicalSha256V1(canonicalQuoteFactsV1(facts))
}
