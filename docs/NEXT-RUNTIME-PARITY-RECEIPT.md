# Next.js runtime parity receipt

Date: 2026-08-08

Branch: `codex/main-prototype`

Figma baseline: `8dede8f296f2d74359e8d1e95734687e18c5a8e5`

## Outcome

The untouched Figma Make application now runs through a thin Next.js 16 App
Router boundary while Vite remains available as the comparison control. This
unit changed runtime packaging only. It did not change buyer, payment,
Mechanism Rail, motion, inventory, or evidence behavior.

The following presentation files remain byte-identical to the baseline:

| File | SHA-256 |
| --- | --- |
| `src/App.tsx` | `b76d8effc17a149c475ddd391f9f9729b49fa261ca5d20a13ddce786c9eb7d61` |
| `src/MechanismRail.tsx` | `85e552feabee81a8218f5526e0856b360a49d80e863bb49c7141118042ef69cf` |
| `src/index.css` | `d9a602831cf0350afbe5e32db966063f273bd5cb856a882d169ccfe2ed88c2e1` |

## Runtime boundary

- `app/page.tsx` renders one client component.
- `app/figma-app.tsx` is the only `use client` boundary and imports the
  untouched `src/App.tsx`.
- `app/layout.tsx` imports the untouched `src/index.css` and retains `#root`.
- Vite entry, Vite config, and `index.html` remain unchanged.
- The metadata description matches `.figma/make/site.json`; `ONSALE` is the
  minimal product shell title because the baseline declares no title.
- Next build scripts use the documented webpack path. Default Turbopack hit an
  environment-level pooled-process spawn error under the available local
  runtime and is not part of this proof.

## Nine-state parity gate

`tests/parity/runtime-parity.mjs` drives the same Figma source through Vite and
Next at 1440 by 1000 for:

1. event;
2. eligibility;
3. seats unselected;
4. two selected seats;
5. checkout;
6. action overlay;
7. success;
8. hard decline;
9. recoverable interruption.

Every state must match the frozen fixture and the other runtime on canonical
DOM SHA-256, critical computed-style SHA-256, and exact PNG SHA-256. Browser
`pageerror` and `console.error` events fail the run. The fixture is bound to the
three baseline source hashes above. The expected record and the final replay
were byte-identical:

`28812072b1af4bdbf4bde9db80c3eb2f7d60e504f840384dc8f2bff500fc5a4c`

The run produced nine unique DOM hashes and nine unique screenshot hashes.

## Preserved red controls and repairs

1. The Windows-mounted dependency relink stalled. Verification moved to a
   byte-identical WSL ext4 mirror without deleting or replacing the shared
   worktree dependency directory.
2. The first Next build used the available Node 26 runtime and Turbopack failed
   while spawning its pooled PostCSS worker. The verified path uses Linux Node
   22.23.2, matching `.mise.toml`, plus `next build --webpack`.
3. The first seat driver used a substring title selector, so `A1` also matched
   `A10`. The driver now uses exact `A1` and `A2` selectors.
4. The first DOM comparison hashed raw style strings, exposing semantically
   equivalent client/SSR color serialization. The serializer now canonicalizes
   inline style declarations while the computed-style and exact-pixel gates
   remain independent.
5. The first format gate caught six authored runtime files. They were
   mechanically formatted; generated `next-env.d.ts` remains generated.
6. `.next/` is ignored so generated runtime output cannot enter the branch.

The red observations remain documented here; the final green run does not
erase them.

## Verification

- Next 16.3.0 webpack production build: pass.
- Vite 8.0.3 production build: pass.
- strict TypeScript: pass.
- Vitest: 13 passed; 16 hosted Neon cases intentionally skipped by the normal
  local test command.
- nine-state record and non-record parity: pass.
- independent final parity replay: pass; expected and actual records are
  byte-identical.
- browser page errors and console errors: zero in the parity population.
- authored-file formatting and scoped whitespace checks: pass.
- baseline source diff: none.

Execution used Linux-native tooling. The verified frozen mirror was
`/tmp/onsale-runtime-parity.9H2pmV`; it is disposable verification state, not a
source or delivery path.

## Skill and principle receipt

The unit was routed through both Adaptive Agent Operating Systems, Product
Craft, HTML Generative UX, Emil Design Engineering, the relevant Figma motion
guidance, current Vercel Next/React/composition guidance, the Windows/WSL
delivery preflight, and the active P-stack principles. The decisions they
changed were concrete:

- experience-first and subtract-before-adding kept the three presentation
  files untouched;
- sequence-verifiable-units separated runtime parity from data inhabitation;
- fix-root-causes moved verification to the correct runtime rather than
  weakening checks;
- prove-it-works required DOM, style, pixels, browser diagnostics, and a second
  replay;
- encode-lessons-in-structure turned every discovered drift mode into a
  permanent gate.

Primary skill file hashes for this unit:

| Skill | SHA-256 |
| --- | --- |
| Adaptive AOS, agent home | `4859e321d4cc9174fb764ffc6f89354e6ce6f06d8bd2444fc57dd315be1170bc` |
| Adaptive AOS, Codex home | `a33580a74daa3ac85253cb9cd519d356936cfc366294aff0dc996bde53de0769` |
| Product Craft | `ba173e458b791a21faaf71b7f071df0306e5f9c0a18ea71bc9aaa39ed927d4` |
| HTML Generative UX | `244c031b48817c43801e23d800e325f16986c594be9a0bd14dc741cd35871699` |
| Emil Design Engineering | `433b5a239cda18e0576e4e558532e7e53512e21fafe5b85db4894c28ec399b72` |
| Deliver Windows/WSL Artifacts | `5d2a522601c67de80be319285158f71f69221c9a5fbc1324c321fb1e3026f8e7` |
| Vercel Next.js | `cdd014ce090e4a137abd81682238d994a41fcd73a626cd70a2af47e2451bbb0c` |
| Vercel React best practices | `71ed7794962fa6e803ee83030517b5b93a9f70fbfeb431ec4535c5480a8d8355` |
| Vercel composition patterns | `e38e0eaa609316b10423a9a138ed95e35099accd3f735585295c8a8f165c28a3` |

HCI Agent Test Lab remains phase-gated. This unit intentionally changed no
critical-flow interaction; HCI reruns begin after the real seat/hold flow is
rendered.

## Claim boundary

This receipt proves source and rendered runtime parity only. The nine states
still contain the Figma mock's fake access, inventory, checkout, action,
webhook, routing, success, and fulfillment semantics. Those states are a visual
control, not sandbox or money evidence. C2 must replace the reachable false
business claims while preserving the structural and motion contract.
