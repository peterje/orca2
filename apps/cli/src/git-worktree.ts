import { Data, Effect } from "effect"
import { mkdir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { NormalizedIssue } from "./domain"
import type { OrcaConfig } from "./orca-config"

const execFileAsync = promisify(execFile)

export class WorktreeError extends Data.TaggedError("WorktreeError")<{
  readonly reason:
    | "path-outside-root"
    | "broken-worktree"
    | "dirty-worktree"
    | "git-failed"
  readonly issueIdentifier: string
  readonly message: string
}> {}

class WorktreeProbeError extends Data.TaggedError("WorktreeProbeError")<{}> {}

export interface WorktreeHandle {
  readonly branchName: string
  readonly path: string
  readonly reused: boolean
}

export type IssueWorktreeInspection =
  | {
      readonly kind: "missing"
      readonly branchName: string
      readonly path: string
    }
  | {
      readonly kind: "ready"
      readonly branchName: string
      readonly path: string
    }
  | {
      readonly kind: "manual-intervention"
      readonly branchName: string | null
      readonly message: string
      readonly path: string | null
    }

interface WorktreeListEntry {
  readonly branchName: string | null
  readonly path: string
}

type WorktreeConfig = Pick<OrcaConfig, "github" | "worktree">

interface ResolvedIssueWorktree {
  readonly branchName: string
  readonly path: string
  readonly repoRoot: string
  readonly worktreeRoot: string
}

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

const resolveIssueWorktreePaths = ({
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
    const resolved = {
      branchName: resolveIssueBranchName(issue),
      path: path.resolve(
        worktreeRoot,
        sanitizeIssueIdentifier(issue.identifier),
      ),
      repoRoot,
      worktreeRoot,
    } satisfies ResolvedIssueWorktree
    const relativePath = path.relative(worktreeRoot, resolved.path)

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return yield* new WorktreeError({
        reason: "path-outside-root",
        issueIdentifier: issue.identifier,
        message: `resolved worktree path ${resolved.path} is outside ${worktreeRoot}`,
      })
    }

    return resolved
  })

const listWorktrees = ({
  issueIdentifier,
  repoRoot,
}: {
  readonly issueIdentifier: string
  readonly repoRoot: string
}) =>
  runGit({
    args: ["worktree", "list", "--porcelain"],
    cwd: repoRoot,
    issueIdentifier,
  }).pipe(Effect.map(parseWorktreeList))

const getWorktreeStatusOutput = ({
  issueIdentifier,
  worktreePath,
}: {
  readonly issueIdentifier: string
  readonly worktreePath: string
}) =>
  runGit({
    args: ["status", "--short", "--untracked-files=all"],
    cwd: worktreePath,
    issueIdentifier,
  })

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
  issue.branchName?.trim()
    ? sanitizeIssueIdentifier(issue.branchName)
    : sanitizeIssueIdentifier(issue.identifier)

export const inspectIssueWorktree = ({
  config,
  issue,
}: {
  readonly config: WorktreeConfig
  readonly issue: NormalizedIssue
}) =>
  Effect.gen(function* () {
    const resolved = yield* resolveIssueWorktreePaths({
      config,
      issue,
    })
    const worktreeList = yield* listWorktrees({
      issueIdentifier: issue.identifier,
      repoRoot: resolved.repoRoot,
    })

    const existingAtPath = worktreeList.find(
      (entry) => entry.path === resolved.path,
    )
    if (existingAtPath) {
      if (existingAtPath.branchName !== resolved.branchName) {
        return {
          branchName: existingAtPath.branchName,
          kind: "manual-intervention",
          message: `worktree ${resolved.path} is already attached to ${existingAtPath.branchName ?? "a detached head"}`,
          path: resolved.path,
        } satisfies IssueWorktreeInspection
      }

      const statusOutput = yield* getWorktreeStatusOutput({
        issueIdentifier: issue.identifier,
        worktreePath: resolved.path,
      })

      if (statusOutput.length > 0) {
        return {
          branchName: resolved.branchName,
          kind: "manual-intervention",
          message: `worktree ${resolved.path} has uncommitted changes and requires manual intervention`,
          path: resolved.path,
        } satisfies IssueWorktreeInspection
      }

      return {
        branchName: resolved.branchName,
        kind: "ready",
        path: resolved.path,
      } satisfies IssueWorktreeInspection
    }

    const existingBranch = worktreeList.find(
      (entry) => entry.branchName === resolved.branchName,
    )
    if (existingBranch) {
      return {
        branchName: resolved.branchName,
        kind: "manual-intervention",
        message: `branch ${resolved.branchName} is already attached at ${existingBranch.path}`,
        path: existingBranch.path,
      } satisfies IssueWorktreeInspection
    }

    if (yield* pathExists(resolved.path)) {
      return {
        branchName: resolved.branchName,
        kind: "manual-intervention",
        message: `worktree path ${resolved.path} already exists but is not managed by git worktree`,
        path: resolved.path,
      } satisfies IssueWorktreeInspection
    }

    return {
      branchName: resolved.branchName,
      kind: "missing",
      path: resolved.path,
    } satisfies IssueWorktreeInspection
  })

