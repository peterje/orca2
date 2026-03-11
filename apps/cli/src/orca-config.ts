import { Data, Effect, Schema } from "effect"
import { pathToFileURL } from "node:url"
import path from "node:path"

export class ConfigLoadError extends Data.TaggedError("ConfigLoadError")<{
  readonly path: string
  readonly cause: unknown
}> {}

export const OrcaConfigSchema = Schema.Struct({
  linear: Schema.Struct({
    apiKey: Schema.String,
    endpoint: Schema.String,
    projectSlug: Schema.String,
    activeStates: Schema.Array(Schema.String),
    terminalStates: Schema.Array(Schema.String),
  }),
  github: Schema.Struct({
    token: Schema.String,
    apiUrl: Schema.String,
    owner: Schema.String,
    repo: Schema.String,
    baseBranch: Schema.String,
  }),
  polling: Schema.Struct({
    intervalMs: Schema.Number,
  }),
  worktree: Schema.Struct({
    repoRoot: Schema.String,
    root: Schema.String,
  }),
  agent: Schema.Struct({
    maxTurns: Schema.Number,
    maxRetryBackoffMs: Schema.Number,
  }),
  codex: Schema.Struct({
    executable: Schema.String,
    args: Schema.Array(Schema.String),
    turnTimeoutMs: Schema.Number,
    readTimeoutMs: Schema.Number,
    stallTimeoutMs: Schema.Number,
  }),
  greptile: Schema.Struct({
    enabled: Schema.Boolean,
    summonComment: Schema.String,
    requiredScore: Schema.Number,
  }),
  humanReview: Schema.Struct({
    requireApproval: Schema.Boolean,
    requireNoUnresolvedThreads: Schema.Boolean,
  }),
})

export type OrcaConfig = Schema.Schema.Type<typeof OrcaConfigSchema>

export const decodeOrcaConfig = (input: unknown) =>
  Schema.decodeUnknownEffect(OrcaConfigSchema)(input)

export const loadOrcaConfig = (configPath: string) =>
  Effect.gen(function* () {
    const resolvedPath = path.resolve(configPath)
    const moduleValue = yield* Effect.tryPromise({
      try: async () => import(pathToFileURL(resolvedPath).href),
      catch: (cause) => new ConfigLoadError({ path: resolvedPath, cause }),
    })

    const config = yield* decodeOrcaConfig(moduleValue.default)

    return {
      config,
      resolvedPath,
    }
  })
