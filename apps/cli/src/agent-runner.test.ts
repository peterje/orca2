import { Effect } from "effect"
import { afterEach, describe, expect, it } from "bun:test"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { runCodexAgent } from "./agent-runner"

const tempDirectories = new Set<string>()

afterEach(async () => {
  await Promise.all(
    [...tempDirectories].map(async (directory) => {
      await rm(directory, { force: true, recursive: true })
      tempDirectories.delete(directory)
    }),
  )
})

const writeAgentScript = async (contents: string) => {
  const directory = await mkdtemp(path.join(tmpdir(), "orca-agent-runner-"))
  tempDirectories.add(directory)

  const scriptPath = path.join(directory, "agent.js")
  await writeFile(scriptPath, contents)

  return {
    cwd: directory,
    scriptPath,
  }
}

describe("agent runner", () => {
  it("rejects invalid maxTurns before spawning the agent process", async () => {
    const { cwd } = await writeAgentScript(`setInterval(() => {}, 1000)\n`)
    const missingExecutable = path.join(cwd, "missing-agent")

    const failure = await Effect.runPromise(
      Effect.flip(
        runCodexAgent({
          config: {
            agent: {
              maxRetryBackoffMs: 1_000,
              maxTurns: 0,
            },
            codex: {
              args: [],
              executable: missingExecutable,
              readTimeoutMs: 50,
              stallTimeoutMs: 1_000,
              turnTimeoutMs: 1_000,
            },
          },
          cwd,
          prompt: "say hello",
        }),
      ),
    )

    expect(failure.message).toBe("agent.maxTurns must be at least 1")
    expect(failure.reason).toBe("protocol-error")
    expect(failure.retryable).toBe(false)

    await expect(access(missingExecutable)).rejects.toThrow()
  })

  it("maps a missing startup handshake to a retryable startup timeout", async () => {
    const { cwd, scriptPath } = await writeAgentScript(
      `setInterval(() => {}, 1000)\n`,
    )

    const failure = await Effect.runPromise(
      Effect.flip(
        runCodexAgent({
          config: {
            agent: {
              maxRetryBackoffMs: 1_000,
              maxTurns: 1,
            },
            codex: {
              args: [scriptPath],
              executable: process.execPath,
              readTimeoutMs: 50,
              stallTimeoutMs: 1_000,
              turnTimeoutMs: 1_000,
            },
          },
          cwd,
          prompt: "say hello",
        }),
      ),
    )

    expect(failure.reason).toBe("startup-timeout")
    expect(failure.retryable).toBe(true)
  })

  it("maps stalled output to a retryable stall timeout", async () => {
    const { cwd, scriptPath } = await writeAgentScript(`
const readline = require("node:readline")

const input = readline.createInterface({ input: process.stdin })

input.on("line", (line) => {
  const message = JSON.parse(line)
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { ok: true } }) + "\\n")
    return
  }

  if (message.method === "thread/start") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { thread: { id: "thr_1" } } }) + "\\n")
    return
  }

  if (message.method === "turn/start") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { turn: { id: "turn_1" } } }) + "\\n")
  }
})
`)

    const failure = await Effect.runPromise(
      Effect.flip(
        runCodexAgent({
          config: {
            agent: {
              maxRetryBackoffMs: 1_000,
              maxTurns: 1,
            },
            codex: {
              args: [scriptPath],
              executable: process.execPath,
              readTimeoutMs: 100,
              stallTimeoutMs: 75,
              turnTimeoutMs: 1_000,
            },
          },
          cwd,
          prompt: "say hello",
        }),
      ),
    )

    expect(failure.reason).toBe("stall-timeout")
    expect(failure.retryable).toBe(true)
  })

  it("maps an overlong turn to a retryable turn timeout", async () => {
    const { cwd, scriptPath } = await writeAgentScript(`
const readline = require("node:readline")

const input = readline.createInterface({ input: process.stdin })

input.on("line", (line) => {
  const message = JSON.parse(line)
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { ok: true } }) + "\\n")
    return
  }

  if (message.method === "thread/start") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { thread: { id: "thr_1" } } }) + "\\n")
    return
  }

  if (message.method === "turn/start") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { turn: { id: "turn_1" } } }) + "\\n")
    setInterval(() => {
      process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "." } }) + "\\n")
    }, 10)
  }
})
`)

    const failure = await Effect.runPromise(
      Effect.flip(
        runCodexAgent({
          config: {
            agent: {
              maxRetryBackoffMs: 1_000,
              maxTurns: 1,
            },
            codex: {
              args: [scriptPath],
              executable: process.execPath,
              readTimeoutMs: 100,
              stallTimeoutMs: 1_000,
              turnTimeoutMs: 75,
            },
          },
          cwd,
          prompt: "say hello",
        }),
      ),
    )

    expect(failure.reason).toBe("turn-timeout")
    expect(failure.retryable).toBe(true)
  })
})
