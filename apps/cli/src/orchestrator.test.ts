import { describe, expect, it } from "bun:test"
import { emptyReviewContext } from "./ai-review"
import {
  applyImplementationOutcome,
  applyManualInterventionState,
  resolveRetryPlan,
  updateIssueStateForGitHubInspection,
} from "./orchestrator"

const issue = {
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

const pullRequest = {
  baseRefName: "main",
  headRefName: "pet-47",
  headSha: "abc123",
  isDraft: false,
  number: 42,
  owner: "peterje",
  provider: "github" as const,
  repo: "orca2",
  state: "open" as const,
  title: "feat: run implementation attempts",
  url: "https://github.com/peterje/orca2/pull/42",
}

const issueState = (overrides: Record<string, unknown> = {}) => ({
  aiReviewRoundCount: null,
  aiReviewStatus: null,
  branchName: null,
  checkSummary: null,
  currentHeadSha: null,
  currentPullRequest: null,
  lastError: null,
  reviewContext: emptyReviewContext,
  retryCount: 0,
  retryDueAt: null,
  state: "Todo" as const,
  worktreePath: null,
  ...overrides,
})

const foundPullRequestInspection = (
  overrides: Record<string, unknown> = {},
) => ({
  aiReviewStatus: null,
  associationSource: "linear" as const,
  branchNames: ["pet-47"],
  checkSummary: {
    failedCount: 0,
    pendingCount: 0,
    status: "passed" as const,
    successfulCount: 3,
    totalCount: 3,
  },
  headSha: pullRequest.headSha,
  headCommitCommittedAt: "2026-03-11T12:05:00.000Z",
  humanReviewStatus: {
    actionableFeedbackCount: 0,
    approvalCount: 0,
    hasActionableFeedback: false,
    hasFreshApproval: false,
    isGreen: false,
    unresolvedThreadCount: 0,
  },
  kind: "found-pr" as const,
  pullRequest,
  reviewContext: emptyReviewContext,
  reviewRoundCount: 1,
  ...overrides,
})

describe("orchestrator", () => {
  it("escalates retryable failures to manual intervention after max retries", () => {
    expect(
      resolveRetryPlan({
        maxRetries: 2,
        maxRetryBackoffMs: 60_000,
        retryCount: 2,
        now: Date.UTC(2026, 2, 11, 12, 0, 0),
      }),
    ).toEqual({
      retryCount: 3,
      retryDueAt: null,
      state: "ManualIntervention",
    })
  })

  it("keeps tracking the worktree while waiting for github reconciliation", () => {
    const nextState = applyImplementationOutcome({
      activeIssues: [
        {
          ...issue,
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
      ],
      issue,
      issueStates: new Map([
        [
          issue.id,
          issueState({
            state: "Implementing",
            worktreePath: "/repo/.orca/worktrees/pet-47",
          }),
        ],
      ]),
      outcome: {
        branchName: "pet-47",
        state: "WaitingForPr",
        worktreePath: "/repo/.orca/worktrees/pet-47",
      },
    })

    expect(nextState.get(issue.id)).toEqual(
      issueState({
        branchName: "pet-47",
        state: "WaitingForPr",
        worktreePath: "/repo/.orca/worktrees/pet-47",
      }),
    )
  })

  it("preserves the tracked worktree path for manual intervention", () => {
    const nextState = applyManualInterventionState({
      issue,
      issueStates: new Map([
        [
          issue.id,
          issueState({
            branchName: "pet-47",
            retryCount: 2,
            retryDueAt: "2026-03-11T12:05:00.000Z",
            state: "Implementing",
            worktreePath: "/repo/.orca/worktrees/pet-47",
          }),
        ],
      ]),
      message: "agent failed permanently",
    })

    expect(nextState.get(issue.id)).toEqual(
      issueState({
        branchName: "pet-47",
        lastError: "agent failed permanently",
        retryCount: 2,
        state: "ManualIntervention",
        worktreePath: "/repo/.orca/worktrees/pet-47",
      }),
    )
  })

  it("moves a branch-associated pr with pending checks into waiting for ci", () => {
    const nextState = updateIssueStateForGitHubInspection({
      issue,
      issueStates: new Map([
        [
          issue.id,
          issueState({
            branchName: "pet-47",
            retryCount: 1,
            state: "WaitingForPr",
            worktreePath: "/repo/.orca/worktrees/pet-47",
          }),
        ],
      ]),
      inspection: foundPullRequestInspection({
        associationSource: "branch",
        checkSummary: {
          failedCount: 0,
          pendingCount: 2,
          status: "pending",
          successfulCount: 0,
          totalCount: 2,
        },
      }),
    })

    expect(nextState.get(issue.id)).toEqual(
      issueState({
        branchName: "pet-47",
        checkSummary: {
          failedCount: 0,
          pendingCount: 2,
          status: "pending",
          successfulCount: 0,
          totalCount: 2,
        },
        currentHeadSha: "abc123",
        currentPullRequest: pullRequest,
        retryCount: 1,
        state: "WaitingForCi",
        worktreePath: "/repo/.orca/worktrees/pet-47",
      }),
    )
  })

  it("parks green ci in waiting for ai review when review activity is pending", () => {
    const nextState = updateIssueStateForGitHubInspection({
      issue,
      issueStates: new Map(),
      inspection: foundPullRequestInspection({
        aiReviewStatus: {
          headSha: "def456",
          lastObservedReviewActivityAt: null,
          status: "pending",
          waitingSince: "2026-03-11T12:04:00.000Z",
        },
        headSha: "def456",
        pullRequest: {
          ...pullRequest,
          headSha: "def456",
        },
        reviewRoundCount: 2,
      }),
    })

    expect(nextState.get(issue.id)?.state).toBe("WaitingForAiReview")
    expect(nextState.get(issue.id)?.currentHeadSha).toBe("def456")
    expect(nextState.get(issue.id)?.aiReviewRoundCount).toBe(2)
  })

  it("moves green ci into evaluating ai review when review activity completed", () => {
    const nextState = updateIssueStateForGitHubInspection({
      issue,
      issueStates: new Map(),
      inspection: foundPullRequestInspection({
        aiReviewStatus: {
          headSha: "def456",
          lastObservedReviewActivityAt: "2026-03-11T12:06:00.000Z",
          status: "completed",
          waitingSince: "2026-03-11T12:04:00.000Z",
        },
        headSha: "def456",
        pullRequest: {
          ...pullRequest,
          headSha: "def456",
        },
        reviewRoundCount: 2,
      }),
    })

    expect(nextState.get(issue.id)?.state).toBe("EvaluatingAiReview")
    expect(nextState.get(issue.id)?.currentHeadSha).toBe("def456")
  })

  it("keeps draft prs out of waiting for ai review even when ci is green", () => {
    const nextState = updateIssueStateForGitHubInspection({
      issue,
      issueStates: new Map(),
      inspection: foundPullRequestInspection({
        pullRequest: {
          ...pullRequest,
          headSha: "draft456",
          isDraft: true,
        },
        headSha: "draft456",
      }),
    })

    expect(nextState.get(issue.id)?.state).toBe("WaitingForCi")
    expect(nextState.get(issue.id)?.currentHeadSha).toBe("draft456")
  })

  it("re-enters ai review when the pr head changes during human review", () => {
    const nextState = updateIssueStateForGitHubInspection({
      issue,
      issueStates: new Map([
        [
          issue.id,
          issueState({
            aiReviewRoundCount: 2,
            branchName: "pet-47",
            checkSummary: {
              failedCount: 0,
              pendingCount: 0,
              status: "passed",
              successfulCount: 3,
              totalCount: 3,
            },
            currentHeadSha: "def456",
            currentPullRequest: {
              ...pullRequest,
              headSha: "def456",
            },
            state: "WaitingForHumanReview",
            worktreePath: "/repo/.orca/worktrees/pet-47",
          }),
        ],
      ]),
      inspection: foundPullRequestInspection({
        aiReviewStatus: {
          headSha: "updated-sha",
          lastObservedReviewActivityAt: "2026-03-11T12:10:00.000Z",
          status: "completed",
          waitingSince: "2026-03-11T12:08:00.000Z",
        },
        headSha: "updated-sha",
        pullRequest: {
          ...pullRequest,
          headSha: "updated-sha",
        },
        reviewRoundCount: 3,
      }),
    })

    expect(nextState.get(issue.id)?.state).toBe("EvaluatingAiReview")
    expect(nextState.get(issue.id)?.currentHeadSha).toBe("updated-sha")
  })

  it("moves waiting human review into ready for merge once approvals are fresh", () => {
    const nextState = updateIssueStateForGitHubInspection({
      issue,
      issueStates: new Map([
        [
          issue.id,
          issueState({
            aiReviewRoundCount: 2,
            branchName: "pet-47",
            checkSummary: {
              failedCount: 0,
              pendingCount: 0,
              status: "passed",
              successfulCount: 3,
              totalCount: 3,
            },
            currentHeadSha: "def456",
            currentPullRequest: {
              ...pullRequest,
              headSha: "def456",
            },
            state: "WaitingForHumanReview",
            worktreePath: "/repo/.orca/worktrees/pet-47",
          }),
        ],
      ]),
      inspection: foundPullRequestInspection({
        aiReviewStatus: {
          headSha: "def456",
          lastObservedReviewActivityAt: "2026-03-11T12:10:00.000Z",
          status: "completed",
          waitingSince: "2026-03-11T12:08:00.000Z",
        },
        headSha: "def456",
        humanReviewStatus: {
          actionableFeedbackCount: 0,
          approvalCount: 1,
          hasActionableFeedback: false,
          hasFreshApproval: true,
          isGreen: true,
          unresolvedThreadCount: 0,
        },
        pullRequest: {
          ...pullRequest,
          headSha: "def456",
        },
        reviewRoundCount: 2,
      }),
    })

    expect(nextState.get(issue.id)?.state).toBe("ReadyForMerge")
  })

  it("wakes ready for merge when new human feedback appears", () => {
    const nextState = updateIssueStateForGitHubInspection({
      issue,
      issueStates: new Map([
        [
          issue.id,
          issueState({
            aiReviewRoundCount: 2,
            branchName: "pet-47",
            checkSummary: {
              failedCount: 0,
              pendingCount: 0,
              status: "passed",
              successfulCount: 3,
              totalCount: 3,
            },
            currentHeadSha: "def456",
            currentPullRequest: {
              ...pullRequest,
              headSha: "def456",
            },
            state: "ReadyForMerge",
            worktreePath: "/repo/.orca/worktrees/pet-47",
          }),
        ],
      ]),
      inspection: foundPullRequestInspection({
        aiReviewStatus: {
          headSha: "def456",
          lastObservedReviewActivityAt: "2026-03-11T12:10:00.000Z",
          status: "completed",
          waitingSince: "2026-03-11T12:08:00.000Z",
        },
        headSha: "def456",
        humanReviewStatus: {
          actionableFeedbackCount: 1,
          approvalCount: 1,
          hasActionableFeedback: true,
          hasFreshApproval: true,
          isGreen: false,
          unresolvedThreadCount: 0,
        },
        pullRequest: {
          ...pullRequest,
          headSha: "def456",
        },
        reviewRoundCount: 2,
      }),
    })

    expect(nextState.get(issue.id)?.state).toBe("AddressingHumanFeedback")
  })

  it("returns human review holding states to waiting for ci when the pr becomes a draft", () => {
    const nextState = updateIssueStateForGitHubInspection({
      issue,
      issueStates: new Map([
        [
          issue.id,
          issueState({
            aiReviewRoundCount: 2,
            branchName: "pet-47",
            checkSummary: {
              failedCount: 0,
              pendingCount: 0,
              status: "passed",
              successfulCount: 3,
              totalCount: 3,
            },
            currentHeadSha: "def456",
            currentPullRequest: {
              ...pullRequest,
              headSha: "def456",
            },
            state: "WaitingForHumanReview",
            worktreePath: "/repo/.orca/worktrees/pet-47",
          }),
        ],
      ]),
      inspection: foundPullRequestInspection({
        aiReviewStatus: null,
        headCommitCommittedAt: null,
        headSha: "def456",
        humanReviewStatus: null,
        pullRequest: {
          ...pullRequest,
          headSha: "def456",
          isDraft: true,
        },
        reviewContext: emptyReviewContext,
        reviewRoundCount: null,
      }),
    })

    expect(nextState.get(issue.id)?.state).toBe("WaitingForCi")
    expect(nextState.get(issue.id)?.currentHeadSha).toBe("def456")
  })

  it("returns to waiting for pr when a branch-associated pr disappears", () => {
    const nextState = updateIssueStateForGitHubInspection({
      issue,
      issueStates: new Map([
        [
          issue.id,
          issueState({
            branchName: "pet-47",
            checkSummary: {
              failedCount: 0,
              pendingCount: 1,
              status: "pending",
              successfulCount: 0,
              totalCount: 1,
            },
            currentHeadSha: "def456",
            currentPullRequest: {
              ...pullRequest,
              headSha: "def456",
            },
            state: "WaitingForCi",
            worktreePath: "/repo/.orca/worktrees/pet-47",
          }),
        ],
      ]),
      inspection: {
        branchNames: ["pet-47"],
        kind: "missing-pr",
      },
    })

    expect(nextState.get(issue.id)).toEqual(
      issueState({
        branchName: "pet-47",
        state: "WaitingForPr",
        worktreePath: "/repo/.orca/worktrees/pet-47",
      }),
    )
  })

  it("enters manual intervention when github state is ambiguous", () => {
    const nextState = updateIssueStateForGitHubInspection({
      issue,
      issueStates: new Map(),
      inspection: {
        branchNames: ["pet-47"],
        kind: "ambiguous",
        message: "multiple pull requests matched branch pet-47 for PET-47",
      },
    })

    expect(nextState.get(issue.id)).toEqual(
      issueState({
        lastError: "multiple pull requests matched branch pet-47 for PET-47",
        state: "ManualIntervention",
      }),
    )
  })
})
