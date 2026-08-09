import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join } from "node:path"
import { promisify } from "node:util"

import ts from "typescript"

export const baselineCommit = "8dede8f296f2d74359e8d1e95734687e18c5a8e5"
export const baselineSourceFiles = [
  "src/App.tsx",
  "src/MechanismRail.tsx",
  "src/index.css",
]

const execFileAsync = promisify(execFile)

// These selected App declarations form the shared visual-leaf contract. The
// complete nine-state control, including its historical rail, is rendered from
// the exact baseline Git sources below. Production does not retain a second,
// unreachable copy of that simulator.
const appDeclarations = [
  "B",
  "B05",
  "B10",
  "B20",
  "GREEN",
  "RED",
  "AMBER",
  "DARK",
  "MONO",
  "SANS",
  "EVENT",
  "dotGridStyle",
  "Tag",
  "LiveDot",
  "Label",
  "QRCode",
  "FLOW_STEPS",
  "stepIndex",
  "StageProscenium",
]

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

async function gitSource(repositoryRoot, path) {
  const { stdout } = await execFileAsync(
    "git",
    ["show", `${baselineCommit}:${path}`],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  )
  return stdout
}

function sourceFile(path, source) {
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function declarationName(node) {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node)) &&
    node.name
  ) {
    return node.name.text
  }
  if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
    const [declaration] = node.declarationList.declarations
    return ts.isIdentifier(declaration.name) ? declaration.name.text : null
  }
  return null
}

function findDeclaration(file, name) {
  const match = file.statements.find((node) => declarationName(node) === name)
  if (!match) throw new Error(`${file.fileName}: missing frozen declaration ${name}`)
  return match
}

function emittedTokens(snippet, fileName) {
  const emitted = ts.transpileModule(snippet, {
    fileName,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      removeComments: true,
    },
    reportDiagnostics: true,
  })
  const errors = (emitted.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  if (errors.length > 0) {
    throw new Error(
      `${fileName}: could not emit frozen declaration\n${errors
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
        .join("\n")}`,
    )
  }

  const emittedFile = ts.createSourceFile(
    fileName.replace(/\.tsx$/, ".js"),
    emitted.outputText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  )
  const semanticTree = (node) => {
    const children = []
    node.forEachChild((child) => children.push(semanticTree(child)))
    let value = null
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) value = node.text
    else if (
      ts.isStringLiteral(node) ||
      ts.isNumericLiteral(node) ||
      ts.isBigIntLiteral(node) ||
      ts.isRegularExpressionLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node)
    ) {
      value = node.text
    }
    const declarationFlags = ts.isVariableDeclarationList(node)
      ? node.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)
      : 0
    return [node.kind, declarationFlags, value, children]
  }
  return JSON.stringify(semanticTree(emittedFile))
}

function declarationSignature(file, name) {
  const node = findDeclaration(file, name)
  return emittedTokens(node.getText(file), `${file.fileName}.${name}.tsx`)
}

