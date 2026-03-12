import { Data, Effect, Schema } from "effect"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type {
  ManualStateEntry,
  ManualStateFile,
  RuntimeSnapshot,
} from "./domain"
import { ManualStateFileSchema } from "./domain"

export class ManualStateError extends Data.TaggedError("ManualStateError")<{
  readonly reason: "decode" | "io" | "parse"
  readonly message: string
}> {}

const emptyManualState = (): ManualStateFile => ({
  blockedIssues: [],
})

export const resolveManualStatePath = (configPath: string) =>
  path.join(path.dirname(configPath), "orca.manual-state.json")

export const decodeManualStateFile = (input: unknown) =>
  Schema.decodeUnknownEffect(ManualStateFileSchema)(input)

export const loadManualState = (manualStatePath: string) =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: async () => {
        try {
          return await readFile(manualStatePath, "utf8")
        } catch (cause) {
          if (
            typeof cause === "object" &&
            cause !== null &&
            "code" in cause &&
            cause.code === "ENOENT"
          ) {
            return null
          }

          throw cause
        }
      },
      catch: (cause) =>
        new ManualStateError({
          message:
            cause instanceof Error
              ? `failed to read manual state: ${cause.message}`
              : `failed to read manual state: ${String(cause)}`,
          reason: "io",
        }),
    })

    if (raw === null) {
      return emptyManualState()
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) =>
        new ManualStateError({
          message:
            cause instanceof Error
              ? `failed to parse manual state: ${cause.message}`
              : `failed to parse manual state: ${String(cause)}`,
          reason: "parse",
        }),
    })

    return yield* decodeManualStateFile(parsed).pipe(
      Effect.mapError(
        (cause) =>
          new ManualStateError({
            message: `failed to decode manual state: ${String(cause)}`,
            reason: "decode",
          }),
      ),
    )
  })

export const saveManualState = ({
  file,
  manualStatePath,
}: {
  readonly file: ManualStateFile
  readonly manualStatePath: string
}) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => mkdir(path.dirname(manualStatePath), { recursive: true }),
      catch: (cause) =>
        new ManualStateError({
          message:
            cause instanceof Error
              ? `failed to prepare manual state directory: ${cause.message}`
              : `failed to prepare manual state directory: ${String(cause)}`,
          reason: "io",
        }),
    })

    yield* Effect.tryPromise({
      try: () =>
        writeFile(
          manualStatePath,
          `${JSON.stringify(file, null, 2)}\n`,
          "utf8",
        ),
      catch: (cause) =>
        new ManualStateError({
          message:
            cause instanceof Error
              ? `failed to write manual state: ${cause.message}`
              : `failed to write manual state: ${String(cause)}`,
          reason: "io",
        }),
    })
  })

export const buildManualStateFile = ({
  snapshot,
  updatedAt = new Date().toISOString(),
}: {
  readonly snapshot: Pick<RuntimeSnapshot, "activeIssues" | "claimedIssues">
  readonly updatedAt?: string
}): ManualStateFile => {
  const activeIssueIds = new Set(snapshot.activeIssues.map((issue) => issue.id))
  const blockedIssues: Array<ManualStateEntry> = []

  for (const issueState of snapshot.claimedIssues) {
    if (issueState.state !== "ManualIntervention") {
      continue
    }

    if (!activeIssueIds.has(issueState.issueId)) {
      continue
    }

    blockedIssues.push({
      branchName: issueState.branchName,
      issueId: issueState.issueId,
      issueIdentifier: issueState.issueIdentifier,
      note: issueState.lastError ?? "manual intervention required",
      updatedAt,
      worktreePath: issueState.worktreePath,
    })
  }

  blockedIssues.sort((left, right) =>
    left.issueIdentifier.localeCompare(right.issueIdentifier),
  )

  return {
    blockedIssues,
  }
}

export const findManualStateEntry = ({
  issueId,
  issueIdentifier,
  manualState,
}: {
  readonly issueId: string
  readonly issueIdentifier: string
  readonly manualState: ManualStateFile
}) =>
  manualState.blockedIssues.find(
    (entry) =>
      entry.issueId === issueId || entry.issueIdentifier === issueIdentifier,
  ) ?? null
