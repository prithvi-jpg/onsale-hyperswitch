export function uuidV4(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`
}

export function money(
  faceValueMinor = 18_000,
  feeMinor = 2_000,
  taxMinor = 500,
) {
  return {
    currency: "USD",
    faceValueMinor,
    feeMinor,
    taxMinor,
    totalMinor: faceValueMinor + feeMinor + taxMinor,
  }
}

export function snapshotFixtureV1() {
  const rows = ["A", "B", "C", "D", "E", "F"].map((rowLabel, rowIndex) => ({
    label: rowLabel,
    ordinal: rowIndex + 1,
    seats: Array.from({ length: 10 }, (_, seatIndex) => ({
      publicRef: uuidV4(100 + rowIndex * 10 + seatIndex),
      sectionLabel: "Section A",
      rowLabel,
      seatLabel: String(seatIndex + 1),
      rowOrdinal: rowIndex + 1,
      seatOrdinal: seatIndex + 1,
      lifecycle: "sellable",
      availability: "available",
      selectable: true,
      priceTier: "Standard",
      price: money(),
    })),
  }))

  return {
    schema: "onsale.inventory.v1",
    revision: `sha256:${"0".repeat(64)}`,
    serverTime: "2026-08-08T19:00:00.000Z",
    inventoryState: "ready",
    session: {
      kind: "anonymous_browser",
      ownsActiveHold: false,
    },
    event: {
      publicRef: uuidV4(1),
      slug: "phantom-circuit",
      name: "PHANTOM CIRCUIT",
      tourName: "Liminal Frequencies Tour 2026",
      venueName: "Terminal 5",
      cityLabel: "New York, NY",
      venueTimezone: "America/New_York",
      startsAt: "2026-08-09T00:00:00.000Z",
      heroAssetRef: "figma:event-hero",
      evidenceClass: "simulation",
      currency: "USD",
      seatingMode: "assigned",
      maximumSeatCount: 4,
      allInPriceRange: {
        minimumMinor: 20_500,
        maximumMinor: 20_500,
      },
      saleWindows: [
        {
          publicRef: uuidV4(2),
          kind: "presale",
          state: "open",
          opensAt: "2026-08-08T18:00:00.000Z",
          closesAt: "2026-08-08T20:00:00.000Z",
          seatLimit: 4,
          access: {
            policy: "local_prototype_cardmember",
            state: "unproven",
            evidenceClass: "unproven",
            expiresAt: null,
          },
          canEnter: false,
        },
        {
          publicRef: uuidV4(3),
          kind: "general",
          state: "open",
          opensAt: "2026-08-08T18:00:00.000Z",
          closesAt: "2026-08-08T22:00:00.000Z",
          seatLimit: 4,
          access: {
            policy: "prototype_open",
            state: "not_required",
            evidenceClass: "merchant_rule",
            expiresAt: null,
          },
          canEnter: true,
        },
      ],
    },
    seatMap: {
      sectionLabel: "Section A",
      rowCount: 6,
      seatsPerRow: 10,
      rows,
    },
    currentHold: null,
    capabilities: {
      quote: true,
      claim: true,
      release: false,
      reconcileExpiry: false,
      checkout: false,
    },
  }
}
