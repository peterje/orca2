import { Effect } from "effect"
import { describe, expect, it } from "bun:test"
import {
  opencodeStartupTimeoutPrefix,
  runOpencodeAgent,
  runOpencodeAgentText,
} from "./agent-runner"

const baseConfig = {
  agent: {
    maxRetries: 5,
    maxRetryBackoffMs: 1_000,
    maxTurns: 1,
  },
  opencode: {
    startupTimeoutMs: 50,
    turnTimeoutMs: 1_000,
  },
} as const

describe("agent runner", () => {
  it("rejects invalid maxTurns before creating an opencode server", async () => {
    let serverStarted = false

    const failure = await Effect.runPromise(
      Effect.flip(
        runOpencodeAgent({
          config: {
            ...baseConfig,
            agent: {
              ...baseConfig.agent,
              maxTurns: 0,
            },
          },
          createServer: async () => {
            serverStarted = true
            return {
              close() {},
              url: "http://127.0.0.1:4096",
            }
          },
          cwd: "/repo",
          prompt: "say hello",
        }),
      ),
    )
    if (failure === undefined) {
      throw new Error("expected the effect to fail")
    }

    expect(failure.message).toBe("agent.maxTurns must be at least 1")
    expect(failure.reason).toBe("protocol-error")
    expect(failure.retryable).toBe(false)
    expect(serverStarted).toBe(false)
  })

  it("maps a server startup timeout to a retryable startup timeout", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        runOpencodeAgent({
          config: baseConfig,
          createServer: async () => {
            throw new Error(`${opencodeStartupTimeoutPrefix}50ms`)
          },
          cwd: "/repo",
          prompt: "say hello",
        }),
      ),
    )
    if (failure === undefined) {
      throw new Error("expected the effect to fail")
    }

    expect(failure.reason).toBe("startup-timeout")
    expect(failure.retryable).toBe(true)
  })

  it("maps assistant message errors to response errors", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        runOpencodeAgent({
          config: baseConfig,
          createClient: () => ({
            session: {
              create: async () => ({
                data: {
                  id: "ses_123",
                },
              }),
              prompt: async () => ({
                data: {
                  info: {
                    error: {
                      data: {
                        message: "missing provider token",
                      },
                      name: "ProviderAuthError",
                    },
                  },
                },
              }),
            },
          }),
          createServer: async () => ({
            close() {},
            url: "http://127.0.0.1:4096",
          }),
          cwd: "/repo",
          prompt: "say hello",
        }),
      ),
    )
    if (failure === undefined) {
      throw new Error("expected the effect to fail")
    }

    expect(failure.reason).toBe("response-error")
    expect(failure.retryable).toBe(false)
    expect(failure.message).toContain("ProviderAuthError")
  })

  it("maps a hanging session create to a retryable turn timeout", async () => {
    let promptCalled = false

    const failure = await Effect.runPromise(
      Effect.flip(
        runOpencodeAgent({
          config: {
            ...baseConfig,
            opencode: {
              ...baseConfig.opencode,
              turnTimeoutMs: 75,
            },
          },
          createClient: () => ({
            session: {
              create: async () => new Promise(() => {}),
              prompt: async () => {
                promptCalled = true
                return {
                  data: {
                    info: {},
                  },
                }
              },
            },
          }),
          createServer: async () => ({
            close() {},
            url: "http://127.0.0.1:4096",
          }),
          cwd: "/repo",
          prompt: "say hello",
        }),
      ),
    )
    if (failure === undefined) {
      throw new Error("expected the effect to fail")
    }

    expect(failure.reason).toBe("turn-timeout")
    expect(failure.retryable).toBe(true)
    expect(failure.message).toBe("opencode session create timed out")
    expect(promptCalled).toBe(false)
  })

  it("maps an overlong prompt to a retryable turn timeout", async () => {
    let closeFinished = false

    const failure = await Effect.runPromise(
      Effect.flip(
        runOpencodeAgent({
          config: {
            ...baseConfig,
            opencode: {
              ...baseConfig.opencode,
              turnTimeoutMs: 75,
            },
          },
          createClient: () => ({
            session: {
              create: async () => ({
                data: {
                  id: "ses_123",
                },
              }),
              prompt: async () => new Promise(() => {}),
            },
          }),
          createServer: async () => ({
            async close() {
              await new Promise((resolve) => setTimeout(resolve, 10))
              closeFinished = true
            },
            url: "http://127.0.0.1:4096",
          }),
          cwd: "/repo",
          prompt: "say hello",
        }),
      ),
    )
    if (failure === undefined) {
      throw new Error("expected the effect to fail")
    }

    expect(failure.reason).toBe("turn-timeout")
    expect(failure.retryable).toBe(true)
    expect(closeFinished).toBe(true)
  })

  it("returns assistant text parts for structured-output callers", async () => {
    const output = await Effect.runPromise(
      runOpencodeAgentText({
        config: baseConfig,
        createClient: () => ({
          session: {
            create: async () => ({
              data: {
                id: "ses_123",
              },
            }),
            prompt: async () => ({
              data: {
                info: {},
                parts: [
                  {
                    text: '{"decision":"waiting_for_human_review"}',
                    type: "text",
                  },
                ],
              },
            }),
          },
        }),
        createServer: async () => ({
          close() {},
          url: "http://127.0.0.1:4096",
        }),
        cwd: "/repo",
        prompt: "return json",
      }),
    )

    expect(output).toBe('{"decision":"waiting_for_human_review"}')
  })
})
