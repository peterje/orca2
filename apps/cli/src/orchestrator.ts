import { Cause, Duration, Effect, Ref } from "effect"
import { AgentRunnerError } from "./agent-runner"
import type {
  NormalizedIssue,
  OrcaIssueState,
  RuntimeSnapshot,
  SelectedRunnableIssue,
} from "./domain"
import { formatErrorMessage } from "./error-format"
import { WorktreeError } from "./git-worktree"
import type { ImplementationAttemptOutcome } from "./implementation-attempt"
import { runImplementationAttempt } from "./implementation-attempt"
import { fetchActiveIssues } from "./linear"
import type { AppLogLevel } from "./logging"
import { log } from "./logging"
import type { OrcaConfig } from "./orca-config"

interface IssueExecutionState {
  readonly lastError: string | null
  readonly retryCount: number
  readonly retryDueAt: string | null
  readonly state: OrcaIssueState
  readonly worktreePath: string | null
}

type IssueStateMap = ReadonlyMap<string, IssueExecutionState>

export const resolveRetryPlan = ({
  maxRetries,
  maxRetryBackoffMs,
  retryCount,
  now = Date.now(),
}: {
  readonly maxRetries: number
  readonly maxRetryBackoffMs: number
  readonly retryCount: number
  readonly now?: number
}) => {
  const nextRetryCount = retryCount + 1

  if (nextRetryCount > maxRetries) {
    return {
      retryCount: nextRetryCount,
      retryDueAt: null,
      state: "ManualIntervention" as const,
    }
  }

  const backoffMs = Math.min(
    1_000 * 2 ** (nextRetryCount - 1),
    maxRetryBackoffMs,
  )

  return {
    retryCount: nextRetryCount,
    retryDueAt: new Date(now + backoffMs).toISOString(),
    state: "RetryQueued" as const,
  }
}

const compareIssues = (
  left: RuntimeSnapshot["activeIssues"][number],
  right: RuntimeSnapshot["activeIssues"][number],
) => {
  const priorityDifference = left.priorityRank - right.priorityRank
  if (priorityDifference !== 0) {
    return priorityDifference
  }

  const leftCreatedAtTime = new Date(left.createdAt).getTime()
  const rightCreatedAtTime = new Date(right.createdAt).getTime()
  const createdAtDifference =
    Number.isFinite(leftCreatedAtTime) && Number.isFinite(rightCreatedAtTime)
      ? leftCreatedAtTime - rightCreatedAtTime
      : 0
  if (createdAtDifference !== 0) {
    return createdAtDifference
  }

  return left.identifier.localeCompare(right.identifier)
}

const currentTimestamp = () => Date.now()

const isRunnableIssueState = (
  issueState: IssueExecutionState | undefined,
  now = currentTimestamp(),
) => {
  if (issueState === undefined) {
    return true
  }

  if (issueState.state === "RetryQueued") {
    return issueState.retryDueAt === null
      ? true
      : new Date(issueState.retryDueAt).getTime() <= now
  }

  return issueState.state === "Todo"
}

export const selectRunnableIssue = (
  issues: RuntimeSnapshot["activeIssues"],
  issueStates: IssueStateMap = new Map(),
): SelectedRunnableIssue | null => {
  const runnableIssues = issues
    .filter(
      (issue) =>
        issue.normalizedState === "runnable" &&
        isRunnableIssueState(issueStates.get(issue.id)),
    )
    .sort(compareIssues)
  const selectedIssue = runnableIssues[0]

  if (!selectedIssue) {
    return null
  }

  return {
    id: selectedIssue.id,
    identifier: selectedIssue.identifier,
    title: selectedIssue.title,
    normalizedState: "runnable",
  }
}

export const buildRuntimeSnapshot = (
  issues: RuntimeSnapshot["activeIssues"],
  issueStates: IssueStateMap = new Map(),
): RuntimeSnapshot => {
  const activeIssues = issues
    .filter((issue) => issue.normalizedState !== "terminal")
    .sort(compareIssues)

  return {
    updatedAt: new Date().toISOString(),
    activeIssues,
    claimedIssues: activeIssues.flatMap((issue) => {
      const issueState = issueStates.get(issue.id)
      if (issueState === undefined) {
        return []
      }

      return [
        {
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          lastError: issueState.lastError,
          retryDueAt: issueState.retryDueAt,
          state: issueState.state,
          worktreePath: issueState.worktreePath,
        },
      ]
    }),
    runnableIssue: selectRunnableIssue(activeIssues, issueStates),
  }
}

const updateIssueState = (
  issueStates: IssueStateMap,
  issue: Pick<NormalizedIssue, "id">,
  nextState: IssueExecutionState,
) => {
  const updated = new Map(issueStates)
  updated.set(issue.id, nextState)
  return updated
}

const clearIssueState = (
  issueStates: IssueStateMap,
  issueId: string,
): IssueStateMap => {
  if (!issueStates.has(issueId)) {
    return issueStates
  }

  const updated = new Map(issueStates)
  updated.delete(issueId)
  return updated
}

