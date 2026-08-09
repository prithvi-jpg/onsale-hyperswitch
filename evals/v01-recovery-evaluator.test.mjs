import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  EXTERNAL_POPULATION_IDS_V1,
  STORY_LAB_IDS_V1,
  buildExternalPopulationResultsV1,
  buildRecoveryManifestV1,
  computeCandidateDigestV1,
  evaluateLocalGatesV1,
  evaluateProtectedExperienceV1,
} from "./v01-recovery-contract.mjs"

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "onsale-eval-v01-"))
  await mkdir(join(root, ".audit"), { recursive: true })
  await mkdir(join(root, "src"), { recursive: true })
  await writeFile(join(root, "src", "App.tsx"), "accepted\n")
  await writeFile(
    join(root, ".audit", "v01-recovery-base.json"),
    JSON.stringify({
      recordType: "onsale.v01-recovery-base.v1",
      protectedFiles: {
        "src/App.tsx":
          "sha256:4825c38ba9e071bc3e19961e7c1bd0c1a2fcc575a5cff7e416d7f7c772597271",
      },
    }),
  )
  return root
}

test("locks the accepted Story Lab taxonomy and blocked external populations", () => {
  assert.deepEqual(STORY_LAB_IDS_V1, [
    "confirmed-payment",
    "action-required",
    "terminal-decline",
    "lost-response-recovery",
    "fixture-label-counterexample",
    "checkout-configuration-boundary",
  ])
  assert.deepEqual(EXTERNAL_POPULATION_IDS_V1, [
    "live_provider",
    "hosted_neon",
    "deployment",
    "named_human",
    "motion_media",
  ])
  assert.ok(
    buildExternalPopulationResultsV1().every(
      (population) => population.status === "blocked",
    ),
  )
})

test("candidate identity changes with source bytes but excludes generated and audit state", async () => {
  const root = await fixtureRoot()
  const first = await computeCandidateDigestV1(root)
  await writeFile(
    join(root, ".audit", "eval-v01-recovery-manifest.json"),
    '{"transient":true}\n',
  )
  const afterReceipt = await computeCandidateDigestV1(root)
  assert.deepEqual(afterReceipt, first)

  await writeFile(
    join(root, ".audit", "v01-recovery-base.json"),
    '{"receipt":"updated"}\n',
  )
  await writeFile(
    join(root, "next-env.d.ts"),
    'import "./.next/dev/types/routes.d.ts";\n',
  )
  const afterGeneratedState = await computeCandidateDigestV1(root)
  assert.deepEqual(afterGeneratedState, first)

  await writeFile(join(root, "src", "App.tsx"), "changed\n")
  const changed = await computeCandidateDigestV1(root)
  assert.notEqual(changed.digest, first.digest)
})

test("protected experience fails closed on an unreceipted delta", async () => {
  const root = await fixtureRoot()
  const accepted = await evaluateProtectedExperienceV1(root)
  assert.equal(accepted.status, "passed")

  await writeFile(join(root, "src", "App.tsx"), "unapproved\n")
  const changed = await evaluateProtectedExperienceV1(root)
  assert.equal(changed.status, "failed")
  assert.deepEqual(changed.changedFiles.map((item) => item.path), [
    "src/App.tsx",
  ])
})

test("a missing owning assertion fails only its local gate", () => {
  const fixture = {
    runtimeChecks: [{ id: "node", status: "passed" }],
    vitestAssertions: new Map(),
    browserAssertions: new Map(),
    candidateStable: true,
    protectedExperience: { status: "passed", changedFiles: [] },
  }
  const gates = evaluateLocalGatesV1(fixture)
  assert.equal(
    gates.find((gate) => gate.id === "candidate_identity")?.status,
    "passed",
  )
  assert.equal(
    gates.find((gate) => gate.id === "protected_experience_deltas")?.status,
    "passed",
  )
  assert.equal(
    gates.find((gate) => gate.id === "story_lab_six_accepted_ids")?.status,
    "failed",
  )
})

test("release remains blocked even when the local population is green", async () => {
  const root = await fixtureRoot()
  const candidate = await computeCandidateDigestV1(root)
  const manifest = buildRecoveryManifestV1({
    generatedAt: "2026-08-09T20:00:00.000Z",
    candidateBefore: candidate,
    candidateAfter: candidate,
    runtime: { nodeVersion: "v22.23.2", nextVersion: "16.3.0" },
    localGates: [{ id: "only", status: "passed", evidence: [] }],
    unitPopulation: { status: "passed", total: 1, passed: 1 },
    browserPopulation: { status: "passed", total: 1, passed: 1 },
  })

  assert.equal(manifest.localRecoveryStatus, "passed")
  assert.equal(manifest.releaseStatus, "blocked")
  assert.ok(
    manifest.externalPopulations.every(
      (population) => population.status === "blocked",
    ),
  )
  assert.equal(
    JSON.parse(
      await readFile(
        join(root, ".audit", "v01-recovery-base.json"),
        "utf8",
      ),
    ).recordType,
    "onsale.v01-recovery-base.v1",
  )
})

test("an unmapped failing selected test still fails the local population", async () => {
  const root = await fixtureRoot()
  const candidate = await computeCandidateDigestV1(root)
  const manifest = buildRecoveryManifestV1({
    generatedAt: "2026-08-09T20:00:00.000Z",
    candidateBefore: candidate,
    candidateAfter: candidate,
    runtime: { nodeVersion: "v22.23.2", nextVersion: "16.3.0" },
    localGates: [{ id: "mapped", status: "passed", evidence: [] }],
    unitPopulation: { status: "failed", total: 2, passed: 1 },
    browserPopulation: { status: "passed", total: 1, passed: 1 },
  })

  assert.equal(manifest.localRecoveryStatus, "failed")
  assert.equal(manifest.releaseStatus, "failed")
})
