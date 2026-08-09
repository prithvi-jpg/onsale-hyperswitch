import { createHash } from "node:crypto"
import { lstat, readFile, readdir } from "node:fs/promises"
import { relative, resolve, sep } from "node:path"

export const EXPECTED_NODE_VERSION_V1 = "v22.23.2"
export const EXPECTED_NEXT_VERSION_V1 = "16.3.0"
export const EXPECTED_PACKAGE_MANAGER_V1 = "pnpm@10.34.3"
export const EXPECTED_NAMED_ORIGIN_V1 = "http://onsale-v01.localhost:4310"

export const STORY_LAB_IDS_V1 = Object.freeze([
  "confirmed-payment",
  "action-required",
  "terminal-decline",
  "lost-response-recovery",
  "fixture-label-counterexample",
  "checkout-configuration-boundary",
])

export const EXTERNAL_POPULATION_IDS_V1 = Object.freeze([
  "live_provider",
  "hosted_neon",
  "deployment",
  "named_human",
  "motion_media",
])

export const VITEST_FILES_V1 = Object.freeze([
  "tests/server/portless-local-preview.test.ts",
  "tests/server/local-preview-runtime.test.ts",
  "tests/server/onsale-session.test.ts",
  "tests/server/onsale-checkout-route-runtime.test.ts",
  "tests/domain/flows-v2.test.tsx",
  "tests/domain/flows-recorded-runs-v01.test.ts",
  "tests/domain/payment-trace-v01.test.tsx",
  "tests/domain/mechanism-rail-c2.test.tsx",
])

export const PLAYWRIGHT_FILE_V1 =
  "tests/next-e2e/onsale-flows-v01-recovery.spec.ts"

const UNIT = Object.freeze({
  runtimeOrigin:
    "v0.1 exact local runtime environment atomically derives origin and cookie policy from Portless http://onsale-v01.localhost:4310",
  runtimeDrift:
    "v0.1 exact local runtime environment rejects Portless origin drift http://onsale-v01.localhost:4311 before Next starts",
  runtimeSocket:
    "v0.1 exact local runtime environment binds Next to the private socket Portless assigned",
  namedRuntime:
    "v0.1 isolated named Portless launcher uses an explicit stable name and project-scoped state",
  pinnedRuntime:
    "v0.1 isolated named Portless launcher pins the Node-22-compatible Portless and makes Next the default runtime",
  nodeRoutes:
    "C3 checkout App Router boundary exposes only the dynamic Node handlers for prepare, retrieve-only reconcile, and return",
  sessionRefresh:
    "C2 anonymous session boundary reuses one valid cookie across refresh and rotates malformed candidates",
  cookieContinuity:
    "C3 checkout App Router boundary carries the two discrete prepare cookies into a cookie-only reconcile reload",
  reconcileAuthority:
    "C3 checkout App Router boundary requires the existing HttpOnly session and order pointer for retrieve-only reconcile",
  orderPointer:
    "C3 checkout App Router boundary retains the bounded HttpOnly order pointer intentionally across unknown and terminal projections",
  cleanReturn:
    "C3 checkout App Router boundary ignores every provider query value and performs a pure 303 strip with no provider or database work",
  sixStories:
    "ONSALE recorded flow replay isolates one deterministic multi-attempt simulation inside Story Lab",
  storiesOutsideLedger:
    "ONSALE v0.1 durable Recorded Runs boundary keeps all six Story Lab subjects outside the durable ledger",
  rejectStoryInLedger:
    "ONSALE v0.1 durable Recorded Runs boundary rejects Story Lab simulation if it reaches the Recorded Runs adapter",
  exactRun:
    "ONSALE v0.1 durable Recorded Runs boundary walks the sanitized cursor with GET-only reads to find an exact completed run",
  mergeRun:
    "ONSALE v0.1 durable Recorded Runs boundary selects a completed exact run idempotently without losing older pages or cursor",
  currentRun:
    "ONSALE v0.1 durable Recorded Runs boundary announces and returns one terminal current run from one GET",
  missingRun:
    "ONSALE v0.1 durable Recorded Runs boundary returns RUN_NOT_FOUND for missing detail and an empty current-run read",
  nullableMoney:
    "ONSALE v0.1 durable Recorded Runs boundary keeps unproven received money unknown while retaining exact succeeded money",
  replayMoney:
    "ONSALE recorded flow replay replays the local two-attempt circuit without revealing received money early",
  preparing:
    "production mechanism-rail trace uses the accepted trace map while checkout is being prepared",
  pay:
    "production mechanism-rail trace animates one buyer intent handoff when Pay activates without claiming an outcome",
  retrieve:
    "production mechanism-rail trace animates one authoritative retrieve delta even when its retained facts change",
  ticket:
    "production mechanism-rail trace moves the verified terminal handoff to tickets only with one charge and exact cardinality",
  oneToken:
    "ONSALE v0.1 shared payment trace renders one slow amber core-and-halo signal only for a valid evidence-linked handoff",
  invalidToken:
    "ONSALE v0.1 shared payment trace fails closed when an event tuple or attempt evidence does not match the fixed topology",
  staticTrace:
    "ONSALE v0.1 shared payment trace keeps hydration and historical selection static, then replays only on an explicit replay branch",
  staticReplay:
    "ONSALE recorded flow replay keeps historical selection still and authorizes only retained replay handoffs",
})