export const removeIssueWorktree = ({
  config,
  issue,
}: {
  readonly config: WorktreeConfig
  readonly issue: NormalizedIssue
}) =>
  Effect.gen(function* () {
    const resolved = yield* resolveIssueWorktreePaths({
      config,
      issue,
    })
    const worktreeList = yield* listWorktrees({
      issueIdentifier: issue.identifier,
      repoRoot: resolved.repoRoot,
    })

    const existingAtPath =
      worktreeList.find((entry) => entry.path === resolved.path) ??
      worktreeList.find(
        (entry) =>
          entry.branchName === resolved.branchName &&
          entry.path.startsWith(`${resolved.worktreeRoot}${path.sep}`),
      )

    if (!existingAtPath) {
      return false
    }

    yield* runGit({
      args: ["worktree", "remove", "--force", existingAtPath.path],
      cwd: resolved.repoRoot,
      issueIdentifier: issue.identifier,
    })

    return true
  })

export const ensureIssueWorktree = ({
  config,
  issue,
}: {
  readonly config: WorktreeConfig
  readonly issue: NormalizedIssue
}) =>
  Effect.gen(function* () {
    const resolved = yield* resolveIssueWorktreePaths({
      config,
      issue,
    })
    const worktreeList = yield* listWorktrees({
      issueIdentifier: issue.identifier,
      repoRoot: resolved.repoRoot,
    })

    const existingAtPath = worktreeList.find(
      (entry) => entry.path === resolved.path,
    )
    if (existingAtPath) {
      if (existingAtPath.branchName !== resolved.branchName) {
        return yield* new WorktreeError({
          reason: "broken-worktree",
          issueIdentifier: issue.identifier,
          message: `worktree ${resolved.path} is already attached to ${existingAtPath.branchName ?? "a detached head"}`,
        })
      }

      const statusOutput = yield* getWorktreeStatusOutput({
        issueIdentifier: issue.identifier,
        worktreePath: resolved.path,
      })
      if (statusOutput.length > 0) {
        return yield* new WorktreeError({
          reason: "dirty-worktree",
          issueIdentifier: issue.identifier,
          message: `worktree ${resolved.path} has uncommitted changes and requires manual intervention`,
        })
      }

      return {
        branchName: resolved.branchName,
        path: resolved.path,
        reused: true,
      }
    }

    const existingBranch = worktreeList.find(
      (entry) => entry.branchName === resolved.branchName,
    )
    if (existingBranch) {
      return yield* new WorktreeError({
        reason: "broken-worktree",
        issueIdentifier: issue.identifier,
        message: `branch ${resolved.branchName} is already attached at ${existingBranch.path}`,
      })
    }

    if (yield* pathExists(resolved.path)) {
      return yield* new WorktreeError({
        reason: "broken-worktree",
        issueIdentifier: issue.identifier,
        message: `worktree path ${resolved.path} already exists but is not managed by git worktree`,
      })
    }

    const branchExists =
      (yield* tryRunGit({
        args: ["rev-parse", "--verify", `refs/heads/${resolved.branchName}`],
        cwd: resolved.repoRoot,
      })) !== null

    const createArgs = branchExists
      ? ["worktree", "add", resolved.path, resolved.branchName]
      : [
          "worktree",
          "add",
          "-b",
          resolved.branchName,
          resolved.path,
          config.github.baseBranch,
        ]

    yield* runGit({
      args: createArgs,
      cwd: resolved.repoRoot,
      issueIdentifier: issue.identifier,
    })

    return {
      branchName: resolved.branchName,
      path: resolved.path,
      reused: false,
    }
  })
