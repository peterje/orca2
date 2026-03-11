import { Duration, Effect } from "effect"
import type { NormalizedIssue } from "./domain"
import { AgentRunnerError } from "./agent-runner"
import { runCodexAgent } from "./agent-runner"
import type { WorktreeHandle } from "./git-worktree"
import { WorktreeError, ensureIssueWorktree } from "./git-worktree"
import { fetchActiveIssues } from "./linear"
import type { OrcaConfig } from "./orca-config"
import { buildImplementationPrompt } from "./prompts"

export const shortMissingPrRetryMs = 1_000

export interface ImplementationAttemptOutcome {
  readonly branchName: string
  readonly state: "LinkedPrDetected" | "WaitingForPr"
  readonly worktreePath: string
}

export const runImplementationAttempt = ({
  config,
  issue,
  ensureWorktree = (currentIssue: NormalizedIssue) =>
    ensureIssueWorktree({
      config,
      issue: currentIssue,
    }),
  refreshIssues = () => fetchActiveIssues(config.linear),
  runAgent = ({
    cwd,
    prompt,
  }: {
    readonly cwd: string
    readonly prompt: string
  }) =>
    runCodexAgent({
      config,
      cwd,
      prompt,
    }),
  sleep = (durationMs: number) => Effect.sleep(Duration.millis(durationMs)),
}: {
  readonly config: OrcaConfig
  readonly ensureWorktree?: (
    issue: NormalizedIssue,
  ) => Effect.Effect<WorktreeHandle, WorktreeError>
  readonly issue: NormalizedIssue
  readonly refreshIssues?: () => ReturnType<typeof fetchActiveIssues>
  readonly runAgent?: (params: {
    readonly cwd: string
    readonly prompt: string
  }) => Effect.Effect<void, AgentRunnerError>
  readonly sleep?: (durationMs: number) => Effect.Effect<void>
}) =>
  Effect.gen(function* () {
    const worktree = yield* ensureWorktree(issue)
    const prompt = buildImplementationPrompt(issue)

    yield* runAgent({
      cwd: worktree.path,
      prompt,
    })

    yield* sleep(shortMissingPrRetryMs)

    const refreshedIssue = yield* refreshIssues().pipe(
      Effect.map((issues) =>
        issues.find((candidate) => candidate.id === issue.id),
      ),
      Effect.catchTag("LinearApiError", () =>
        Effect.sync(() => undefined as NormalizedIssue | undefined),
      ),
    )

    return {
      branchName: worktree.branchName,
      state:
        refreshedIssue !== undefined &&
        refreshedIssue.linkedPullRequests.length > 0
          ? "LinkedPrDetected"
          : "WaitingForPr",
      worktreePath: worktree.path,
    } satisfies ImplementationAttemptOutcome
  })
