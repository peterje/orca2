import { Effect } from "effect"
import { describe, expect, it } from "bun:test"
import type { PullRequest } from "./domain"
import type { GitHubInspectionResult } from "./github"
import {
  deriveAiReviewStatus,
  inspectIssueGitHubState,
  normalizeCheckSummary,
} from "./github"

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
        currentHeadSha: null,
        currentReviewRoundCount: null,
        fetchCheckSummary: () =>
          Effect.succeed({
            failedCount: 0,
            pendingCount: 0,
            status: "passed",
            successfulCount: 2,
            totalCount: 2,
          }),
        fetchPullRequestByNumber: () => Effect.succeed(openPullRequest),
        fetchReviewContext: () =>
          Effect.succeed({
            headCommitCommittedAt: "2026-03-11T12:02:00.000Z",
            reviewContext: {
              issueComments: [
                {
                  authorLogin: "orca-bot",
                  body: "@review please",
                  createdAt: "2026-03-11T12:03:00.000Z",
                  htmlUrl:
                    "https://github.com/peterje/orca2/pull/42#issuecomment-1",
                  id: "comment-1",
                },
              ],
              reviewThreads: [],
              reviews: [],
            },
          }),
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
    expect(result.aiReviewStatus?.status).toBe("pending")
    expect(branchLookups).toEqual([])
  })

  it("falls back to tracked branch lookup when no linked pull request exists", async () => {
    const branchLookups: Array<string> = []

    const result = await Effect.runPromise(
      inspectIssueGitHubState({
        config: githubConfig,
        currentHeadSha: null,
        currentReviewRoundCount: null,
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
      aiReviewStatus: null,
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
      reviewContext: {
        issueComments: [],
        reviewThreads: [],
        reviews: [],
      },
      reviewRoundCount: null,
    })
    expect(branchLookups).toEqual(["pet-47"])
  })

  it("treats a closed linear-linked pull request as ambiguous", async () => {
    const result = await Effect.runPromise(
      inspectIssueGitHubState({
        config: githubConfig,
        fetchPullRequestByNumber: () =>
          Effect.succeed({
            ...openPullRequest,
            state: "closed",
          }),
        issue: {
          ...baseIssue,
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
      }) as Effect.Effect<GitHubInspectionResult, unknown, never>,
    )

    expect(result).toEqual({
      branchNames: ["pet-47"],
      kind: "ambiguous",
      message: "linked pull request peterje/orca2#42 is closed",
    })
  })

  it("classifies ai review as completed when review activity arrives after waiting", () => {
    expect(
      deriveAiReviewStatus({
        currentHeadSha: "abc123",
        headCommitCommittedAt: "2026-03-11T12:00:00.000Z",
        issueComments: [
          {
            authorLogin: "orca-bot",
            body: "@review please",
            createdAt: "2026-03-11T12:01:00.000Z",
            htmlUrl: "https://github.com/peterje/orca2/pull/42#issuecomment-1",
            id: "comment-1",
          },
        ],
        previousStatus: {
          headSha: "abc123",
          lastObservedReviewActivityAt: null,
          status: "pending",
          waitingSince: "2026-03-11T12:01:00.000Z",
        },
        reviewThreads: [
          {
            comments: [
              {
                authorLogin: "review-bot",
                body: "needs a test",
                commitId: "abc123",
                createdAt: "2026-03-11T12:04:00.000Z",
                htmlUrl:
                  "https://github.com/peterje/orca2/pull/42#discussion_r1",
                id: "thread-comment-1",
                inReplyToId: null,
                originalCommitId: "abc123",
                path: "src/index.ts",
              },
            ],
            id: "thread-1",
            isResolved: false,
            path: "src/index.ts",
            updatedAt: "2026-03-11T12:04:00.000Z",
          },
        ],
        reviews: [],
      }),
    ).toEqual({
      headSha: "abc123",
      lastObservedReviewActivityAt: "2026-03-11T12:04:00.000Z",
      status: "completed",
      waitingSince: "2026-03-11T12:01:00.000Z",
    })
  })

  it("classifies ai review as pending when only the request comment exists", () => {
    expect(
      deriveAiReviewStatus({
        currentHeadSha: "abc123",
        headCommitCommittedAt: "2026-03-11T12:00:00.000Z",
        issueComments: [
          {
            authorLogin: "orca-bot",
            body: "@review please",
            createdAt: "2026-03-11T12:01:00.000Z",
            htmlUrl: "https://github.com/peterje/orca2/pull/42#issuecomment-1",
            id: "comment-1",
          },
        ],
        reviewThreads: [],
        reviews: [],
      }),
    ).toEqual({
      headSha: "abc123",
      lastObservedReviewActivityAt: null,
      status: "pending",
      waitingSince: "2026-03-11T12:01:00.000Z",
    })
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

  it("ignores cancelled and stale check runs when classifying ci", () => {
    expect(
      normalizeCheckSummary({
        checkRuns: {
          check_runs: [
            {
              conclusion: "cancelled",
              name: "superseded workflow",
              status: "completed",
            },
            {
              conclusion: "stale",
              name: "older workflow",
              status: "completed",
            },
          ],
          total_count: 2,
        },
        combinedStatus: {
          state: "success",
          total_count: 1,
        },
      }),
    ).toEqual({
      failedCount: 0,
      pendingCount: 0,
      status: "passed",
      successfulCount: 1,
      totalCount: 3,
    })
  })
})
