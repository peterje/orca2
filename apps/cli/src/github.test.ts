import { Effect } from "effect"
import { describe, expect, it } from "bun:test"
import type { PullRequest } from "./domain"
import type { GitHubInspectionResult } from "./github"
import { inspectIssueGitHubState, normalizeCheckSummary } from "./github"

const baseIssue = {
  blockers: [],
  branchName: null,
  createdAt: "2026-03-11T12:00:00.000Z",
  description: "implement the execution slice",
  id: "issue-1",
  identifier: "PET-47",
  labels: ["daemon"],
  linkedPullRequests: [],
  normalizedState: "runnable" as const,
  priority: 1,
  priorityRank: 1,
  stateName: "Todo",
  stateType: "unstarted",
  title: "run implementation attempts",
  updatedAt: "2026-03-11T12:01:00.000Z",
}

const githubConfig = {
  apiUrl: "https://api.github.com",
  owner: "peterje",
  repo: "orca2",
  token: "github-token",
} as const

const openPullRequest: PullRequest = {
  baseRefName: "main",
  headRefName: "pet-47",
  headSha: "abc123",
  isDraft: false,
  number: 42,
  owner: "peterje",
  provider: "github",
  repo: "orca2",
  state: "open",
  title: "feat: run implementation attempts",
  url: "https://github.com/peterje/orca2/pull/42",
}

describe("github inspection", () => {
  it("prefers the pull request linked from linear over branch fallback", async () => {
    const branchLookups: Array<string> = []

    const result = await Effect.runPromise(
      inspectIssueGitHubState({
        config: githubConfig,
        fetchCheckSummary: () =>
          Effect.succeed({
            failedCount: 0,
            pendingCount: 0,
            status: "passed",
            successfulCount: 2,
            totalCount: 2,
          }),
        fetchPullRequestByNumber: () => Effect.succeed(openPullRequest),
        issue: {
          ...baseIssue,
          branchName: "some-other-branch",
          linkedPullRequests: [
            {
              attachmentId: "attachment-1",
              number: 42,
              owner: "peterje",
              provider: "github" as const,
              repo: "orca2",
              title: "feat: run implementation attempts",
              url: "https://github.com/peterje/orca2/pull/42",
            },
          ],
          normalizedState: "linked-pr-detected" as const,
        },
        listPullRequestsByBranch: (_, branchName) => {
          branchLookups.push(branchName)
          return Effect.succeed([])
        },
      }) as Effect.Effect<GitHubInspectionResult, unknown, never>,
    )

    expect(result.kind).toBe("found-pr")
    if (result.kind !== "found-pr") {
      throw new Error("expected a found pull request result")
    }
    expect(result.associationSource).toBe("linear")
    expect(result.headSha).toBe("abc123")
    expect(branchLookups).toEqual([])
  })

  it("falls back to tracked branch lookup when no linked pull request exists", async () => {
    const branchLookups: Array<string> = []

    const result = await Effect.runPromise(
      inspectIssueGitHubState({
        config: githubConfig,
        fetchCheckSummary: () =>
          Effect.succeed({
            failedCount: 0,
            pendingCount: 2,
            status: "pending",
            successfulCount: 0,
            totalCount: 2,
          }),
        issue: baseIssue,
        listPullRequestsByBranch: (_, branchName) => {
          branchLookups.push(branchName)
          return Effect.succeed([
            {
              ...openPullRequest,
              headSha: "def456",
              number: 43,
              title: "feat: reconcile github state",
              url: "https://github.com/peterje/orca2/pull/43",
            },
          ])
        },
        trackedBranchName: "pet-47",
      }) as Effect.Effect<GitHubInspectionResult, unknown, never>,
    )

    expect(result).toEqual({
      associationSource: "branch",
      branchNames: ["pet-47"],
      checkSummary: {
        failedCount: 0,
        pendingCount: 2,
        status: "pending",
        successfulCount: 0,
        totalCount: 2,
      },
      headSha: "def456",
      kind: "found-pr",
      pullRequest: {
        ...openPullRequest,
        headSha: "def456",
        number: 43,
        title: "feat: reconcile github state",
        url: "https://github.com/peterje/orca2/pull/43",
      },
    })
    expect(branchLookups).toEqual(["pet-47"])
  })

  it("marks missing check signals as ambiguous", () => {
    expect(
      normalizeCheckSummary({
        checkRuns: {
          check_runs: [],
          total_count: 0,
        },
        combinedStatus: {
          state: "success",
          total_count: 0,
        },
      }),
    ).toEqual({
      failedCount: 0,
      pendingCount: 0,
      status: "ambiguous",
      successfulCount: 0,
      totalCount: 0,
    })
  })
})
