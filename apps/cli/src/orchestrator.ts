import { Cause, Duration, Effect, Ref } from "effect"
import { AgentRunnerError } from "./agent-runner"
import type {
  CheckSummary,
  NormalizedIssue,
  OrcaIssueState,
  PullRequest,
  RuntimeSnapshot,
  SelectedRunnableIssue,
} from "./domain"
import { formatErrorMessage } from "./error-format"
import { WorktreeError } from "./git-worktree"
import type { GitHubInspectionResult } from "./github"
import { inspectIssueGitHubState } from "./github"
import type { ImplementationAttemptOutcome } from "./implementation-attempt"
import { runImplementationAttempt } from "./implementation-attempt"
import { fetchActiveIssues } from "./linear"
import type { AppLogLevel } from "./logging"
import { log } from "./logging"
import type { OrcaConfig } from "./orca-config"

interface IssueExecutionState {
  readonly branchName: string | null
  readonly checkSummary: CheckSummary | null
  readonly currentHeadSha: string | null
  readonly currentPullRequest: PullRequest | null
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

const hasNonTerminalBlockers = (issue: Pick<NormalizedIssue, "blockers">) =>
  issue.blockers.some((blocker) => !blocker.terminal)

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
        !hasNonTerminalBlockers(issue) &&
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
          branchName: issueState.branchName,
          checkSummary: issueState.checkSummary,
          currentHeadSha: issueState.currentHeadSha,
          currentPullRequest: issueState.currentPullRequest,
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
    if (issue === undefined || issue.normalizedState === "terminal") {
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

const downstreamGitHubStates = new Set<OrcaIssueState>([
  "AddressingAiReviewFeedback",
  "AddressingHumanFeedback",
  "EvaluatingAiReview",
  "ReadyForMerge",
  "Released",
  "WaitingForHumanReview",
])

export const updateIssueStateForGitHubInspection = ({
  issue,
  issueStates,
  inspection,
}: {
  readonly issue: NormalizedIssue
  readonly issueStates: IssueStateMap
  readonly inspection: GitHubInspectionResult
}): IssueStateMap => {
  const currentIssueState = issueStates.get(issue.id)
  if (
    currentIssueState !== undefined &&
    downstreamGitHubStates.has(currentIssueState.state)
  ) {
    return issueStates
  }

  if (inspection.kind === "missing-pr") {
    if (
      currentIssueState === undefined ||
      ![
        "WaitingForAiReview",
        "WaitingForCi",
        "WaitingForPr",
      ].includes(currentIssueState.state)
    ) {
      return issueStates
    }

    return updateIssueState(issueStates, issue, {
      branchName: currentIssueState.branchName,
      checkSummary: null,
      currentHeadSha: null,
      currentPullRequest: null,
      lastError: null,
      retryCount: currentIssueState.retryCount,
      retryDueAt: null,
      state: "WaitingForPr",
      worktreePath: currentIssueState.worktreePath,
    })
  }

  if (inspection.kind === "ambiguous") {
    return applyManualInterventionState({
      issue,
      issueStates,
      message: inspection.message,
    })
  }

  if (inspection.checkSummary.status === "pending") {
    return updateIssueState(issueStates, issue, {
      branchName: inspection.pullRequest.headRefName,
      checkSummary: inspection.checkSummary,
      currentHeadSha: inspection.headSha,
      currentPullRequest: inspection.pullRequest,
      lastError: null,
      retryCount: currentIssueState?.retryCount ?? 0,
      retryDueAt: null,
      state: "WaitingForCi",
      worktreePath: currentIssueState?.worktreePath ?? null,
    })
  }

  if (inspection.checkSummary.status === "passed") {
    const nextState: OrcaIssueState = inspection.pullRequest.isDraft
      ? "WaitingForCi"
      : "WaitingForAiReview"

    return updateIssueState(issueStates, issue, {
      branchName: inspection.pullRequest.headRefName,
      checkSummary: inspection.checkSummary,
      currentHeadSha: inspection.headSha,
      currentPullRequest: inspection.pullRequest,
      lastError: null,
      retryCount: currentIssueState?.retryCount ?? 0,
      retryDueAt: null,
      state: nextState,
      worktreePath: currentIssueState?.worktreePath ?? null,
    })
  }

  return applyManualInterventionState({
    issue,
    issueStates,
    message:
      inspection.checkSummary.status === "failed"
        ? `ci failed for ${issue.identifier} on ${inspection.headSha}`
        : `unable to classify github checks for ${issue.identifier}`,
    branchName: inspection.pullRequest.headRefName,
    checkSummary: inspection.checkSummary,
    currentHeadSha: inspection.headSha,
    currentPullRequest: inspection.pullRequest,
  })
}

const statesThatSkipGitHubReconciliation = new Set<OrcaIssueState>([
  ...downstreamGitHubStates,
  "Implementing",
  "ManualIntervention",
  "RetryQueued",
])

const reconcileIssuesWithGitHub = ({
  config,
  issues,
  issueStates,
}: {
  readonly config: OrcaConfig["github"]
  readonly issues: ReadonlyArray<NormalizedIssue>
  readonly issueStates: IssueStateMap
}) =>
  Effect.gen(function* () {
    let currentIssueStates = issueStates

    for (const issue of issues) {
      const currentIssueState = currentIssueStates.get(issue.id)

      if (
        currentIssueState !== undefined &&
        statesThatSkipGitHubReconciliation.has(currentIssueState.state)
      ) {
        continue
      }

      currentIssueStates = yield* inspectIssueGitHubState({
        config,
        issue,
        trackedBranchName: currentIssueState?.branchName,
      }).pipe(
        Effect.map((inspection) =>
          updateIssueStateForGitHubInspection({
            issue,
            issueStates: currentIssueStates,
            inspection,
          }),
        ),
        Effect.catch((error: unknown) =>
          Effect.succeed(
            applyManualInterventionState({
              issue,
              issueStates: currentIssueStates,
              message: formatErrorMessage(error),
            }),
          ),
        ),
      )
    }

    return currentIssueStates
  })

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
  if (activeIssue === undefined || activeIssue.normalizedState === "terminal") {
    return clearIssueState(issueStates, issue.id)
  }

  return updateIssueState(issueStates, issue, {
    branchName: outcome.branchName,
    checkSummary: null,
    currentHeadSha: null,
    currentPullRequest: null,
    lastError: null,
    retryCount: 0,
    retryDueAt: null,
    state: "WaitingForPr",
    worktreePath: outcome.worktreePath,
  })
}

export const applyManualInterventionState = ({
  issue,
  issueStates,
  branchName,
  checkSummary,
  currentHeadSha,
  currentPullRequest,
  message,
  worktreePath,
}: {
  readonly issue: Pick<NormalizedIssue, "id">
  readonly issueStates: IssueStateMap
  readonly message: string
  readonly branchName?: string | null | undefined
  readonly checkSummary?: CheckSummary | null | undefined
  readonly currentHeadSha?: string | null | undefined
  readonly currentPullRequest?: PullRequest | null | undefined
  readonly worktreePath?: string | null | undefined
}): IssueStateMap =>
  updateIssueState(issueStates, issue, {
    branchName:
      branchName === undefined
        ? (issueStates.get(issue.id)?.branchName ?? null)
        : branchName,
    checkSummary:
      checkSummary === undefined
        ? (issueStates.get(issue.id)?.checkSummary ?? null)
        : checkSummary,
    currentHeadSha:
      currentHeadSha === undefined
        ? (issueStates.get(issue.id)?.currentHeadSha ?? null)
        : currentHeadSha,
    currentPullRequest:
      currentPullRequest === undefined
        ? (issueStates.get(issue.id)?.currentPullRequest ?? null)
        : currentPullRequest,
    lastError: message,
    retryCount: issueStates.get(issue.id)?.retryCount ?? 0,
    retryDueAt: null,
    state: "ManualIntervention",
    worktreePath:
      worktreePath === undefined
        ? (issueStates.get(issue.id)?.worktreePath ?? null)
        : worktreePath,
  })

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
            branchName: currentIssueStates.get(issue.id)?.branchName ?? null,
            checkSummary:
              currentIssueStates.get(issue.id)?.checkSummary ?? null,
            currentHeadSha:
              currentIssueStates.get(issue.id)?.currentHeadSha ?? null,
            currentPullRequest:
              currentIssueStates.get(issue.id)?.currentPullRequest ?? null,
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
      worktreePath?: string | null,
    ) =>
      Ref.update(issueStatesRef, (currentIssueStates) =>
        applyManualInterventionState({
          issue,
          issueStates: currentIssueStates,
          message,
          worktreePath,
        }),
      )

    const dispatchIssue = (issue: NormalizedIssue) =>
      Effect.gen(function* () {
        yield* Ref.update(issueStatesRef, (currentIssueStates) =>
          updateIssueState(currentIssueStates, issue, {
            branchName: currentIssueStates.get(issue.id)?.branchName ?? null,
            checkSummary:
              currentIssueStates.get(issue.id)?.checkSummary ?? null,
            currentHeadSha:
              currentIssueStates.get(issue.id)?.currentHeadSha ?? null,
            currentPullRequest:
              currentIssueStates.get(issue.id)?.currentPullRequest ?? null,
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
                branchName: worktree.branchName,
                checkSummary:
                  currentIssueStates.get(issue.id)?.checkSummary ?? null,
                currentHeadSha:
                  currentIssueStates.get(issue.id)?.currentHeadSha ?? null,
                currentPullRequest:
                  currentIssueStates.get(issue.id)?.currentPullRequest ?? null,
                lastError: null,
                retryCount: currentIssueStates.get(issue.id)?.retryCount ?? 0,
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
                    : log(
                        logLevel,
                        "Warn",
                        "orca.issue.dispatch.retry-queued",
                        {
                          issue_id: issue.id,
                          issue_identifier: issue.identifier,
                          message: error.message,
                          state: "RetryQueued",
                        },
                      )
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
              return markManualIntervention(issue, error.message).pipe(
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
          const githubReconciledIssueStates = yield* reconcileIssuesWithGitHub({
            config: config.github,
            issues: issues.filter((issue) => issue.normalizedState !== "terminal"),
            issueStates: reconciledIssueStates,
          })

          yield* Ref.set(activeIssuesRef, issues)
          yield* Ref.set(issueStatesRef, githubReconciledIssueStates)

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
