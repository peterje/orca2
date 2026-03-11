import { Effect } from "effect"
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { ensureIssueWorktree } from "./git-worktree"

const execFileAsync = promisify(execFile)
const tempDirectories = new Set<string>()

afterEach(async () => {
  await Promise.all(
    [...tempDirectories].map(async (directory) => {
      await rm(directory, { force: true, recursive: true })
      tempDirectories.delete(directory)
    }),
  )
})

const createRepository = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orca-worktree-"))
  tempDirectories.add(directory)

  await execFileAsync("git", ["init", "-b", "main"], { cwd: directory })
  await writeFile(path.join(directory, "README.md"), "hello worktree\n")
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

describe("git worktree", () => {
  it("creates and then reuses an issue worktree", async () => {
    const repoRoot = await createRepository()
    const worktreeRoot = path.join(repoRoot, ".orca", "worktrees")

    const created = await Effect.runPromise(
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
        issue,
      }),
    )

    const reused = await Effect.runPromise(
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
        issue,
      }),
    )

    const branch = await execFileAsync("git", ["branch", "--show-current"], {
      cwd: created.path,
    })

    expect(created.reused).toBe(false)
    expect(reused.reused).toBe(true)
    expect(reused.path).toBe(created.path)
    expect(branch.stdout.trim()).toBe("pet-47")
  })
})
