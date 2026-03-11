import { Data, Effect } from "effect"
import { spawn } from "node:child_process"
import readline from "node:readline"
import type { OrcaConfig } from "./orca-config"

type AgentFailureReason =
  | "process-exited"
  | "protocol-error"
  | "read-timeout"
  | "response-error"
  | "stall-timeout"
  | "startup-timeout"
  | "turn-timeout"

export class AgentRunnerError extends Data.TaggedError("AgentRunnerError")<{
  readonly diagnostics: ReadonlyArray<string>
  readonly message: string
  readonly reason: AgentFailureReason
  readonly retryable: boolean
}> {}

type CodexConfig = Pick<OrcaConfig, "agent" | "codex">

const formatRpcError = (error: unknown) => {
  if (typeof error !== "object" || error === null) {
    return String(error)
  }

  const code = "code" in error ? String(error.code) : "unknown"
  const message = "message" in error ? String(error.message) : "unknown"

  return `${code}: ${message}`
}

const getResponseId = (message: unknown) =>
  typeof message === "object" && message !== null && "id" in message
    ? typeof message.id === "number"
      ? message.id
      : null
    : null

const getNotificationMethod = (message: unknown) =>
  typeof message === "object" && message !== null && "method" in message
    ? typeof message.method === "string"
      ? message.method
      : null
    : null