const BROWSER = Object.freeze({
  staticMerge:
    "Recorded Runs stays static on selection, replays explicitly, and merges the just-completed run",
  exactRun:
    "an exact later-page run target resolves without rendering the newest different run",
  noFallback:
    "a cross-buyer exact target renders not-found and never walks or substitutes the visible ledger",
})

export const LOCAL_GATE_DEFINITIONS_V1 = Object.freeze([
  {
    id: "named_next_runtime",
    label: "Exact named Next runtime contract",
    runtimeChecks: true,
    unitAssertions: [
      UNIT.runtimeOrigin,
      UNIT.runtimeDrift,
      UNIT.runtimeSocket,
      UNIT.namedRuntime,
      UNIT.pinnedRuntime,
      UNIT.nodeRoutes,
    ],
    browserAssertions: [],
    proofClass: "deterministic_local_contract",
    claimBoundary:
      "Pins the Node, Next, Portless name, origin, cookie policy, and App Router contract. It is not live-provider or hosted-runtime proof.",
  },
  {
    id: "session_current_order_continuity",
    label: "Session and current-order continuity",
    unitAssertions: [
      UNIT.sessionRefresh,
      UNIT.cookieContinuity,
      UNIT.reconcileAuthority,
      UNIT.orderPointer,
    ],
    browserAssertions: [],
    proofClass: "deterministic_local_contract",
    claimBoundary:
      "Proves the anonymous-session and HttpOnly current-order contract without claiming a provider action.",
  },
  {
    id: "return_checkout",
    label: "Provider return resolves to /checkout",
    unitAssertions: [UNIT.cookieContinuity, UNIT.cleanReturn],
    browserAssertions: [],
    proofClass: "deterministic_local_contract",
    claimBoundary:
      "Proves query stripping, same-order cookie continuity, and the exact clean return. It does not prove a current provider callback.",
  },
  {
    id: "story_lab_six_accepted_ids",
    label: "Six accepted Story Lab subjects",
    unitAssertions: [
      UNIT.sixStories,
      UNIT.storiesOutsideLedger,
      UNIT.rejectStoryInLedger,
    ],
    browserAssertions: [],
    proofClass: "local_simulation_contract",
    expectedIds: STORY_LAB_IDS_V1,
    claimBoundary:
      "All six subjects remain local simulations and cannot enter Recorded Runs.",
  },
  {
    id: "recorded_runs_same_session_exact_run",
    label: "Same-session Recorded Runs and exact-run no-fallback",
    unitAssertions: [
      UNIT.exactRun,
      UNIT.mergeRun,
      UNIT.currentRun,
      UNIT.missingRun,
    ],
    browserAssertions: [
      BROWSER.staticMerge,
      BROWSER.exactRun,
      BROWSER.noFallback,
    ],
    proofClass: "deterministic_local_browser_fixture",
    claimBoundary:
      "The rendered browser cases use intercepted read-only run fixtures. They do not prove hosted Neon history.",
  },
  {
    id: "unknown_received_amount_nullable",
    label: "Unknown received amount remains null",
    unitAssertions: [UNIT.nullableMoney, UNIT.replayMoney],
    browserAssertions: [],
    proofClass: "deterministic_local_contract",
    claimBoundary:
      "Zero cannot stand in for unknown received money; success still requires exact received money.",
  },
  {
    id: "one_token_motion",
    label: "Preparation, Pay, retrieve, and ticket one-token motion",
    unitAssertions: [
      UNIT.preparing,
      UNIT.pay,
      UNIT.retrieve,
      UNIT.ticket,
      UNIT.oneToken,
      UNIT.invalidToken,
    ],
    browserAssertions: [],
    proofClass: "deterministic_component_motion_contract",
    claimBoundary:
      "Proves the authored state-to-motion contract and one-token DOM invariant, not a captured real-time browser sequence.",
  },
  {
    id: "static_history",
    label: "Historical selection stays static until Replay",
    unitAssertions: [UNIT.staticTrace, UNIT.staticReplay],
    browserAssertions: [BROWSER.staticMerge],
    proofClass: "deterministic_local_browser_fixture",
    claimBoundary:
      "Historic facts do not animate on selection; explicit Replay is the only motion authority.",
  },
])

