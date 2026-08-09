# ONSALE C2 — Neon inventory receipt

Date: 2026-08-08

Branch: `codex/main-prototype`
Entry gate: C1 Next runtime parity at commit `159d1b1`

## Outcome

C2 makes the Figma-baseline event, general-sale, assigned-seat, quote, hold, evidence, and release experience operate against persistent Neon inventory. The production entry no longer uses the Figma simulator. The original visual language, stage illustration, 72/28 desktop composition, five-panel Mechanism Rail, and intentional motion model remain the presentation foundation.

This slice stops before order creation, Hyperswitch checkout, payment, provider action, webhook, routing, and ticket fulfillment. Those states remain visibly `UNPROVEN` or deferred; C2 does not manufacture them.

## What is real in this slice

- One fixed, guarded application namespace: `onsale_app_v1`.
- One deterministic active dataset: six rows, 60 assigned seats, all-in USD prices, and at least one adjacent selectable group of four.
- One anonymous browser session represented by an HttpOnly cookie; raw session identity never crosses the public contract.
- Server-authored snapshots and SHA-256 revisions.
- One-to-four-seat server quotes.
- Atomic seat claims and exact hold release.
- One current hold per buyer/event, buyer-bound terminal operations, server-clock expiry, durable idempotency, and stale-quote rejection.
- A truth-safe Mechanism Rail that shows merchant inventory evidence while payment, connector, routing, webhook, and ticket evidence remain unproven.
- An inspectable receipt with full snapshot revision, server observation time, hold expiry, proof boundary, and an explicit refresh/reconcile control.

## Durable database proof

The additive migration was applied once to the fixed namespace. Its recorded migration checksum is:

`622c17491da6aa4458d9a81ec19ce71b5421da7e3679f79ea5e1425f73453a1a`

The guarded hosted suite first returned 23/24 because the legacy `INV-06` assertion assumed one ordering at the expiry/order-conversion race. The repository correctly rejected a terminal converted hold as `HOLD_NOT_ACTIVE`. The test was narrowed to accept the two valid serializations, and the exact hosted `INV-06` rerun passed. New C2 hosted cases, including quote locking, one-current-hold enforcement, ownership, exact expiry reporting, and Figma seed metadata, passed in that hosted run. Cleanup checks found zero orphan `onsale_test_*` schemas and zero public ONSALE tables.

After the final HCI run, a read-only application-schema check returned:

- active holds: `0`
- active holds already past expiry: `0`

## Browser and HCI proof

Deterministic mocked Playwright: `14/14` passed.

The suite covers:

- production truth boundary and the five Mechanism Rail panels;
- event → four-seat quote → atomic hold → reload/resume → release;
- stale and mismatched quote rejection;
- conflict pruning and requote;
- expiry reconciliation;
- 390×844, 768×1024, and 1440×1000 layouts with all 60 seats and no horizontal overflow;
- shared-session visibility reconciliation;
- a one-Tab roving seat grid with spatial arrow navigation;
- stable focus after entering seats, committing a hold, and releasing it;
- persistent compact quote/hold context while mobile Evidence is inspected.

The independent live-Neon HCI repair cohort completed `3/3` with a contract-valid aggregate and no implementation-ready issue remaining:

- desktop: D1–D4 quoted for $880, evidence refreshed, held atomically, and released;
- mobile: E1–E4 quoted for $880, compact context stayed visible during receipt inspection, held, and released;
- keyboard: F4–F7 selected through the roving grid, held for $880, and released, with focus restored to live status after both writes.

The first keyboard assignment, F1–F4, was preserved as a blocked harness receipt because deterministic F3 is intentionally blocked. No substitution or write occurred. The profile was corrected to adjacent selectable F4–F7 and rerun in a fresh isolated session.

Mechanical HCI evidence does not establish accessibility conformance or human comprehension. One human-review question remains: whether the dense receipt metadata is comfortably legible at 390 px.

## Local verification

- TypeScript: passed with no diagnostics.
- Vitest: 13 files, 79 passed, 22 hosted-only cases skipped locally.
- Playwright Chromium: 14/14 passed.
- HCI aggregate validation: valid, 3/3 complete, zero errors, zero warnings.
- Production Next.js webpack build: passed.
- Repository diff whitespace check: passed.

## Forward boundary

The next slice must add a stable order/payment identity and official Hyperswitch Unified Checkout without replacing the Figma presentation system. Provider-owned fields and method discovery stay inside the official widget. Redirect/action completion must return to the same order and reconcile by server retrieve before the UI can claim payment success. Method selection, connector execution, routing, webhook receipt, and ticket issuance must remain separate evidence facts.
