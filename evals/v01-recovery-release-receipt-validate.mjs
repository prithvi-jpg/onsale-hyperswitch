import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const receiptPath = resolve(root, ".audit/v01-recovery-base.json")
const exactOrigin = "http://onsale-v01.localhost:4310"

const acceptedBaseline = {
  "src/App.tsx": "sha256:3c624e54db44751b00089469687d8d7e8706d66af5fbff51b1a073cd07c98c70",
  "src/MechanismRail.tsx": "sha256:14f5aa28f442aa9bf21075b3756a17a77f3937c18bfaf1c5637cd99ccc18eb7a",
  "src/PaymentTraceMap.tsx": "sha256:a3db305e849fab0f029cb7a1e40c7512e42d802d5b82c0e5897b14f31258f6fe",
  "src/payment-trace/trace-geometry.ts": "sha256:2c52bfdc77c74c10f1decd735daae3a7ca19c06abeb21cea20bd540f19acef14",
  "src/index.css": "sha256:6141b286e1948be0c375f961b26c5e1b0a4aba818afeb87e52c252a4e4ec0786",
  "app/flows/FlowsGallery.tsx": "sha256:270ef509fb6907c45a1db36e651271bd5963e976846846e524ec68f9a8bc0913",
  "app/flows/flows.module.css": "sha256:ccc7087e6a4f6ea3a99d1f96e218c67291e6f96c9a8928ade0040d650104cc22",
  "app/flows/replay.ts": "sha256:78063a6650edef99f9fa69918ea99d5af0910d6ab8c110d36708ef3aac2d7909",
}

function invariant(value, message) {
  if (!value) throw new Error(message)
}

async function sha256(path) {
  const bytes = await readFile(path)
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

const receipt = JSON.parse(await readFile(receiptPath, "utf8"))
invariant(
  receipt.recordType === "onsale.v01-recovery-base.v1",
  "Unexpected recovery-base receipt schema.",
)
invariant(
  JSON.stringify(receipt.protectedFiles) === JSON.stringify(acceptedBaseline),
  "The accepted protected-file baseline was rewritten.",
)
invariant(
  Array.isArray(receipt.approvedBoundaryDeltas) &&
    receipt.approvedBoundaryDeltas.length === 1,
  "Expected one runtime/session/return boundary change set.",
)
invariant(
  Array.isArray(receipt.approvedExperienceDeltas),
  "Approved experience deltas are missing.",
)

for (const changeSet of receipt.approvedBoundaryDeltas) {
  invariant(changeSet.changeSetId === "v01-runtime-session-return", "Unexpected boundary change set.")
  invariant(Array.isArray(changeSet.proofIds) && changeSet.proofIds.length > 0, "Boundary proof IDs are missing.")
  for (const item of changeSet.paths) {
    invariant(
      (await sha256(resolve(root, item.path))) === item.afterSha256,
      `Boundary after hash does not match ${item.path}.`,
    )
  }
}

const deltasByPath = new Map(
  receipt.approvedExperienceDeltas.map((item) => [item.path, item]),
)
const changedPaths = []
for (const [path, beforeSha256] of Object.entries(acceptedBaseline)) {
  const afterSha256 = await sha256(resolve(root, path))
  if (afterSha256 === beforeSha256) continue
  changedPaths.push(path)
  const delta = deltasByPath.get(path)
  invariant(delta, `Missing approved experience delta for ${path}.`)
  invariant(delta.beforeSha256 === beforeSha256, `Before hash mismatch for ${path}.`)
  invariant(delta.afterSha256 === afterSha256, `After hash mismatch for ${path}.`)
  invariant(delta.approvalReference === receipt.approval.reference, `Approval reference mismatch for ${path}.`)
  invariant(Array.isArray(delta.proofIds) && delta.proofIds.length > 0, `Proof IDs are missing for ${path}.`)
  invariant(delta.proof?.status === "passed", `Current-candidate browser proof is not passed for ${path}.`)
  invariant(delta.proof?.population === "current_candidate_browser", `Wrong proof population for ${path}.`)
  const artifactPath = resolve(root, delta.proof.artifact)
  invariant(
    (await sha256(artifactPath)) === delta.proof.artifactSha256,
    `Browser receipt hash mismatch for ${path}.`,
  )
  const browserReceipt = JSON.parse(await readFile(artifactPath, "utf8"))
  invariant(browserReceipt.schema === "onsale.browser-receipt.v1", "Unexpected browser receipt schema.")
  invariant(browserReceipt.candidateUrl === exactOrigin, "Browser receipt uses the wrong exact origin.")
  invariant(browserReceipt.passed === true, "Browser receipt is not passed.")
}

invariant(
  receipt.approvedExperienceDeltas.every((item) => changedPaths.includes(item.path)),
  "An experience delta names a protected file that did not change.",
)

process.stdout.write(
  `${JSON.stringify(
    {
      schema: receipt.recordType,
      exactOrigin,
      protectedBaselinePreserved: true,
      boundaryChangeSets: receipt.approvedBoundaryDeltas.length,
      approvedExperienceDeltas: changedPaths,
      status: "passed",
    },
    null,
    2,
  )}\n`,
)
