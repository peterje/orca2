import { Effect } from "effect"
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  loadManualState,
  resolveManualStatePath,
  saveManualState,
} from "./manual-state"

const tempDirectories = new Set<string>()

afterEach(async () => {
  await Promise.all(
    [...tempDirectories].map(async (directory) => {
      await rm(directory, { force: true, recursive: true })
      tempDirectories.delete(directory)
    }),
  )
})

describe("manual state", () => {
  it("returns an empty manual state file when the file is missing", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "orca-manual-state-"))
    tempDirectories.add(directory)

    const manualState = await Effect.runPromise(
      loadManualState(path.join(directory, "orca.manual-state.json")),
    )

    expect(manualState).toEqual({
      blockedIssues: [],
    })
  })

  it("saves and reloads manual intervention entries", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "orca-manual-state-"))
    tempDirectories.add(directory)

    const configPath = path.join(directory, "orca.config.ts")
    const manualStatePath = resolveManualStatePath(configPath)

    await Effect.runPromise(
      saveManualState({
        file: {
          blockedIssues: [
            {
              branchName: "pet-51",
              issueId: "issue-1",
              issueIdentifier: "PET-51",
              note: "worktree needs cleanup",
              updatedAt: "2026-03-11T12:00:00.000Z",
              worktreePath: "/repo/.orca/worktrees/pet-51",
            },
          ],
        },
        manualStatePath,
      }),
    )

    const reloaded = await Effect.runPromise(loadManualState(manualStatePath))

    expect(reloaded).toEqual({
      blockedIssues: [
        {
          branchName: "pet-51",
          issueId: "issue-1",
          issueIdentifier: "PET-51",
          note: "worktree needs cleanup",
          updatedAt: "2026-03-11T12:00:00.000Z",
          worktreePath: "/repo/.orca/worktrees/pet-51",
        },
      ],
    })
  })
})
