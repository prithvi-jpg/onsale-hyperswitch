import { describe, expect, it } from "vitest"

import {
  mapInventoryConditionV1,
  mapUnknownInventoryFailureV1,
  type InventoryBoundaryConditionV1,
} from "../../src/server/onsale-error-mapper"
import { uuidV4 } from "../fixtures/onsale-public-v1"

describe("C2 exhaustive safe error mapping", () => {
  it.each<readonly [InventoryBoundaryConditionV1["kind"], string, number, boolean]>(
    [
      ["invalid_request", "INVALID_REQUEST", 400, false],
      ["request_origin_denied", "REQUEST_ORIGIN_DENIED", 403, false],
      ["access_required", "ACCESS_REQUIRED", 403, false],
      ["hold_not_found", "HOLD_NOT_FOUND", 404, false],
      ["sale_window_not_open", "SALE_WINDOW_NOT_OPEN", 409, false],
      ["seat_not_available", "SEAT_NOT_AVAILABLE", 409, false],
      ["quote_stale", "QUOTE_STALE", 409, false],
      ["active_hold_exists", "ACTIVE_HOLD_EXISTS", 409, false],
      ["hold_not_active", "HOLD_NOT_ACTIVE", 409, false],
      ["idempotency_conflict", "IDEMPOTENCY_CONFLICT", 409, false],
      ["inventory_integrity_error", "INVENTORY_INTEGRITY_ERROR", 503, false],
      [
        "inventory_temporarily_unavailable",
        "INVENTORY_TEMPORARILY_UNAVAILABLE",
        503,
        true,
      ],
    ],
  )(
    "maps %s without forwarding private messages",
    (kind, code, status, retryable) => {
      const seatRefs = [uuidV4(101)]
      const condition: InventoryBoundaryConditionV1 =
        kind === "seat_not_available" ? { kind, seatRefs } : { kind }
      const mapped = mapInventoryConditionV1(condition)

      expect(mapped.status).toBe(status)
      expect(mapped.body).toMatchObject({
        ok: false,
        error: { code, retryable },
      })
      expect(JSON.stringify(mapped)).not.toMatch(/sql|password|buyerRef/i)
    },
  )

  it("includes only already-sanitized command/seat selectors", () => {
    const commandId = uuidV4(901)
    const seatRefs = [uuidV4(101), uuidV4(102)]
    const mapped = mapInventoryConditionV1({
      kind: "seat_not_available",
      commandId,
      seatRefs,
    })

    expect(mapped.body.commandId).toBe(commandId)
    expect(mapped.body.error.seatRefs).toEqual(seatRefs)
  })

  it("turns unknown infrastructure errors into one retryable generic failure", () => {
    const secret = "postgres://user:password@example.test/private"
    const mapped = mapUnknownInventoryFailureV1(new Error(secret))
    const serialized = JSON.stringify(mapped)

    expect(mapped).toMatchObject({
      status: 503,
      body: {
        ok: false,
        error: {
          code: "INVENTORY_TEMPORARILY_UNAVAILABLE",
          retryable: true,
        },
      },
    })
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain("password")
  })
})
