import { Cause, Data, Deferred, Effect, Queue, Ref } from "effect"
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

type AgentEvent =
  | {
      readonly _tag: "process-exited"
      readonly exitCode: number | null
      readonly signalCode: number | string | null
    }
  | {
      readonly _tag: "stderr-line"
      readonly line: string
    }
  | {
      readonly _tag: "stdout-line"
      readonly line: string
    }
  | {
      readonly _tag: "stream-error"
      readonly message: string
    }

type PendingRequest = Deferred.Deferred<unknown, AgentRunnerError>

const spawnAgent = ({
  config,
  cwd,
}: {
  readonly config: CodexConfig
  readonly cwd: string
}) =>
  Effect.try({
    try: () =>
      Bun.spawn([config.codex.executable, ...config.codex.args], {
        cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      } as const),
    catch: (cause) =>
      new AgentRunnerError({
        diagnostics: [],
        message: cause instanceof Error ? cause.message : String(cause),
        reason: "process-exited",
        retryable: true,
      }),
  })

const cleanupAgent = (
  child: ReturnType<typeof Bun.spawn>,
): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      getStdin(child).end()
    } catch {
      // Ignore cleanup races when the process has already exited.
    }

    if (child.exitCode === null) {
      child.kill("SIGTERM")
    }
  })

const getStdin = (child: ReturnType<typeof Bun.spawn>) =>
  child.stdin as {
    readonly end: () => unknown
    readonly flush: () => unknown
    readonly write: (chunk: string) => unknown
  }

const getStderr = (child: ReturnType<typeof Bun.spawn>) =>
  child.stderr as ReadableStream<Uint8Array>

const getStdout = (child: ReturnType<typeof Bun.spawn>) =>
  child.stdout as ReadableStream<Uint8Array>

