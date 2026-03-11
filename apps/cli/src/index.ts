import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Command, Flag } from "effect/unstable/cli"
import { runOrchestrator } from "./orchestrator"
import { appLogLevels } from "./logging"
import { loadOrcaConfig } from "./orca-config"

const logLevelFlag = Flag.choiceWithValue(
  "log-level",
  appLogLevels.map((level) => [level.toLowerCase(), level] as const),
).pipe(Flag.withDefault("Info"), Flag.withDescription("minimum log level"))

const configFlag = Flag.string("config").pipe(
  Flag.withDefault("orca.config.ts"),
  Flag.withDescription("path to orca.config.ts"),
)

export const cli = Command.make(
  "orca",
  {
    config: configFlag,
    logLevel: logLevelFlag,
  },
  ({ config, logLevel }) =>
    loadOrcaConfig(config).pipe(
      Effect.flatMap(({ config: orcaConfig, resolvedPath }) =>
        runOrchestrator({
          config: orcaConfig,
          configPath: resolvedPath,
          logLevel,
        }),
      ),
    ),
).pipe(Command.withDescription("poll Linear and track the runnable orca issue"))

export const program = Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.catch((error: unknown) =>
    Effect.sync(() => {
      const message = Schema.isSchemaError(error)
        ? String(error.issue)
        : error instanceof Error
          ? error.message
          : String(error)

      console.error(message)
      process.exitCode = 1
    }),
  ),
  Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
)