export const runCodexAgent = ({
  config,
  cwd,
  prompt,
}: {
  readonly config: CodexConfig
  readonly cwd: string
  readonly prompt: string
}) =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        if (config.agent.maxTurns < 1) {
          reject(
            new AgentRunnerError({
              diagnostics: [],
              message: "agent.maxTurns must be at least 1",
              reason: "protocol-error",
              retryable: false,
            }),
          )
          return
        }

        const child = spawn(config.codex.executable, [...config.codex.args], {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
        })

        const stdout = child.stdout
        const stderr = child.stderr

        if (stdout === null || stderr === null || child.stdin === null) {
          reject(
            new AgentRunnerError({
              diagnostics: [],
              message: "agent process did not expose stdio pipes",
              reason: "process-exited",
              retryable: true,
            }),
          )
          return
        }

        const diagnostics: Array<string> = []
        const pending = new Map<
          number,
          {
            readonly reject: (error: AgentRunnerError) => void
            readonly resolve: (result: unknown) => void
            readonly timeout: ReturnType<typeof setTimeout>
          }
        >()
        const output = readline.createInterface({ input: stdout })

        let completed = false
        let currentTurnId: string | null = null
        let nextRequestId = 0
        let stallTimeout: ReturnType<typeof setTimeout> | null = null
        let turnTimeout: ReturnType<typeof setTimeout> | null = null

        const fail = (
          reason: AgentFailureReason,
          message: string,
          retryable: boolean,
        ) => {
          if (completed) {
            return
          }

          completed = true
          if (stallTimeout !== null) {
            clearTimeout(stallTimeout)
          }
          if (turnTimeout !== null) {
            clearTimeout(turnTimeout)
          }
          for (const entry of pending.values()) {
            clearTimeout(entry.timeout)
          }
          pending.clear()
          output.close()
          child.stdin.end()
          if (child.exitCode === null) {
            child.kill("SIGTERM")
          }

          reject(
            new AgentRunnerError({
              diagnostics: [...diagnostics],
              message,
              reason,
              retryable,
            }),
          )
        }

        const succeed = () => {
          if (completed) {
            return
          }

          completed = true
          if (stallTimeout !== null) {
            clearTimeout(stallTimeout)
          }
          if (turnTimeout !== null) {
            clearTimeout(turnTimeout)
          }
          for (const entry of pending.values()) {
            clearTimeout(entry.timeout)
          }
          pending.clear()
          output.close()
          child.stdin.end()
          if (child.exitCode === null) {
            child.kill("SIGTERM")
          }
          resolve()
        }

        const resetStallTimeout = () => {
          if (stallTimeout !== null) {
            clearTimeout(stallTimeout)
          }

          stallTimeout = setTimeout(() => {
            fail("stall-timeout", "agent stalled waiting for output", true)
          }, config.codex.stallTimeoutMs)
        }

        const send = (message: Record<string, unknown>) => {
          child.stdin.write(`${JSON.stringify(message)}\n`)
        }

        const request = (
          method: string,
          params: Record<string, unknown>,
          timeoutMs: number,
          timeoutReason: AgentFailureReason,
          timeoutMessage: string,
          retryable: boolean,
        ) => {
          const id = ++nextRequestId

          return new Promise<unknown>((innerResolve, innerReject) => {
            const timeout = setTimeout(() => {
              pending.delete(id)
              innerReject(
                new AgentRunnerError({
                  diagnostics: [...diagnostics],
                  message: timeoutMessage,
                  reason: timeoutReason,
                  retryable,
                }),
              )
            }, timeoutMs)

            pending.set(id, {
              reject: innerReject,
              resolve: innerResolve,
              timeout,
            })

            send({
              id,
              method,
              params,
            })
          })
        }

        child.on("error", (error) => {
          fail(
            "process-exited",
            `failed to start the agent process: ${error.message}`,
            true,
          )
        })

        child.on("exit", (code, signal) => {
          if (completed) {
            return
          }

          fail(
            "process-exited",
            `agent process exited before turn completion (code ${code ?? "null"}, signal ${signal ?? "null"})`,
            true,
          )
        })

        stderr.on("data", (chunk) => {
          resetStallTimeout()
          diagnostics.push(String(chunk).trim())
        })

        output.on("line", (line) => {
          resetStallTimeout()

          let message: unknown
          try {
            message = JSON.parse(line)
          } catch {
            fail(
              "protocol-error",
              "agent emitted malformed stdout protocol payload",
              false,
            )
            return
          }

          const responseId = getResponseId(message)
          if (responseId !== null) {
            const pendingResponse = pending.get(responseId)
            if (pendingResponse) {
              clearTimeout(pendingResponse.timeout)
              pending.delete(responseId)

              if (
                typeof message === "object" &&
                message !== null &&
                "error" in message &&
                message.error !== undefined
              ) {
                pendingResponse.reject(
                  new AgentRunnerError({
                    diagnostics: [...diagnostics],
                    message: `agent request failed: ${formatRpcError(message.error)}`,
                    reason: "response-error",
                    retryable: true,
                  }),
                )
                return
              }

              pendingResponse.resolve(
                typeof message === "object" &&
                  message !== null &&
                  "result" in message
                  ? message.result
                  : null,
              )
            }
            return
          }

          const method = getNotificationMethod(message)
          if (method !== "turn/completed") {
            return
          }

          const turn =
            typeof message === "object" &&
            message !== null &&
            "params" in message
              ? (
                  message.params as {
                    readonly turn?: {
                      readonly id?: string
                      readonly status?: string
                    }
                  }
                ).turn
              : undefined

          if (
            currentTurnId !== null &&
            typeof turn?.id === "string" &&
            turn.id !== currentTurnId
          ) {
            return
          }

          const status = turn?.status ?? "completed"
          if (status === "completed") {
            succeed()
            return
          }

          fail(
            "response-error",
            `agent turn completed with status ${status}`,
            true,
          )
        })

        resetStallTimeout()

        void (async () => {
          try {
            const initializeResult = (await request(
              "initialize",
              {
                clientInfo: {
                  name: "orca",
                  title: "Orca",
                  version: "0.0.0",
                },
              },
              config.codex.readTimeoutMs,
              "startup-timeout",
              "agent startup handshake timed out",
              true,
            )) as Record<string, unknown> | null

            if (initializeResult === null) {
              throw new AgentRunnerError({
                diagnostics: [...diagnostics],
                message: "agent startup handshake returned no result",
                reason: "protocol-error",
                retryable: false,
              })
            }

            send({
              method: "initialized",
              params: {},
            })

            const threadResult = (await request(
              "thread/start",
              {
                cwd,
              },
              config.codex.readTimeoutMs,
              "read-timeout",
              "timed out waiting for thread/start response",
              true,
            )) as {
              readonly thread?: {
                readonly id?: string
              }
            } | null

            const threadId = threadResult?.thread?.id
            if (typeof threadId !== "string" || threadId.length === 0) {
              throw new AgentRunnerError({
                diagnostics: [...diagnostics],
                message: "agent did not return a thread id",
                reason: "protocol-error",
                retryable: false,
              })
            }

            const turnResult = (await request(
              "turn/start",
              {
                cwd,
                input: [
                  {
                    text: prompt,
                    type: "text",
                  },
                ],
                threadId,
              },
              config.codex.readTimeoutMs,
              "read-timeout",
              "timed out waiting for turn/start response",
              true,
            )) as {
              readonly turn?: {
                readonly id?: string
              }
            } | null

            currentTurnId = turnResult?.turn?.id ?? null
            if (currentTurnId === null) {
              throw new AgentRunnerError({
                diagnostics: [...diagnostics],
                message: "agent did not return a turn id",
                reason: "protocol-error",
                retryable: false,
              })
            }

            turnTimeout = setTimeout(() => {
              fail("turn-timeout", "agent turn timed out", true)
            }, config.codex.turnTimeoutMs)
          } catch (error) {
            if (error instanceof AgentRunnerError) {
              fail(error.reason, error.message, error.retryable)
              return
            }

            fail(
              "process-exited",
              error instanceof Error ? error.message : String(error),
              true,
            )
          }
        })()
      }),
    catch: (cause) =>
      cause instanceof AgentRunnerError
        ? cause
        : new AgentRunnerError({
            diagnostics: [],
            message: cause instanceof Error ? cause.message : String(cause),
            reason: "process-exited",
            retryable: true,
          }),
  })
