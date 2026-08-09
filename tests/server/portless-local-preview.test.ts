import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import {
  buildPortlessLocalPreviewEnvironmentV1,
  portlessLocalPreviewArgumentsV1,
} from "../../scripts/portless-local-preview"

describe("v0.1 isolated named Portless launcher", () => {
  it("uses an explicit stable name and project-scoped state", () => {
    expect(portlessLocalPreviewArgumentsV1("dev", "http")).toEqual([
      "node_modules/portless/dist/cli.js",
      "--name",
      "onsale-v01",
      "--",
      process.execPath,
      "scripts/local-preview-runtime.ts",
      "dev",
    ])
    expect(
      buildPortlessLocalPreviewEnvironmentV1(
        {
          PORT: "9999",
          PORTLESS_URL: "https://global.localhost",
          ONSALE_ALLOWED_ORIGINS: "https://stale.example",
        },
        "/tmp/onsale-v01-native",
        "http",
      ),
    ).toMatchObject({
      ONSALE_PORTLESS_NAME: "onsale-v01",
      PORTLESS_HTTPS: "0",
      PORTLESS_LAN: "0",
      PORTLESS_PORT: "4310",
      PORTLESS_STATE_DIR:
        "/tmp/onsale-v01-recovery-portless-v012-http",
      PORTLESS_SYNC_HOSTS: "0",
      PORTLESS_TLD: "localhost",
    })
    const isolated = buildPortlessLocalPreviewEnvironmentV1(
      { PORT: "9999", PORTLESS_URL: "https://global.localhost" },
      "/tmp/onsale-v01-native",
      "http",
    )
    expect(isolated.PORT).toBeUndefined()
    expect(isolated.PORTLESS_URL).toBeUndefined()
    expect(isolated.ONSALE_ALLOWED_ORIGINS).toBeUndefined()
  })

  it("keeps proxy state stable when the native build mirror changes", () => {
    const first = buildPortlessLocalPreviewEnvironmentV1(
      {},
      "/tmp/onsale-v01-native-a",
      "http",
    )
    const second = buildPortlessLocalPreviewEnvironmentV1(
      {},
      "/tmp/onsale-v01-native-b",
      "http",
    )
    expect(first.PORTLESS_STATE_DIR).toBe(second.PORTLESS_STATE_DIR)
    expect(first.PORTLESS_STATE_DIR).toBe(
      "/tmp/onsale-v01-recovery-portless-v012-http",
    )
  })

  it("accepts a safe review-specific name without changing runtime code", () => {
    const environment = buildPortlessLocalPreviewEnvironmentV1(
      { ONSALE_PORTLESS_NAME: "onsale-review" },
      "/tmp/onsale-v01-native",
      "http",
    )
    expect(environment.ONSALE_PORTLESS_NAME).toBe("onsale-review")
    expect(
      portlessLocalPreviewArgumentsV1(
        "dev",
        "http",
        environment.ONSALE_PORTLESS_NAME,
      ),
    ).toContain("onsale-review")
    expect(() =>
      buildPortlessLocalPreviewEnvironmentV1(
        { ONSALE_PORTLESS_NAME: "Preview.Bad" },
        "/tmp/onsale-v01-native",
        "http",
      ),
    ).toThrow(/ONSALE_PORTLESS_NAME/iu)
  })

  it("pins the Node-22-compatible Portless and makes Next the default runtime", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
      scripts: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(packageJson.devDependencies.portless).toBe("0.12.0")
    expect(packageJson.scripts.dev).toBe(
      "bash scripts/native-node22.sh portless dev http",
    )
    expect(packageJson.scripts.build).toBe(
      "bash scripts/native-node22.sh build",
    )
    expect(packageJson.scripts.preview).toBe(
      "bash scripts/native-node22.sh portless start http",
    )
  })
})
