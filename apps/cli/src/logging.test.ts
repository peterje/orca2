import { Effect } from "effect"
import { afterEach, describe, expect, it } from "bun:test"
import { log } from "./logging"

const originalConsoleLog = console.log

let capturedLine: string | null = null

afterEach(() => {
  capturedLine = null
  console.log = originalConsoleLog
})

describe("logging", () => {
  it("preserves reserved metadata keys when fields collide", async () => {
    console.log = (message?: unknown) => {
      capturedLine = String(message)
    }

    await Effect.runPromise(
      log("Info", "Info", "orca.snapshot.updated", {
        event: "user-event",
        level: "Fatal",
        timestamp: "not-a-real-timestamp",
        issueId: "issue-1",
      }),
    )

    expect(capturedLine).not.toBeNull()

    const parsed = JSON.parse(capturedLine as string) as Record<string, unknown>

    expect(parsed.event).toBe("orca.snapshot.updated")
    expect(parsed.level).toBe("Info")
    expect(parsed.timestamp).not.toBe("not-a-real-timestamp")
    expect(parsed.issueId).toBe("issue-1")
  })
})