const reconcileIssueStates = (
  issues: ReadonlyArray<NormalizedIssue>,
  issueStates: IssueStateMap,
): IssueStateMap => {
  const issuesById = new Map(issues.map((issue) => [issue.id, issue]))
  const updated = new Map<string, IssueExecutionState>()

  for (const [issueId, issueState] of issueStates) {
    const issue = issuesById.get(issueId)
    if (issue === undefined || issue.normalizedState !== "runnable") {
      continue
    }

    updated.set(issueId, issueState)
  }

  return updated
}

const findIssue = (
  issues: ReadonlyArray<NormalizedIssue>,
  issueId: string,
): NormalizedIssue | undefined => issues.find((issue) => issue.id === issueId)

export const applyImplementationOutcome = ({
  activeIssues,
  issue,
  issueStates,
  outcome,
}: {
  readonly activeIssues: ReadonlyArray<NormalizedIssue>
  readonly issue: NormalizedIssue
  readonly issueStates: IssueStateMap
  readonly outcome: ImplementationAttemptOutcome
}): IssueStateMap => {
  const activeIssue = findIssue(activeIssues, issue.id)
  if (
    outcome.state === "LinkedPrDetected" ||
    activeIssue?.normalizedState !== "runnable"
  ) {
    return clearIssueState(issueStates, issue.id)
  }

  return updateIssueState(issueStates, issue, {
    lastError: null,
    retryCount: 0,
    retryDueAt: null,
    state: "WaitingForPr",
    worktreePath: outcome.worktreePath,
  })
}

const logSnapshot = (minimumLogLevel: AppLogLevel, snapshot: RuntimeSnapshot) =>
  log(minimumLogLevel, "Info", "orca.snapshot.updated", {
    active_issue_count: snapshot.activeIssues.length,
    claimed_issue_count: snapshot.claimedIssues.length,
    runnable_issue_identifier: snapshot.runnableIssue?.identifier ?? null,
    snapshot,
  })