const EXCLUDED_DIRECTORIES_V1 = new Set([
  ".audit",
  ".git",
  ".next",
  ".cache",
  "artifacts",
  "coverage",
  "node_modules",
  "test-results",
])

function normalizedPathV1(root, path) {
  return relative(root, path).split(sep).join("/")
}

function excludedFileV1(path) {
  return path === "next-env.d.ts" || path === "tsconfig.tsbuildinfo"
}

async function candidateFilesV1(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true })
  const paths = []
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES_V1.has(entry.name)) {
      continue
    }
    const absolute = resolve(directory, entry.name)
    const relativePath = normalizedPathV1(root, absolute)
    if (entry.isDirectory()) {
      paths.push(...(await candidateFilesV1(root, absolute)))
      continue
    }
    if (!entry.isFile() || excludedFileV1(relativePath)) continue
    paths.push({ absolute, relativePath })
  }
  return paths
}

export async function computeCandidateDigestV1(root) {
  const resolvedRoot = resolve(root)
  const files = await candidateFilesV1(resolvedRoot)
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  const digest = createHash("sha256")
  digest.update("onsale-v01-recovery-candidate-v1\0")
  let totalBytes = 0
  for (const file of files) {
    const bytes = await readFile(file.absolute)
    totalBytes += bytes.byteLength
    digest.update(file.relativePath)
    digest.update("\0")
    digest.update(String(bytes.byteLength))
    digest.update("\0")
    digest.update(bytes)
    digest.update("\0")
  }
  return Object.freeze({
    algorithm: "sha256",
    digest: `sha256:${digest.digest("hex")}`,
    fileCount: files.length,
    totalBytes,
    exclusions: Object.freeze([
      ".git/",
      ".audit/",
      ".next/",
      ".cache/",
      "artifacts/",
      "coverage/",
      "node_modules/",
      "test-results/",
      "next-env.d.ts",
      "tsconfig.tsbuildinfo",
    ]),
  })
}

