# ONSALE v0.1 recovery

React 19 and Next.js 16 application preserving the accepted Figma experience
while replacing mock state with server-owned inventory and payment behavior.

## Development server

No preview may be assumed to be running. `pnpm dev` is the canonical command.
It enforces Linux Node 22.23.2, mirrors the candidate to a Linux-native working
directory, loads the approved private local environment at the process
boundary, and starts Next through the isolated Portless name printed by the
launcher. The default is `http://onsale-v01.localhost:4310`; a review-specific
name may be supplied through `ONSALE_PORTLESS_NAME` as one lowercase DNS label.
The launcher derives the displayed URL and every origin-dependent setting from
that name and rejects a mismatch before Next starts. `pnpm dev:direct` is the
explicit `http://localhost:3102` fallback.
`pnpm dev:figma` exists only for archived presentation parity and cannot serve
the owned API routes.

## Project structure

This is the canonical project structure. Start with task-relevant files below. Only follow imports or inspect other files when required, when a documented path is missing, or when the repository contradicts this guide.

- `app/page.tsx` - canonical Next buyer entrypoint
- `app/checkout/page.tsx` - cookie-aware provider-return recovery entrypoint
- `app/flows/` - reviewer Story Lab and Recorded Runs route
- `app/api/onsale/` - inventory, checkout, return, and read-only evidence routes
- `src/main.tsx` - parity-only Vite entrypoint
- `src/App.tsx` - Primary application component and the usual starting point for UI work
- `src/index.css` - Global CSS entrypoint and Tailwind CSS v4 import
- `index.html` - Vite HTML shell containing the `#root` element and loading `src/main.tsx`
- `package.json` - canonical Next commands plus explicit `*:figma` parity commands
- `vite.config.ts` - Vite configuration with React, Tailwind CSS v4, and Figma Make plugins plus the `@` alias for `src`
- `.mise.toml` - Toolchain versions for Node.js and pnpm

## Dependencies

- Runtime: React 19 and React DOM 19
- Styling: Tailwind CSS v4 with the Next PostCSS integration; Vite remains a parity dependency
- Build tooling: Next 16.3, Vite 8 parity, and TypeScript 5.7
- Formatting: oxfmt

## Styling

This project uses **Tailwind CSS v4** through the `@tailwindcss/vite` plugin configured in `vite.config.ts`. `src/index.css` imports Tailwind with `@import 'tailwindcss';`. Use Tailwind utility classes directly in JSX and put global CSS or Tailwind v4 theme customization in `src/index.css`. This scaffold does not need a Tailwind config file or PostCSS config.

`src/main.tsx` imports `src/index.css`, so global font wiring belongs in `src/index.css`. Keep CSS `@import` statements first, then add any `@font-face` rules and font-family defaults there.

## Code quality

- Use double quotes for strings containing apostrophes (`"We're here to help"`), or escape them in single-quoted strings. An unescaped apostrophe in a single-quoted string breaks the build.
- Ensure JSX tags are closed and braces are balanced.
- Export components as default exports.

## ONSALE rebuild contract

Direct user instructions and the parent project contract at `../AGENTS.md` are
authoritative. Read `../docs/agent/PROJECT.md`, `../docs/agent/STATE.md`,
`../../../outputs/ONSALE_SANDBOX_FIRST_REBUILD_APPROACH_v1.0.md`, and
`docs/FIGMA-EXPERIENCE-CONTRACT.md` before implementation.

This branch begins at the exact Figma Make commit
`8dede8f296f2d74359e8d1e95734687e18c5a8e5`. The baseline presentation and
motion are the binding product contract:

- preserve the 72/28 same-page customer/mechanism composition;
- preserve the event hero, proscenium SVG, sale-card hierarchy, six-by-ten seat
  density, cobalt/sharp visual language, nonlinear rail topology, five-panel
  order, and authored causal motion;
- keep full crafted motion as the default experience. An OS-level reduced-motion
  variant may convey the same state changes, but it must not flatten or dictate
  the default design;
- replace fake timers, random outcomes, client-owned inventory/money state,
  static card/OTP forms, and invented evidence with authoritative backend state;
- do not copy `src/App.tsx`, `src/MechanismRail.tsx`, or `src/index.css` from the
  archived superseded implementation. Independently verified domain, adapter,
  and test units may be reintroduced only with a provenance and proof receipt;
- visible structure may change only for an observed sandbox/state-model
  constraint or a verified usability failure, and the change must have a review
  receipt.

## Build gates

1. Freeze and render the untouched Figma event, access, seats, checkout,
   action, success, decline, and recovery states.
2. Prove the official sandbox action/return/retrieve path and design the durable
   multi-seat/hold/payment model. Both gates precede frontend integration.
3. Port one backend vertical slice at a time while keeping the Figma experience
   visibly recognizable after every slice.
4. Run model tests, browser proof, responsive captures, and only the
   risk-matched HCI Agent Test Lab profile for each unit. Preserve red evidence
   and produce HANDOFF before HCI-driven fixes.