export const runOrchestrator = ({
  config,
  configPath,
  logLevel,
}: {
  readonly config: OrcaConfig
  readonly configPath: string
  readonly logLevel: AppLogLevel
}) =>
  Effect.gen(function* () {
    const activeIssuesRef = yield* Ref.make<RuntimeSnapshot["activeIssues"]>([])
    const issueStatesRef = yield* Ref.make<IssueStateMap>(new Map())
    const runningIssueIdRef = yield* Ref.make<string | null>(null)
    const snapshotRef = yield* Ref.make<RuntimeSnapshot>({
      updatedAt: new Date(0).toISOString(),
      activeIssues: [],
      claimedIssues: [],
      runnableIssue: null,
    })

    const refreshSnapshot = Effect.gen(function* () {
      const activeIssues = yield* Ref.get(activeIssuesRef)
      const issueStates = yield* Ref.get(issueStatesRef)
      const snapshot = buildRuntimeSnapshot(activeIssues, issueStates)

      yield* Ref.set(snapshotRef, snapshot)
      yield* logSnapshot(logLevel, snapshot)

      return snapshot
    })

    const markRetryQueued = (issue: NormalizedIssue, error: AgentRunnerError) =>
      Effect.gen(function* () {
        const currentIssueStates = yield* Ref.get(issueStatesRef)
        const retryPlan = resolveRetryPlan({
          maxRetries: config.agent.maxRetries,
          maxRetryBackoffMs: config.agent.maxRetryBackoffMs,
          retryCount: currentIssueStates.get(issue.id)?.retryCount ?? 0,
        })

        yield* Ref.set(
          issueStatesRef,
          updateIssueState(currentIssueStates, issue, {
            lastError: error.message,
            retryCount: retryPlan.retryCount,
            retryDueAt: retryPlan.retryDueAt,
            state: retryPlan.state,
            worktreePath:
              currentIssueStates.get(issue.id)?.worktreePath ?? null,
          }),
        )
      })

    const markManualIntervention = (
      issue: NormalizedIssue,
      message: string,
      worktreePath: string | null,
    ) =>
      Ref.update(issueStatesRef, (currentIssueStates) =>
        updateIssueState(currentIssueStates, issue, {
          lastError: message,
          retryCount: currentIssueStates.get(issue.id)?.retryCount ?? 0,
          retryDueAt: null,
          state: "ManualIntervention",
          worktreePath,
        }),
      )

    const dispatchIssue = (issue: NormalizedIssue) =>
      Effect.gen(function* () {
        yield* Ref.update(issueStatesRef, (currentIssueStates) =>
          updateIssueState(currentIssueStates, issue, {
            lastError: null,
            retryCount: currentIssueStates.get(issue.id)?.retryCount ?? 0,
            retryDueAt: null,
            state: "Implementing",
            worktreePath:
              currentIssueStates.get(issue.id)?.worktreePath ?? null,
          }),
        )
        yield* Ref.set(runningIssueIdRef, issue.id)
        yield* refreshSnapshot

        yield* log(logLevel, "Info", "orca.issue.dispatch.started", {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          state: "Implementing",
        })

        yield* runImplementationAttempt({
          config,
          issue,
          onWorktreeReady: (worktree) =>
            Ref.update(issueStatesRef, (currentIssueStates) =>
              updateIssueState(currentIssueStates, issue, {
                lastError: null,
                retryCount:
                  currentIssueStates.get(issue.id)?.retryCount ?? 0,
                retryDueAt: null,
                state: "Implementing",
                worktreePath: worktree.path,
              }),
            ).pipe(Effect.andThen(refreshSnapshot)),
        }).pipe(
          Effect.flatMap((outcome) =>
            Ref.get(activeIssuesRef).pipe(
              Effect.flatMap((activeIssues) =>
                Ref.update(issueStatesRef, (currentIssueStates) =>
                  applyImplementationOutcome({
                    activeIssues,
                    issue,
                    issueStates: currentIssueStates,
                    outcome,
                  }),
                ),
              ),
            ),
          ),
          Effect.tap(() =>
            log(logLevel, "Info", "orca.issue.dispatch.completed", {
              issue_id: issue.id,
              issue_identifier: issue.identifier,
            }),
          ),
          Effect.catch((error: unknown) => {
            if (error instanceof AgentRunnerError && error.retryable) {
              return markRetryQueued(issue, error).pipe(
                Effect.flatMap(() => Ref.get(issueStatesRef)),
                Effect.flatMap((issueStates) => {
                  const state = issueStates.get(issue.id)?.state

                  return state === "ManualIntervention"
                    ? log(
                        logLevel,
                        "Error",
                        "orca.issue.dispatch.manual-intervention",
                        {
                          issue_id: issue.id,
                          issue_identifier: issue.identifier,
                          message: error.message,
                          state: "ManualIntervention",
                        },
                      )
                    : log(logLevel, "Warn", "orca.issue.dispatch.retry-queued", {
                        issue_id: issue.id,
                        issue_identifier: issue.identifier,
                        message: error.message,
                        state: "RetryQueued",
                      })
                }),
              )
            }

            if (error instanceof WorktreeError) {
              return markManualIntervention(issue, error.message, null).pipe(
                Effect.andThen(
                  log(
                    logLevel,
                    "Error",
                    "orca.issue.dispatch.manual-intervention",
                    {
                      issue_id: issue.id,
                      issue_identifier: issue.identifier,
                      message: error.message,
                      state: "ManualIntervention",
                    },
                  ),
                ),
              )
            }

            if (error instanceof AgentRunnerError) {
              return markManualIntervention(issue, error.message, null).pipe(
                Effect.andThen(
                  log(
                    logLevel,
                    "Error",
                    "orca.issue.dispatch.manual-intervention",
                    {
                      issue_id: issue.id,
                      issue_identifier: issue.identifier,
                      message: error.message,
                      state: "ManualIntervention",
                    },
                  ),
                ),
              )
            }

            return markManualIntervention(
              issue,
              formatErrorMessage(error),
              null,
            ).pipe(
              Effect.andThen(
                log(logLevel, "Error", "orca.issue.dispatch.failed", {
                  issue_id: issue.id,
                  issue_identifier: issue.identifier,
                  message: formatErrorMessage(error),
                }),
              ),
            )
          }),
          Effect.ensuring(
            Ref.set(runningIssueIdRef, null).pipe(
              Effect.andThen(refreshSnapshot),
            ),
          ),
          Effect.forkChild,
        )
      })

    yield* log(logLevel, "Info", "orca.boot.completed", {
      config_path: configPath,
      polling_interval_ms: config.polling.intervalMs,
      linear_project_slug: config.linear.projectSlug,
    })

    const pollOnce = fetchActiveIssues(config.linear).pipe(
      Effect.flatMap((issues) =>
        Effect.gen(function* () {
          const reconciledIssueStates = reconcileIssueStates(
            issues,
            yield* Ref.get(issueStatesRef),
          )

          yield* Ref.set(activeIssuesRef, issues)
          yield* Ref.set(issueStatesRef, reconciledIssueStates)

          const snapshot = yield* refreshSnapshot
          const runningIssueId = yield* Ref.get(runningIssueIdRef)

          if (runningIssueId !== null) {
            return snapshot
          }

          const runnableIssue = snapshot.runnableIssue
          if (runnableIssue === null) {
            return snapshot
          }

          const selectedIssue = findIssue(issues, runnableIssue.id)
          if (selectedIssue === undefined) {
            return snapshot
          }

          yield* dispatchIssue(selectedIssue)
          return snapshot
        }),
      ),
      Effect.catchCause((cause: Cause.Cause<unknown>) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : log(logLevel, "Error", "orca.linear.poll.failed", {
              message: formatErrorMessage(Cause.squash(cause)),
            }),
      ),
    )

    while (true) {
      const pollStartedAt = Date.now()
      yield* pollOnce

      const elapsedMs = Date.now() - pollStartedAt
      const remainingDelayMs = Math.max(
        config.polling.intervalMs - elapsedMs,
        0,
      )

      // Keep the configured interval close to the time between poll starts.
      if (remainingDelayMs > 0) {
        yield* Effect.sleep(Duration.millis(remainingDelayMs))
      }
    }
  })
