import { expect, test, type Page } from "@playwright/test"

import { uuidV4 } from "../fixtures/onsale-public-v1"
import {
  allSeats,
  InventoryApiHarness,
  itemsFor,
  makeHold,
  makeSnapshot,
  markSeatUnavailable,
  shaRevision,
  snapshotWithHold,
  snapshotWithoutHold,
  type MockRouteResult,
} from "./fixtures/inventory-api"

async function openGeneralSale(page: Page): Promise<void> {
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "PHANTOM CIRCUIT" })).toBeVisible()
  await page.getByRole("button", { name: "VIEW LIVE SEATS →" }).click()
  await expect(page.getByTestId("inventory-hold-screen")).toBeVisible()
  await expect(page.locator("[data-inventory-seat]")).toHaveCount(60)
}

async function selectSeats(page: Page, count: number): Promise<void> {
  const seats = page.locator("[data-inventory-seat]")
  for (let index = 0; index < count; index += 1) {
    await seats.nth(index).click()
    await expect(seats.nth(index)).toHaveAttribute("aria-pressed", "true")
  }
}

function quoteResult(
  harness: InventoryApiHarness,
  request: Record<string, unknown>,
  index: number,
  overrides: Record<string, unknown> = {},
): MockRouteResult {
  const seatRefs = request.seatRefs as string[]
  const items = itemsFor(harness.snapshot, seatRefs)
  const totals = items.reduce(
    (sum, item) => ({
      currency: "USD" as const,
      faceValueMinor: sum.faceValueMinor + item.price.faceValueMinor,
      feeMinor: sum.feeMinor + item.price.feeMinor,
      taxMinor: sum.taxMinor + item.price.taxMinor,
      totalMinor: sum.totalMinor + item.price.totalMinor,
    }),
    {
      currency: "USD" as const,
      faceValueMinor: 0,
      feeMinor: 0,
      taxMinor: 0,
      totalMinor: 0,
    },
  )
  return {
    body: {
      ok: true,
      requestId: request.requestId,
      basisRevision: harness.snapshot.revision,
      quoteRevision: shaRevision(500 + index),
      saleWindowRef: request.saleWindowRef,
      seatRefs,
      items,
      totals,
      ...overrides,
    },
  }
}

