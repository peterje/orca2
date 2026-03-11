import { Cause, Duration, Effect, Ref } from "effect"
import type { RuntimeSnapshot, SelectedRunnableIssue } from "./domain"
import { formatErrorMessage } from "./error-format"
import { fetchActiveIssues } from "./linear"
import type { AppLogLevel } from "./logging"
import { log } from "./logging"
import type { OrcaConfig } from "./orca-config"

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

export const selectRunnableIssue = (
  issues: RuntimeSnapshot["activeIssues"],
): SelectedRunnableIssue | null => {
  const runnableIssues = issues
    .filter((issue) => issue.runnable)
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
): RuntimeSnapshot => ({
  updatedAt: new Date().toISOString(),
  activeIssues: [...issues].sort(compareIssues),
  runnableIssue: selectRunnableIssue(issues),
})

const logSnapshot = (minimumLogLevel: AppLogLevel, snapshot: RuntimeSnapshot) =>
  log(minimumLogLevel, "Info", "orca.snapshot.updated", {
    active_issue_count: snapshot.activeIssues.length,
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
    const snapshotRef = yield* Ref.make<RuntimeSnapshot>({
      updatedAt: new Date(0).toISOString(),
      activeIssues: [],
      runnableIssue: null,
    })

    yield* log(logLevel, "Info", "orca.boot.completed", {
      config_path: configPath,
      polling_interval_ms: config.polling.intervalMs,
      linear_project_slug: config.linear.projectSlug,
    })

    const pollOnce = fetchActiveIssues(config.linear).pipe(
      Effect.map(buildRuntimeSnapshot),
      Effect.tap((snapshot) => Ref.set(snapshotRef, snapshot)),
      Effect.tap((snapshot) => logSnapshot(logLevel, snapshot)),
      Effect.catchCause((cause: Cause.Cause<unknown>) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : log(logLevel, "Error", "orca.linear.poll.failed", {
              message: formatErrorMessage(Cause.squash(cause)),
            }),
      ),
    )

    while (true) {
      yield* pollOnce
      yield* Effect.sleep(Duration.millis(config.polling.intervalMs))
    }
  })
