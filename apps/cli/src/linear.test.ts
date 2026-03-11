import { Effect, Schema } from "effect"
import { describe, expect, it } from "bun:test"
import { decodeActiveIssuesResponse, normalizeActiveIssues } from "./linear"
import { buildRuntimeSnapshot } from "./orchestrator"

describe("linear normalization", () => {
  it("normalizes linked github pull requests from attachments", async () => {
    const decoded = await Effect.runPromise(
      decodeActiveIssuesResponse({
        data: {
          issues: {
            nodes: [
              {
                id: "issue-1",
                identifier: "PET-46",
                title: "bootstrap orca",
                description: "build the tracer bullet",
                branchName: null,
                priority: 2,
                createdAt: "2026-03-11T10:00:00.000Z",
                updatedAt: "2026-03-11T10:05:00.000Z",
                state: {
                  id: "state-1",
                  name: "In Progress",
                  type: "started",
                },
                labels: {
                  nodes: [{ id: "label-1", name: "daemon" }],
                },
                attachments: {
                  nodes: [
                    {
                      id: "attachment-1",
                      title: "orca bootstrap pr",
                      subtitle: null,
                      url: "https://github.com/peterje/orca2/pull/42",
                      metadata: { source: "github" },
                      sourceType: "github",
                    },
                    {
                      id: "attachment-2",
                      title: "duplicate link",
                      subtitle: null,
                      url: "https://github.com/peterje/orca2/pull/42",
                      metadata: { source: "github" },
                      sourceType: "github",
                    },
                  ],
                },
              },
            ],
          },
        },
      }),
    )

    const issues = normalizeActiveIssues(decoded, ["Done", "Canceled"])

    expect(issues).toHaveLength(1)
    expect(issues[0]?.linkedPullRequests).toEqual([
      {
        provider: "github",
        owner: "peterje",
        repo: "orca2",
        number: 42,
        url: "https://github.com/peterje/orca2/pull/42",
        title: "orca bootstrap pr",
        attachmentId: "attachment-1",
      },
    ])
    expect(issues[0]?.normalizedState).toBe("linked-pr-detected")
    expect(issues[0]?.runnable).toBe(false)
  })

  it("fails with a schema error for invalid linear payloads", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        decodeActiveIssuesResponse({
          data: {
            issues: {
              nodes: [
                {
                  id: "issue-1",
                },
              ],
            },
          },
        }),
      ),
    )

    expect(Schema.isSchemaError(failure)).toBe(true)
    if (!Schema.isSchemaError(failure)) {
      throw failure
    }
    expect(String(failure.issue)).toContain("identifier")
  })

  it("marks terminal issues without pull requests as terminal", async () => {
    const decoded = await Effect.runPromise(
      decodeActiveIssuesResponse({
        data: {
          issues: {
            nodes: [
              {
                id: "issue-5",
                identifier: "PET-49",
                title: "already done",
                description: null,
                branchName: null,
                priority: 2,
                createdAt: "2026-03-11T08:00:00.000Z",
                updatedAt: "2026-03-11T08:05:00.000Z",
                state: {
                  id: "state-4",
                  name: "Done",
                  type: "completed",
                },
                labels: {
                  nodes: [],
                },
                attachments: {
                  nodes: [],
                },
              },
            ],
          },
        },
      }),
    )

    const issues = normalizeActiveIssues(decoded, ["Done", "Canceled"])

    expect(issues[0]?.normalizedState).toBe("terminal")
    expect(issues[0]?.runnable).toBe(false)
  })

  it("selects a single runnable issue by priority, age, and identifier", async () => {
    const decoded = await Effect.runPromise(
      decodeActiveIssuesResponse({
        data: {
          issues: {
            nodes: [
              {
                id: "issue-2",
                identifier: "PET-48",
                title: "lower priority",
                description: null,
                branchName: null,
                priority: 3,
                createdAt: "2026-03-11T11:00:00.000Z",
                updatedAt: "2026-03-11T11:05:00.000Z",
                state: {
                  id: "state-1",
                  name: "Todo",
                  type: "unstarted",
                },
                labels: {
                  nodes: [],
                },
                attachments: {
                  nodes: [],
                },
              },
              {
                id: "issue-3",
                identifier: "PET-47",
                title: "higher priority",
                description: null,
                branchName: null,
                priority: 1,
                createdAt: "2026-03-11T12:00:00.000Z",
                updatedAt: "2026-03-11T12:05:00.000Z",
                state: {
                  id: "state-2",
                  name: "Todo",
                  type: "unstarted",
                },
                labels: {
                  nodes: [],
                },
                attachments: {
                  nodes: [],
                },
              },
              {
                id: "issue-4",
                identifier: "PET-46",
                title: "already linked",
                description: null,
                branchName: null,
                priority: 1,
                createdAt: "2026-03-11T09:00:00.000Z",
                updatedAt: "2026-03-11T09:05:00.000Z",
                state: {
                  id: "state-3",
                  name: "In Progress",
                  type: "started",
                },
                labels: {
                  nodes: [],
                },
                attachments: {
                  nodes: [
                    {
                      id: "attachment-9",
                      title: "tracked pr",
                      subtitle: null,
                      url: "https://github.com/peterje/orca2/pull/99",
                      metadata: {},
                      sourceType: "github",
                    },
                  ],
                },
              },
            ],
          },
        },
      }),
    )

    const snapshot = buildRuntimeSnapshot(
      normalizeActiveIssues(decoded, ["Done", "Canceled"]),
    )

    expect(snapshot.runnableIssue?.identifier).toBe("PET-47")
    expect(snapshot.activeIssues.map((issue) => issue.identifier)).toEqual([
      "PET-46",
      "PET-47",
      "PET-48",
    ])
  })
})
