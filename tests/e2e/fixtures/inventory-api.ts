import type { BrowserContext, Page, Route } from "@playwright/test"

import { money, snapshotFixtureV1, uuidV4 } from "../../fixtures/onsale-public-v1"

type SnapshotFixture = ReturnType<typeof snapshotFixtureV1>
type FixtureSeat = SnapshotFixture["seatMap"]["rows"][number]["seats"][number]

export interface MockHoldItem {
  seatRef: string
  sectionLabel: string
  rowLabel: string
  seatLabel: string
  priceTier: string
  price: ReturnType<typeof money>
}

export interface MockHold {
  publicRef: string
  state: "active" | "expired_pending_reconcile"
  saleWindowRef: string
  expiresAt: string
  items: MockHoldItem[]
  totals: ReturnType<typeof money>
}

export type MockSnapshot = Omit<SnapshotFixture, "currentHold"> & {
  currentHold: MockHold | null
}

export interface MockRouteResult {
  status?: number
  body: unknown
  delayMs?: number
}

export interface InventoryApiHarnessHandlers {
  quote?: (
    harness: InventoryApiHarness,
    request: Record<string, unknown>,
    index: number,
  ) => MockRouteResult | Promise<MockRouteResult>
  claim?: (
    harness: InventoryApiHarness,
    request: Record<string, unknown>,
    index: number,
  ) => MockRouteResult | Promise<MockRouteResult>
  release?: (
    harness: InventoryApiHarness,
    request: Record<string, unknown>,
    holdRef: string,
    index: number,
  ) => MockRouteResult | Promise<MockRouteResult>
  expire?: (
    harness: InventoryApiHarness,
    request: Record<string, unknown>,
    holdRef: string,
    index: number,
  ) => MockRouteResult | Promise<MockRouteResult>
}

type RouteTarget = Pick<Page, "route"> | Pick<BrowserContext, "route">

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" }

export function shaRevision(index: number): string {
  return `sha256:${index.toString(16).padStart(64, "0")}`
}

export function makeSnapshot(revisionIndex = 1): MockSnapshot {
  const fixture = structuredClone(snapshotFixtureV1())
  fixture.event.heroAssetRef =
    "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="
  return {
    ...fixture,
    revision: shaRevision(revisionIndex),
    currentHold: null,
  } as MockSnapshot
}

export function allSeats(snapshot: MockSnapshot): FixtureSeat[] {
  return snapshot.seatMap.rows.flatMap((row) => row.seats)
}

function aggregate(items: readonly MockHoldItem[]): ReturnType<typeof money> {
  return items.reduce(
    (total, item) => ({
      currency: "USD" as const,
      faceValueMinor: total.faceValueMinor + item.price.faceValueMinor,
      feeMinor: total.feeMinor + item.price.feeMinor,
      taxMinor: total.taxMinor + item.price.taxMinor,
      totalMinor: total.totalMinor + item.price.totalMinor,
    }),
    money(0, 0, 0),
  )
}

export function itemsFor(
  snapshot: MockSnapshot,
  seatRefs: readonly string[],
): MockHoldItem[] {
  const seatsByRef = new Map(
    allSeats(snapshot).map((seat) => [seat.publicRef, seat] as const),
  )
  return seatRefs.map((seatRef) => {
    const seat = seatsByRef.get(seatRef)
    if (!seat) throw new Error(`Unknown mocked seat ${seatRef}`)
    return {
      seatRef: seat.publicRef,
      sectionLabel: seat.sectionLabel,
      rowLabel: seat.rowLabel,
      seatLabel: seat.seatLabel,
      priceTier: seat.priceTier,
      price: structuredClone(seat.price),
    }
  })
}

export function makeHold(
  snapshot: MockSnapshot,
  seatRefs: readonly string[],
  options: {
    state?: MockHold["state"]
    expiresAt?: string
    holdRef?: string
  } = {},
): MockHold {
  const items = itemsFor(snapshot, seatRefs)
  return {
    publicRef: options.holdRef ?? uuidV4(900),
    state: options.state ?? "active",
    saleWindowRef: snapshot.event.saleWindows[1].publicRef,
    expiresAt: options.expiresAt ?? "2026-08-08T19:10:00.000Z",
    items,
    totals: aggregate(items),
  }
}

export function snapshotWithHold(
  snapshot: MockSnapshot,
  hold: MockHold,
  revisionIndex: number,
): MockSnapshot {
  const heldRefs = new Set(hold.items.map((item) => item.seatRef))
  const next = structuredClone(snapshot)
  next.revision = shaRevision(revisionIndex)
  next.serverTime = "2026-08-08T19:00:00.000Z"
  next.inventoryState =
    hold.state === "active" ? "held" : "expiry_check_required"
  next.session.ownsActiveHold = hold.state === "active"
  next.currentHold = structuredClone(hold)
  next.capabilities.release = true
  next.capabilities.reconcileExpiry = true
  for (const seat of allSeats(next)) {
    if (heldRefs.has(seat.publicRef)) {
      seat.availability = "held_by_session"
      seat.selectable = false
    }
  }
  return next
}

export function snapshotWithoutHold(
  snapshot: MockSnapshot,
  revisionIndex: number,
): MockSnapshot {
  const next = makeSnapshot(revisionIndex)
  next.serverTime = "2026-08-08T19:00:01.000Z"
  return next
}

