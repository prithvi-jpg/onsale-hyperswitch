import { useCallback, useState, useEffect, useRef } from 'react'
import {
  ProductionMechanismRail,
  type CheckoutRailEvidence,
  type InventoryRailEvidence,
} from './MechanismRail'
import {
  canonicalSeatRefsV1,
  type OnsaleInventorySnapshotV1,
  type PublicRef,
  type QuoteSeatsResponseV1,
  type SeatRefs,
} from "./domain/onsale-public-contract"
import {
  useOnsaleInventoryV1,
  type InventoryRequestStateV1,
} from "./use-onsale-inventory"
import type { CheckoutPrivateSuccessV1 } from "./domain/onsale-checkout-private-v1"
import {
  useOnsaleCheckoutV1,
  type CheckoutClientRequestStateV1,
  type CheckoutWidgetReadinessV1,
} from "./use-onsale-checkout"
import HyperswitchCheckoutClient from "./HyperswitchCheckoutClient"
import type { RecordedRunRefV1 } from "./onsale/contracts/recorded-run-v1"
import { useAnnounceCurrentRecordedRunV1 } from "./onsale/flows/use-announce-current-recorded-run-v1"

// ─── Tokens ───────────────────────────────────────────────────────────────────
const B    = '#006DF9'
const B05  = 'rgba(0,109,249,0.05)'
const B10  = 'rgba(0,109,249,0.10)'
const B20  = 'rgba(0,109,249,0.20)'
const GREEN = '#22C55E'
const RED   = '#EF4444'
const AMBER = '#F59E0B'
const DARK  = '#06080f'
const MONO  = "'JetBrains Mono', monospace"
const SANS  = "'Inter', sans-serif"

// ─── App state ────────────────────────────────────────────────────────────────
type AppState = 'event' | 'eligibility' | 'hold' | 'checkout'
  | 'action' | 'success' | 'hard_decline' | 'recoverable'

// ─── Event definition ─────────────────────────────────────────────────────────
const EVENT = {
  name:      'PHANTOM CIRCUIT',
  tour:      'Liminal Frequencies Tour 2026',
  venue:     'Terminal 5',
  city:      'New York, NY',
  date:      'Sat · Aug 09 · 8:00 PM',
  priceFrom: 90,
  priceTo:   220,
  heroImg:   "/assets/phantom-circuit-hero.png",
}

// ─── Shared atoms ─────────────────────────────────────────────────────────────
const dotGridStyle = {
  backgroundImage: 'radial-gradient(circle, rgba(0,109,249,0.10) 1px, transparent 1px)',
  backgroundSize: '22px 22px',
}

function Tag({ children, color = B, bg = B10,
}: { children: React.ReactNode
  color?: string
  bg?: string }) {
  return (
    <span style={{ fontFamily: MONO, fontSize: 9, color, background: bg, border: `1px solid ${color}30`, padding: '2px 8px', letterSpacing: '0.1em', display: 'inline-flex', alignItems: 'center', gap: 4,
      }}
    >
      {children}
    </span>
  )
}

function LiveDot({ color = GREEN }: { color?: string }) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', width: 8, height: 8, flexShrink: 0,
      }}
    >
      <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: color, opacity: 0.6, animation: 'pulse-ring 1.8s ease-out infinite',
        }} />
      <span style={{ position: 'relative', borderRadius: '50%', background: color, width: 8, height: 8,
        }} />
    </span>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontFamily: MONO, fontSize: 9, color: 'rgba(0,0,0,0.35)', letterSpacing: '0.12em', display: 'block', marginBottom: 4,
      }}
    >
      {children}
    </span>
  )
}

// ─── QR Code placeholder ──────────────────────────────────────────────────────
function QRCode() {
  const on = (v: number) => v === 1
  // Simplified 13×13 grid — looks like QR, not real
  const grid = [
    [1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 0],
    [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 0, 1, 0],
    [1, 0, 1, 1, 1, 0, 1, 0, 0, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 0],
    [1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 0, 1],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0],
    [1, 1, 0, 1, 0, 1, 1, 1, 1, 0, 1, 0, 1],
    [0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 1, 1],
    [1, 0, 0, 1, 1, 1, 1, 0, 1, 0, 1, 0, 0],
    [0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1],
    [1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 0, 1, 0],
  ]
  const size = 6.5
  return (
    <svg viewBox={`0 0 ${13 * size} ${13 * size}`} style={{ width: 84, height: 84 }}
    >
      {grid.map((row, r) => row.map((cell, c) => cell === 1 ? (
        <rect key={`${r}-${c}`} x={c * size + 0.5} y={r * size + 0.5} width={size - 1} height={size - 1} fill="rgba(255,255,255,0.9)" />
      ) : null,
        ),
      )}
    </svg>
  )
}

// ─── Step breadcrumb + event context bar ─────────────────────────────────────
interface FlowStep { id: string
  label: string }

const FLOW_STEPS: FlowStep[] = [
  { id: 'event',       label: 'EVENT' },
  { id: 'eligibility', label: 'ELIGIBILITY' },
  { id: 'hold',        label: 'SEATS' },
  { id: 'checkout',    label: 'CHECKOUT' },
  { id: 'result',      label: 'RESULT' },
]

function stepIndex(app: AppState): number {
  if (app === 'event')        return 0
  if (app === 'eligibility')  return 1
  if (app === 'hold')         return 2
  if (app === 'checkout')     return 3
  return 4 // action, success, hard_decline, recoverable
}

function BreadcrumbNav({
  appState, holdSeconds, onHome, onBack,
  holdCommitted,
}: {
  appState: AppState
  holdSeconds: number
  onHome: () => void
  onBack: () => void
  holdCommitted?: boolean
}) {
  const cur = stepIndex(appState)
  const showTimer = ['hold', 'checkout', 'action'].includes(appState) && holdSeconds > 0 &&
    (holdCommitted ?? true)
  const min = String(Math.floor(holdSeconds / 60)).padStart(2, '0')
  const sec = String(holdSeconds % 60).padStart(2, '0')
  const timerRed = holdSeconds < 120
  const canBack = appState !== 'event' && !['routing', 'hyperswitch', 'processor', 'webhook'].includes(appState)

  return (
    <div className="onsale-breadcrumb" style={{
      display: 'flex', alignItems: 'center', gap: 0,
      background: DARK, flexShrink: 0,
      borderBottom: '1px solid rgba(0,109,249,0.15)',
    }}
    >
      {/* Back button */}
      <button
        className="btn-home"
        onClick={onBack}
        disabled={!canBack}
        style={{ padding: '8px 14px', opacity: canBack ? 1 : 0, pointerEvents: canBack ? 'auto' : 'none',
        }}
        aria-label="Go back"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M8 2L4 6L8 10" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" strokeLinecap="round"
          />
        </svg>
      </button>

      {/* Divider */}
      <div style={{ width: 1, height: 32, background: 'rgba(255,255,255,0.06)' }} />

      {/* Event pill */}
      <div className="onsale-breadcrumb-event" style={{ padding: '0 16px', display: 'flex', alignItems: 'center', gap: 8,
        }}
      >
        <span style={{ fontFamily: MONO, fontSize: 9, color: B, letterSpacing: '0.1em', fontWeight: 600,
          }}
        >
          {EVENT.name}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 8, color: 'rgba(255,255,255,0.3)',
          }}
        >
          ·</span>
        <span style={{ fontFamily: MONO, fontSize: 8, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.04em',
          }}
        >
          {EVENT.venue}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 8, color: 'rgba(255,255,255,0.3)',
          }}
        >
          ·</span>
        <span style={{ fontFamily: MONO, fontSize: 8, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.04em',
          }}
        >
          Aug 09</span>
      </div>

      <div style={{ width: 1, height: 32, background: 'rgba(255,255,255,0.06)' }} />

      {/* Step breadcrumb */}
      <div className="onsale-breadcrumb-steps" style={{ display: 'flex', alignItems: 'center', padding: '0 16px', gap: 2,
        }}
      >
        {FLOW_STEPS.map((step, i) => {
          const done = i < cur
          const active = i === cur
          const canNav = done && !['routing', 'hyperswitch', 'processor', 'webhook'].includes(
              appState,
            )
          return (
            <div key={step.id} style={{ display: 'flex', alignItems: 'center', gap: 2 }}
            >
              {i > 0 && (
                <svg width="12" height="10" viewBox="0 0 12 10" style={{ margin: '0 1px', flexShrink: 0 }}
                >
                  <path d="M2 5H10M7 2L10 5L7 8" stroke={
                      done || active ? 'rgba(0,109,249,0.5)' : 'rgba(255,255,255,0.1)'
                    } strokeWidth="1" strokeLinecap="round" fill="none"
                  />
                </svg>
              )}
              <button
                className="breadcrumb-step"
                disabled={!canNav && !active}
                onClick={canNav ? onHome : undefined}
                style={{
                  color: active ? '#fff'
                    : done ? 'rgba(0,109,249,0.7)'
                    : 'rgba(255,255,255,0.2)',
                  fontWeight: active ? 600 : 400,
                }}
              >
                {step.label}
              </button>
            </div>
          )
        })}
      </div>

      <div style={{ flex: 1 }} />

      {/* Hold timer */}
      {showTimer && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '0 16px',
          color: timerRed ? RED : AMBER,
          fontFamily: MONO, fontSize: 10, letterSpacing: '0.08em',
          transition: 'color 0.5s',
          borderLeft: '1px solid rgba(255,255,255,0.06)',
        }}
        >
          <svg width="11" height="11" viewBox="0 0 11 11">
            <circle cx="5.5" cy="5.5" r="5" stroke="currentColor" strokeWidth="1" fill="none"
            />
            <line x1="5.5" y1="2.5" x2="5.5" y2="5.5" stroke="currentColor" strokeWidth="1.2"
            />
            <line x1="5.5" y1="5.5" x2="7.5" y2="7" stroke="currentColor" strokeWidth="1.2"
            />
          </svg>
          HOLD {min}:{sec}
        </div>
      )}

      {/* Status badges */}
      {appState === 'success' && (
        <div style={{ padding: '0 16px', borderLeft: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 6,
          }}
        >
          <LiveDot color={GREEN} />
          <span style={{ fontFamily: MONO, fontSize: 9, color: GREEN, letterSpacing: '0.1em',
            }}
          >
            CONFIRMED</span>
        </div>
      )}
      {appState === 'hard_decline' && (
        <div style={{ padding: '0 16px', borderLeft: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <span style={{ fontFamily: MONO, fontSize: 9, color: RED, letterSpacing: '0.1em',
            }}
          >
            DECLINED</span>
        </div>
      )}
      {appState === 'recoverable' && (
        <div style={{ padding: '0 16px', borderLeft: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <span style={{ fontFamily: MONO, fontSize: 9, color: AMBER, letterSpacing: '0.1em',
            }}
          >
            INTERRUPTED</span>
        </div>
      )}
    </div>
  )
}

// ─── Main Shell ───────────────────────────────────────────────────────────────
type CompactClaimContextState =
  | "quoted"
  | "claiming"
  | "held"
  | "releasing"
  | "expiry_required"
  | "expiring"

interface CompactClaimContext {
  state: CompactClaimContextState
  seats: string
  amount: string
  status: string
  tail?: string
}

function Shell({
  appState, holdSeconds, onHome, onBack, children, rightPanel,
  checkoutMode = false,
  railIdle = false,
  holdCommitted,
  buyerContext,
}: {
  appState: AppState
  holdSeconds: number
  onHome: () => void
  onBack: () => void
  children: React.ReactNode
  rightPanel: React.ReactNode
  checkoutMode?: boolean
  railIdle?: boolean
  holdCommitted?: boolean
  buyerContext?: CompactClaimContext | null
}) {
  return (
    <div
      className="onsale-shell inventory-shell"
      style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#fff', overflow: 'hidden',
      }}
    >

      {/* Global header */}
      <header
        className="onsale-header"
        style={{
        borderBottom: `1px solid ${B}`, background: '#fff',
        display: 'flex', alignItems: 'center', padding: '0 24px', height: 46, flexShrink: 0, gap: 16,
      }}
      >
        {/* Home button — logo */}
        <button
          className="btn-home"
          onClick={onHome}
          aria-label="ONSALE home"
          style={{ padding: '4px 6px 4px 0' }}
        >
          <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: B, letterSpacing: '0.06em',
            }}
          >
            ONSALE</span>
        </button>

        <div style={{ width: 1, height: 18, background: B20 }} />
        <span
          className="onsale-powered-label"
          style={{ fontFamily: MONO, fontSize: 8, color: 'rgba(0,109,249,0.45)', letterSpacing: '0.14em',
          }}
        >
          POWERED BY JUSPAY HYPERSWITCH
        </span>
        <a className="onsale-flows-tab" href="/flows">
          FLOWS
        </a>
        <div style={{ flex: 1 }} />
        {/* Buyer-facing context. Engineering evidence lives in the rail. */}
        <div className="onsale-environment-badges">
          <Tag color={B} bg={B05}>
            <LiveDot color={B} /> {checkoutMode ? "SECURE CHECKOUT" : "EVENT DEMO"}
          </Tag>
          <Tag color={B} bg={B05}>
            {checkoutMode ? "SANDBOX" : "ALL-IN PRICING"}
          </Tag>
        </div>
      </header>

      {/* Body: accepted Figma customer/mechanism split */}
      <div
        className={`onsale-shell-body${railIdle ? " rail-is-idle" : ""}`}
        style={{ flex: 1, display: 'grid', gridTemplateColumns: 'minmax(0,72fr) 1px minmax(0,28fr)', minHeight: 0,
        }}
      >
        <div
          className="onsale-buyer-pane"
          style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}
        >
          {/* Breadcrumb — always visible except on event screen */}
          {appState !== 'event' && (
            <BreadcrumbNav appState={appState} holdSeconds={holdSeconds} onHome={onHome} onBack={onBack}
              holdCommitted={holdCommitted}
            />
          )}
          <main className="dot-grid onsale-canvas"
            style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}
          >
            {children}
          </main>
          {buyerContext && (
            <div
              className="onsale-mobile-claim-context"
              data-state={buyerContext.state}
              data-testid="inventory-mobile-context"
              role="region"
              aria-label="Current inventory status"
            >
              <span className="onsale-mobile-claim-seats">
                {buyerContext.seats}
              </span>
              <span className="onsale-mobile-claim-amount">
                {buyerContext.amount}
              </span>
              <span className="onsale-mobile-claim-status">
                {buyerContext.status}
              </span>
              <span className="onsale-mobile-claim-tail">
                {buyerContext.tail}
              </span>
            </div>
          )}
        </div>
        {/* Divider */}
        <div
          className="onsale-divider"
          style={{ background: B, flexShrink: 0 }} />
        <aside
          id="mechanism-rail"
          tabIndex={-1}
          className="onsale-rail"
          style={{ overflowY: 'auto', overflowX: 'hidden', padding: '18px 14px', background: '#fafcff',
          }}
        >
          {rightPanel}
        </aside>
      </div>

    </div>
  )
}