function assertSignature(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} changed relative to ${baselineCommit}. ` +
        "Keep production behavior outside the frozen Figma baseline or review the baseline explicitly.",
    )
  }
}

function verifyDeclarations(currentFile, baselineFile, names, label) {
  for (const name of names) {
    assertSignature(
      declarationSignature(currentFile, name),
      declarationSignature(baselineFile, name),
      `${label} ${name}`,
    )
  }
}

function baselineCssSlice(currentCss) {
  const marker = "/* ── C2 inventory inhabitation"
  const markerIndex = currentCss.indexOf(marker)
  if (markerIndex < 0 || currentCss.indexOf(marker, markerIndex + marker.length) >= 0) {
    throw new Error("src/index.css: expected one C2 production boundary marker")
  }
  return currentCss.slice(0, markerIndex)
}

// Browser snapshots deliberately disable transitions and animation. Compare all
// static declarations/keyframes used by the frozen nine states while excluding
// only transition declarations from this static contract. Motion remains
// guarded by the emitted App/rail semantics and the production motion tests.
function staticCssSignature(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?:^|[;{])\s*transition(?:-[\w-]+)?\s*:[^;}]*;?/gi, (match) =>
      match.startsWith("{") ? "{" : ";",
    )
    .replace(/\s+/g, "")
}

async function writeRuntimeProject(repositoryRoot, baselineSources, cssSource) {
  // Next builds can stall for minutes on the Windows-mounted workspace. Keep
  // the generated, disposable harness on the native filesystem while linking
  // the already-installed dependency tree byte-for-byte.
  const nativeTempRoot = process.platform === "win32" ? tmpdir() : "/tmp"
  const runtimeRoot = await mkdtemp(join(nativeTempRoot, "onsale-runtime-parity-"))
  const requestedNodeModules = process.env.ONSALE_PARITY_NODE_MODULES
  if (requestedNodeModules && !isAbsolute(requestedNodeModules)) {
    throw new Error("ONSALE_PARITY_NODE_MODULES must be an absolute node_modules path")
  }
  const nodeModulesPath = await realpath(
    requestedNodeModules ?? join(repositoryRoot, "node_modules"),
  )
  if (basename(nodeModulesPath) !== "node_modules" || !(await stat(nodeModulesPath)).isDirectory()) {
    throw new Error("ONSALE_PARITY_NODE_MODULES must resolve to a node_modules directory")
  }
  await symlink(nodeModulesPath, join(runtimeRoot, "node_modules"), "dir")

  const files = {
    "package.json": JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: {
          next: "16.3.0",
          react: "^19.0.0",
          "react-dom": "^19.0.0",
        },
      },
      null,
      2,
    ),
    "tsconfig.json": JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["dom", "dom.iterable", "esnext"],
          allowJs: false,
          skipLibCheck: true,
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          module: "esnext",
          moduleResolution: "bundler",
          resolveJsonModule: true,
          isolatedModules: true,
          jsx: "preserve",
          incremental: true,
          plugins: [{ name: "next" }],
        },
        include: ["**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
        exclude: ["node_modules"],
      },
      null,
      2,
    ),
    "next-env.d.ts": '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n',
    "next.config.ts": `import type { NextConfig } from "next"\n\nconst nextConfig: NextConfig = { images: { disableStaticImages: true } }\nexport default nextConfig\n`,
    "postcss.config.mjs": `const config = { plugins: { "@tailwindcss/postcss": {} } }\nexport default config\n`,
    "vite.config.mjs": `import { defineConfig } from "vite"\nimport react from "@vitejs/plugin-react"\nimport tailwindcss from "@tailwindcss/vite"\n\nexport default defineConfig({\n  plugins: [react(), tailwindcss()],\n  build: { outDir: "dist", emptyOutDir: true, minify: true },\n})\n`,
    "index.html": `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>ONSALE</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n`,
    "src/main.tsx": `import React from "react"\nimport ReactDOM from "react-dom/client"\nimport App from "./App"\nimport "./index.css"\n\nReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>)\n`,
    "src/App.tsx": baselineSources["src/App.tsx"],
    "src/MechanismRail.tsx": baselineSources["src/MechanismRail.tsx"],
    "src/index.css": cssSource,
    "app/layout.tsx": `import type { ReactNode } from "react"\nimport "../src/index.css"\n\nexport default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {\n  return <html lang="en"><body><div id="root">{children}</div></body></html>\n}\n`,
    "app/figma-app.tsx": `"use client"\nimport App from "../src/App"\nexport default function FigmaApp() { return <App /> }\n`,
    "app/page.tsx": `import FigmaApp from "./figma-app"\nexport default function HomePage() { return <FigmaApp /> }\n`,
  }

  await Promise.all(
    Object.entries(files).map(async ([path, contents]) => {
      const absolutePath = join(runtimeRoot, path)
      await mkdir(join(absolutePath, ".."), { recursive: true })
      await writeFile(absolutePath, contents)
    }),
  )
  return { nodeModulesPath, runtimeRoot }
}

export async function verifyBaselineContract(repositoryRoot, currentSources) {
  const baselineSources = Object.fromEntries(
    await Promise.all(
      baselineSourceFiles.map(async (path) => [path, await gitSource(repositoryRoot, path)]),
    ),
  )

  const baselineApp = sourceFile("baseline/src/App.tsx", baselineSources["src/App.tsx"])
  const currentApp = sourceFile("current/src/App.tsx", currentSources["src/App.tsx"])
  verifyDeclarations(currentApp, baselineApp, appDeclarations, "App baseline declaration")

  const cssSlice = baselineCssSlice(currentSources["src/index.css"])
  assertSignature(
    staticCssSignature(cssSlice),
    staticCssSignature(baselineSources["src/index.css"]),
    "baseline static CSS declarations",
  )

  const runtime = await writeRuntimeProject(repositoryRoot, baselineSources, cssSlice)
  return {
    baselineSources,
    baselineHashes: Object.fromEntries(
      baselineSourceFiles.map((path) => [path, sha256(baselineSources[path])]),
    ),
    nodeModulesPath: runtime.nodeModulesPath,
    runtimeRoot: runtime.runtimeRoot,
  }
}