async function sha256FileV1(path) {
  const bytes = await readFile(path)
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function approvedDeltaV1(receipt, path, beforeSha256, afterSha256) {
  if (!Array.isArray(receipt.approvedExperienceDeltas)) return null
  return (
    receipt.approvedExperienceDeltas.find(
      (item) =>
        item &&
        item.path === path &&
        item.beforeSha256 === beforeSha256 &&
        item.afterSha256 === afterSha256 &&
        typeof item.reason === "string" &&
        item.reason.trim().length > 0 &&
        typeof item.approvalReference === "string" &&
        item.approvalReference.trim().length > 0 &&
        item.proof?.status === "passed" &&
        item.proof?.population === "current_candidate_browser" &&
        typeof item.proof?.artifact === "string" &&
        item.proof.artifact.trim().length > 0,
    ) ?? null
  )
}

export async function evaluateProtectedExperienceV1(root) {
  const receiptPath = resolve(root, ".audit/v01-recovery-base.json")
  let receipt
  try {
    receipt = JSON.parse(await readFile(receiptPath, "utf8"))
  } catch (error) {
    return {
      status: "failed",
      changedFiles: [],
      error: `Unable to read the protected experience receipt: ${error.message}`,
    }
  }
  if (
    receipt.recordType !== "onsale.v01-recovery-base.v1" ||
    !receipt.protectedFiles ||
    typeof receipt.protectedFiles !== "object"
  ) {
    return {
      status: "failed",
      changedFiles: [],
      error: "The protected experience receipt has the wrong schema.",
    }
  }

  const changedFiles = []
  const missingFiles = []
  for (const [path, beforeSha256] of Object.entries(
    receipt.protectedFiles,
  ).sort(([left], [right]) => left.localeCompare(right))) {
    const absolute = resolve(root, path)
    let afterSha256
    try {
      const stat = await lstat(absolute)
      if (!stat.isFile()) throw new Error("not a regular file")
      afterSha256 = await sha256FileV1(absolute)
    } catch {
      missingFiles.push(path)
      continue
    }
    if (afterSha256 === beforeSha256) continue
    const approved = approvedDeltaV1(
      receipt,
      path,
      beforeSha256,
      afterSha256,
    )
    changedFiles.push({
      path,
      beforeSha256,
      afterSha256,
      approvalStatus: approved ? "receipted" : "missing",
      ...(approved
        ? {
            reason: approved.reason,
            approvalReference: approved.approvalReference,
            proof: approved.proof,
          }
        : {}),
    })
  }
  const allChangesReceipted = changedFiles.every(
    (item) => item.approvalStatus === "receipted",
  )
  return {
    status:
      missingFiles.length === 0 && allChangesReceipted ? "passed" : "failed",
    receipt: ".audit/v01-recovery-base.json",
    protectedFileCount: Object.keys(receipt.protectedFiles).length,
    changedFiles,
    missingFiles,
  }
}

function evidenceV1(kind, name, status) {
  return { kind, name, status: status ?? "missing" }
}

export function evaluateLocalGatesV1({
  runtimeChecks,
  vitestAssertions,
  browserAssertions,
  candidateStable,
  protectedExperience,
}) {
  const gates = [
    {
      id: "candidate_identity",
      label: "One stable candidate digest",
      status: candidateStable ? "passed" : "failed",
      evidence: [
        {
          kind: "candidate_digest",
          name: "digest unchanged while evidence ran",
          status: candidateStable ? "passed" : "failed",
        },
      ],
      claimBoundary:
        "A changed digest invalidates the run rather than attaching evidence to a moving candidate.",
    },
    {
      id: "protected_experience_deltas",
      label: "Protected v0.1 experience deltas",
      status: protectedExperience.status,
      evidence: [
        {
          kind: "protected_experience_receipt",
          name: ".audit/v01-recovery-base.json",
          status: protectedExperience.status,
          changedFiles: protectedExperience.changedFiles,
          missingFiles: protectedExperience.missingFiles ?? [],
        },
      ],
      claimBoundary:
        "A protected file may differ only through an exact before/after receipt, direct approval reference, and current-candidate browser proof.",
    },
  ]

  for (const definition of LOCAL_GATE_DEFINITIONS_V1) {
    const evidence = []
    if (definition.runtimeChecks) {
      for (const check of runtimeChecks) {
        evidence.push(evidenceV1("runtime_check", check.id, check.status))
      }
    }
    for (const assertion of definition.unitAssertions) {
      evidence.push(
        evidenceV1(
          "vitest_assertion",
          assertion,
          vitestAssertions.get(assertion),
        ),
      )
    }
    for (const assertion of definition.browserAssertions) {
      evidence.push(
        evidenceV1(
          "next_browser_assertion",
          assertion,
          browserAssertions.get(assertion),
        ),
      )
    }
    gates.push({
      id: definition.id,
      label: definition.label,
      status: evidence.every((item) => item.status === "passed")
        ? "passed"
        : "failed",
      proofClass: definition.proofClass,
      claimBoundary: definition.claimBoundary,
      ...(definition.expectedIds
        ? { expectedIds: definition.expectedIds }
        : {}),
      evidence,
    })
  }
  return gates
}

export function buildExternalPopulationResultsV1() {
  const definitions = {
    live_provider: {
      owner: "official Hyperswitch sandbox action, return, retrieve, and repeat return",
      blocker: "No current-candidate provider transaction was authorized or run by this evaluator.",
    },
    hosted_neon: {
      owner: "hosted Neon migration plus isolated write and readback",
      blocker: "The evaluator makes no hosted database connection or mutation.",
    },
    deployment: {
      owner: "hosted origin, cookie, return URL, environment, revision, and post-deploy readback",
      blocker: "Deployment and publication remain separately approval-gated.",
    },
    named_human: {
      owner: "named-human comprehension and assistive-technology review",
      blocker: "Synthetic and automated checks cannot satisfy human evidence.",
    },
    motion_media: {
      owner: "current-candidate preparation, Pay, return, retrieve, and ticket motion capture",
      blocker: "Component assertions are not a motion capture.",
    },
  }
  return EXTERNAL_POPULATION_IDS_V1.map((id) => ({
    id,
    status: "blocked",
    ...definitions[id],
  }))
}

export function buildRecoveryManifestV1({
  generatedAt,
  candidateBefore,
  candidateAfter,
  runtime,
  localGates,
  unitPopulation,
  browserPopulation,
  commands = {},
}) {
  const localRecoveryStatus =
    localGates.every((gate) => gate.status === "passed") &&
    unitPopulation.status === "passed" &&
    browserPopulation.status === "passed"
    ? "passed"
    : "failed"
  const externalPopulations = buildExternalPopulationResultsV1()
  return {
    schema: "onsale.eval-v01-recovery.v1",
    generatedAt,
    evaluatorVersion: "1.0.0",
    candidate: {
      digest: candidateAfter.digest,
      beforeDigest: candidateBefore.digest,
      afterDigest: candidateAfter.digest,
      stable: candidateBefore.digest === candidateAfter.digest,
      fileCount: candidateAfter.fileCount,
      totalBytes: candidateAfter.totalBytes,
      exclusions: candidateAfter.exclusions,
    },
    runtime,
    commands,
    localRecoveryStatus,
    localGates,
    unitPopulation,
    browserPopulation,
    releaseStatus: localRecoveryStatus === "passed" ? "blocked" : "failed",
    externalPopulations,
    releaseBlockers: externalPopulations.map((population) => population.id),
  }
}
