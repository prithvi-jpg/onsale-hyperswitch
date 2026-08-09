import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { readFile, realpath, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  EXPECTED_NAMED_ORIGIN_V1,
  EXPECTED_NEXT_VERSION_V1,
  EXPECTED_NODE_VERSION_V1,
  EXPECTED_PACKAGE_MANAGER_V1,
  PLAYWRIGHT_FILE_V1,
  VITEST_FILES_V1,
  buildRecoveryManifestV1,
  computeCandidateDigestV1,
  evaluateLocalGatesV1,
  evaluateProtectedExperienceV1,
} from "../evals/v01-recovery-contract.mjs"

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
)
const manifestPath = resolve(
  repositoryRoot,
  ".audit/eval-v01-recovery-manifest.json",
)
const temporaryManifestPath = `${manifestPath}.${process.pid}.tmp`
const temporaryVitestReport = `/tmp/eval-v01-recovery-vitest-${process.pid}.json`

function sha256V1(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function commandReceiptV1(result, command) {
  return {
    command,
    exitCode: result.status,
    signal: result.signal,
    stdoutSha256: sha256V1(result.stdout ?? ""),
    stderrSha256: sha256V1(result.stderr ?? ""),
  }
}

function runV1(command, args, environment = process.env) {
  return spawnSync(command, args, {
    cwd: repositoryRoot,
    env: environment,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
}

function vitestAssertionsV1(report) {
  const assertions = new Map()
  for (const suite of report?.testResults ?? []) {
    for (const assertion of suite.assertionResults ?? []) {
      assertions.set(assertion.fullName, assertion.status)
    }
  }
  return assertions
}

function visitPlaywrightSuitesV1(suites, assertions) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) {
      const passed =
        spec.ok === true &&
        (spec.tests ?? []).every((test) =>
          (test.results ?? []).some((result) => result.status === "passed"),
        )
      assertions.set(spec.title, passed ? "passed" : "failed")
    }
    visitPlaywrightSuitesV1(suite.suites, assertions)
  }
}

function playwrightAssertionsV1(report) {
  const assertions = new Map()
  visitPlaywrightSuitesV1(report?.suites, assertions)
  return assertions
}

function parseJsonOutputV1(output, label) {
  const start = output.indexOf("{")
  const end = output.lastIndexOf("}")
  if (start < 0 || end < start) {
    throw new Error(`${label} did not produce a JSON report.`)
  }
  return JSON.parse(output.slice(start, end + 1))
}

function populationStatusV1(exitCode, passed, total) {
  return exitCode === 0 && total > 0 && passed === total
    ? "passed"
    : "failed"
}

