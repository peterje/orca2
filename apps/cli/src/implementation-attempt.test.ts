import { Data, Effect } from "effect"
import { BunServices } from "@effect/platform-bun"
import { afterEach, describe, expect, it } from "bun:test"
import { FetchHttpClient } from "effect/unstable/http"
import { Layer } from "effect"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { ensureIssueWorktree } from "./git-worktree"
import {
  runImplementationAttempt,
  shortMissingPrRetryMs,
} from "./implementation-attempt"
import { LinearApiError } from "./linear"

const execFileAsync = promisify(execFile)
const tempDirectories = new Set<string>()

class TemporaryRefreshError extends Data.TaggedError(
  "TemporaryRefreshError",
)<{
  readonly message: string
}> {}

afterEach(async () => {
  await Promise.all(
    [...tempDirectories].map(async (directory) => {
      await rm(directory, { force: true, recursive: true })
      tempDirectories.delete(directory)
    }),
  )
})

const createRepository = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orca-attempt-"))
  tempDirectories.add(directory)

  await execFileAsync("git", ["init", "-b", "main"], { cwd: directory })
  await writeFile(path.join(directory, "README.md"), "hello attempt\n")
  await execFileAsync("git", ["add", "README.md"], { cwd: directory })
  await execFileAsync("git", ["commit", "-m", "initial commit"], {
    cwd: directory,
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "orca@example.com",
      GIT_AUTHOR_NAME: "Orca",
      GIT_COMMITTER_EMAIL: "orca@example.com",
      GIT_COMMITTER_NAME: "Orca",
    },
  })

  return directory
}

const issue = {
  blockers: [],
  branchName: null,
  createdAt: "2026-03-11T12:00:00.000Z",
  description: "implement the execution slice",
  id: "issue-1",
  identifier: "PET-47",
  labels: ["daemon"],
  linkedPullRequests: [],
  normalizedState: "runnable" as const,
  priority: 1,
  priorityRank: 1,
  stateName: "Todo",
  stateType: "unstarted",
  title: "run implementation attempts",
  updatedAt: "2026-03-11T12:01:00.000Z",
}

const baseConfig = {
  agent: {
    maxRetries: 5,
    maxRetryBackoffMs: 300_000,
    maxTurns: 1,
  },
  opencode: {
    startupTimeoutMs: 100,
    turnTimeoutMs: 1_000,
  },
  github: {
    apiUrl: "https://api.github.com",
    baseBranch: "main",
    owner: "peterje",
    repo: "orca2",
    token: "github-token",
  },
  greptile: {
    enabled: true,
    requiredScore: 4,
    summonComment: "@greptileai",
  },
  humanReview: {
    requireApproval: true,
    requireNoUnresolvedThreads: true,
  },
  linear: {
    activeStates: ["Todo", "In Progress"],
    apiKey: "linear-token",
    endpoint: "https://api.linear.app/graphql",
    projectSlug: "orca",
    terminalStates: ["Done", "Canceled"],
  },
  polling: {
    intervalMs: 5_000,
  },
  worktree: {
    repoRoot: "",
    root: "",
  },
} as const

describe("implementation attempt", () => {
  it("runs the agent in the issue worktree and waits once for a pull request", async () => {
    const repoRoot = await createRepository()
    const cwdOutputPath = path.join(repoRoot, "cwd.txt")
    const worktreeRoot = path.join(repoRoot, ".orca", "worktrees")

    let sleepCalls = 0

    const outcome = await Effect.runPromise(
      runImplementationAttempt({
        config: {
          ...baseConfig,
          worktree: {
            repoRoot,
            root: worktreeRoot,
          },
        },
        ensureWorktree: (currentIssue) =>
          ensureIssueWorktree({
            config: {
              github: {
                baseBranch: "main",
              },
              worktree: {
                repoRoot,
                root: worktreeRoot,
              },
            } as never,
            issue: currentIssue,
          }),
        issue,
        refreshIssues: () => Effect.succeed([issue]),
        runAgent: ({ cwd }) =>
          Effect.tryPromise(() => writeFile(cwdOutputPath, cwd)),
        sleep: (durationMs) =>
          Effect.sync(() => {
            sleepCalls += 1
            expect(durationMs).toBe(shortMissingPrRetryMs)
          }),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(BunServices.layer, FetchHttpClient.layer),
        ),
      ),
    )

    const observedCwd = await readFile(cwdOutputPath, "utf8")

    expect(outcome.state).toBe("WaitingForPr")
    expect(observedCwd).toBe(outcome.worktreePath)
    expect(sleepCalls).toBe(1)
  })

  it("detects a linked pull request on the short retry", async () => {
    const outcome = await Effect.runPromise(
      runImplementationAttempt({
        config: {
          ...baseConfig,
          worktree: {
            repoRoot: "/repo",
            root: "/repo/.orca/worktrees",
          },
        },
        ensureWorktree: () =>
          Effect.succeed({
            branchName: "pet-47",
            path: "/repo/.orca/worktrees/pet-47",
            reused: true,
          }),
        issue,
        refreshIssues: () =>
          Effect.succeed([
            {
              ...issue,
              linkedPullRequests: [
                {
                  attachmentId: "attachment-1",
                  number: 42,
                  owner: "peterje",
                  provider: "github" as const,
                  repo: "orca2",
                  title: "feat: run implementation attempts",
                  url: "https://github.com/peterje/orca2/pull/42",
                },
              ],
              normalizedState: "linked-pr-detected" as const,
            },
          ]),
        runAgent: () => Effect.void,
        sleep: () => Effect.void,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(BunServices.layer, FetchHttpClient.layer),
        ),
      ),
    )

    expect(outcome.state).toBe("LinkedPrDetected")
  })

  it("treats a transient linear refresh failure as waiting for pr", async () => {
    const outcome = await Effect.runPromise(
      runImplementationAttempt({
        config: {
          ...baseConfig,
          worktree: {
            repoRoot: "/repo",
            root: "/repo/.orca/worktrees",
          },
        },
        ensureWorktree: () =>
          Effect.succeed({
            branchName: "pet-47",
            path: "/repo/.orca/worktrees/pet-47",
            reused: true,
          }),
        issue,
        refreshIssues: () =>
          Effect.fail(
            new LinearApiError({
              message: "temporary linear outage",
            }),
          ),
        runAgent: () => Effect.void,
        sleep: () => Effect.void,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(BunServices.layer, FetchHttpClient.layer),
        ),
      ),
    )

    expect(outcome.state).toBe("WaitingForPr")
    expect(outcome.worktreePath).toBe("/repo/.orca/worktrees/pet-47")
  })

  it("treats a transient transport refresh failure as waiting for pr", async () => {
    const outcome = await Effect.runPromise(
      runImplementationAttempt({
        config: {
          ...baseConfig,
          worktree: {
            repoRoot: "/repo",
            root: "/repo/.orca/worktrees",
          },
        },
        ensureWorktree: () =>
          Effect.succeed({
            branchName: "pet-47",
            path: "/repo/.orca/worktrees/pet-47",
            reused: true,
          }),
        issue,
        refreshIssues: () =>
          Effect.fail(
            new TemporaryRefreshError({
              message: "temporary network reset during refresh",
            }),
          ),
        runAgent: () => Effect.void,
        sleep: () => Effect.void,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(BunServices.layer, FetchHttpClient.layer),
        ),
      ),
    )

    expect(outcome.state).toBe("WaitingForPr")
    expect(outcome.worktreePath).toBe("/repo/.orca/worktrees/pet-47")
  })
})
