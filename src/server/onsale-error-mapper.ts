import {
  parseCommandIdV1,
  parsePublicRefV1,
  type CommandIdV1,
  type InventoryFailureV1,
  type PublicInventoryErrorCodeV1,
  type PublicRef,
} from "../domain/onsale-public-contract"

type ConditionWithoutSeatsV1 = {
  readonly kind: Exclude<InventoryBoundaryConditionV1["kind"], "seat_not_available">
  readonly commandId?: CommandIdV1 | string
}

type SeatUnavailableConditionV1 = {
  readonly kind: "seat_not_available"
  readonly commandId?: CommandIdV1 | string
  readonly seatRefs: readonly (PublicRef | string)[]
}

export type InventoryBoundaryConditionV1 = {
  readonly kind: "invalid_request"
  readonly commandId?: CommandIdV1 | string
} | {
  readonly kind: "request_origin_denied"
  readonly commandId?: CommandIdV1 | string
} | {
  readonly kind: "access_required"
  readonly commandId?: CommandIdV1 | string
} | {
  readonly kind: "hold_not_found"
  readonly commandId?: CommandIdV1 | string
} | {
  readonly kind: "sale_window_not_open"
  readonly commandId?: CommandIdV1 | string
} | SeatUnavailableConditionV1 | {
  readonly kind: "quote_stale"
  readonly commandId?: CommandIdV1 | string
} | {
  readonly kind: "active_hold_exists"
  readonly commandId?: CommandIdV1 | string
} | {
  readonly kind: "hold_not_active"
  readonly commandId?: CommandIdV1 | string
} | {
  readonly kind: "idempotency_conflict"
  readonly commandId?: CommandIdV1 | string
} | {
  readonly kind: "inventory_integrity_error"
  readonly commandId?: CommandIdV1 | string
} | {
  readonly kind: "inventory_temporarily_unavailable"
  readonly commandId?: CommandIdV1 | string
}

export interface InventoryErrorMappingV1 {
  readonly status: 400 | 403 | 404 | 409 | 503
  readonly body: InventoryFailureV1
}

interface FixedErrorV1 {
  readonly code: PublicInventoryErrorCodeV1
  readonly status: InventoryErrorMappingV1["status"]
  readonly retryable: boolean
  readonly message: string
}

function fixedErrorForKind(
  kind: InventoryBoundaryConditionV1["kind"],
): FixedErrorV1 {
  switch (kind) {
    case "invalid_request":
      return {
        code: "INVALID_REQUEST",
        status: 400,
        retryable: false,
        message: "The request is invalid.",
      }
    case "request_origin_denied":
      return {
        code: "REQUEST_ORIGIN_DENIED",
        status: 403,
        retryable: false,
        message: "The request origin is not allowed.",
      }
    case "access_required":
      return {
        code: "ACCESS_REQUIRED",
        status: 403,
        retryable: false,
        message: "Access proof is required for this sale window.",
      }
    case "hold_not_found":
      return {
        code: "HOLD_NOT_FOUND",
        status: 404,
        retryable: false,
        message: "The hold was not found.",
      }
    case "sale_window_not_open":
      return {
        code: "SALE_WINDOW_NOT_OPEN",
        status: 409,
        retryable: false,
        message: "The selected sale window is not open.",
      }
    case "seat_not_available":
      return {
        code: "SEAT_NOT_AVAILABLE",
        status: 409,
        retryable: false,
        message: "One or more selected seats are not available.",
      }
    case "quote_stale":
      return {
        code: "QUOTE_STALE",
        status: 409,
        retryable: false,
        message:
          "The quote changed. Review the latest inventory before retrying.",
      }
    case "active_hold_exists":
      return {
        code: "ACTIVE_HOLD_EXISTS",
        status: 409,
        retryable: false,
        message: "This session already has an active hold.",
      }
    case "hold_not_active":
      return {
        code: "HOLD_NOT_ACTIVE",
        status: 409,
        retryable: false,
        message: "The hold is no longer active.",
      }
    case "idempotency_conflict":
      return {
        code: "IDEMPOTENCY_CONFLICT",
        status: 409,
        retryable: false,
        message:
          "This command identifier was already used for another request.",
      }
    case "inventory_integrity_error":
      return {
        code: "INVENTORY_INTEGRITY_ERROR",
        status: 503,
        retryable: false,
        message:
          "Inventory is temporarily unavailable because its state could not be verified.",
      }
    case "inventory_temporarily_unavailable":
      return {
        code: "INVENTORY_TEMPORARILY_UNAVAILABLE",
        status: 503,
        retryable: true,
        message: "Inventory is temporarily unavailable. Try again.",
      }
    default: {
      const exhaustive: never = kind
      return exhaustive
    }
  }
}

function safeCommandId(
  value: CommandIdV1 | string | undefined,
): CommandIdV1 | undefined {
  if (value === undefined) return undefined
  try {
    return parseCommandIdV1(value)
  } catch {
    return undefined
  }
}

function safeSeatRefs(
  values: readonly (PublicRef | string)[],
): readonly PublicRef[] | undefined {
  try {
    const refs = values.map((value, index) =>
      parsePublicRefV1(value, `$seatRefs[${index}]`),
    )
    if (new Set(refs).size !== refs.length) return undefined
    return refs
  } catch {
    return undefined
  }
}

function mapFixedErrorV1(
  fixed: FixedErrorV1,
  commandId?: CommandIdV1,
  seatRefs?: readonly PublicRef[],
): InventoryErrorMappingV1 {
  return {
    status: fixed.status,
    body: {
      ok: false,
      ...(commandId === undefined ? {} : { commandId }),
      error: {
        code: fixed.code,
        message: fixed.message,
        retryable: fixed.retryable,
        ...(seatRefs === undefined ? {} : { seatRefs }),
      },
    },
  }
}

export function mapInventoryConditionV1(
  condition: InventoryBoundaryConditionV1,
): InventoryErrorMappingV1 {
  const commandId = safeCommandId(condition.commandId)
  if (condition.kind === "seat_not_available") {
    const seatRefs = safeSeatRefs(condition.seatRefs)
    if (seatRefs === undefined) {
      return mapFixedErrorV1(
        fixedErrorForKind("inventory_integrity_error"),
        commandId,
      )
    }
    return mapFixedErrorV1(
      fixedErrorForKind(condition.kind),
      commandId,
      seatRefs,
    )
  }
  const noSeats: ConditionWithoutSeatsV1 = condition
  return mapFixedErrorV1(fixedErrorForKind(noSeats.kind), commandId)
}

export function mapUnknownInventoryFailureV1(
  _failure: unknown,
  commandId?: CommandIdV1 | string,
): InventoryErrorMappingV1 {
  return mapFixedErrorV1(
    fixedErrorForKind("inventory_temporarily_unavailable"),
    safeCommandId(commandId),
  )
}
