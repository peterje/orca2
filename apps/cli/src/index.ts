import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Command, Flag } from "effect/unstable/cli"
import { formatErrorMessage } from "./error-format"
import { appLogLevels, writeLogLine } from "./logging"
import { runOrchestrator } from "./orchestrator"
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

export const platformLayer = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
)

export const program = cli.pipe(
  Command.run({ version: "0.0.0" }),
  Effect.catch((error: unknown) =>
    Effect.sync(() => {
      writeLogLine("Error", "orca.boot.failed", {
        message: formatErrorMessage(error),
      })
      process.exitCode = 1
    }),
  ),
)