test.describe("ONSALE C2 inventory runtime", () => {
  test("production entry stays buyer-calm until a payment journey exists", async ({
    page,
  }) => {
    const api = new InventoryApiHarness()
    await api.install(page)
    await page.goto("/")

    const rail = page.getByTestId("production-payment-rail")
    await expect(rail).toContainText("PAYMENT TRACE")
    await expect(rail).toContainText("Starts at checkout")
    await expect(rail).toContainText(
      "Choose and hold seats first. The payment trace appears only when Hyperswitch begins.",
    )
    await expect(rail.locator("[data-mechanism-panel]")).toHaveCount(0)
    await expect(rail).not.toContainText("LOCAL PROTOTYPE")
    await expect(rail).not.toContainText("NEON INVENTORY")
    await expect(rail).not.toContainText("UNPROVEN")
    await expect(rail).not.toContainText("WEBHOOK")
    await expect(rail).not.toContainText("REVISION")
    await expect(rail).not.toContainText("REFRESH")
    await expect(page.locator("body")).not.toContainText("SIMULATE PAYMENT")
    await expect(page.locator("body")).not.toContainText("TICKET ISSUED ✓")
    await expect(page.locator("body")).not.toContainText("STRIPE")
  })

  test("event to four-seat quote, atomic hold, refresh resume, and release", async ({
    page,
  }) => {
    const api = new InventoryApiHarness()
    await api.install(page)
    await openGeneralSale(page)

    const seats = page.locator("[data-inventory-seat]")
    await selectSeats(page, 4)
    await expect(
      page.getByRole("button", { name: "HOLD 4 SEATS — $820 →" }),
    ).toBeEnabled()
    await expect(seats.nth(4)).toBeDisabled()
    await expect(seats.nth(4)).toHaveAttribute(
      "aria-label",
      /available, 4-seat selection limit reached/,
    )
    await expect(page.locator("aside")).toContainText("INVENTORY PRELUDE")
    await expect(page.locator("aside")).toContainText("4 SEATS SELECTED")
    await expect(page.locator("aside")).toContainText("$820.00 QUOTED · NOT CHARGED")

    await page.getByRole("button", { name: "HOLD 4 SEATS — $820 →" }).click()
    await expect(page.getByText("INVENTORY HOLD ACTIVE", { exact: true })).toBeVisible()
    await expect(page.locator("aside")).toContainText("4 SEATS HELD")
    await expect(page.locator("aside")).toContainText("$820.00 HELD · NOT CHARGED")
    await expect(page.getByRole("button", { name: "RELEASE HOLD" })).toBeEnabled()
    await expect.poll(() => api.claimRequests.length).toBe(1)

    await page.reload()
    await expect(page.getByText("INVENTORY HOLD ACTIVE", { exact: true })).toBeVisible()
    await expect(page.locator('[data-seat-state="held by this session"]')).toHaveCount(4)

    await page.getByRole("button", { name: "RELEASE HOLD" }).click()
    await expect(page.getByRole("button", { name: "VIEW LIVE SEATS →" })).toBeVisible()
    await expect.poll(() => api.releaseRequests.length).toBe(1)

    const commandId = api.claimRequests[0].commandId
    expect(typeof commandId).toBe("string")
    expect(commandId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })

  test("a stale quote response cannot overwrite the latest seat bundle", async ({
    page,
  }) => {
    let releaseFirstQuote!: () => void
    const firstQuoteGate = new Promise<void>((resolve) => {
      releaseFirstQuote = resolve
    })
    const api = new InventoryApiHarness(makeSnapshot(), {
      quote: async (harness, request, index) => {
        const response = quoteResult(harness, request, index)
        if (index === 1) await firstQuoteGate
        return response
      },
    })
    await api.install(page)
    await openGeneralSale(page)

    const seats = page.locator("[data-inventory-seat]")
    await seats.nth(0).click()
    await expect.poll(() => api.quoteRequests.length).toBe(1)
    await seats.nth(1).click()

    await expect(
      page.getByRole("button", { name: "HOLD 2 SEATS — $410 →" }),
    ).toBeEnabled()
    await expect.poll(() => api.quoteRequests.length).toBe(2)
    const staleResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/onsale/quotes" &&
        response.status() === 200,
    )
    releaseFirstQuote()
    await staleResponse
    await expect(
      page.getByRole("button", { name: "HOLD 2 SEATS — $410 →" }),
    ).toBeEnabled()
    await expect(page.getByRole("button", { name: /HOLD 1 SEAT/ })).toHaveCount(0)
  })

  test("a mismatched quote is rejected and the buyer can explicitly retry pricing", async ({
    page,
  }) => {
    const api = new InventoryApiHarness(makeSnapshot(), {
      quote: (harness, request, index) =>
        index === 1
          ? quoteResult(harness, request, index, { requestId: uuidV4(777) })
          : quoteResult(harness, request, index),
    })
    await api.install(page)
    await openGeneralSale(page)

    await page.locator("[data-inventory-seat]").first().click()
    await expect(page.getByTestId("inventory-failure-status")).toContainText(
      "Inventory is temporarily unavailable. Try again.",
    )
    const retry = page.getByRole("button", { name: "RETRY PRICE CHECK →" })
    await expect(retry).toBeEnabled()
    await expect(page.locator("aside")).toContainText("INVENTORY PRELUDE")
    await expect(page.locator("aside")).toContainText("1 SEAT SELECTED")
    await expect(page.locator("aside")).not.toContainText("DATABASE")
    expect(api.claimRequests).toHaveLength(0)

    await retry.click()
    await expect(
      page.getByRole("button", { name: "HOLD 1 SEAT — $205 →" }),
    ).toBeEnabled()
    expect(api.quoteRequests).toHaveLength(2)
    expect(api.claimRequests).toHaveLength(0)
  })

  test("a seat conflict prunes rejected ghost selection and requotes the survivor", async ({
    page,
  }) => {
    const api = new InventoryApiHarness(makeSnapshot(), {
      claim: (harness, request) => {
        const [rejectedSeatRef] = request.seatRefs as string[]
        harness.snapshot = markSeatUnavailable(
          harness.snapshot,
          rejectedSeatRef,
          650,
        )
        return {
          status: 409,
          body: {
            ok: false,
            commandId: request.commandId,
            error: {
              code: "SEAT_NOT_AVAILABLE",
              message: "One selected seat is no longer available.",
              retryable: false,
              seatRefs: [rejectedSeatRef],
            },
            snapshot: harness.snapshot,
          },
        }
      },
    })
    await api.install(page)
    await openGeneralSale(page)

    const seats = page.locator("[data-inventory-seat]")
    await selectSeats(page, 2)
    await expect(
      page.getByRole("button", { name: "HOLD 2 SEATS — $410 →" }),
    ).toBeEnabled()
    await page.getByRole("button", { name: "HOLD 2 SEATS — $410 →" }).click()

    await expect(seats.nth(0)).toBeDisabled()
    await expect(seats.nth(0)).toHaveAttribute("aria-pressed", "false")
    await expect(seats.nth(0)).toHaveAttribute(
      "data-seat-state",
      "held by other",
    )
    await expect(seats.nth(1)).toHaveAttribute("aria-pressed", "true")
    await expect(
      page.getByRole("button", { name: "HOLD 1 SEAT — $205 →" }),
    ).toBeEnabled()
    expect(api.claimRequests).toHaveLength(1)
  })

  test("expired-pending and in-progress reconciliation remain distinct", async ({
    page,
  }) => {
    const initial = makeSnapshot(700)
    const firstSeat = allSeats(initial)[0].publicRef
    const expiredHold = makeHold(initial, [firstSeat], {
      state: "expired_pending_reconcile",
      expiresAt: "2026-08-08T18:59:59.000Z",
      holdRef: uuidV4(901),
    })
    const expiredSnapshot = snapshotWithHold(initial, expiredHold, 701)

    let releaseExpiry!: () => void
    const expiryGate = new Promise<void>((resolve) => {
      releaseExpiry = resolve
    })
    let observeExpiryRequest!: () => void
    const expiryRequested = new Promise<void>((resolve) => {
      observeExpiryRequest = resolve
    })

    const api = new InventoryApiHarness(expiredSnapshot, {
      expire: async (harness, request, holdRef) => {
        observeExpiryRequest()
        await expiryGate
        harness.snapshot = snapshotWithoutHold(harness.snapshot, 702)
        return {
          body: {
            ok: true,
            command: {
              commandId: request.commandId,
              replayed: false,
              result: {
                kind: "hold_expired",
                holdRef,
                seatRefs: [firstSeat],
              },
            },
            snapshot: harness.snapshot,
          },
        }
      },
    })
    await api.install(page)

    await page.addInitScript(() => {
      const history: string[] = []
      Object.defineProperty(window, "__onsaleC2TextHistory", {
        value: history,
        configurable: false,
      })
      const remember = (value: string | null | undefined) => {
        if (value && !history.includes(value)) history.push(value)
      }
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === "characterData") {
            remember(record.oldValue)
            remember(record.target.textContent)
          }
          for (const node of record.addedNodes) remember(node.textContent)
        }
      })
      observer.observe(document, {
        subtree: true,
        childList: true,
        characterData: true,
        characterDataOldValue: true,
      })
    })

    try {
      await page.goto("/")
      await expiryRequested
      await expect(page.getByText("CHECKING EXPIRED HOLD", { exact: true })).toBeVisible()
      await expect(page.locator("aside")).toContainText("INVENTORY PRELUDE")
      await expect(page.locator("aside")).toContainText("1 SEAT HELD")
      await expect(page.locator("aside")).not.toContainText("DATABASE TIME")
      await expect(
        page.getByRole("button", { name: "RECONCILING EXPIRED HOLD…" }),
      ).toBeDisabled()
      await expect
        .poll(() =>
          page.evaluate(() => {
            const history = (
              window as typeof window & { __onsaleC2TextHistory: string[] }
            ).__onsaleC2TextHistory
            return history.some((entry) =>
              entry.includes("HOLD TIME ENDED · CHECKING"),
            )
          }),
        )
        .toBe(true)
    } finally {
      releaseExpiry()
    }
    await expect(page.getByText("SELECT UP TO 4 SEATS", { exact: true })).toBeVisible()
    await expect(page.getByTestId("production-payment-rail")).toContainText(
      "Starts at checkout",
    )
  })

  test("seat selection is operable from the keyboard and exposes state", async ({
    page,
  }) => {
    const api = new InventoryApiHarness()
    await api.install(page)
    await openGeneralSale(page)

    const seats = page.locator("[data-inventory-seat]")
    const first = seats.first()
    await first.focus()
    await page.keyboard.press("Space")
    await expect(first).toHaveAttribute("aria-pressed", "true")
    await expect(first).toHaveAttribute(
      "aria-label",
      /Section A, row A, seat 1, selected, not held, \$205 all-in/,
    )

    await page.keyboard.press("Enter")
    await expect(first).toHaveAttribute("aria-pressed", "false")
    for (let index = 0; index < 4; index += 1) {
      await seats.nth(index).focus()
      await page.keyboard.press("Space")
    }
    await expect(seats.nth(4)).toBeDisabled()
    await seats.nth(3).focus()
    await page.keyboard.press("Tab")
    const fifthRef = await seats.nth(4).getAttribute("data-seat-ref")
    await expect
      .poll(() =>
        page.evaluate(
          (ref) =>
            document.activeElement?.getAttribute("data-seat-ref") !== ref,
          fifthRef,
        ),
      )
      .toBe(true)
  })

  test("HCI I-002: phone prelude keeps buyer context visible without engineering evidence", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const api = new InventoryApiHarness()
    await api.install(page)
    await openGeneralSale(page)
    await selectSeats(page, 4)

    const claimButton = page.getByRole("button", {
      name: "HOLD 4 SEATS — $820 →",
    })
    await expect(claimButton).toBeEnabled()

    const rail = page.getByTestId("production-payment-rail")
    await expect(rail).toContainText("INVENTORY PRELUDE")
    await expect(rail.getByRole("button", { name: /05 · EVIDENCE/ })).toHaveCount(0)
    await expect(rail).not.toContainText("REVISION")
    await expect(rail).not.toContainText("REFRESH")

    const compactContext = page
      .locator(".onsale-buyer-pane")
      .getByRole("region", { name: "Current inventory status" })
    await expect(compactContext).toHaveAttribute(
      "data-testid",
      "inventory-mobile-context",
    )
    await expect(compactContext).toBeInViewport({ ratio: 1 })
    await expect(compactContext).toContainText(/4 seats selected/i)
    await expect(compactContext).toContainText(/\$820\.00 quoted · not held/i)

    await claimButton.click()
    await expect(page.getByTestId("inventory-hold-status")).toContainText(
      "INVENTORY HOLD ACTIVE",
    )
    await expect(rail).toContainText("4 SEATS HELD")
    await expect(compactContext).toBeInViewport({ ratio: 1 })
    await expect(compactContext).toContainText(/4 seats held/i)
    await expect(compactContext).toContainText(/\$820\.00 held · not charged/i)
  })

  test("HCI I-003: the seat map uses one Tab stop and arrow-key spatial navigation", async ({
    page,
  }) => {
    const api = new InventoryApiHarness()
    await api.install(page)
    await openGeneralSale(page)

    const grid = page.getByRole("group", { name: "Assigned seat map" })
    const seats = grid.locator("[data-inventory-seat]")
    await expect(grid).toHaveAttribute(
      "aria-describedby",
      "inventory-seat-grid-help",
    )
    await expect(seats).toHaveCount(60)
    await expect
      .poll(() =>
        seats.evaluateAll(
          (elements) =>
            elements.filter(
              (element) =>
                element instanceof HTMLButtonElement &&
                !element.disabled &&
                element.tabIndex === 0,
            ).length,
        ),
      )
      .toBe(1)

    const first = seats.nth(0)
    const second = seats.nth(1)
    const rowBSecond = seats.nth(11)
    const rowBFirst = seats.nth(10)

    await first.focus()
    await expect(first).toBeFocused()
    await expect(first).toHaveAttribute(
      "aria-label",
      /^Section A, row A, seat 1, available, \$[\d,.]+ all-in$/,
    )

    await page.keyboard.press("ArrowRight")
    await expect(second).toBeFocused()
    await expect(second).toHaveAttribute(
      "aria-label",
      /^Section A, row A, seat 2, available, \$[\d,.]+ all-in$/,
    )

    await page.keyboard.press("ArrowDown")
    await expect(rowBSecond).toBeFocused()
    await expect(rowBSecond).toHaveAttribute(
      "aria-label",
      /^Section A, row B, seat 2, available, \$[\d,.]+ all-in$/,
    )

    await page.keyboard.press("ArrowLeft")
    await expect(rowBFirst).toBeFocused()
    await page.keyboard.press("ArrowUp")
    await expect(first).toBeFocused()

    await page.keyboard.press("Space")
    await expect(first).toHaveAttribute("aria-pressed", "true")
    const holdButton = page.getByRole("button", {
      name: "HOLD 1 SEAT — $205 →",
    })
    await expect(holdButton).toBeEnabled()

    await page.keyboard.press("Tab")
    await expect(holdButton).toBeFocused()
  })

  test("HCI I-004: major inventory transitions move focus to stable context", async ({
    page,
  }) => {
    const api = new InventoryApiHarness()
    await api.install(page)
    await page.goto("/")

    await page.getByRole("button", { name: "VIEW LIVE SEATS →" }).click()
    const seatHeading = page.getByTestId("inventory-seat-heading")
    await expect(seatHeading).toHaveText("Choose your seats")
    await expect(seatHeading).toHaveAttribute("tabindex", "-1")
    await expect(seatHeading).toBeFocused()

    await page.locator("[data-inventory-seat]").first().click()
    const holdButton = page.getByRole("button", {
      name: "HOLD 1 SEAT — $205 →",
    })
    await expect(holdButton).toBeEnabled()
    await holdButton.click()

    const holdStatus = page.getByTestId("inventory-hold-status")
    await expect(holdStatus).toHaveAttribute("role", "status")
    await expect(holdStatus).toHaveAttribute("aria-live", "polite")
    await expect(holdStatus).toHaveText("INVENTORY HOLD ACTIVE")
    await expect(holdStatus).toBeFocused()

    await page.getByRole("button", { name: "RELEASE HOLD" }).click()
    const releaseConfirmation = page.getByTestId("inventory-event-notice")
    await expect(releaseConfirmation).toHaveAttribute("role", "status")
    await expect(releaseConfirmation).toHaveAttribute("aria-live", "polite")
    await expect(releaseConfirmation).toHaveText(
      "HOLD RELEASED · ALL SEATS RETURNED TO INVENTORY",
    )
    await expect(releaseConfirmation).toBeFocused()
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.tagName))
      .not.toBe("BODY")
  })

  for (const viewport of [
    { label: "phone", width: 390, height: 844 },
    { label: "tablet", width: 768, height: 1024 },
    { label: "desktop", width: 1440, height: 1000 },
  ]) {
    test(`${viewport.label} ${viewport.width}x${viewport.height} keeps all 60 seats accessible without horizontal overflow`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport)
      const api = new InventoryApiHarness()
      await api.install(page)
      await openGeneralSale(page)

      const seats = page.locator("[data-inventory-seat]")
      await expect(seats).toHaveCount(60)
      const result = await page.evaluate(() => {
        const root = document.documentElement
        const shell = document.querySelector<HTMLElement>(".onsale-shell")
        const canvas = document.querySelector<HTMLElement>(".onsale-canvas")
        const screen = document.querySelector<HTMLElement>(
          ".inventory-hold-screen",
        )
        const grid = document.querySelector<HTMLElement>(
          "[data-testid='inventory-seat-grid']",
        )
        if (!shell || !canvas || !screen || !grid) {
          throw new Error("Missing responsive inventory anatomy")
        }
        const canvasRect = canvas.getBoundingClientRect()
        const gridRect = grid.getBoundingClientRect()
        return {
          overflows: [
            ["document", root.scrollWidth, root.clientWidth],
            ["shell", shell.scrollWidth, shell.clientWidth],
            ["canvas", canvas.scrollWidth, canvas.clientWidth],
            ["hold screen", screen.scrollWidth, screen.clientWidth],
          ].filter(([, scrollWidth, clientWidth]) => scrollWidth > clientWidth + 1),
          gridInsideCanvas:
            gridRect.left >= canvasRect.left - 1 &&
            gridRect.right <= canvasRect.right + 1,
          renderedSeatCount: grid.querySelectorAll("[data-inventory-seat]").length,
          buyerWidth:
            document.querySelector<HTMLElement>(".onsale-buyer-pane")
              ?.getBoundingClientRect().width ?? 0,
          railWidth:
            document.querySelector<HTMLElement>(".onsale-rail")
              ?.getBoundingClientRect().width ?? 0,
        }
      })

      expect(result.renderedSeatCount).toBe(60)
      expect(result.overflows).toEqual([])
      expect(result.gridInsideCanvas).toBe(true)
      if (viewport.width === 768) {
        const ratio = result.buyerWidth / (result.buyerWidth + result.railWidth)
        expect(ratio).toBeGreaterThan(0.595)
        expect(ratio).toBeLessThan(0.605)
      } else if (viewport.width > 900) {
        const ratio = result.buyerWidth / (result.buyerWidth + result.railWidth)
        expect(ratio).toBeGreaterThan(0.715)
        expect(ratio).toBeLessThan(0.725)
      }
    })
  }

  test("a tab reconciles the shared session snapshot when it becomes visible", async ({
    context,
    page: firstPage,
  }) => {
    const api = new InventoryApiHarness()
    await api.install(context)
    const secondPage = await context.newPage()
    await Promise.all([firstPage.goto("/"), secondPage.goto("/")])
    await expect(firstPage.getByRole("button", { name: "VIEW LIVE SEATS →" })).toBeVisible()
    await expect(secondPage.getByRole("button", { name: "VIEW LIVE SEATS →" })).toBeVisible()

    const heldSeat = allSeats(api.snapshot)[0].publicRef
    api.snapshot = snapshotWithHold(
      api.snapshot,
      makeHold(api.snapshot, [heldSeat], { holdRef: uuidV4(950) }),
      951,
    )
    const readsBeforeReconcile = api.sessionRequests.length

    await firstPage.bringToFront()
    await firstPage.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    )
    await expect(firstPage.getByText("INVENTORY HOLD ACTIVE", { exact: true })).toBeVisible()
    await expect.poll(() => api.sessionRequests.length).toBeGreaterThan(
      readsBeforeReconcile,
    )

    await secondPage.bringToFront()
    await secondPage.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    )
    await expect(secondPage.getByText("INVENTORY HOLD ACTIVE", { exact: true })).toBeVisible()
    await secondPage.close()
  })
})