export function markSeatUnavailable(
  snapshot: MockSnapshot,
  seatRef: string,
  revisionIndex: number,
): MockSnapshot {
  const next = structuredClone(snapshot)
  next.revision = shaRevision(revisionIndex)
  next.serverTime = "2026-08-08T19:00:01.000Z"
  const seat = allSeats(next).find((candidate) => candidate.publicRef === seatRef)
  if (!seat) throw new Error(`Unknown mocked seat ${seatRef}`)
  seat.availability = "held_by_other"
  seat.selectable = false
  return next
}

function bodyRecord(route: Route): Record<string, unknown> {
  const raw = route.request().postData()
  if (!raw) return {}
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return {}
  return parsed as Record<string, unknown>
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("Expected a mocked string array")
  }
  return value as string[]
}

function commandSuccess(
  commandId: unknown,
  result: Record<string, unknown>,
  snapshot: MockSnapshot,
) {
  return {
    ok: true,
    command: {
      commandId,
      replayed: false,
      result,
    },
    snapshot,
  }
}

async function fulfill(route: Route, result: MockRouteResult): Promise<void> {
  if (result.delayMs) {
    await new Promise((resolve) => setTimeout(resolve, result.delayMs))
  }
  await route.fulfill({
    status: result.status ?? 200,
    headers: JSON_HEADERS,
    body: JSON.stringify(result.body),
  })
}

export class InventoryApiHarness {
  snapshot: MockSnapshot
  readonly handlers: InventoryApiHarnessHandlers
  readonly sessionRequests: string[] = []
  readonly quoteRequests: Record<string, unknown>[] = []
  readonly claimRequests: Record<string, unknown>[] = []
  readonly releaseRequests: Record<string, unknown>[] = []
  readonly expireRequests: Record<string, unknown>[] = []

  constructor(
    snapshot: MockSnapshot = makeSnapshot(),
    handlers: InventoryApiHarnessHandlers = {},
  ) {
    this.snapshot = snapshot
    this.handlers = handlers
  }

  async install(target: RouteTarget): Promise<void> {
    await target.route(/https:\/\/fonts\.(?:googleapis|gstatic)\.com\/.*/, (route) =>
      route.abort(),
    )
    await target.route("**/api/onsale/**", async (route) => {
      const url = new URL(route.request().url())
      const path = url.pathname

      if (path === "/api/onsale/session" && route.request().method() === "GET") {
        this.sessionRequests.push(path)
        await fulfill(route, { body: this.snapshot })
        return
      }

      if (path === "/api/onsale/quotes" && route.request().method() === "POST") {
        const request = bodyRecord(route)
        this.quoteRequests.push(request)
        const index = this.quoteRequests.length
        if (this.handlers.quote) {
          await fulfill(route, await this.handlers.quote(this, request, index))
          return
        }
        const seatRefs = stringArray(request.seatRefs)
        const items = itemsFor(this.snapshot, seatRefs)
        await fulfill(route, {
          body: {
            ok: true,
            requestId: request.requestId,
            basisRevision: this.snapshot.revision,
            quoteRevision: shaRevision(100 + index),
            saleWindowRef: request.saleWindowRef,
            seatRefs,
            items,
            totals: aggregate(items),
          },
        })
        return
      }

      if (path === "/api/onsale/holds" && route.request().method() === "POST") {
        const request = bodyRecord(route)
        this.claimRequests.push(request)
        const index = this.claimRequests.length
        if (this.handlers.claim) {
          await fulfill(route, await this.handlers.claim(this, request, index))
          return
        }
        const seatRefs = stringArray(request.seatRefs)
        const hold = makeHold(this.snapshot, seatRefs)
        this.snapshot = snapshotWithHold(this.snapshot, hold, 200 + index)
        await fulfill(route, {
          body: commandSuccess(
            request.commandId,
            { kind: "hold_claimed", holdRef: hold.publicRef, seatRefs },
            this.snapshot,
          ),
        })
        return
      }

      const commandMatch = path.match(
        /^\/api\/onsale\/holds\/([^/]+)\/(release|expire)$/,
      )
      if (commandMatch && route.request().method() === "POST") {
        const [, encodedHoldRef, action] = commandMatch
        const holdRef = decodeURIComponent(encodedHoldRef)
        const request = bodyRecord(route)
        const list = action === "release" ? this.releaseRequests : this.expireRequests
        list.push(request)
        const index = list.length
        const handler =
          action === "release" ? this.handlers.release : this.handlers.expire
        if (handler) {
          await fulfill(route, await handler(this, request, holdRef, index))
          return
        }
        const releasedRefs = this.snapshot.currentHold?.items.map(
          (item) => item.seatRef,
        ) ?? []
        this.snapshot = snapshotWithoutHold(this.snapshot, 300 + index)
        await fulfill(route, {
          body: commandSuccess(
            request.commandId,
            {
              kind: action === "release" ? "hold_released" : "hold_expired",
              holdRef,
              seatRefs: releasedRefs,
            },
            this.snapshot,
          ),
        })
        return
      }

      await route.fulfill({ status: 404, body: "not mocked" })
    })
  }
}