function formatUsdMinor(amountMinor: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: amountMinor % 100 === 0 ? 0 : 2,
  }).format(amountMinor / 100)
}

function formatUsdMinorFixed(amountMinor: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100)
}

function formatCheckoutMinorFixed(
  amountMinor: number,
  currency: string,
): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100)
}

function formatEventDate(startsAt: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  })
    .format(new Date(startsAt))
    .replace(",", " ·")
}

// ─── STATE 1: Event ───────────────────────────────────────────────────────────
function EventScreen({
  onPresale,
  onGeneral,
  inventory,
  inventoryNotice,
  resumeCheckout,
}: {
  onPresale: () => void
  onGeneral: () => void
  inventory?: OnsaleInventorySnapshotV1
  inventoryNotice?: string | null
  resumeCheckout?: {
    readonly label: string
    readonly onResume: () => void
  }
}) {
  const inventoryNoticeRef = useRef<HTMLDivElement>(null)
  const runtimeEvent = inventory?.event
  const presale = runtimeEvent?.saleWindows.find(
    (window) => window.kind === "presale",
  )
  const general = runtimeEvent?.saleWindows.find(
    (window) => window.kind === "general",
  )
  const eventName = runtimeEvent?.name ?? EVENT.name
  const eventTour = runtimeEvent?.tourName ?? EVENT.tour
  const eventVenue = runtimeEvent?.venueName ?? EVENT.venue
  const eventCity = runtimeEvent?.cityLabel ?? EVENT.city
  const eventDate = runtimeEvent
    ? formatEventDate(runtimeEvent.startsAt, runtimeEvent.venueTimezone)
    : EVENT.date
  const eventHero = runtimeEvent?.heroAssetRef?.startsWith("figma:")
    ? EVENT.heroImg
    : (runtimeEvent?.heroAssetRef ?? EVENT.heroImg)
  const priceRange = runtimeEvent
    ? `${formatUsdMinor(runtimeEvent.allInPriceRange.minimumMinor)}–${formatUsdMinor(runtimeEvent.allInPriceRange.maximumMinor)}`
    : `$${EVENT.priceFrom}–$${EVENT.priceTo}`
  const priceFrom = runtimeEvent
    ? formatUsdMinor(runtimeEvent.allInPriceRange.minimumMinor)
    : `$${EVENT.priceFrom}`

  useEffect(() => {
    if (inventoryNotice) inventoryNoticeRef.current?.focus()
  }, [inventoryNotice])

  return (
    <div>
      {/* Hero */}
      <div
        className="event-hero"
        style={{
          position: "relative",
          height: 340,
          overflow: "hidden",
          background: DARK,
        }}
      >
        <img
          src={eventHero}
          alt="Performer under dramatic stage lighting"
          style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0.5,
          }}
        />
        {/* Gradient overlays */}
        <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(to right, ${DARK} 0%, rgba(6,8,15,0.7) 60%, transparent 100%)`,
          }} />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to top, rgba(6,8,15,0.95) 0%, transparent 60%)',
          }} />

        {/* Hero content */}
        <div className="event-hero-content" style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', padding: '32px 40px',
          }}
        >
          <div style={{ animation: 'slide-up 0.5s ease both' }}>
            <div style={{ fontFamily: MONO, fontSize: 10, color: B, letterSpacing: '0.2em', marginBottom: 8,
              }}
            >
              FICTIONAL EVENT · PROTOTYPE ONLY</div>
            <h1
              className="event-title"
              style={{ fontFamily: MONO, fontSize: 52, fontWeight: 600, color: '#fff', letterSpacing: '-0.02em', lineHeight: 1, marginBottom: 10,
              }}
            >
              {eventName}
            </h1>
            <div style={{ fontFamily: SANS, fontSize: 15, color: 'rgba(255,255,255,0.7)', marginBottom: 4,
              }}
            >
              {eventTour}
            </div>
            <div className="event-hero-meta" style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 12,
              }}
            >
              <span style={{ fontFamily: MONO, fontSize: 11, color: 'rgba(255,255,255,0.55)', letterSpacing: '0.06em',
                }}
              >
                {eventVenue} · {eventCity}
              </span>
              <span style={{ width: 3, height: 3, borderRadius: '50%', background: 'rgba(255,255,255,0.3)', flexShrink: 0,
                }} />
              <span style={{ fontFamily: MONO, fontSize: 11, color: 'rgba(255,255,255,0.55)', letterSpacing: '0.06em',
                }}
              >
                {eventDate}
              </span>
              <span style={{ width: 3, height: 3, borderRadius: '50%', background: 'rgba(255,255,255,0.3)', flexShrink: 0,
                }} />
              <span style={{ fontFamily: MONO, fontSize: 11, color: '#fff', letterSpacing: '0.06em',
                }}
              >
                From {priceFrom} all-in</span>
            </div>
          </div>
        </div>
      </div>

      {inventory && inventoryNotice && (
        <div
          ref={inventoryNoticeRef}
          role="status"
          aria-live="polite"
          tabIndex={-1}
          data-testid="inventory-event-notice"
          style={{
            borderBottom: `1px solid ${B20}`,
            background: B05,
            color: B,
            padding: "10px 40px",
            fontFamily: MONO,
            fontSize: 9,
            letterSpacing: "0.08em",
          }}
        >
          {inventoryNotice}
        </div>
      )}

      {resumeCheckout && (
        <div className="inventory-checkout-resume" data-testid="inventory-checkout-resume">
          <div>
            <span>YOUR ORDER IS SAVED</span>
            <strong>
              Payment and ticket state stay attached to this browser session.
            </strong>
          </div>
          <button type="button" onClick={resumeCheckout.onResume}>
            {resumeCheckout.label}
          </button>
        </div>
      )}

      {/* Sale window cards */}
      <div style={{ padding: '32px 40px', animation: 'slide-up 0.5s 0.1s ease both',
        }}
      >
        <div style={{ fontFamily: MONO, fontSize: 9, color: 'rgba(0,0,0,0.35)', letterSpacing: '0.14em', marginBottom: 20,
          }}
        >
          SALE WINDOWS</div>
        <div className="event-sale-window-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}
        >

          {/* Cardmember presale — active */}
          <div style={{ border: `1.5px solid ${B}`, background: '#fff', animation: 'slide-up 0.5s 0.15s both',
            }}
          >
            <div style={{ background: B, padding: '10px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}
            >
              <span style={{ fontFamily: MONO, fontSize: 9, color: '#fff', letterSpacing: '0.12em', fontWeight: 600,
                }}
              >
                CITI CARDMEMBER PRESALE</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <LiveDot color="#fff" />
                <span style={{ fontFamily: MONO, fontSize: 8, color: 'rgba(255,255,255,0.8)', letterSpacing: '0.08em',
                  }}
                >
                  {inventory ? "DEMO ACCESS" : "LIVE NOW"}
                </span>
              </div>
            </div>
            <div style={{ padding: '18px 18px 20px' }}>
              <div style={{ fontSize: 13, color: '#333', lineHeight: 1.6, marginBottom: 16,
                }}
              >
                {inventory
                  ? "Try the presentation presale with a demo access code. No card details are needed to browse seats."
                  : "Access this sale with an eligible Citi-issued payment card. Priority inventory allocation applies."}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 20,
                }}
              >
                {[
                  [
                    'Access',
                    inventory
                      ? "Demo code · CITI26"
                      : 'Eligible Citi card required',
                  ],
                  [
                    'Inventory',
                    inventory
                      ? "Assigned seating · limited"
                      : 'Priority allocation · limited',
                  ],
                  ['Price', `${priceRange} all-in`],
                  [
                    'Window',
                    inventory
                      ? "Open for demo"
                      : 'Open now · closes at 11:59 AM',
                  ],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #f0f0f0', padding: '4px 0',
                    }}
                  >
                    <span style={{ fontFamily: MONO, fontSize: 9, color: '#aaa', letterSpacing: '0.08em',
                      }}
                    >
                      {k}
                    </span>
                    <span style={{ fontFamily: MONO, fontSize: 9, color: '#333' }}
                    >
                      {v}
                    </span>
                  </div>
                ))}
              </div>
              <button onClick={onPresale} style={{
                width: '100%', background: B, color: '#fff', border: 'none',
                padding: '12px 0', fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em',
                cursor: 'pointer',
              }}
              >
                {inventory ? "ENTER DEMO PRESALE →" : "VERIFY ACCESS →"}
              </button>
            </div>
          </div>

          {/* General onsale — upcoming */}
          <div style={{ border: '1.5px solid #e8e8e8', background: '#fff', animation: 'slide-up 0.5s 0.2s both',
            }}
          >
            <div style={{ background: '#f5f5f5', padding: '10px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}
            >
              <span style={{ fontFamily: MONO, fontSize: 9, color: '#666', letterSpacing: '0.12em', fontWeight: 600,
                }}
              >
                GENERAL ONSALE</span>
              <span style={{ fontFamily: MONO, fontSize: 8, color: general?.canEnter ? B : '#999', letterSpacing: '0.08em',
                }}
              >
                {inventory
                  ? general?.canEnter
                    ? "OPEN NOW"
                    : (general?.state ?? "UNAVAILABLE").toUpperCase()
                  : "OPENS 12:00 PM"}
              </span>
            </div>
            <div style={{ padding: '18px 18px 20px' }}>
              <div style={{ fontSize: 13, color: '#666', lineHeight: 1.6, marginBottom: 16,
                }}
              >
                {inventory
                  ? "Open to everyone. Choose up to four assigned seats and see the all-in price before holding them."
                  : "Open to all buyers. No access code required. Standard queue and inventory policies apply."}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 20,
                }}
              >
                {[
                  [
                    'Access',
                    inventory
                      ? "Open to everyone"
                      : 'No requirement',
                  ],
                  [
                    'Inventory',
                    inventory
                      ? "60 assigned seats"
                      : 'Standard allocation',
                  ],
                  ['Price', `${priceRange} all-in`],
                  [
                    'Window',
                    inventory
                      ? general?.canEnter
                        ? "Open now"
                        : (general?.state ?? "unavailable")
                      : 'Opens 12:00 PM today',
                  ],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #f0f0f0', padding: '4px 0',
                    }}
                  >
                    <span style={{ fontFamily: MONO, fontSize: 9, color: '#aaa', letterSpacing: '0.08em',
                      }}
                    >
                      {k}
                    </span>
                    <span style={{ fontFamily: MONO, fontSize: 9, color: '#666' }}
                    >
                      {v}
                    </span>
                  </div>
                ))}
              </div>
              <button onClick={onGeneral}
                disabled={inventory ? !general?.canEnter : false}
                style={{
                width: '100%', background: inventory && general?.canEnter ? B : '#fff', color: inventory && general?.canEnter ? "#fff" : '#999', border:
                    inventory && general?.canEnter
                      ? `1.5px solid ${B}`
                      : '1.5px solid #ddd',
                padding: '12px 0', fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em',
                cursor:
                    inventory && !general?.canEnter ? "not-allowed" : 'pointer',
              }}
              >
                {inventory ? "VIEW LIVE SEATS →" : "JOIN QUEUE →"}
              </button>
            </div>
          </div>
        </div>

        {/* Additional event info */}
        <div className="event-info-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 1, marginTop: 24, border: '1px solid #eee',
          }}
        >
          {[
            { label: inventory ? "AVAILABLE INVENTORY" : 'VENUE CAPACITY', value: inventory
                ? "60 assigned seats · Section A"
                : '3,000 standing',
            },
            { label: 'TICKET LIMIT', value: '4 per order' },
            { label: 'ALL-IN PRICING', value: 'Fees included in display price',
            },
          ].map(({ label, value }) => (
            <div key={label} style={{ padding: '14px 18px', background: '#fafafa', borderRight: '1px solid #eee',
              }}
            >
              <Label>{label}</Label>
              <span style={{ fontFamily: SANS, fontSize: 12, color: '#333' }}>
                {value}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── STATE 2: Eligibility ─────────────────────────────────────────────────────
const DEMO_PRESALE_CODE = "CITI26"

function InventoryEligibilityScreen({
  onVerified,
  onGeneral,
}: {
  onVerified: () => void
  onGeneral: () => void
}) {
  const [code, setCode] = useState("")
  const [invalid, setInvalid] = useState(false)

  const verifyDemoCode = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (code.trim().toUpperCase() !== DEMO_PRESALE_CODE) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    onVerified()
  }

  return (
    <div
      style={{
        padding: "40px",
        maxWidth: 560,
        animation: "slide-up 0.4s ease both",
      }}
    >
      <div
        style={{
          fontFamily: MONO,
          fontSize: 9,
          color: B,
          letterSpacing: "0.14em",
          marginBottom: 8,
        }}
      >
        CITI CARDMEMBER PRESALE · DEMO ACCESS
      </div>
      <h2
        style={{
          fontSize: 26,
          fontWeight: 600,
          marginBottom: 6,
          letterSpacing: "-0.02em",
        }}
      >
        Enter the demo presale
      </h2>
      <p
        style={{
          fontSize: 13,
          color: "#555",
          lineHeight: 1.7,
          marginBottom: 24,
        }}
      >
        Use the presentation code to open this demo seat map. It uses the same
        assigned-seat inventory as the open sale and does not claim Citi bank
        eligibility.
      </p>
      <form onSubmit={verifyDemoCode} className="inventory-demo-access">
        <label htmlFor="demo-presale-code">ACCESS CODE</label>
        <div className="inventory-demo-access-row">
          <input
            id="demo-presale-code"
            autoComplete="off"
            value={code}
            placeholder={DEMO_PRESALE_CODE}
            onFocus={() => {
              if (code === "") setCode(DEMO_PRESALE_CODE)
            }}
            onChange={(event) => {
              setCode(event.target.value.toUpperCase())
              setInvalid(false)
            }}
            aria-describedby="demo-presale-help"
            aria-invalid={invalid}
          />
          <button type="submit">UNLOCK SEATS →</button>
        </div>
        <p id="demo-presale-help">
          Tab into the field to use the suggested demo code {DEMO_PRESALE_CODE}.
        </p>
        {invalid && <div role="alert">That demo code is not recognized.</div>}
      </form>
      <button
        onClick={onGeneral}
        style={{
          width: "100%",
          background: "#fff",
          color: B,
          border: `1.5px solid ${B}`,
          padding: "12px 0",
          fontFamily: MONO,
          fontSize: 10,
          letterSpacing: "0.1em",
          cursor: "pointer",
        }}
      >
        CONTINUE TO OPEN GENERAL SALE →
      </button>
    </div>
  )
}

// ─── Proscenium stage SVG ────────────────────────────────────────────────────
function StageProscenium() {
    const B = "#006DF9"
  const thin = 0.65
  const med = 1.05
  const hvy = 1.6

  const W = 520,
    H = 224
  const fx1 = 14,
    fy1 = 10,
    fx2 = 506,
    fy2 = 214

  // Valance swag cubic bezier paths
  const SWAG1 = "M14,10 C38,82 140,82 170,22"
  const SWAG2 = "M170,22 C202,86 318,86 350,22"
  const SWAG3 = "M350,22 C380,82 482,82 506,10"

  // Approximate y on swag curve via linear t ≈ (x-x0)/(x1-x0)
  function swagY(x: number): number {
    let t: number, p0y: number, p1y: number, p2y: number, p3y: number
    if (x <= 170) {
      t = (x - 14) / 156
      p0y = 10
      p1y = 82
      p2y = 82
      p3y = 22
    } else if (x <= 350) {
      t = (x - 170) / 180
      p0y = 22
      p1y = 86
      p2y = 86
      p3y = 22
    } else {
      t = (x - 350) / 156
      p0y = 22
      p1y = 82
      p2y = 82
      p3y = 10
    }
    const u = 1 - t
    return (
      u * u * u * p0y +
      3 * u * u * t * p1y +
      3 * u * t * t * p2y +
      t * t * t * p3y
    )
  }

  // Valance vertical pleat lines: from frame top to swag belly
  const valFolds: string[] = []
  for (let x = fx1 + 5; x <= fx2 - 5; x += 7) {
    valFolds.push(`M${x},${fy1 + 1} L${x},${swagY(x).toFixed(1)}`)
  }

  // Curtain geometry
  const CTOP = 74 // curtain top y (below valance belly)
  const LOPEN = 152,
    ROPEN = 368 // inner opening x at top
  const LTIE = [108, 152] as const
  const RTIE = [W - 108, 152] as const
  const LBOT = 147,
    RBOT = W - 147 // inner edge x at bottom

  // Left curtain fold lines — upper: (sx, CTOP) → tie-back
  const lUpXs = [
    18, 26, 34, 42, 50, 58, 67, 76, 85, 94, 103, 113, 123, 132, 141, 149, 153,
  ]
  const lUpFolds = lUpXs.map((sx) => {
    const c1x = (sx + (LTIE[0] - sx) * 0.22).toFixed(1)
    const c2x = (sx + (LTIE[0] - sx) * 0.8).toFixed(1)
    return `M${sx},${CTOP} C${c1x},${CTOP + 34} ${c2x},${LTIE[1] - 18} ${LTIE[0]},${LTIE[1]}`
  })

  // Left curtain fold lines — lower: tie-back → (ex, fy2)
  const lLoXs = [18, 28, 40, 52, 64, 76, 88, 98, 109, 119, 129, 139, 148]
  const lLoFolds = lLoXs.map((ex) => {
    const c1x = (LTIE[0] + (ex - LTIE[0]) * 0.22).toFixed(1)
    const c2x = (LTIE[0] + (ex - LTIE[0]) * 0.8).toFixed(1)
    return `M${LTIE[0]},${LTIE[1]} C${c1x},${LTIE[1] + 23} ${c2x},${fy2 - 22} ${ex},${fy2}`
  })

  // Right curtain — mirror of left
  const rUpFolds = lUpXs.map((sx) => {
    const rx = W - sx
    const c1x = (rx + (RTIE[0] - rx) * 0.22).toFixed(1)
    const c2x = (rx + (RTIE[0] - rx) * 0.8).toFixed(1)
    return `M${rx},${CTOP} C${c1x},${CTOP + 34} ${c2x},${RTIE[1] - 18} ${RTIE[0]},${RTIE[1]}`
  })
  const rLoFolds = lLoXs.map((ex) => {
    const re = W - ex
    const c1x = (RTIE[0] + (re - RTIE[0]) * 0.22).toFixed(1)
    const c2x = (RTIE[0] + (re - RTIE[0]) * 0.8).toFixed(1)
    return `M${RTIE[0]},${RTIE[1]} C${c1x},${RTIE[1] + 23} ${c2x},${fy2 - 22} ${re},${fy2}`
  })

  // Stage floor perspective lines from vanishing point
  const VPX = 260,
    VPY = 188
  const floorXs = [LOPEN, 170, 196, 222, 248, 260, 272, 298, 324, 350, ROPEN]
  const floorPaths = floorXs.map((x) => `M${VPX},${VPY} L${x},${fy2}`)

  // Curtain inner edge silhouette
  const lEdge = `M${LOPEN},${CTOP} C${LOPEN + 12},97 ${LTIE[0] + 18},140 ${LTIE[0]},${LTIE[1]} C${LTIE[0] - 5},169 ${LBOT - 7},191 ${LBOT},${fy2}`
  const rEdge = `M${ROPEN},${CTOP} C${ROPEN - 12},97 ${RTIE[0] - 18},140 ${RTIE[0]},${RTIE[1]} C${RTIE[0] + 5},169 ${RBOT + 7},191 ${RBOT},${fy2}`

  // Center mask shape (stage opening) to clip bleed from fold lines
  const centerMask = `M${LOPEN},${CTOP} C${LOPEN + 12},97 ${LTIE[0] + 18},140 ${LTIE[0]},${LTIE[1]} C${LTIE[0] - 5},169 ${LBOT - 7},191 ${LBOT},${fy2} L${RBOT},${fy2} C${RBOT + 7},191 ${RTIE[0] + 5},169 ${RTIE[0]},${RTIE[1]} C${RTIE[0] - 18},140 ${ROPEN - 12},97 ${ROPEN},${CTOP} Z`

  // Spotlight cones from top of opening
  const spotlights = [
    [LOPEN + 16, CTOP, 210, fy2],
    [LOPEN + 60, CTOP, 240, fy2],
    [260, CTOP - 2, 260, fy2],
    [ROPEN - 60, CTOP, 280, fy2],
    [ROPEN - 16, CTOP, 310, fy2],
  ]

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
      <rect width={W} height={H} fill="#fff" />

      {/* ── Valance pleat lines ── */}
      {valFolds.map((d, i) => (
        <path key={`v${i}`} d={d} stroke={B} strokeWidth={thin} fill="none"
          opacity="0.7"
        />
      ))}
      {/* ── Curtain fold lines ── */}
      {lUpFolds.map((d, i) => (
        <path key={`lu${i}`} d={d} stroke={B} strokeWidth={thin} fill="none" />
      ))}

      {lLoFolds.map((d, i) => (
        <path key={`ll${i}`} d={d} stroke={B} strokeWidth={thin} fill="none" />
      ))}
      {rUpFolds.map((d, i) => (
        <path key={`ru${i}`} d={d} stroke={B} strokeWidth={thin} fill="none" />
      ))}
      {rLoFolds.map((d, i) => (
        <path key={`rl${i}`} d={d} stroke={B} strokeWidth={thin} fill="none" />
      ))}

      {/* ── White mask for stage opening ── */}
      <path d={centerMask} fill="#fff" stroke="none" />

      {/* ── Spotlight cones ── */}
      {spotlights.map(([x1, y1, x2, y2], i) => (
        <line
          key={`sp${i}`}
          x1={x1}
          y1={y1}
          x2={x2} y2={y2}
          stroke={B} strokeWidth={0.55} fill="none" opacity="0.18"
        />
      ))}

      {/* ── Stage floor perspective ── */}
      <line x1={LOPEN} y1={VPY} x2={ROPEN} y2={VPY} stroke={B} strokeWidth={thin} opacity="0.4"
      />
      {floorPaths.map((d, i) => (
        <path key={`f${i}`} d={d} stroke={B} strokeWidth={thin} fill="none" opacity="0.35"
        />
      ))}
      {/* Stage apron */}
      <line x1={LBOT - 2} y1={fy2} x2={RBOT + 2} y2={fy2} stroke={B} strokeWidth={thin} opacity="0.6"
      />

      {/* ── Centre labels ── */}
      <text x="260" y="146" textAnchor="middle"
        fontFamily="'JetBrains Mono',monospace" fontSize="28" fontWeight="700"
        fill={B} letterSpacing="6" opacity="0.07"
      >
        STAGE</text>
      <text x="260" y="118" textAnchor="middle"
        fontFamily="'JetBrains Mono',monospace" fontSize="9"
        fill={B} letterSpacing="4" opacity="0.35"
      >
        {EVENT.name}
      </text>
      <text x="260" y="132" textAnchor="middle"
        fontFamily="'JetBrains Mono',monospace" fontSize="7"
        fill={B} letterSpacing="3" opacity="0.22"
      >
        {EVENT.venue.toUpperCase()} · {EVENT.city.toUpperCase()}
      </text>

      {/* ── Swag silhouettes (drawn after fold lines) ── */}
      <path d={SWAG1} stroke={B} strokeWidth={med} fill="none" />
      <path d={SWAG2} stroke={B} strokeWidth={med} fill="none" />
      <path d={SWAG3} stroke={B} strokeWidth={med} fill="none" />

      {/* Valance top edge */}
      <line x1={fx1} y1={fy1 + 1} x2={fx2} y2={fy1 + 1} stroke={B} strokeWidth={thin} opacity="0.5"
      />

      {/* ── Curtain inner edge silhouettes ── */}
      <path d={lEdge} stroke={B} strokeWidth={med} fill="none" />
      <path d={rEdge} stroke={B} strokeWidth={med} fill="none" />

      {/* ── Tie-back knots ── */}
      <circle cx={LTIE[0]} cy={LTIE[1]} r={5.5} fill="#fff" stroke={B} strokeWidth={med}
      />
      <circle cx={RTIE[0]} cy={RTIE[1]} r={5.5} fill="#fff" stroke={B} strokeWidth={med}
      />
      {/* inner dot */}
      <circle cx={LTIE[0]} cy={LTIE[1]} r={2} fill={B} />
      <circle cx={RTIE[0]} cy={RTIE[1]} r={2} fill={B} />

      {/* ── Proscenium frame (last, cleans all edges) ── */}
      <rect x={fx1} y={fy1} width={fx2 - fx1} height={fy2 - fy1}
        fill="none" stroke={B} strokeWidth={hvy}
      />
    </svg>
  )
}

// ─── STATE 3: Hold (seat selection) ──────────────────────────────────────────
function sameSeatSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false
  const a = [...left].sort()
  const b = [...right].sort()

  return a.every((value, index) => value === b[index])
}

function InventoryHoldScreen({
  snapshot,
  quote,
  draftSeatRefs,
  requestState,
  failureMessage,
  checkoutRequestState,
  checkoutFailureMessage,
  holdSeconds,
  onToggle,
  onClaim,
  onCheckout,
  onRetryQuote,
  onReset,
  onRelease,
}: {
  snapshot: OnsaleInventorySnapshotV1
  quote: QuoteSeatsResponseV1 | null
  draftSeatRefs: readonly PublicRef[]
  requestState: InventoryRequestStateV1
  failureMessage: string | null
  checkoutRequestState: CheckoutClientRequestStateV1
  checkoutFailureMessage: string | null
  holdSeconds: number
  onToggle: (seatRef: PublicRef) => void
  onClaim: () => void
  onCheckout: () => void
  onRetryQuote: () => void
  onReset: () => void
  onRelease: () => void
}) {
  const currentHold = snapshot.currentHold
  const committedSeatRefs = currentHold?.items.map((item) => item.seatRef) ?? []
  const selectedSeatRefs = currentHold ? committedSeatRefs : draftSeatRefs
  const selected = new Set<string>(selectedSeatRefs)
  const generalWindowRef = snapshot.event.saleWindows.find(
    (window) => window.kind === "general",
  )?.publicRef
  const quoteMatchesDraft = Boolean(
    quote &&
      quote.basisRevision === snapshot.revision &&
      quote.saleWindowRef === generalWindowRef &&
      sameSeatSet(quote.seatRefs, draftSeatRefs),
  )
  const displayItems =
    currentHold?.items ?? (quoteMatchesDraft ? quote?.items : undefined) ?? []
  const totals =
    currentHold?.totals ?? (quoteMatchesDraft ? quote?.totals : undefined)
  const busy = ["quoting", "claiming", "releasing", "expiring"].includes(
    requestState,
  )
  const checkoutBusy = ["preparing", "reconciling", "confirming"].includes(
    checkoutRequestState,
  )
  const quoteRetryAvailable =
    !currentHold &&
    draftSeatRefs.length > 0 &&
    requestState === "blocked"
  const visibleFailureMessage = failureMessage ?? checkoutFailureMessage
  const holdActive = currentHold?.state === "active"
  const holdExpired = currentHold?.state === "expired_pending_reconcile"
  const pct = holdActive
    ? Math.max(0, Math.min(100, Math.round((holdSeconds / 600) * 100)))
    : 0
  const timerRed = holdSeconds < 120
  const min = String(Math.floor(holdSeconds / 60)).padStart(2, "0")
  const sec = String(holdSeconds % 60).padStart(2, "0")
  const headingRef = useRef<HTMLHeadingElement>(null)
  const statusRef = useRef<HTMLSpanElement>(null)
  const seatGridRef = useRef<HTMLDivElement>(null)
  const previousHoldRef = useRef<string | null | undefined>(undefined)
  const [activeSeatRef, setActiveSeatRef] = useState<PublicRef | null>(null)
  const selectionLocked = ["claiming", "releasing", "expiring"].includes(
    requestState,
  )
  const focusableSeatRefs = snapshot.seatMap.rows.flatMap((row) =>
    row.seats
      .filter((seat) => {
        const isSelected = selected.has(seat.publicRef)
        const atSelectionLimit =
          !isSelected && draftSeatRefs.length >= 4
        return (
          !currentHold &&
          !selectionLocked &&
          seat.selectable &&
          !atSelectionLimit
        )
      })
      .map((seat) => seat.publicRef),
  )
  const focusableSeatKey = focusableSeatRefs.join("|")

  useEffect(() => {
    setActiveSeatRef((previous) =>
      previous && focusableSeatRefs.includes(previous)
        ? previous
        : (focusableSeatRefs[0] ?? null),
    )
  }, [focusableSeatKey])

  useEffect(() => {
    const nextHoldRef = currentHold?.publicRef ?? null
    if (previousHoldRef.current === nextHoldRef) return
    previousHoldRef.current = nextHoldRef
    if (nextHoldRef) statusRef.current?.focus()
    else headingRef.current?.focus()
  }, [currentHold?.publicRef])

  const focusSeatAt = (rowIndex: number, seatIndex: number): boolean => {
    const seat = snapshot.seatMap.rows[rowIndex]?.seats[seatIndex]
    if (!seat || !focusableSeatRefs.includes(seat.publicRef)) return false
    const button = seatGridRef.current?.querySelector<HTMLButtonElement>(
      `[data-seat-row="${rowIndex}"][data-seat-col="${seatIndex}"]`,
    )
    if (!button || button.disabled) return false
    setActiveSeatRef(seat.publicRef)
    button.focus()
    return true
  }

  const moveSeatFocus = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    rowIndex: number,
    seatIndex: number,
  ) => {
    const rowCount = snapshot.seatMap.rows.length
    const columnCount = snapshot.seatMap.rows[rowIndex]?.seats.length ?? 0
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault()
      const start = event.key === "Home" ? 0 : columnCount - 1
      const step = event.key === "Home" ? 1 : -1
      for (
        let column = start;
        column >= 0 && column < columnCount;
        column += step
      ) {
        if (focusSeatAt(rowIndex, column)) return
      }
      return
    }

    const delta =
      event.key === "ArrowLeft"
        ? [0, -1]
        : event.key === "ArrowRight"
          ? [0, 1]
          : event.key === "ArrowUp"
            ? [-1, 0]
            : event.key === "ArrowDown"
              ? [1, 0]
              : null
    if (!delta) return
    event.preventDefault()
    let row = rowIndex + delta[0]
    let column = seatIndex + delta[1]
    while (
      row >= 0 &&
      row < rowCount &&
      column >= 0 &&
      column < (snapshot.seatMap.rows[row]?.seats.length ?? 0)
    ) {
      if (focusSeatAt(row, column)) return
      row += delta[0]
      column += delta[1]
    }
  }

  return (
    <div
      className="inventory-hold-screen"
      data-testid="inventory-hold-screen"
      style={{ padding: "28px 40px", animation: "slide-up 0.4s ease both" }}
    >
                <div style={{ marginBottom: 28 }}>
        <div style={{ display: 'flex',
            justifyContent: "space-between",
            marginBottom: 6,
          }}
        >
              <span
            ref={statusRef}
            role="status"
            aria-live="polite"
            tabIndex={-1}
            data-testid="inventory-hold-status"
            style={{
              fontFamily: MONO,
              fontSize: 9,
              color: holdActive
                ? timerRed
                  ? RED
                  : AMBER
                : holdExpired
                  ? RED
                  : B,
              letterSpacing: "0.1em",
            }}
          >
            {holdActive
              ? "INVENTORY HOLD ACTIVE"
              : holdExpired
                ? "CHECKING EXPIRED HOLD"
                : "SELECT UP TO 4 SEATS"}
          </span>
          <span
            style={{
              fontFamily: MONO,
              fontSize: 10, color: holdActive ? (timerRed ? RED : AMBER) : "#999", letterSpacing: '0.06em',
            }}
          >
            {holdActive
              ? `${min}:${sec} remaining`
              : holdExpired
                ? "database reconciliation required"
                : `${draftSeatRefs.length} of 4 selected`}
          </span>
        </div>

            <div style={{
            height: 3,
            background: "#eee",
            position: "relative",
            overflow: "hidden",
          }}
        >
              <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              background: holdActive ? (timerRed ? RED : AMBER) : B,
              width: "100%",
              transformOrigin: "left center",
              transform: `scaleX(${(holdActive ? pct : draftSeatRefs.length * 25) / 100})`,
              transition: "transform 1s linear, background 0.5s",
            }}
          />
        </div>
      </div>

      <div
        className="inventory-hold-layout"
        style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 40 }}
      >
                  <div>
          <h2
            ref={headingRef}
            tabIndex={-1}
            data-testid="inventory-seat-heading"
            style={{
              fontSize: 20,
              fontWeight: 600, marginBottom: 4, letterSpacing: "-0.01em",
            }}
          >
            Choose your seats
          </h2>
                  <p style={{ fontSize: 13, color: "#666", marginBottom: 24 }}>
                    {snapshot.event.venueName} · {snapshot.event.cityLabel} · up to 4
            per order
          </p>

          <div style={{ marginBottom: 20 }}>
                <StageProscenium />
            <div
              style={{
                fontFamily: MONO, fontSize: 8,
                color: "rgba(0,109,249,0.45)",
                letterSpacing: "0.14em",
                marginTop: 6,
                textAlign: "center",
              }}
            >
              {snapshot.seatMap.sectionLabel.toUpperCase()} · ASSIGNED SEATING
            </div>
            <div
              id="inventory-seat-grid-help"
              style={{
                fontFamily: MONO,
                fontSize: 7.5,
                color: "rgba(0,109,249,0.48)",
                letterSpacing: "0.08em",
                marginTop: 5,
                textAlign: "center",
              }}
            >
              TAB INTO MAP · ARROW KEYS MOVE · SPACE SELECTS
            </div>
          </div>
              <div
            ref={seatGridRef}
            data-testid="inventory-seat-grid"
            role="group"
            aria-label="Assigned seat map"
            aria-describedby="inventory-seat-grid-help"
            style={{
              display: 'flex',
              flexDirection: "column",
              gap: 8, alignItems: "center",
            }}
          >
                {snapshot.seatMap.rows.map((row, rowIndex) => (
              <div
                className="inventory-seat-row"
                key={row.label}
                style={{ display: "flex", gap: 6, alignItems: "center" }}
              >
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 9,
                    color: "#bbb",
                    width: 14,
                    textAlign: "right",
                    letterSpacing: "0.06em",
                  }}
                >
                  {row.label}
                </span>
                {row.seats.map((seat) => {
                  const isSelected = selected.has(seat.publicRef)
                  const atSelectionLimit =
                    !isSelected && draftSeatRefs.length >= 4
                  const selectable =
                    !currentHold &&
                    !selectionLocked &&
                    seat.selectable &&
                    !atSelectionLimit
                  const unavailable = !seat.selectable && !isSelected
                  const statusLabel = isSelected
                    ? holdActive
                      ? "held by this session"
                      : "selected, not held"
                    : atSelectionLimit && seat.selectable
                      ? "available, 4-seat selection limit reached"
                      : seat.availability === "available" &&
                          seat.lifecycle === "sellable"
                        ? "available"
                        : seat.lifecycle === "blocked"
                          ? "blocked"
                          : seat.availability.replace(/_/g, " ")
                  return (
                    <button
                      key={seat.publicRef}
                      type="button"
                      disabled={!selectable}
                      onClick={() => onToggle(seat.publicRef)}
                      title={`${row.label}${seat.seatOrdinal}`}
                      aria-label={`${snapshot.seatMap.sectionLabel}, row ${row.label}, seat ${seat.seatOrdinal}, ${statusLabel}, ${formatUsdMinor(seat.price.totalMinor)} all-in`}
                      aria-pressed={isSelected}
                      tabIndex={
                        selectable && activeSeatRef === seat.publicRef ? 0 : -1
                      }
                      onFocus={() => setActiveSeatRef(seat.publicRef)}
                      onKeyDown={(event) =>
                        moveSeatFocus(event, rowIndex, seat.seatOrdinal - 1)
                      }
                      className={selectable ? "seat-btn" : ""}
                      data-inventory-seat
                      data-seat-ref={seat.publicRef}
                      data-seat-row={rowIndex}
                      data-seat-col={seat.seatOrdinal - 1}
                      data-seat-state={statusLabel} style={{
                        width: 34,
                        height: 28,
            border: `1.5px solid ${
                          unavailable ? "#e5e5e5" : isSelected ? B : "#ccc"
                        }`,
                        background: unavailable
                          ? "#f5f5f5"
                          : isSelected
                            ? B
                            : "#fff", cursor: selectable ? 'pointer' : "not-allowed", transition: "all 0.1s",
                        position: "relative",
                        transform: `perspective(80px) rotateX(${rowIndex * 1.5}deg)`,
          }}
                    >
                      {isSelected && (
                        <span
                          style={{
                            fontFamily: MONO,
                            fontSize: 7,
                            color: "#fff",
                            position: "absolute",
                            top: "50%",
                            left: "50%",
                            transform: "translate(-50%,-50%)",
                          }}
                        >
                          ✓
                        </span>
                      )}
                    </button>
                  )
                })}
        </div>
            ))}
          </div>
          <div style={{
              display: "flex",
              gap: 20,
              marginTop: 16,
              justifyContent: "center",
            }}
          >
            {([
              ["Available", "#fff", "#ccc"],
              ["Selected / held", B, B],
              ["Unavailable", "#f5f5f5", "#e5e5e5"],
            ] as const).map(([label, background, border]) => (
              <div
                key={label}
                style={{ display: 'flex', alignItems: "center", gap: 6 }}
              >
              <div
                  style={{
                    width: 14,
                    height: 12,
                    background,
                    border: `1.5px solid ${border}`,
                  }}
                />
              <span style={{ fontFamily: MONO, fontSize: 9, color: "#888",
                    letterSpacing: "0.06em",
                  }}
                >
                  {label}
                </span>
            </div>
            ))}
          </div>
        </div>

        <div className="inventory-summary">
          <div style={{ border: `1px solid ${B20}`, marginBottom: 16 }}>
              <div
              style={{
                padding: "11px 14px", borderBottom: `1px solid ${B10}`, fontFamily: MONO, fontSize: 9,
                color: B,
                letterSpacing: "0.12em",
              }}
            >
                  {currentHold ? "HELD SEATS" : "SEAT SUMMARY"}
            </div>
            <div style={{ padding: 14 }}>
              {selectedSeatRefs.length === 0 && (
                <p style={{ fontFamily: MONO, fontSize: 9, color: "#ccc" }}>
                  no seats selected
                </p>
              )}
              {selectedSeatRefs.length > 0 && displayItems.length === 0 && (
                <p style={{ fontFamily: MONO, fontSize: 9, color: AMBER }}>
                {requestState === "quoting"
                    ? "pricing selected seats…"
                    : "waiting for server quote"}
                </p>
              )}
              {displayItems.map((item) => (
                <div
                  key={item.seatRef}
                  style={{ display: 'flex', justifyContent: 'space-between', padding: "5px 0", borderBottom: '1px solid #f5f5f5',
                  }}
                >
                  <span style={{ fontFamily: MONO, fontSize: 10 }}>
                {item.sectionLabel} · {item.rowLabel}
                    {item.seatLabel}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 10 }}>
                    {formatUsdMinor(item.price.totalMinor)}
                  </span>
              </div>
              ))}
              {totals && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: "4px 0",
                      borderBottom: "1px solid #f5f5f5", marginTop: 4,
                    }}
                  >
                <span style={{ fontFamily: MONO, fontSize: 9, color: "#888" }}
                    >
                      Face value
                    </span>
                <span style={{ fontFamily: MONO, fontSize: 9, color: "#888" }}
                    >
                      {formatUsdMinor(totals.faceValueMinor)}
                    </span>
          </div>

          <div style={{
                      display: "flex",
                      justifyContent: "space-between",
                      padding: "4px 0",
                      borderBottom: "1px solid #f5f5f5",
                    }}
                  >
            <span
                      style={{ fontFamily: MONO, fontSize: 9, color: "#888" }}
                    >
                      Service fee
                    </span>
                    <span
                      style={{ fontFamily: MONO, fontSize: 9, color: "#888" }}
                    >
                      {formatUsdMinor(totals.feeMinor)}
                    </span>
                  </div>
                  <div
                    style={{
                      display: 'flex', justifyContent: 'space-between',
                      padding: "4px 0",
                      borderBottom: "1px solid #f5f5f5",
                    }}
                  >
              <span
                      style={{ fontFamily: MONO, fontSize: 9, color: "#888" }}
                    >
                      Tax
                    </span>
              <span style={{ fontFamily: MONO, fontSize: 9, color: "#888" }}
                    >
                      {formatUsdMinor(totals.taxMinor)}
                    </span>
            </div>
            <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between", padding: "10px 0 2px",
                      borderTop: `1px solid ${B20}`,
                      marginTop: 8,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: MONO, fontSize: 11,
                        fontWeight: 600,
                      }}
                    >
                      ALL-IN TOTAL
                    </span>
                    <span style={{ fontFamily: MONO, fontSize: 13, color: B }}>
{formatUsdMinor(totals.totalMinor)}
            </span>
          </div>
        </>
              )}
            </div>
    </div>

          <div
            style={{
              padding: "10px 12px",
              border: `1px solid ${B10}`,
      background: B05,
              marginBottom: 14,
    }}
          >
      <div style={{
                fontFamily: MONO,
                fontSize: 8,
                color: B,
                letterSpacing: "0.1em",
                marginBottom: 4,
              }}
            >
              SERVER-PRICED · ATOMIC INVENTORY
            </div>
            <p
              style={{ fontFamily: MONO, fontSize: 8.5, color: "#555",
                lineHeight: 1.7,
              }}
            >
              {currentHold
                ? "These seats and all-in amounts are immutable allocation snapshots from the committed hold."
                : "Selection is local until the merchant server prices and commits the entire seat bundle. No partial hold is shown."}
            </p>
        </div>

        {visibleFailureMessage && (
            <div
              role="status"
              data-testid="inventory-failure-status"
              style={{ padding: "9px 11px",
                border: `1px solid ${RED}40`,
                background: "rgba(239,68,68,0.04)",
                color: RED,
                fontFamily: MONO, fontSize: 8.5,
                lineHeight: 1.6, marginBottom: 10,
              }}
            >
              {visibleFailureMessage}
            </div>
          )}

          <button
            type="button"
            onClick={
              quoteRetryAvailable
                ? onRetryQuote
                : currentHold
                  ? onCheckout
                  : onClaim
            }
            disabled={
              !quoteRetryAvailable &&
              (holdExpired ||
                busy ||
                checkoutBusy ||
                (currentHold
                  ? !holdActive || holdSeconds <= 0
                  : !quoteMatchesDraft))
            }
            style={{
              width: "100%",
              background:
                (quoteRetryAvailable ||
                  (currentHold && holdActive && holdSeconds > 0) ||
                  (!currentHold && quoteMatchesDraft)) &&
                !busy &&
                !checkoutBusy
                  ? B
                  : "#e0e0e0",
              color:
                (quoteRetryAvailable ||
                  (currentHold && holdActive && holdSeconds > 0) ||
                  (!currentHold && quoteMatchesDraft)) &&
                !busy &&
                !checkoutBusy
                  ? "#fff"
                  : "#999",
              border: "none",
              padding: "13px 0",
              fontFamily: MONO, fontSize: 10,
              letterSpacing: "0.1em",
              cursor:
                (quoteRetryAvailable ||
                  (currentHold && holdActive && holdSeconds > 0) ||
                  (!currentHold && quoteMatchesDraft)) &&
                !busy &&
                !checkoutBusy
                  ? "pointer"
                  : "not-allowed",
              transition: "all 0.15s", marginBottom: 10,
            }}
          >
            {quoteRetryAvailable
              ? "RETRY PRICE CHECK →"
              : holdExpired
              ? "RECONCILING EXPIRED HOLD…"
              : checkoutRequestState === "preparing"
                ? "OPENING SECURE CHECKOUT…"
              : holdActive
                ? "CONTINUE TO SECURE CHECKOUT →"
                : requestState === "claiming"
                  ? "COMMITTING COMPLETE HOLD…"
                  : quoteMatchesDraft && quote
                    ? `HOLD ${draftSeatRefs.length} SEAT${
                        draftSeatRefs.length === 1 ? "" : "S"
                      } — ${formatUsdMinor(quote.totals.totalMinor)} →`
                    : draftSeatRefs.length > 0
                      ? "WAITING FOR SERVER QUOTE"
                      : "SELECT SEATS FIRST"}
          </button>
            <button
            type="button"
            onClick={currentHold ? onRelease : onReset}
            disabled={busy || checkoutBusy || (!currentHold && draftSeatRefs.length === 0)}
              style={{ width: '100%',
              background: "transparent",
              color: "#888",
              border: "1px solid #e5e5e5", padding: "10px 0", fontFamily: MONO, fontSize: 9, letterSpacing: "0.08em",
              cursor:
                busy || checkoutBusy || (!currentHold && draftSeatRefs.length === 0)
                  ? "not-allowed"
                  : "pointer",
            }}
          >
            {requestState === "releasing"
              ? "RELEASING COMPLETE HOLD…"
              : currentHold
                ? "RELEASE HOLD"
                : "RESET SELECTION"}
          </button>
          </div>

          </div>
    </div>
  )
}

// ─── STATE 4: Checkout ────────────────────────────────────────────────────────
function checkoutStagePresentation(snapshot: CheckoutPrivateSuccessV1): {
  readonly kicker: string
  readonly title: string
  readonly body: string
  readonly terminal: boolean
} {
  switch (snapshot.stage) {
    case "checkout_ready":
      return {
        kicker: "SECURE CHECKOUT READY",
        title: "Secure checkout",
        body: "Choose a payment method in the official Hyperswitch fields. ONSALE never receives card or wallet credentials.",
        terminal: false,
      }
    case "checking_same_payment":
      return {
        kicker: "CHECKING PAYMENT",
        title: "One moment — we’re checking your payment",
        body: "Keep this page open. We will not submit a second payment while this check is running.",
        terminal: false,
      }
    case "action_required":
      return {
        kicker: "SECURE APPROVAL REQUIRED",
        title: "Complete the secure approval",
        body: "Your payment provider may open its own approval page. When it returns, this order resumes automatically.",
        terminal: false,
      }
    case "processing":
      return {
        kicker: "PAYMENT PROCESSING",
        title: "Your payment is processing",
        body: "We’re confirming the result before showing your tickets. Please do not submit again.",
        terminal: false,
      }
    case "declined":
      return {
        kicker: "PAYMENT NOT COMPLETED",
        title: "Payment was not completed.",
        body: "No ticket was issued. Check this payment once more or use a new demo session after the order is resolved.",
        terminal: true,
      }
    case "recoverable_failure":
      return {
        kicker: "CHECKOUT NEEDS ATTENTION",
        title: "This checkout needs resolution.",
        body: "We did not retry your payment. Use the status check to look up this same payment.",
        terminal: true,
      }
    case "fulfilled":
      return {
        kicker: "YOU’RE IN",
        title: "Your tickets are ready.",
        body: `${snapshot.order.ticketCount} ticket${snapshot.order.ticketCount === 1 ? "" : "s"} confirmed for PHANTOM CIRCUIT.`,
        terminal: true,
      }
    case "expired":
      return {
        kicker: "CHECKOUT TIME EXPIRED",
        title: "Checkout time expired.",
        body: "Payment is disabled. You can still check the status of this same order.",
        terminal: true,
      }
    case "review_required":
      return {
        kicker: "ORDER REVIEW REQUIRED",
        title: "We need to review this order.",
        body: "Payment is blocked until the order status can be confirmed safely.",
        terminal: true,
      }
  }
}

function ProductionTicketWallet({
  snapshot,
  event,
  onStartOver,
  recordedRunRef,
}: {
  snapshot: CheckoutPrivateSuccessV1
  event: OnsaleInventorySnapshotV1["event"] | null
  onStartOver: () => void
  recordedRunRef: RecordedRunRefV1 | null
}) {
  const eventName = event?.name ?? EVENT.name
  const venue = event?.venueName ?? EVENT.venue
  const eventDate = event
    ? formatEventDate(event.startsAt, event.venueTimezone)
    : EVENT.date
  return (
    <div className="production-ticket-wallet">
      <header className="production-ticket-wallet-header">
        <span>{eventName} · {venue}</span>
        <strong>{eventDate}</strong>
        <p>
          {snapshot.order.ticketCount} of {snapshot.order.itemCount} tickets issued
        </p>
      </header>
      <div className="production-ticket-list">
        {snapshot.order.items.map((item, index) => (
          <article
            className="production-ticket-pass"
            key={`${item.sectionLabel}:${item.rowLabel}:${item.seatLabel}`}
          >
            <div className="production-ticket-copy">
              <span>
                TICKET {String(index + 1).padStart(2, "0")} OF {String(snapshot.order.itemCount).padStart(2, "0")}
              </span>
              <strong>{item.sectionLabel}</strong>
              <p>ROW {item.rowLabel} · SEAT {item.seatLabel}</p>
              <small>
                {formatCheckoutMinorFixed(item.totalMinor, item.currency)} all-in
              </small>
            </div>
            <div
              className="production-ticket-qr"
              aria-label={`Presentation QR placeholder for row ${item.rowLabel}, seat ${item.seatLabel}`}
            >
              <QRCode />
              <span>DEMO PASS · {item.rowLabel}{item.seatLabel}</span>
            </div>
          </article>
        ))}
      </div>
      <p className="production-ticket-disclaimer">
        Presentation ticket visuals only · not valid for venue entry. Durable
        issuance is proven by the ticket count; no entry credential is exposed
        by this prototype.
      </p>
      <div className="production-ticket-actions">
        <button type="button" className="btn-outline-blue" onClick={onStartOver}>
          BUY ANOTHER TICKET →
        </button>
        <button
          type="button"
          className="btn-outline-blue"
          onClick={() => window.print()}
        >
          PRINT / SAVE SUMMARY
        </button>
        <a
          href={
            recordedRunRef
              ? `/flows?run=${encodeURIComponent(recordedRunRef)}`
              : "/flows?story=confirmed-payment"
          }
        >
          {recordedRunRef
            ? "OPEN THIS RECORDED PAYMENT"
            : "EXPLORE A CONFIRMED-PAYMENT STORY"}
        </a>
      </div>
    </div>
  )
}

function ProductionCheckoutScreen({
  snapshot,
  event,
  mountRevision,
  requestState,
  failureMessage,
  canSubmit,
  widget,
  onReadiness,
  onConfirm,
  onReconcile,
  onStartOver,
  navigationNotice,
  recordedRunRef,
}: {
  snapshot: CheckoutPrivateSuccessV1
  event: OnsaleInventorySnapshotV1["event"] | null
  mountRevision: number
  requestState: CheckoutClientRequestStateV1
  failureMessage: string | null
  canSubmit: boolean
  widget: CheckoutWidgetReadinessV1
  onReadiness: (
    mountRevision: number,
    value: CheckoutWidgetReadinessV1,
  ) => void
  onConfirm: (
    mountRevision: number,
    confirm: () => Promise<unknown>,
  ) => Promise<boolean>
  onReconcile: () => void
  onStartOver: () => void
  navigationNotice: string | null
  recordedRunRef: RecordedRunRefV1 | null
}) {
  const presentation = checkoutStagePresentation(snapshot)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const terminalHeadingRef = useRef<HTMLHeadingElement>(null)
  const statusRef = useRef<HTMLDivElement>(null)
  const previousFocusState = useRef<string | null>(null)
  const handleReadiness = useCallback(
    (value: CheckoutWidgetReadinessV1) =>
      onReadiness(mountRevision, value),
    [mountRevision, onReadiness],
  )
  const handleConfirm = useCallback(
    (confirm: () => Promise<unknown>) =>
      onConfirm(mountRevision, confirm),
    [mountRevision, onConfirm],
  )

  useEffect(() => {
    const focusState = `${snapshot.stage}:${snapshot.payment.evidenceRevision}`
    if (previousFocusState.current === focusState) return
    if (presentation.terminal) terminalHeadingRef.current?.focus()
    else if (
      previousFocusState.current === null &&
      snapshot.stage === "checkout_ready"
    )
      headingRef.current?.focus()
    else statusRef.current?.focus()
    previousFocusState.current = focusState
  }, [presentation.terminal, snapshot.payment.evidenceRevision, snapshot.stage])

  return (
    <div className="production-checkout-screen" data-checkout-stage={snapshot.stage}>
      <div
        ref={statusRef}
        className="production-checkout-status"
        role="status"
        aria-live="polite"
        tabIndex={-1}
      >
        <span>{presentation.kicker}</span>
        <span>{snapshot.message}</span>
      </div>
      {presentation.terminal ? (
        <h1 ref={terminalHeadingRef} tabIndex={-1} className="production-checkout-heading terminal">
          {presentation.title}
        </h1>
      ) : (
        <h2 ref={headingRef} tabIndex={-1} className="production-checkout-heading">
          {presentation.title}
        </h2>
      )}
      <p className="production-checkout-intro">{presentation.body}</p>
      {navigationNotice && (
        <div className="production-checkout-guidance" role="status">
          {navigationNotice}
        </div>
      )}

      <div className="production-checkout-layout">
        <div>
          <Label>{snapshot.stage === "fulfilled" ? "YOUR TICKETS" : "SECURE PAYMENT"}</Label>
          <div className="production-checkout-provider">
            <div className="production-checkout-provider-header">
              <LiveDot color={snapshot.stage === "fulfilled" ? GREEN : B} />
              <span>{snapshot.stage === "fulfilled" ? "ONSALE · TICKET WALLET" : "hyperswitch · unified checkout"}</span>
              <Tag>{snapshot.stage === "checkout_ready" ? "OFFICIAL" : snapshot.stage === "fulfilled" ? "CONFIRMED" : "STATUS"}</Tag>
            </div>
            {snapshot.stage === "fulfilled" ? (
              <ProductionTicketWallet
                snapshot={snapshot}
                event={event}
                onStartOver={onStartOver}
                recordedRunRef={recordedRunRef}
              />
            ) : snapshot.checkout ? (
              <HyperswitchCheckoutClient
                key={mountRevision}
                grant={snapshot.checkout}
                amountLabel={formatCheckoutMinorFixed(
                  snapshot.order.totalMinor,
                  snapshot.order.currency,
                )}
                canSubmit={canSubmit}
                submitting={
                  requestState === "confirming" ||
                  requestState === "reconciling"
                }
                onReadiness={handleReadiness}
                onConfirm={handleConfirm}
                onRetry={() => window.location.reload()}
              />
            ) : (
              <div className="production-checkout-state-card">
                <span>{presentation.kicker}</span>
                <p>{presentation.body}</p>
                <button
                  type="button"
                  className="btn-outline-blue production-checkout-reconcile"
                  onClick={onReconcile}
                  disabled={requestState === "reconciling"}
                >
                  {requestState === "reconciling"
                    ? "CHECKING THIS PAYMENT…"
                    : "CHECK SAME PAYMENT STATUS →"}
                </button>
              </div>
            )}
          </div>
          {failureMessage && (
            <div className="production-checkout-failure" role="alert">
              {failureMessage}
            </div>
          )}
          <span className="sr-only" aria-live="polite">
            {snapshot.stage === "checkout_ready"
              ? `Official payment fields ${widget.ready ? "ready" : "loading"}. Payment details ${widget.complete ? "complete" : "incomplete"}.`
              : ""}
          </span>
        </div>

        <div>
          <Label>ORDER</Label>
          <div className="production-order-card">
            <div className="production-order-card-header">
              <span>ORDER SUMMARY</span>
              <span>{snapshot.order.itemCount} SEAT{snapshot.order.itemCount === 1 ? "" : "S"}</span>
            </div>
            <div className="production-order-card-body">
              {snapshot.order.items.map((item) => (
                <div className="production-order-line" key={`${item.sectionLabel}:${item.rowLabel}:${item.seatLabel}`}>
                  <span>{item.sectionLabel} · {item.rowLabel}{item.seatLabel}</span>
                  <span>{formatCheckoutMinorFixed(item.totalMinor, item.currency)}</span>
                </div>
              ))}
              <div className="production-order-line secondary">
                <span>Face value</span>
                <span>{formatCheckoutMinorFixed(snapshot.order.subtotalMinor, snapshot.order.currency)}</span>
              </div>
              <div className="production-order-line secondary">
                <span>Fees</span>
                <span>{formatCheckoutMinorFixed(snapshot.order.feeMinor, snapshot.order.currency)}</span>
              </div>
              <div className="production-order-line secondary">
                <span>Tax</span>
                <span>{formatCheckoutMinorFixed(snapshot.order.taxMinor, snapshot.order.currency)}</span>
              </div>
              <div className="production-order-total">
                <span>ALL-IN TOTAL</span>
                <span>{formatCheckoutMinorFixed(snapshot.order.totalMinor, snapshot.order.currency)}</span>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}

// ─── ACTION REQUIRED overlay (3DS) ───────────────────────────────────────────
function InventoryLoadingScreen({
  message,
  onRetry,
}: {
  message?: string
  onRetry: () => void
}) {
  return (
    <div className="inventory-event-loading" aria-busy={!message}>
      <div className="inventory-event-loading-art" aria-hidden="true" />
      <div className="inventory-event-loading-copy">
        <span>{message ? "EVENT UNAVAILABLE" : "GETTING THE EVENT READY"}</span>
        <h2>PHANTOM CIRCUIT</h2>
        <p>{message ?? "Loading seats and prices…"}</p>
        {!message && <div className="inventory-event-loading-bar" />}
        {message && (
          <button onClick={onRetry} className="btn-outline-blue">
            TRY AGAIN →
          </button>
        )}
      </div>
    </div>
  )
}

function CheckoutTransitionScreen() {
  return (
    <div className="checkout-transition-screen" role="status" aria-live="polite">
      <div className="checkout-transition-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <span>SECURING YOUR ORDER</span>
      <h2>Preparing checkout</h2>
      <p>
        Your seats are held. We’re opening the protected payment fields now.
        If checkout cannot open, you’ll return to the held seats.
      </p>
      <div className="checkout-transition-bar" aria-hidden="true" />
    </div>
  )
}

function InventoryRuntimeApp({
  resumeCheckout,
}: {
  readonly resumeCheckout: boolean
}) {
  const inventory = useOnsaleInventoryV1()
  const checkout = useOnsaleCheckoutV1({ resumeCheckout })
  const [appState, setAppState] = useState<AppState>("event")
  const [draftSeatRefs, setDraftSeatRefs] = useState<PublicRef[]>([])
  const [clockTick, setClockTick] = useState(() => Date.now())
  const [eventNotice, setEventNotice] = useState<string | null>(null)
  const [navigationNotice, setNavigationNotice] = useState<string | null>(null)
  const [checkoutDismissedToEvent, setCheckoutDismissedToEvent] =
    useState(false)
  const [serverClockRevision, setServerClockRevision] = useState<string | null>(
    null,
  )
  const serverOffset = useRef(0)
  const expiryRequestedFor = useRef<string | null>(null)
  const snapshot = inventory.snapshot
  const checkoutSnapshot = checkout.snapshot
  const completedRunRef = useAnnounceCurrentRecordedRunV1(
    checkoutSnapshot &&
      [
        "declined",
        "recoverable_failure",
        "fulfilled",
        "expired",
        "review_required",
      ].includes(checkoutSnapshot.stage)
      ? checkoutSnapshot.payment.evidenceRevision
      : null,
  )
  const currentHold = snapshot?.currentHold ?? null
  const generalWindow = snapshot?.event.saleWindows.find(
    (window) => window.kind === "general",
  )
  const validQuote =
    inventory.quote &&
    snapshot &&
    generalWindow &&
    inventory.quote.basisRevision === snapshot.revision &&
    inventory.quote.saleWindowRef === generalWindow.publicRef &&
    sameSeatSet(inventory.quote.seatRefs, draftSeatRefs)
      ? inventory.quote
      : null

  useEffect(() => {
    if (!snapshot) return
    serverOffset.current = Date.parse(snapshot.serverTime) - Date.now()
    setClockTick(Date.now())
    setServerClockRevision(snapshot.revision)
    if (snapshot.currentHold && !checkoutSnapshot) {
      setDraftSeatRefs([])
      inventory.clearQuote()
      setAppState("hold")
    }
  }, [snapshot?.revision, snapshot?.serverTime, checkoutSnapshot])

  useEffect(() => {
    if (!checkoutSnapshot) return
    setNavigationNotice(null)
    const nextState: AppState =
      checkoutSnapshot.stage === "fulfilled"
        ? "success"
        : checkoutSnapshot.stage === "declined"
          ? "hard_decline"
          : ["recoverable_failure", "expired", "review_required"].includes(
                checkoutSnapshot.stage,
              )
            ? "recoverable"
            : "checkout"
    setAppState(nextState)
  }, [
    checkoutSnapshot?.payment.evidenceRevision,
    checkoutSnapshot?.stage,
  ])

  useEffect(() => {
    if (!checkoutSnapshot) setCheckoutDismissedToEvent(false)
  }, [checkoutSnapshot])

  useEffect(() => {
    if (!snapshot || currentHold || draftSeatRefs.length === 0) return
    const available = new Set(
      snapshot.seatMap.rows
        .flatMap((row) => row.seats)
        .filter((seat) => seat.selectable)
        .map((seat) => seat.publicRef),
    )
    const rejected = new Set(inventory.failure?.error.seatRefs ?? [])
    const next = draftSeatRefs.filter(
      (seatRef) => available.has(seatRef) && !rejected.has(seatRef),
    )
    if (next.length === draftSeatRefs.length) return
    setDraftSeatRefs(next)
    inventory.clearQuote()
  }, [
    snapshot?.revision,
    currentHold?.publicRef,
    draftSeatRefs,
    inventory.failure?.error.seatRefs,
    inventory.clearQuote,
  ])

  useEffect(() => {
    if (!currentHold) return
    const interval = window.setInterval(() => setClockTick(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [currentHold?.publicRef])

  const holdSeconds = currentHold
    ? Math.max(
        0,
        Math.ceil(
          (Date.parse(currentHold.expiresAt) -
            (clockTick + serverOffset.current)) /
            1000,
        ),
      )
    : 0

  useEffect(() => {
    if (
      !currentHold ||
      serverClockRevision !== snapshot?.revision ||
      (currentHold.state === "active" && holdSeconds > 0) ||
      expiryRequestedFor.current === currentHold.publicRef
    )
      return
    expiryRequestedFor.current = currentHold.publicRef
    void inventory.expireHold(currentHold.publicRef).then((success) => {
      expiryRequestedFor.current = null
      if (!success) {
        void inventory.refresh()
      }
    })
  }, [
    currentHold?.publicRef,
    currentHold?.state,
    holdSeconds,
    serverClockRevision,
    snapshot?.revision,
    inventory.expireHold,
    inventory.refresh,
  ])

  useEffect(() => {
    if (
      !snapshot ||
      currentHold ||
      !generalWindow ||
      draftSeatRefs.length === 0
    ) {
      if (draftSeatRefs.length === 0) inventory.clearQuote()
      return
    }
    const seatRefs = canonicalSeatRefsV1(draftSeatRefs)
    const timer = window.setTimeout(() => {
      void inventory.quoteSeats(generalWindow.publicRef, seatRefs)
    }, 160)
    return () => window.clearTimeout(timer)
  }, [
    snapshot?.revision,
    currentHold?.publicRef,
    generalWindow?.publicRef,
    draftSeatRefs,
    inventory.quoteSeats,
  ])

  const toggleSeat = (seatRef: PublicRef) => {
    if (
      ["claiming", "releasing", "expiring"].includes(inventory.requestState)
    ) {
      return
    }
    inventory.clearFailure()
    setDraftSeatRefs((previous) => {
      if (previous.includes(seatRef))
        return previous.filter((ref) => ref !== seatRef)
      if (previous.length >= 4) return previous
      return [...previous, seatRef]
    })
  }

  const resetDraft = () => {
    setDraftSeatRefs([])
    inventory.clearQuote()
    inventory.clearFailure()
  }

  const claimDraft = () => {
    if (
      !generalWindow ||
      !validQuote ||
      inventory.requestState !== "ready" ||
      draftSeatRefs.length === 0
    )
      return
    const seatRefs = canonicalSeatRefsV1(draftSeatRefs)
    if (!sameSeatSet(validQuote.seatRefs, seatRefs)) return
    void inventory.claimSeats(
      generalWindow.publicRef,
      seatRefs,
      validQuote.quoteRevision,
    )
  }

  const releaseCurrentHold = () => {
    if (!currentHold) return
    void inventory.releaseHold(currentHold.publicRef).then((released) => {
      if (released) {
        resetDraft()
        setEventNotice("HOLD RELEASED · ALL SEATS RETURNED TO INVENTORY")
        setAppState("event")
      }
    })
  }

  const beginCheckout = () => {
    if (
      !currentHold ||
      currentHold.state !== "active" ||
      holdSeconds <= 0 ||
      checkout.requestState !== "idle"
    ) {
      return
    }
    setNavigationNotice(null)
    setCheckoutDismissedToEvent(false)
    setAppState("checkout")
    void checkout.prepare(currentHold.publicRef).then((prepared) => {
      if (!prepared) setAppState("hold")
    })
  }

  const retryDraftQuote = () => {
    if (!generalWindow || draftSeatRefs.length === 0) return
    inventory.clearFailure()
    inventory.clearQuote()
    void inventory.quoteSeats(
      generalWindow.publicRef,
      canonicalSeatRefsV1(draftSeatRefs),
    )
  }

  const keepHoldVisibleOrGoHome = () => {
    if (checkoutSnapshot) {
      setCheckoutDismissedToEvent(true)
      setNavigationNotice(null)
      setEventNotice(
        checkoutSnapshot.stage === "fulfilled"
          ? "TICKETS SAVED · OPEN YOUR CONFIRMED ORDER ANY TIME"
          : "CHECKOUT SAVED · RETURN TO THIS SAME PAYMENT WHEN YOU ARE READY",
      )
      setAppState("event")
      return
    }
    if (currentHold) {
      setAppState("hold")
      return
    }
    resetDraft()
    setEventNotice(null)
    setAppState("event")
  }

  const startFreshDemo = () => {
    setNavigationNotice("Starting a fresh ticket session…")
    void fetch("/api/onsale/demo/reset", {
      method: "POST",
      credentials: "same-origin",
    }).then((response) => {
      if (!response.ok) {
        setNavigationNotice("Could not start a new session. Please try again.")
        return
      }
      window.location.assign("/")
    }).catch(() => {
      setNavigationNotice("Could not start a new session. Please try again.")
    })
  }

  const railState: InventoryRailEvidence["state"] =
    inventory.requestState === "loading"
      ? "loading"
      : inventory.requestState === "quoting"
        ? "quoting"
        : inventory.requestState === "claiming"
          ? "claiming"
          : inventory.requestState === "releasing"
            ? "releasing"
            : inventory.requestState === "expiring"
              ? "expiring"
              : inventory.requestState === "blocked"
                ? "blocked"
                : currentHold?.state === "active"
                  ? "held"
                  : currentHold?.state === "expired_pending_reconcile"
                    ? "expiry_required"
                    : validQuote
                      ? "quoted"
                      : draftSeatRefs.length > 0
                        ? "draft"
                        : "preview"
  const railEvidence: InventoryRailEvidence = {
    mode: "inventory",
    state: railState,
    selectedSeatCount: draftSeatRefs.length,
    heldSeatCount: currentHold?.items.length ?? 0,
    totalMinor:
      currentHold?.totals.totalMinor ?? validQuote?.totals.totalMinor ?? null,
    currency: "USD",
    expiresAt: currentHold?.expiresAt ?? null,
    revision: snapshot?.revision ?? null,
    serverTime: snapshot?.serverTime ?? null,
    onReconcile: () => void inventory.refresh(),
    message:
      checkout.requestState === "preparing"
        ? "checkout_preparing"
        : inventory.failure?.error.code,
    checkout: checkoutSnapshot
      ? {
          stage: checkoutSnapshot.stage,
          orderState: checkoutSnapshot.order.state,
          itemCount: checkoutSnapshot.order.itemCount,
          ticketCount: checkoutSnapshot.order.ticketCount,
          totalMinor: checkoutSnapshot.order.totalMinor,
          currency: checkoutSnapshot.order.currency,
          paymentDeadlineAt: checkoutSnapshot.order.paymentDeadlineAt,
          canonicalState: checkoutSnapshot.payment.canonicalState,
          integrityState: checkoutSnapshot.payment.integrityState,
          observationSource: checkoutSnapshot.payment.observationSource,
          selectedMethod: checkoutSnapshot.payment.selectedMethod,
          observedConnector: checkoutSnapshot.payment.observedConnector,
          attempts: checkoutSnapshot.payment.attempts,
          chargedAttemptCount: checkoutSnapshot.payment.chargedAttemptCount,
          evidenceGeneration: checkoutSnapshot.payment.evidenceGeneration,
          evidenceRevision: checkoutSnapshot.payment.evidenceRevision,
          retryPermitted: checkoutSnapshot.payment.retryPermitted,
          retryReason: checkoutSnapshot.payment.retryReason,
          requestState: checkout.requestState,
          recordedRunRef: completedRunRef,
          onReconcile: () => void checkout.reconcile("refresh"),
        }
      : undefined,
  }
  const visibleRailEvidence: InventoryRailEvidence = checkoutDismissedToEvent
    ? {
        ...railEvidence,
        state: "preview",
        selectedSeatCount: 0,
        heldSeatCount: 0,
        totalMinor: null,
        expiresAt: null,
        message: undefined,
        checkout: undefined,
      }
    : railEvidence
  const mobileContextItems = currentHold?.items ?? validQuote?.items ?? []
  const mobileContextTotals = currentHold?.totals ?? validQuote?.totals ?? null
  const mobileContextState: CompactClaimContextState | null =
    railState === "quoted" ||
    railState === "claiming" ||
    railState === "held" ||
    railState === "releasing" ||
    railState === "expiry_required" ||
    railState === "expiring"
      ? railState
      : null
  const mobileClaimContext: CompactClaimContext | null =
    mobileContextState && mobileContextItems.length > 0 && mobileContextTotals
      ? {
          state: mobileContextState,
          seats: `${mobileContextItems.length} seat${
            mobileContextItems.length === 1 ? "" : "s"
          } ${currentHold ? "held" : "selected"} · ${mobileContextItems
            .map((item) => `${item.rowLabel}${item.seatLabel}`)
            .join(" · ")}`,
          amount: `${formatUsdMinorFixed(mobileContextTotals.totalMinor)} ${
            currentHold
              ? "held · not charged"
              : mobileContextState === "claiming"
                ? "committing · not yet held"
                : "quoted · not held"
          }`,
          status:
            mobileContextState === "quoted"
              ? "PRICE CONFIRMED"
              : mobileContextState === "claiming"
                ? "HOLDING YOUR SEATS"
                : mobileContextState === "held"
                  ? "SEATS HELD"
                  : mobileContextState === "releasing"
                    ? "RETURNING SEATS"
                    : mobileContextState === "expiry_required"
                      ? "HOLD TIME ENDED · CHECKING"
                      : "CHECKING YOUR HOLD",
          tail: currentHold
            ? `HOLD ${String(Math.floor(holdSeconds / 60)).padStart(
                2,
                "0",
              )}:${String(holdSeconds % 60).padStart(2, "0")}`
            : undefined,
        }
      : null
  const visibleAppState: AppState = checkoutDismissedToEvent
    ? "event"
    : appState
  return (
    <Shell
      appState={visibleAppState}
      holdSeconds={holdSeconds}
      holdCommitted={
        checkoutSnapshot ? false : currentHold?.state === "active"
      }
      checkoutMode={
        !checkoutDismissedToEvent &&
        (Boolean(checkoutSnapshot) || appState === "checkout")
      }
      railIdle={
        checkoutDismissedToEvent ||
        railState === "loading" ||
        (railState === "preview" && !checkoutSnapshot)
      }
      buyerContext={checkoutSnapshot ? null : mobileClaimContext}
      onHome={keepHoldVisibleOrGoHome}
      onBack={keepHoldVisibleOrGoHome}
      rightPanel={
        <ProductionMechanismRail
          revision={
            draftSeatRefs.length +
            (currentHold ? 10 : 0) +
            (checkoutSnapshot?.payment.evidenceGeneration ?? 0)
          }
          inventory={visibleRailEvidence}
        />
      }
    >

      {!snapshot && !checkoutSnapshot && (
        <InventoryLoadingScreen
          message={inventory.failure?.error.message}
          onRetry={() => void inventory.refresh()}
        />
      )}

      {snapshot &&
        appState === "event" &&
        (!checkoutSnapshot || checkoutDismissedToEvent) && (
        <EventScreen
          inventory={snapshot}
          inventoryNotice={eventNotice}
          resumeCheckout={
            checkoutSnapshot
              ? {
                  label:
                    checkoutSnapshot.stage === "fulfilled"
                      ? "VIEW YOUR TICKETS →"
                      : "RESUME SECURE CHECKOUT →",
                  onResume: () => {
                    setCheckoutDismissedToEvent(false)
                    setEventNotice(null)
                    setAppState(
                      checkoutSnapshot.stage === "fulfilled"
                        ? "success"
                        : checkoutSnapshot.stage === "declined"
                          ? "hard_decline"
                          : [
                                "recoverable_failure",
                                "expired",
                                "review_required",
                              ].includes(checkoutSnapshot.stage)
                            ? "recoverable"
                            : "checkout",
                    )
                  },
                }
              : undefined
          }
          onPresale={() => {
            setEventNotice(null)
            setAppState("eligibility")
          }}
          onGeneral={() => {
            if (!generalWindow?.canEnter) return
            setEventNotice(null)
            setAppState("hold")
          }}
        />
      )}

      {snapshot && !checkoutSnapshot && appState === "eligibility" && (
        <InventoryEligibilityScreen
          onVerified={() => {
            if (!generalWindow?.canEnter) return
            setEventNotice("DEMO ACCESS ACCEPTED · OPEN ASSIGNED-SEAT INVENTORY")
            setAppState("hold")
          }}
          onGeneral={() => {
            if (generalWindow?.canEnter) setAppState("hold")
          }}
        />
      )}

      {snapshot && !checkoutSnapshot && appState === "checkout" && (
        <CheckoutTransitionScreen />
      )}

      {snapshot && !checkoutSnapshot && appState === "hold" && (
        <InventoryHoldScreen
          snapshot={snapshot}
          quote={validQuote}
          draftSeatRefs={draftSeatRefs}
          requestState={inventory.requestState}
          failureMessage={inventory.failure?.error.message ?? null}
          checkoutRequestState={checkout.requestState}
          checkoutFailureMessage={checkout.failure?.error.message ?? null}
          holdSeconds={holdSeconds}
          onToggle={toggleSeat}
          onClaim={claimDraft}
          onCheckout={beginCheckout}
          onRetryQuote={retryDraftQuote}
          onReset={resetDraft}
          onRelease={releaseCurrentHold}
        />
      )}

      {checkoutSnapshot && !checkoutDismissedToEvent && (
        <ProductionCheckoutScreen
          snapshot={checkoutSnapshot}
          event={snapshot?.event ?? null}
          mountRevision={checkout.mountRevision}
          requestState={checkout.requestState}
          failureMessage={checkout.failure?.error.message ?? null}
          canSubmit={checkout.canSubmit}
          widget={checkout.widget}
          onReadiness={checkout.setWidgetReadiness}
          onConfirm={checkout.confirmOfficialPayment}
          onReconcile={() => void checkout.reconcile("refresh")}
          onStartOver={startFreshDemo}
          navigationNotice={navigationNotice}
          recordedRunRef={completedRunRef}
        />
      )}
    </Shell>
  )
}

// ─── Root App ──────────────────────────────────────────────────────────────────
export default function App({
  resumeCheckout = true,
}: {
  readonly resumeCheckout?: boolean
}) {
  return <InventoryRuntimeApp resumeCheckout={resumeCheckout} />
}
