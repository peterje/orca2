import {
  createOpencodeClient,
  createOpencodeServer,
  type Config as OpencodeServerConfig,
  type ServerOptions,
} from "@opencode-ai/sdk"
import { Data, Effect } from "effect"
import type { OrcaConfig } from "./orca-config"

type AgentFailureReason =
  | "process-exited"
  | "protocol-error"
  | "response-error"
  | "startup-timeout"
  | "turn-timeout"

export class AgentRunnerError extends Data.TaggedError("AgentRunnerError")<{
  readonly diagnostics: ReadonlyArray<string>
  readonly message: string
  readonly reason: AgentFailureReason
  readonly retryable: boolean
}> {}

type OpencodeConfig = Pick<OrcaConfig, "agent" | "opencode">

type CreateSessionResponse = {
  readonly data:
    | {
        readonly id?: string
      }
    | undefined
}

type PromptSessionResponse = {
  readonly data:
    | {
        readonly info?: {
          readonly error?: unknown
        }
      }
    | undefined
}

type OpencodeClientLike = {
  readonly session: {
    readonly create: (options?: {
      readonly throwOnError?: boolean
    }) => Promise<CreateSessionResponse>
    readonly prompt: (options: {
      readonly body: {
        readonly parts: Array<{
          readonly text: string
          readonly type: "text"
        }>
      }
      readonly path: {
        readonly id: string
      }
      readonly throwOnError?: boolean
    }) => Promise<PromptSessionResponse>
  }
}

type OpencodeServerLike = {
  readonly close: () => void
  readonly url: string
}

const cleanupServer = (server: OpencodeServerLike) =>
  Effect.sync(() => {
    server.close()
  })

const getProperty = (input: unknown, key: string) =>
  typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)[key]
    : undefined

const getBoolean = (input: unknown) =>
  typeof input === "boolean" ? input : undefined

const getString = (input: unknown) =>
  typeof input === "string" ? input : undefined

const formatUnknown = (input: unknown): string => {
  if (input instanceof Error) {
    return input.message
  }

  if (typeof input === "string") {
    return input
  }

  try {
    return JSON.stringify(input)
  } catch {
    return String(input)
  }
}

const diagnosticsFrom = (input: unknown): ReadonlyArray<string> => {
  const message = formatUnknown(input).trim()
  return message.length === 0 ? [] : [message]
}

const formatMessageError = (error: unknown) => {
  const name = getString(getProperty(error, "name")) ?? "UnknownError"
  const message =
    getString(getProperty(getProperty(error, "data"), "message")) ??
    formatUnknown(error)

  return `${name}: ${message}`
}

const isRetryableMessageError = (error: unknown) => {
  const name = getString(getProperty(error, "name"))
  if (name === "APIError") {
    return (
      getBoolean(getProperty(getProperty(error, "data"), "isRetryable")) ??
      true
    )
  }

  return name === "MessageAbortedError" || name === "UnknownError"
}

const buildServerConfig = (
  config: OpencodeConfig,
): OpencodeServerConfig => ({
  agent: {
    build: {
      maxSteps: config.agent.maxTurns,
    },
  },
})

const invalidMaxTurnsError = () =>
  new AgentRunnerError({
    diagnostics: [],
    message: "agent.maxTurns must be at least 1",
    reason: "protocol-error",
    retryable: false,
  })

const startupFailure = (cause: unknown) => {
  const message = formatUnknown(cause)

  return new AgentRunnerError({
    diagnostics: diagnosticsFrom(cause),
    message,
    reason: message.includes("Timeout waiting for server to start")
      ? "startup-timeout"
      : "process-exited",
    retryable: true,
  })
}

const responseFailure = (
  cause: unknown,
  retryable = true,
  message = formatUnknown(cause),
) =>
  new AgentRunnerError({
    diagnostics: diagnosticsFrom(cause),
    message,
    reason: "response-error",
    retryable,
  })

const protocolFailure = (message: string) =>
  new AgentRunnerError({
    diagnostics: [],
    message,
    reason: "protocol-error",
    retryable: false,
  })

export const runOpencodeAgent = ({
  config,
  cwd,
  prompt,
  createClient = ({
    baseUrl,
    directory,
  }: {
    readonly baseUrl: string
    readonly directory: string
  }) => createOpencodeClient({ baseUrl, directory }) as OpencodeClientLike,
  createServer = (options: ServerOptions) => createOpencodeServer(options),
}: {
  readonly config: OpencodeConfig
  readonly cwd: string
  readonly prompt: string
  readonly createClient?: (options: {
    readonly baseUrl: string
    readonly directory: string
  }) => OpencodeClientLike
  readonly createServer?: (
    options: ServerOptions,
  ) => Promise<OpencodeServerLike>
}) =>
  config.agent.maxTurns < 1
    ? Effect.fail(invalidMaxTurnsError())
    : Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () =>
            createServer({
              config: buildServerConfig(config),
              timeout: config.opencode.startupTimeoutMs,
            }),
          catch: startupFailure,
        }),
        (server) =>
          Effect.gen(function* () {
            const client = createClient({
              baseUrl: server.url,
              directory: cwd,
            })

            const createdSession = yield* Effect.tryPromise({
              try: () => client.session.create({ throwOnError: true }),
              catch: (cause) => responseFailure(cause, true),
            })

            const sessionId = createdSession.data?.id
            if (typeof sessionId !== "string" || sessionId.length === 0) {
              return yield* protocolFailure(
                "opencode did not return a session id",
              )
            }

            const promptResponse = yield* Effect.tryPromise({
              try: () =>
                client.session.prompt({
                  body: {
                    parts: [
                      {
                        text: prompt,
                        type: "text",
                      },
                    ],
                  },
                  path: {
                    id: sessionId,
                  },
                  throwOnError: true,
                }),
              catch: (cause) => responseFailure(cause, true),
            }).pipe(
              Effect.timeoutOrElse({
                duration: config.opencode.turnTimeoutMs,
                onTimeout: () =>
                  Effect.fail(
                    new AgentRunnerError({
                      diagnostics: [],
                      message: "agent turn timed out",
                      reason: "turn-timeout",
                      retryable: true,
                    }),
                  ),
              }),
            )

            const messageError = promptResponse.data?.info?.error
            if (messageError !== undefined) {
              return yield* responseFailure(
                messageError,
                isRetryableMessageError(messageError),
                `opencode prompt failed: ${formatMessageError(messageError)}`,
              )
            }
          }),
        cleanupServer,
      )
