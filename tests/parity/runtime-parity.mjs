import { createHash } from "node:crypto"
import { readFile, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

import { chromium } from "@playwright/test"

import {
  baselineCommit,
  baselineSourceFiles,
  verifyBaselineContract,
} from "./baseline-contract.mjs"

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const expectedPath = join(repositoryRoot, "tests", "parity", "expected.json")
const recordOnly = process.argv.includes("--record")
const viteUrl = "http://127.0.0.1:44731"
const nextUrl = "http://127.0.0.1:44732"

const states = [
  "01-event",
  "02-eligibility",
  "03-seats-unselected",
  "04-hold-two-seats",
  "05-checkout",
  "06-action-overlay",
  "07-success",
  "08-hard-decline",
  "09-recoverable",
]

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

async function currentSources() {
  return Object.fromEntries(
    await Promise.all(
      baselineSourceFiles.map(async (path) => [
        path,
        await readFile(join(repositoryRoot, path), "utf8"),
      ]),
    ),
  )
}

function startServer(label, modulePath, args, cwd) {
  const child = spawn(process.execPath, [modulePath, ...args], {
    cwd,
    env: { ...process.env, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  const append = (chunk) => {
    output = `${output}${chunk}`.slice(-12000)
  }
  child.stdout.on("data", append)
  child.stderr.on("data", append)
  child.on("error", append)
  return { child, label, output: () => output }
}

async function runBuild(label, modulePath, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [modulePath, ...args], {
      cwd,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
        NODE_ENV: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    const append = (chunk) => {
      output = `${output}${chunk}`.slice(-20_000)
    }
    child.stdout.on("data", append)
    child.stderr.on("data", append)
    child.on("error", reject)
    child.on("exit", (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${label} failed (${code ?? signal})\n${output}`))
    })
  })
}

async function waitForServer(server, url) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(
        `${server.label} exited early (${server.child.exitCode})\n${server.output()}`,
      )
    }
    try {
      const response = await fetch(url, { redirect: "manual" })
      if (response.status >= 200 && response.status < 500) return
    } catch {
      // The process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`${server.label} did not become ready\n${server.output()}`)
}

async function stopServer(server) {
  if (server.child.exitCode !== null) return
  server.child.kill("SIGTERM")
  await Promise.race([
    new Promise((resolve) => server.child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ])
  if (server.child.exitCode === null) server.child.kill("SIGKILL")
}

async function clearIntervals(page) {
  await page.evaluate(() => {
    for (let id = 1; id <= 10_000; id += 1) window.clearInterval(id)
  })
}

async function enterSeatSelection(page) {
  await page.getByRole("button", { name: "JOIN QUEUE →", exact: true }).click()
  await page.getByRole("heading", { name: "Choose your seats" }).waitFor()
  await clearIntervals(page)
}

async function selectTwoSeats(page) {
  await enterSeatSelection(page)
  await page.getByTitle("A1", { exact: true }).click()
  await page.getByTitle("A2", { exact: true }).click()
  await page.getByText("Sec A · A1", { exact: true }).waitFor()
  await page.getByText("Sec A · A2", { exact: true }).waitFor()
}

async function enterCheckout(page) {
  await selectTwoSeats(page)
  await page.getByRole("button", { name: /PROCEED TO CHECKOUT/ }).click()
  await page.getByRole("heading", { name: "Secure checkout" }).waitFor()
  await clearIntervals(page)
}

async function setPaymentScenario(page, scenario) {
  await page
    .getByRole("button", { name: /SIMULATE PAYMENT FLOW/ })
    .evaluate((button, scenarioValue) => {
      const originalRandom = Math.random
      try {
        Math.random = () => scenarioValue
        button.click()
      } finally {
        Math.random = originalRandom
      }
    }, scenario)
}

async function driveState(page, state) {
  if (state === "01-event") {
    await page.getByRole("heading", { name: "PHANTOM CIRCUIT" }).waitFor()
    return
  }
  if (state === "02-eligibility") {
    await page
      .getByRole("button", { name: "VERIFY ACCESS →", exact: true })
      .click()
    await page.getByRole("heading", { name: "Verify presale access" }).waitFor()
    return
  }
  if (state === "03-seats-unselected") {
    await enterSeatSelection(page)
    return
  }
  if (state === "04-hold-two-seats") {
    await selectTwoSeats(page)
    return
  }

  await enterCheckout(page)
  if (state === "05-checkout") return
  if (state === "06-action-overlay") {
    await setPaymentScenario(page, 0.1)
    await page
      .getByText("3-D SECURE CHALLENGE", { exact: true })
      .waitFor({ timeout: 6_000 })
    await clearIntervals(page)
    return
  }
  if (state === "07-success") {
    await setPaymentScenario(page, 0.5)
    await page
      .getByText(/PAYMENT CONFIRMED · TICKET ISSUED/)
      .waitFor({ timeout: 8_000 })
    return
  }
  if (state === "08-hard-decline") {
    await setPaymentScenario(page, 0.75)
    await page
      .getByRole("heading", { name: "Payment declined" })
      .waitFor({ timeout: 6_000 })
    await clearIntervals(page)
    return
  }
  if (state === "09-recoverable") {
    await setPaymentScenario(page, 0.9)
    await page
      .getByRole("heading", { name: "Payment interrupted" })
      .waitFor({ timeout: 6_000 })
    await clearIntervals(page)
    return
  }
  throw new Error(`Unknown parity state: ${state}`)
}

async function settlePage(page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all(
      Array.from(document.images, (image) =>
        image.complete
          ? undefined
          : new Promise((resolve) => {
              image.addEventListener("load", resolve, { once: true })
              image.addEventListener("error", resolve, { once: true })
            }),
      ),
    )
  })
  await page.addStyleTag({
    content:
      "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}",
  })
}

async function capture(page) {
  const snapshot = await page.locator("#root").evaluate((root) => {
    const normalizeText = (text) =>
      text
        .replace(/\b\d{2}:\d{2}(?=\s+remaining)/g, "MM:SS")
        .replace(/\s+/g, " ")
        .trim()
    const serialize = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const value = normalizeText(node.textContent ?? "")
        return value ? value : null
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return null
      const element = /** @type {Element} */ (node)
      const inlineStyle = /** @type {HTMLElement} */ (element).style
      return {
        tag: element.tagName.toLowerCase(),
        attributes: Object.fromEntries(
          Array.from(element.attributes)
            .map(({ name, value }) => [
              name,
              name === "style"
                ? JSON.stringify(
                    Array.from(inlineStyle)
                      .sort()
                      .map((property) => [
                        property,
                        normalizeText(inlineStyle.getPropertyValue(property)),
                        inlineStyle.getPropertyPriority(property),
                      ]),
                  )
                : normalizeText(value),
            ])
            .sort(([left], [right]) => left.localeCompare(right)),
        ),
        children: Array.from(element.childNodes, serialize).filter(Boolean),
      }
    }
    const shell = root.firstElementChild
    const header = shell?.querySelector("header") ?? null
    const bodyGrid = header?.nextElementSibling ?? null
    const aside = bodyGrid?.children.item(2) ?? null
    const styleOf = (element, properties) => {
      if (!element) return null
      const style = getComputedStyle(element)
      return Object.fromEntries(
        properties.map((property) => [
          property,
          style.getPropertyValue(property),
        ]),
      )
    }
    return {
      dom: serialize(root),
      styles: {
        body: styleOf(document.body, [
          "background-color",
          "color",
          "font-family",
          "margin",
        ]),
        shell: styleOf(shell, [
          "display",
          "height",
          "overflow",
          "background-color",
        ]),
        header: styleOf(header, ["display", "height", "border-bottom-color"]),
        bodyGrid: styleOf(bodyGrid, ["display", "grid-template-columns"]),
        rail: styleOf(aside, ["background-color", "overflow-x", "overflow-y"]),
      },
    }
  })
  const screenshot = await page.screenshot({ animations: "disabled" })
  return {
    domSha256: sha256(JSON.stringify(snapshot.dom)),
    styleSha256: sha256(JSON.stringify(snapshot.styles)),
    screenshotSha256: sha256(screenshot),
    screenshot,
  }
}

async function captureState(context, baseUrl, state) {
  const page = await context.newPage()
  const diagnostics = []
  page.on("pageerror", (error) => {
    diagnostics.push({ type: "pageerror", message: error.message })
  })
  page.on("console", (message) => {
    if (message.type() === "error") {
      diagnostics.push({ type: "console.error", message: message.text() })
    }
  })
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" })
    await page.locator("#root").waitFor()
    await driveState(page, state)
    await settlePage(page)
    const result = await capture(page)
    if (diagnostics.length > 0) {
      throw new Error(
        `${baseUrl} ${state} emitted browser diagnostics:\n${JSON.stringify(diagnostics, null, 2)}`,
      )
    }
    return result
  } finally {
    await page.close()
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected)
    throw new Error(`${label}: expected ${expected}, received ${actual}`)
}

async function main() {
  const sources = await currentSources()
  const contract = await verifyBaselineContract(repositoryRoot, sources)
  const hashes = contract.baselineHashes
  const nodeModulesPath = contract.nodeModulesPath
  const runtimeRoot = contract.runtimeRoot
  let expected
  try {
    expected = recordOnly
      ? null
      : JSON.parse(await readFile(expectedPath, "utf8"))
    if (expected) {
      assertEqual(
        expected.baselineCommit,
        baselineCommit,
        "baseline commit",
      )
      for (const path of baselineSourceFiles) {
        assertEqual(hashes[path], expected.sourceSha256[path], `${path} SHA-256`)
      }
    }

    await runBuild(
      "Figma baseline Vite build",
      join(nodeModulesPath, "vite", "bin", "vite.js"),
      ["build", "--config", join(runtimeRoot, "vite.config.mjs")],
      runtimeRoot,
    )
    await runBuild(
      "Figma baseline Next build",
      join(nodeModulesPath, "next", "dist", "bin", "next"),
      ["build", "--webpack"],
      runtimeRoot,
    )
  } catch (error) {
    await rm(runtimeRoot, { recursive: true, force: true })
    throw error
  }

  const vite = startServer(
    "Vite preview",
    join(nodeModulesPath, "vite", "bin", "vite.js"),
    [
      "preview",
      "--config",
      join(runtimeRoot, "vite.config.mjs"),
      "--host",
      "127.0.0.1",
      "--port",
      "44731",
      "--strictPort",
    ],
    runtimeRoot,
  )
  const next = startServer(
    "Next production server",
    join(nodeModulesPath, "next", "dist", "bin", "next"),
    ["start", "--hostname", "127.0.0.1", "--port", "44732"],
    runtimeRoot,
  )
  const servers = [vite, next]
  let browser
  try {
    await Promise.all([
      waitForServer(vite, viteUrl),
      waitForServer(next, nextUrl),
    ])
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    })
    const stateResults = {}
    for (const state of states) {
      const [viteCapture, nextCapture] = await Promise.all([
        captureState(context, viteUrl, state),
        captureState(context, nextUrl, state),
      ])
      assertEqual(
        nextCapture.domSha256,
        viteCapture.domSha256,
        `${state} DOM parity`,
      )
      assertEqual(
        nextCapture.styleSha256,
        viteCapture.styleSha256,
        `${state} style parity`,
      )
      assertEqual(
        nextCapture.screenshotSha256,
        viteCapture.screenshotSha256,
        `${state} screenshot parity`,
      )
      if (expected) {
        assertEqual(
          viteCapture.domSha256,
          expected.states[state].domSha256,
          `${state} baseline DOM`,
        )
        assertEqual(
          viteCapture.styleSha256,
          expected.states[state].styleSha256,
          `${state} baseline styles`,
        )
        assertEqual(
          viteCapture.screenshotSha256,
          expected.states[state].screenshotSha256,
          `${state} baseline screenshot`,
        )
      }
      stateResults[state] = {
        domSha256: viteCapture.domSha256,
        styleSha256: viteCapture.styleSha256,
        screenshotSha256: viteCapture.screenshotSha256,
      }
    }
    await context.close()
    const record = {
      schemaVersion: 1,
      baselineCommit,
      viewport: { width: 1440, height: 1000 },
      sourceSha256: hashes,
      states: stateResults,
    }
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`)
  } finally {
    await browser?.close()
    await Promise.all(servers.map(stopServer))
    await rm(runtimeRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
