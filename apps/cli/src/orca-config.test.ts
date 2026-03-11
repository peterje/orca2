import { Effect, Schema } from "effect"
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { decodeOrcaConfig, loadOrcaConfig } from "./orca-config"

const tempDirectories = new Set<string>()

afterEach(async () => {
  await Promise.all(
    [...tempDirectories].map(async (directory) => {
      await rm(directory, { recursive: true, force: true })
      tempDirectories.delete(directory)
    }),
  )
})

describe("orca config", () => {
  it("decodes a valid config object", async () => {
    const config = await Effect.runPromise(
      decodeOrcaConfig({
        linear: {
          apiKey: "linear-token",
          endpoint: "https://api.linear.app/graphql",
          projectSlug: "orca",
          activeStates: ["Todo", "In Progress"],
          terminalStates: ["Done", "Canceled"],
        },
        github: {
          token: "github-token",
          apiUrl: "https://api.github.com",
          owner: "peterje",
          repo: "orca2",
          baseBranch: "main",
        },
        polling: {
          intervalMs: 5_000,
        },
        worktree: {
          repoRoot: ".",
          root: ".orca/worktrees",
        },
        agent: {
          maxTurns: 12,
          maxRetryBackoffMs: 300_000,
        },
        codex: {
          executable: "codex",
          args: ["app-server"],
          turnTimeoutMs: 3_600_000,
          readTimeoutMs: 5_000,
          stallTimeoutMs: 300_000,
        },
        greptile: {
          enabled: true,
          summonComment: "@greptileai",
          requiredScore: 5,
        },
        humanReview: {
          requireApproval: true,
          requireNoUnresolvedThreads: true,
        },
      }),
    )

    expect(config.linear.projectSlug).toBe("orca")
    expect(config.polling.intervalMs).toBe(5_000)
  })

  it("fails fast with a schema error for invalid config", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        decodeOrcaConfig({
          linear: {
            apiKey: undefined,
            endpoint: "https://api.linear.app/graphql",
            projectSlug: "orca",
            activeStates: ["Todo"],
            terminalStates: ["Done"],
          },
        }),
      ),
    )

    expect(Schema.isSchemaError(failure)).toBe(true)
    if (!Schema.isSchemaError(failure)) {
      throw failure
    }
    expect(String(failure.issue)).toContain("Expected string, got undefined")
  })

  it("loads a ts config file from disk", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "orca-config-"))
    tempDirectories.add(directory)

    const configPath = path.join(directory, "orca.config.ts")
    await writeFile(
      configPath,
      `export default {
  linear: {
    apiKey: "linear-token",
    endpoint: "https://api.linear.app/graphql",
    projectSlug: "orca",
    activeStates: ["Todo", "In Progress"],
    terminalStates: ["Done", "Canceled"]
  },
  github: {
    token: "github-token",
    apiUrl: "https://api.github.com",
    owner: "peterje",
    repo: "orca2",
    baseBranch: "main"
  },
  polling: {
    intervalMs: 5000
  },
  worktree: {
    repoRoot: ".",
    root: ".orca/worktrees"
  },
  agent: {
    maxTurns: 12,
    maxRetryBackoffMs: 300000
  },
  codex: {
    executable: "codex",
    args: ["app-server"],
    turnTimeoutMs: 3600000,
    readTimeoutMs: 5000,
    stallTimeoutMs: 300000
  },
  greptile: {
    enabled: true,
    summonComment: "@greptileai",
    requiredScore: 5
  },
  humanReview: {
    requireApproval: true,
    requireNoUnresolvedThreads: true
  }
} as const
`,
    )

    const loaded = await Effect.runPromise(loadOrcaConfig(configPath))

    expect(loaded.resolvedPath).toBe(configPath)
    expect(loaded.config.github.repo).toBe("orca2")
  })
})
