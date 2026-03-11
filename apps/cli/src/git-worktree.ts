import { Data, Effect } from "effect"
import { mkdir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { NormalizedIssue } from "./domain"
import type { OrcaConfig } from "./orca-config"

const execFileAsync = promisify(execFile)

export class WorktreeError extends Data.TaggedError("WorktreeError")<{
  readonly reason: "path-outside-root" | "broken-worktree" | "git-failed"
  readonly issueIdentifier: string
  readonly message: string
}> {}

class WorktreeProbeError extends Data.TaggedError("WorktreeProbeError")<{}> {}

export interface WorktreeHandle {
  readonly branchName: string
  readonly path: string
  readonly reused: boolean
}

interface WorktreeListEntry {
  readonly branchName: string | null
  readonly path: string
}

type WorktreeConfig = Pick<OrcaConfig, "github" | "worktree">

const toWorktreeError = (
  issueIdentifier: string,
  message: string,
  cause: unknown,
) =>
  new WorktreeError({
    reason: "git-failed",
    issueIdentifier,
    message:
      cause instanceof Error
        ? `${message}: ${cause.message}`
        : `${message}: ${String(cause)}`,
  })

const runGit = ({
  args,
  cwd,
  issueIdentifier,
}: {
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly issueIdentifier: string
}) =>
  Effect.tryPromise({
    try: () => execFileAsync("git", [...args], { cwd }),
    catch: (cause) =>
      toWorktreeError(issueIdentifier, `git ${args.join(" ")} failed`, cause),
  }).pipe(Effect.map(({ stdout }) => stdout.trim()))

const tryRunGit = ({
  args,
  cwd,
}: {
  readonly args: ReadonlyArray<string>
  readonly cwd: string
}) =>
  Effect.tryPromise({
    try: () => execFileAsync("git", [...args], { cwd }),
    catch: () => new WorktreeProbeError(),
  }).pipe(
    Effect.map((result) => result.stdout.trim()),
    Effect.catch(() => Effect.succeed(null)),
  )

const pathExists = (candidatePath: string) =>
  Effect.tryPromise({
    try: async () => {
      await stat(candidatePath)
      return true
    },
    catch: () => new WorktreeProbeError(),
  }).pipe(Effect.catch(() => Effect.succeed(false)))

const parseWorktreeList = (output: string): Array<WorktreeListEntry> => {
  const entries: Array<WorktreeListEntry> = []
  const blocks = output.split("\n\n")

  for (const block of blocks) {
    if (block.trim().length === 0) {
      continue
    }

    let branchName: string | null = null
    let worktreePath: string | null = null

    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        worktreePath = line.slice("worktree ".length)
        continue
      }

      if (line.startsWith("branch refs/heads/")) {
        branchName = line.slice("branch refs/heads/".length)
      }
    }

    if (worktreePath !== null) {
      entries.push({
        branchName,
        path: worktreePath,
      })
    }
  }

  return entries
}

export const sanitizeIssueIdentifier = (identifier: string) =>
  identifier
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

export const resolveIssueBranchName = (issue: NormalizedIssue) =>
  issue.branchName?.trim() || sanitizeIssueIdentifier(issue.identifier)

export const ensureIssueWorktree = ({
  config,
  issue,
}: {
  readonly config: WorktreeConfig
  readonly issue: NormalizedIssue
}) =>
  Effect.gen(function* () {
    const repoRoot = yield* Effect.tryPromise({
      try: () => realpath(path.resolve(config.worktree.repoRoot)),
      catch: (cause) =>
        toWorktreeError(issue.identifier, "failed to resolve repo root", cause),
    })
    const worktreeRootInput = path.resolve(config.worktree.root)
    const branchName = resolveIssueBranchName(issue)

    yield* Effect.tryPromise({
      try: () => mkdir(worktreeRootInput, { recursive: true }),
      catch: (cause) =>
        toWorktreeError(
          issue.identifier,
          "failed to create worktree root",
          cause,
        ),
    })

    const worktreeRoot = yield* Effect.tryPromise({
      try: () => realpath(worktreeRootInput),
      catch: (cause) =>
        toWorktreeError(
          issue.identifier,
          "failed to resolve worktree root",
          cause,
        ),
    })
    const worktreePath = path.resolve(
      worktreeRoot,
      sanitizeIssueIdentifier(issue.identifier),
    )
    const relativePath = path.relative(worktreeRoot, worktreePath)

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return yield* new WorktreeError({
        reason: "path-outside-root",
        issueIdentifier: issue.identifier,
        message: `resolved worktree path ${worktreePath} is outside ${worktreeRoot}`,
      })
    }

    const worktreeList = parseWorktreeList(
      yield* runGit({
        args: ["worktree", "list", "--porcelain"],
        cwd: repoRoot,
        issueIdentifier: issue.identifier,
      }),
    )

    const existingAtPath = worktreeList.find(
      (entry) => entry.path === worktreePath,
    )
    if (existingAtPath) {
      if (existingAtPath.branchName !== branchName) {
        return yield* new WorktreeError({
          reason: "broken-worktree",
          issueIdentifier: issue.identifier,
          message: `worktree ${worktreePath} is already attached to ${existingAtPath.branchName ?? "a detached head"}`,
        })
      }

      return {
        branchName,
        path: worktreePath,
        reused: true,
      }
    }

    const existingBranch = worktreeList.find(
      (entry) => entry.branchName === branchName,
    )
    if (existingBranch) {
      return yield* new WorktreeError({
        reason: "broken-worktree",
        issueIdentifier: issue.identifier,
        message: `branch ${branchName} is already attached at ${existingBranch.path}`,
      })
    }

    if (yield* pathExists(worktreePath)) {
      return yield* new WorktreeError({
        reason: "broken-worktree",
        issueIdentifier: issue.identifier,
        message: `worktree path ${worktreePath} already exists but is not managed by git worktree`,
      })
    }

    const branchExists =
      (yield* tryRunGit({
        args: ["rev-parse", "--verify", `refs/heads/${branchName}`],
        cwd: repoRoot,
      })) !== null

    const createArgs = branchExists
      ? ["worktree", "add", worktreePath, branchName]
      : [
          "worktree",
          "add",
          "-b",
          branchName,
          worktreePath,
          config.github.baseBranch,
        ]

    yield* runGit({
      args: createArgs,
      cwd: repoRoot,
      issueIdentifier: issue.identifier,
    })

    return {
      branchName,
      path: worktreePath,
      reused: false,
    }
  })