async function mainV1() {
  if (process.argv.length !== 2) {
    throw new Error("Usage: bash scripts/eval-v01-recovery.sh")
  }

  const candidateBefore = await computeCandidateDigestV1(repositoryRoot)
  const packageJson = JSON.parse(
    await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
  )
  const mise = await readFile(resolve(repositoryRoot, ".mise.toml"), "utf8")
  const dependencyRoot = await realpath(resolve(repositoryRoot, "node_modules"))

  const evaluatorTestCommand =
    `${process.execPath} --test evals/v01-recovery-evaluator.test.mjs`
  const evaluatorTest = runV1(process.execPath, [
    "--test",
    "evals/v01-recovery-evaluator.test.mjs",
  ])

  const unitCommand = [
    "bash scripts/native-node22.sh test",
    ...VITEST_FILES_V1,
    "--reporter=json",
  ].join(" ")
  const unitEnvironment = {
    ...process.env,
    ONSALE_NODE22_BIN: process.execPath,
    ONSALE_NATIVE_NODE_MODULES:
      process.env.ONSALE_NATIVE_NODE_MODULES ?? dependencyRoot,
    ONSALE_NATIVE_ROOT:
      process.env.ONSALE_EVAL_NATIVE_ROOT ??
      "/tmp/onsale-v01-recovery-eval-native",
  }
  const unitResult = runV1(
    "bash",
    [
      "scripts/native-node22.sh",
      "test",
      ...VITEST_FILES_V1,
      "--reporter=json",
      `--outputFile=${temporaryVitestReport}`,
    ],
    unitEnvironment,
  )

  let vitestReport = null
  let vitestReportError = null
  try {
    vitestReport = JSON.parse(await readFile(temporaryVitestReport, "utf8"))
  } catch (error) {
    vitestReportError = error.message
  } finally {
    await unlink(temporaryVitestReport).catch(() => undefined)
  }

  const browserCommand = [
    process.execPath,
    "node_modules/@playwright/test/cli.js test",
    PLAYWRIGHT_FILE_V1,
    "--config=playwright.next.config.ts",
    "--reporter=json",
  ].join(" ")
  const browserResult = runV1(
    process.execPath,
    [
      "node_modules/@playwright/test/cli.js",
      "test",
      PLAYWRIGHT_FILE_V1,
      "--config=playwright.next.config.ts",
      "--reporter=json",
    ],
    unitEnvironment,
  )

  let playwrightReport = null
  let playwrightReportError = null
  try {
    playwrightReport = parseJsonOutputV1(
      browserResult.stdout ?? "",
      "Playwright",
    )
  } catch (error) {
    playwrightReportError = error.message
  }

  const protectedExperience =
    await evaluateProtectedExperienceV1(repositoryRoot)
  const candidateAfter = await computeCandidateDigestV1(repositoryRoot)
  const candidateStable =
    candidateBefore.digest === candidateAfter.digest

  const runtimeChecks = [
    {
      id: `node=${EXPECTED_NODE_VERSION_V1}`,
      status:
        process.version === EXPECTED_NODE_VERSION_V1 ? "passed" : "failed",
      observed: process.version,
    },
    {
      id: `next=${EXPECTED_NEXT_VERSION_V1}`,
      status:
        packageJson.dependencies?.next === EXPECTED_NEXT_VERSION_V1
          ? "passed"
          : "failed",
      observed: packageJson.dependencies?.next ?? null,
    },
    {
      id: `packageManager=${EXPECTED_PACKAGE_MANAGER_V1}`,
      status:
        packageJson.packageManager === EXPECTED_PACKAGE_MANAGER_V1
          ? "passed"
          : "failed",
      observed: packageJson.packageManager ?? null,
    },
    {
      id: "default-dev=named-next",
      status:
        packageJson.scripts?.dev ===
        "bash scripts/native-node22.sh portless dev http"
          ? "passed"
          : "failed",
      observed: packageJson.scripts?.dev ?? null,
    },
    {
      id: "mise-node=22.23.2",
      status: /node\s*=\s*["']22\.23\.2["']/u.test(mise)
        ? "passed"
        : "failed",
    },
    {
      id: "linux-native-dependencies",
      status:
        dependencyRoot.startsWith("/mnt/c/") ||
        dependencyRoot.startsWith("/mnt/C/")
          ? "failed"
          : "passed",
      observed: dependencyRoot,
    },
    {
      id: "evaluator-self-test",
      status: evaluatorTest.status === 0 ? "passed" : "failed",
    },
  ]

  const vitestAssertions = vitestAssertionsV1(vitestReport)
  const browserAssertions = playwrightAssertionsV1(playwrightReport)
  const localGates = evaluateLocalGatesV1({
    runtimeChecks,
    vitestAssertions,
    browserAssertions,
    candidateStable,
    protectedExperience,
  })

  const unitTotal = vitestReport?.numTotalTests ?? 0
  const unitPassed = vitestReport?.numPassedTests ?? 0
  const browserTotal = playwrightReport?.stats?.expected ?? 0
  const browserUnexpected = playwrightReport?.stats?.unexpected ?? 0
  const browserFlaky = playwrightReport?.stats?.flaky ?? 0
  const browserPassed = Math.max(
    0,
    browserTotal - browserUnexpected - browserFlaky,
  )

  const manifest = buildRecoveryManifestV1({
    generatedAt: new Date().toISOString(),
    candidateBefore,
    candidateAfter,
    runtime: {
      nodeVersion: process.version,
      nextVersion: packageJson.dependencies?.next ?? null,
      packageManager: packageJson.packageManager ?? null,
      namedOrigin: EXPECTED_NAMED_ORIGIN_V1,
      namedRuntimeProofClass: "deterministic_local_contract",
      dependencyRoot,
    },
    localGates,
    unitPopulation: {
      id: "focused_vitest",
      status: populationStatusV1(
        unitResult.status,
        unitPassed,
        unitTotal,
      ),
      total: unitTotal,
      passed: unitPassed,
      failed: vitestReport?.numFailedTests ?? unitTotal - unitPassed,
      reportSha256: vitestReport
        ? sha256V1(JSON.stringify(vitestReport))
        : null,
      reportError: vitestReportError,
      ...commandReceiptV1(unitResult, unitCommand),
    },
    browserPopulation: {
      id: "next_browser_read_fixture",
      status: populationStatusV1(
        browserResult.status,
        browserPassed,
        browserTotal,
      ),
      proofClass: "intercepted_read_only_fixture",
      total: browserTotal,
      passed: browserPassed,
      failed: browserUnexpected + browserFlaky,
      reportSha256: playwrightReport
        ? sha256V1(JSON.stringify(playwrightReport))
        : null,
      reportError: playwrightReportError,
      ...commandReceiptV1(browserResult, browserCommand),
    },
    commands: {
      run: "bash scripts/eval-v01-recovery.sh",
      evaluatorTest: evaluatorTestCommand,
      unit: unitCommand,
      browser: browserCommand,
    },
  })

  await writeFile(
    temporaryManifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  await rename(temporaryManifestPath, manifestPath)

  process.stdout.write(
    [
      `candidate ${manifest.candidate.digest}`,
      `local ${manifest.localRecoveryStatus}`,
      `release ${manifest.releaseStatus}`,
      `unit ${manifest.unitPopulation.passed}/${manifest.unitPopulation.total}`,
      `browser ${manifest.browserPopulation.passed}/${manifest.browserPopulation.total}`,
      `manifest ${manifestPath}`,
    ].join("\n") + "\n",
  )
  if (manifest.localRecoveryStatus !== "passed") process.exitCode = 1
}

mainV1().catch(async (error) => {
  await unlink(temporaryVitestReport).catch(() => undefined)
  await unlink(temporaryManifestPath).catch(() => undefined)
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