const readStreamLines = ({
  onLine,
  stream,
}: {
  readonly onLine: (line: string) => Effect.Effect<void>
  readonly stream: ReadableStream<Uint8Array>
}) =>
  Effect.gen(function* () {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    let buffered = ""

    try {
      while (true) {
        const chunk = yield* Effect.tryPromise(() => reader.read())
        if (chunk.done) {
          break
        }

        buffered += decoder.decode(chunk.value, { stream: true })
        let newlineIndex = buffered.indexOf("\n")
        while (newlineIndex !== -1) {
          const line = buffered.slice(0, newlineIndex).replace(/\r$/, "")
          buffered = buffered.slice(newlineIndex + 1)

          if (line.length > 0) {
            yield* onLine(line)
          }

          newlineIndex = buffered.indexOf("\n")
        }
      }

      buffered += decoder.decode()
      const trailingLine = buffered.replace(/\r$/, "")
      if (trailingLine.length > 0) {
        yield* onLine(trailingLine)
      }
    } finally {
      reader.releaseLock()
    }
  })

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
  config.agent.maxTurns < 1
    ? Effect.fail(
        new AgentRunnerError({
          diagnostics: [],
          message: "agent.maxTurns must be at least 1",
          reason: "protocol-error",
          retryable: false,
        }),
      )
    : Effect.acquireUseRelease(
        spawnAgent({
          config,
          cwd,
        }),
        (child) => {
          const diagnosticsRef = Ref.make<ReadonlyArray<string>>([])
          const pendingRef = Ref.make<ReadonlyMap<number, PendingRequest>>(
            new Map(),
          )
          const currentTurnIdRef = Ref.make<string | null>(null)
          const nextRequestIdRef = Ref.make(0)
          const completedRef = Ref.make(false)
          const turnCompleted = Deferred.make<void, AgentRunnerError>()
          const events = Queue.unbounded<AgentEvent>()

          return Effect.gen(function* () {
            const diagnosticsRefValue = yield* diagnosticsRef
            const pendingRefValue = yield* pendingRef
            const currentTurnIdRefValue = yield* currentTurnIdRef
            const nextRequestIdRefValue = yield* nextRequestIdRef
            const completedRefValue = yield* completedRef
            const turnCompletedValue = yield* turnCompleted
            const eventsValue = yield* events

            const makeAgentRunnerError = (
              reason: AgentFailureReason,
              message: string,
              retryable: boolean,
            ) =>
              Ref.get(diagnosticsRefValue).pipe(
                Effect.map(
                  (diagnostics) =>
                    new AgentRunnerError({
                      diagnostics: [...diagnostics],
                      message,
                      reason,
                      retryable,
                    }),
                ),
              )

            const failSession = (error: AgentRunnerError) =>
              Effect.gen(function* () {
                const alreadyCompleted = yield* Ref.get(completedRefValue)
                if (alreadyCompleted) {
                  return
                }

                yield* Ref.set(completedRefValue, true)
                const pending = yield* Ref.modify(
                  pendingRefValue,
                  (currentPending) => [currentPending, new Map()],
                )

                for (const pendingRequest of pending.values()) {
                  yield* Deferred.fail(pendingRequest, error)
                }

                yield* Deferred.fail(turnCompletedValue, error)
              })

            const completeSession = () =>
              Effect.gen(function* () {
                const alreadyCompleted = yield* Ref.get(completedRefValue)
                if (alreadyCompleted) {
                  return
                }

                yield* Ref.set(completedRefValue, true)
                yield* Deferred.succeed(turnCompletedValue, undefined)
              })

            const send = (message: Record<string, unknown>) =>
              Effect.sync(() => {
                getStdin(child).write(`${JSON.stringify(message)}\n`)
                getStdin(child).flush()
              })

            const request = (
              method: string,
              params: Record<string, unknown>,
              timeoutMs: number,
              timeoutReason: AgentFailureReason,
              timeoutMessage: string,
              retryable: boolean,
            ) =>
              Effect.gen(function* () {
                const id = yield* Ref.modify(
                  nextRequestIdRefValue,
                  (currentRequestId) => {
                    const nextRequestId = currentRequestId + 1
                    return [nextRequestId, nextRequestId]
                  },
                )
                const deferred = yield* Deferred.make<
                  unknown,
                  AgentRunnerError
                >()

                yield* Ref.update(pendingRefValue, (currentPending) => {
                  const nextPending = new Map(currentPending)
                  nextPending.set(id, deferred)
                  return nextPending
                })

                yield* send({
                  id,
                  method,
                  params,
                })

                return yield* Deferred.await(deferred).pipe(
                  Effect.timeoutOrElse({
                    duration: timeoutMs,
                    onTimeout: () =>
                      makeAgentRunnerError(
                        timeoutReason,
                        timeoutMessage,
                        retryable,
                      ).pipe(Effect.flatMap(Effect.fail)),
                  }),
                  Effect.ensuring(
                    Ref.update(pendingRefValue, (currentPending) => {
                      const nextPending = new Map(currentPending)
                      nextPending.delete(id)
                      return nextPending
                    }),
                  ),
                )
              })

            const resolvePendingRequest = (
              message: unknown,
              responseId: number,
            ) =>
              Effect.gen(function* () {
                const pendingRequest = yield* Ref.modify(
                  pendingRefValue,
                  (currentPending) => {
                    const nextPending = new Map(currentPending)
                    const request = nextPending.get(responseId)
                    nextPending.delete(responseId)
                    return [request, nextPending]
                  },
                )

                if (pendingRequest === undefined) {
                  return
                }

                if (
                  typeof message === "object" &&
                  message !== null &&
                  "error" in message &&
                  message.error !== undefined
                ) {
                  yield* Deferred.fail(
                    pendingRequest,
                    new AgentRunnerError({
                      diagnostics: [...(yield* Ref.get(diagnosticsRefValue))],
                      message: `agent request failed: ${formatRpcError(message.error)}`,
                      reason: "response-error",
                      retryable: true,
                    }),
                  )
                  return
                }

                yield* Deferred.succeed(
                  pendingRequest,
                  typeof message === "object" &&
                    message !== null &&
                    "result" in message
                    ? message.result
                    : null,
                )
              })

            const handleRpcMessage = (message: unknown) =>
              Effect.gen(function* () {
                const responseId = getResponseId(message)
                if (responseId !== null) {
                  yield* resolvePendingRequest(message, responseId)
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
                const currentTurnId = yield* Ref.get(currentTurnIdRefValue)

                if (
                  currentTurnId !== null &&
                  typeof turn?.id === "string" &&
                  turn.id !== currentTurnId
                ) {
                  return
                }

                const status = turn?.status ?? "completed"
                if (status === "completed") {
                  yield* completeSession()
                  return
                }

                const error = yield* makeAgentRunnerError(
                  "response-error",
                  `agent turn completed with status ${status}`,
                  true,
                )
                yield* failSession(error)
              })

            const handleEvent = (event: AgentEvent) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "stderr-line":
                    yield* Ref.update(diagnosticsRefValue, (diagnostics) =>
                      event.line.trim().length === 0
                        ? diagnostics
                        : [...diagnostics, event.line.trim()],
                    )
                    return
                  case "stdout-line": {
                    const message = yield* Effect.sync(() =>
                      JSON.parse(event.line),
                    ).pipe(
                      Effect.catch(() =>
                        makeAgentRunnerError(
                          "protocol-error",
                          "agent emitted malformed stdout protocol payload",
                          false,
                        ).pipe(
                          Effect.tap(failSession),
                          Effect.flatMap(Effect.fail),
                        ),
                      ),
                    )

                    yield* handleRpcMessage(message)
                    return
                  }
                  case "stream-error": {
                    const error = yield* makeAgentRunnerError(
                      "process-exited",
                      event.message,
                      true,
                    )
                    yield* failSession(error)
                    return
                  }
                  case "process-exited": {
                    const alreadyCompleted = yield* Ref.get(completedRefValue)
                    if (alreadyCompleted) {
                      return
                    }

                    const error = yield* makeAgentRunnerError(
                      "process-exited",
                      `agent process exited before turn completion (code ${event.exitCode ?? "null"}, signal ${event.signalCode ?? "null"})`,
                      true,
                    )
                    yield* failSession(error)
                  }
                }
              })

            const watchEvents = Queue.take(eventsValue).pipe(
              Effect.timeoutOrElse({
                duration: config.codex.stallTimeoutMs,
                onTimeout: () =>
                  makeAgentRunnerError(
                    "stall-timeout",
                    "agent stalled waiting for output",
                    true,
                  ).pipe(
                    Effect.flatMap((error) =>
                      failSession(error).pipe(
                        Effect.andThen(Effect.fail(error)),
                      ),
                    ),
                  ),
              }),
              Effect.flatMap(handleEvent),
              Effect.forever,
              Effect.catch(() => Effect.void),
            )

            const startReader = ({
              lineTag,
              stream,
            }: {
              readonly lineTag: "stderr-line" | "stdout-line"
              readonly stream: ReadableStream<Uint8Array>
            }) =>
              readStreamLines({
                onLine: (line) =>
                  Queue.offer(eventsValue, {
                    _tag: lineTag,
                    line,
                  }),
                stream,
              }).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterrupts(cause)
                    ? Effect.failCause(cause)
                    : Queue.offer(eventsValue, {
                        _tag: "stream-error",
                        message: `failed reading agent ${lineTag === "stdout-line" ? "stdout" : "stderr"}: ${String(Cause.squash(cause))}`,
                      }),
                ),
              )

            yield* watchEvents.pipe(Effect.forkChild)
            yield* startReader({
              lineTag: "stdout-line",
              stream: getStdout(child),
            }).pipe(Effect.forkChild)
            yield* startReader({
              lineTag: "stderr-line",
              stream: getStderr(child),
            }).pipe(Effect.forkChild)
            yield* Effect.tryPromise(() => child.exited).pipe(
              Effect.flatMap(() =>
                Queue.offer(eventsValue, {
                  _tag: "process-exited",
                  exitCode: child.exitCode,
                  signalCode: child.signalCode,
                }),
              ),
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.failCause(cause)
                  : Queue.offer(eventsValue, {
                      _tag: "stream-error",
                      message: `failed waiting for agent exit: ${String(Cause.squash(cause))}`,
                    }),
              ),
              Effect.forkChild,
            )

            return yield* Effect.gen(function* () {
              const initializeResult = (yield* request(
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
                return yield* new AgentRunnerError({
                  diagnostics: [...(yield* Ref.get(diagnosticsRefValue))],
                  message: "agent startup handshake returned no result",
                  reason: "protocol-error",
                  retryable: false,
                })
              }

              yield* send({
                method: "initialized",
                params: {},
              })

              const threadResult = (yield* request(
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
                return yield* new AgentRunnerError({
                  diagnostics: [...(yield* Ref.get(diagnosticsRefValue))],
                  message: "agent did not return a thread id",
                  reason: "protocol-error",
                  retryable: false,
                })
              }

              // Multi-turn orchestration is not wired up yet, so the runner
              // currently dispatches a single turn and reserves maxTurns for that
              // future control flow.
              const turnResult = (yield* request(
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

              const currentTurnId = turnResult?.turn?.id ?? null
              if (currentTurnId === null) {
                return yield* new AgentRunnerError({
                  diagnostics: [...(yield* Ref.get(diagnosticsRefValue))],
                  message: "agent did not return a turn id",
                  reason: "protocol-error",
                  retryable: false,
                })
              }

              yield* Ref.set(currentTurnIdRefValue, currentTurnId)
              yield* Deferred.await(turnCompletedValue).pipe(
                Effect.timeoutOrElse({
                  duration: config.codex.turnTimeoutMs,
                  onTimeout: () =>
                    makeAgentRunnerError(
                      "turn-timeout",
                      "agent turn timed out",
                      true,
                    ).pipe(Effect.flatMap(Effect.fail)),
                }),
              )
            }).pipe(
              Effect.catch((error) => {
                return failSession(error).pipe(
                  Effect.andThen(Effect.fail(error)),
                )
              }),
            )
          })
        },
        cleanupAgent,
      )