5. Do not push, deploy, publish, or mutate routing/webhook configuration until
   its separate review gate is open.

## v0.1 recovery release rules

The accepted v0.1 candidate is the product base. Later work is additive and
bug-scoped. A backend improvement does not authorize a new composition, trace
topology, Story Lab taxonomy, or motion language.

- Preserve `src/App.tsx`, the 72/28 buyer and rail relationship, the compact
  six-actor trace, the authored amber-token choreography, the ticket result,
  and the six accepted Story Lab subjects unless a direct user-approved defect
  requires a specific delta.
- Record every approved experience delta in `.audit/v01-recovery-base.json`
  with the affected contract, reason, changed paths, before and after hashes,
  and current-candidate proof. An unlisted visual or interaction change is a
  regression even when its unit tests pass.
- Keep inventory, order, payment, fulfillment, session, cookie, and trace facts
  server-authored. Browser state may describe an action in flight, but it must
  never assert a provider result, charge, ticket, connector, or retry decision.
- `Recorded Runs` may contain only sanitized projections of durable payment
  rows. Story Lab remains an explicitly labelled simulation population and is
  never substituted when the durable read is empty or unavailable.
- A completed order must resolve to one stable opaque run reference. Refreshing
  that run replaces it idempotently and retains earlier runs. Historic
  selection is static; Replay alone authorizes historic motion.

### Canonical runtime proof

- `pnpm dev` must start the Next.js API runtime through the pinned Linux Node 22
  launcher and print one canonical named local URL. Vite is parity-only and
  cannot be handed to the user as the working product.
- The canonical origin is one exact value shared by displayed URL, Origin
  guards, return URL, and cookie policy. Lookalike hostnames, scheme changes,
  and unapproved ports must fail closed.
- Before handing off a URL, open that exact candidate as a user and exercise
  event -> seats -> hold -> checkout preparation -> official checkout ->
  reconcile or recovery -> result -> exact Recorded Run. Owned APIs must not be
  intercepted or replaced. Capture browser errors, server errors, redirects,
  cookies, and the process runtime/cwd.
- A mocked or intercepted Playwright suite is component behavior proof only.
  It cannot satisfy canonical runtime, database, provider, deployment, or live
  history proof. A skipped or blocked owning population keeps its release claim
  blocked.

### Candidate and receipt authority

- Freeze one source digest before final acceptance. Typecheck, tests, build,
  browser evidence, document, video, and deployment readback must all name that
  same digest.
- Gate status comes from the evaluator manifest and its preserved negative
  controls. Prose, test totals, screenshots, or an independent review cannot
  override a blocked owning evaluator.
- Verify the current candidate, not only an archived fixture. Required visual
  journeys include quiet, inventory prelude, preparation, Pay activation,
  provider action or truthful fallback, decline, uncertain recovery, verified
  fulfillment, Home, Back, Buy another, all six Story Lab subjects, Recorded
  Runs refresh, replay, reduced motion, and narrow layouts.
- Before claiming completion, compare the observed final behavior with the
  latest user request line by line. Preserve open gaps as `pending proof`; do
  not convert implementation intent into evidence.

### Bounded parallel work

- Use at most three active implementation lanes plus the integrating root.
  Each lane owns explicit files and a verifiable outcome. Stop or reuse a lane
  as soon as it hands off; do not leave finished agents running.
- Shared presentation files have one owner at a time. Agents may report a
  dependency but must not silently edit across another lane's scope.
- The integrating root reviews every diff against the frozen v0.1 hashes and
  runs the combined candidate gate after all lanes freeze.

## Code Review Rules

### Protected experience changes

Flag any change to a protected experience file that is missing from
`.audit/v01-recovery-base.json` as an approved, bug-scoped delta with its
before hash, after hash, and current-candidate browser proof. The safe path is
to preserve the accepted file or add the narrow delta receipt before release.

### Proof-population laundering

Flag a `working`, `recorded`, `live`, `ready`, or `passed` claim when the owning
API was intercepted, the source is a Story Lab simulation, or the required
runtime, database, provider, deployment, or human-review population is blocked
or skipped. The safe path is to name the proof class and keep the larger claim
pending until its own population passes.

### Exact-run identity

Flag any `/flows?run=<ref>` path that can select, render, or replay a different
run when the requested reference is missing, unavailable, or belongs to
another buyer. The safe path is a dedicated resolving state followed by the
exact run or a target-specific error with no fallback receipt.

## Skill routing

Use both named Adaptive Agent Operating System skills and Product Craft for the
whole run. Apply the P-stack principles for foundational thinking,
experience-first design, outcome-oriented execution, boundary discipline,
sequence-verifiable units, subtract-before-adding, root-cause repair,
idempotency, encoded lessons, and proof-before-claim. Use HTML Generative UX,
Emil Design Engineering, and Figma motion guidance for the experience contract;
the relevant current Vercel React/Next.js guidance only during integration; HCI
Agent Test Lab only after a critical flow renders; and Remotion/HyperFrames only
after the product and visual gates pass.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
