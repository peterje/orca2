import { Effect } from "effect"
import { describe, expect, it } from "bun:test"
import { formatErrorMessage } from "./error-format"
import { decodeActiveIssuesResponse } from "./linear"
import { ConfigLoadError } from "./orca-config"

describe("error formatting", () => {
  it("formats config load errors with path and cause", () => {
    const error = new ConfigLoadError({
      path: "/tmp/orca.config.ts",
      cause: new Error("ENOENT: no such file or directory"),
    })

    expect(formatErrorMessage(error)).toBe(
      "failed to load config from /tmp/orca.config.ts: ENOENT: no such file or directory",
    )
  })

  it("formats schema errors using the issue tree", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        decodeActiveIssuesResponse({
          data: {
            issues: {
              nodes: [{ id: "issue-1" }],
            },
          },
        }),
      ),
    )

    expect(formatErrorMessage(failure)).toContain("identifier")
  })
})
