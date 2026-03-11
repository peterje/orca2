import { describe, expect, it } from "bun:test"
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
          {
            branchName: null,
            checkSummary: null,
            currentHeadSha: null,
            currentPullRequest: null,
            lastError: null,
            retryCount: 0,
            retryDueAt: null,
            state: "Implementing" as const,
            worktreePath: "/repo/.orca/worktrees/pet-47",
          },
        ],
      ]),
      outcome: {
        branchName: "pet-47",
        state: "WaitingForPr",
        worktreePath: "/repo/.orca/worktrees/pet-47",
      },
    })

    expect(nextState.get(issue.id)).toEqual({
      branchName: "pet-47",
      checkSummary: null,
      currentHeadSha: null,
      currentPullRequest: null,
      lastError: null,
      retryCount: 0,
      retryDueAt: null,
      state: "WaitingForPr",
      worktreePath: "/repo/.orca/worktrees/pet-47",
    })
  })

  it("preserves the tracked worktree path for manual intervention", () => {
    const nextState = applyManualInterventionState({
      issue,
      issueStates: new Map([
        [
          issue.id,
          {
            branchName: "pet-47",
            checkSummary: null,
            currentHeadSha: null,
            currentPullRequest: null,
            lastError: null,
            retryCount: 2,
            retryDueAt: "2026-03-11T12:05:00.000Z",
            state: "Implementing" as const,
            worktreePath: "/repo/.orca/worktrees/pet-47",
          },
        ],
      ]),
      message: "agent failed permanently",
    })

    expect(nextState.get(issue.id)).toEqual({
      branchName: "pet-47",
      checkSummary: null,
      currentHeadSha: null,
      currentPullRequest: null,
      lastError: "agent failed permanently",
      retryCount: 2,
      retryDueAt: null,
      state: "ManualIntervention",
      worktreePath: "/repo/.orca/worktrees/pet-47",
    })
  })

  it("moves a branch-associated pr with pending checks into waiting for ci", () => {
    const nextState = updateIssueStateForGitHubInspection({
      issue,
      issueStates: new Map([
        [
          issue.id,
          {
            branchName: "pet-47",
            checkSummary: null,
            currentHeadSha: null,
            currentPullRequest: null,
            lastError: null,
            retryCount: 1,
            retryDueAt: null,
            state: "WaitingForPr" as const,
            worktreePath: "/repo/.orca/worktrees/pet-47",
          },
        ],
      ]),
      inspection: {
        associationSource: "branch",
        branchNames: ["pet-47"],
        checkSummary: {
          failedCount: 0,
          pendingCount: 2,
          status: "pending",
          successfulCount: 0,
          totalCount: 2,
        },
        headSha: "abc123",
        kind: "found-pr",
        pullRequest: {
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
        },
      },
    })

    expect(nextState.get(issue.id)).toEqual({
      branchName: "pet-47",
      checkSummary: {
        failedCount: 0,
        pendingCount: 2,
        status: "pending",
        successfulCount: 0,
        totalCount: 2,
      },
      currentHeadSha: "abc123",
      currentPullRequest: {
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
      },
      lastError: null,
      retryCount: 1,
      retryDueAt: null,
      state: "WaitingForCi",
      worktreePath: "/repo/.orca/worktrees/pet-47",
    })
  })

  it("parks green ci in waiting for ai review and records the current head sha", () => {
    const nextState = updateIssueStateForGitHubInspection({
      issue,
      issueStates: new Map(),
      inspection: {
        associationSource: "linear",
        branchNames: ["pet-47"],
        checkSummary: {
          failedCount: 0,
          pendingCount: 0,
          status: "passed",
          successfulCount: 3,
          totalCount: 3,
        },
        headSha: "def456",
        kind: "found-pr",
        pullRequest: {
          baseRefName: "main",
          headRefName: "pet-47",
          headSha: "def456",
          isDraft: false,
          number: 42,
          owner: "peterje",
          provider: "github" as const,
          repo: "orca2",
          state: "open" as const,
          title: "feat: run implementation attempts",
          url: "https://github.com/peterje/orca2/pull/42",
        },
      },
    })

    expect(nextState.get(issue.id)?.state).toBe("WaitingForAiReview")
    expect(nextState.get(issue.id)?.currentHeadSha).toBe("def456")
  })

  it("does not regress downstream review states during github reconciliation", () => {
    const nextState = updateIssueStateForGitHubInspection({
      issue,
      issueStates: new Map([
        [
          issue.id,
          {
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
              baseRefName: "main",
              headRefName: "pet-47",
              headSha: "def456",
              isDraft: false,
              number: 42,
              owner: "peterje",
              provider: "github" as const,
              repo: "orca2",
              state: "open" as const,
              title: "feat: run implementation attempts",
              url: "https://github.com/peterje/orca2/pull/42",
            },
            lastError: null,
            retryCount: 0,
            retryDueAt: null,
            state: "WaitingForHumanReview" as const,
            worktreePath: "/repo/.orca/worktrees/pet-47",
          },
        ],
      ]),
      inspection: {
        associationSource: "linear",
        branchNames: ["pet-47"],
        checkSummary: {
          failedCount: 0,
          pendingCount: 0,
          status: "passed",
          successfulCount: 3,
          totalCount: 3,
        },
        headSha: "updated-sha",
        kind: "found-pr",
        pullRequest: {
          baseRefName: "main",
          headRefName: "pet-47",
          headSha: "updated-sha",
          isDraft: false,
          number: 42,
          owner: "peterje",
          provider: "github" as const,
          repo: "orca2",
          state: "open" as const,
          title: "feat: run implementation attempts",
          url: "https://github.com/peterje/orca2/pull/42",
        },
      },
    })

    expect(nextState.get(issue.id)?.state).toBe("WaitingForHumanReview")
    expect(nextState.get(issue.id)?.currentHeadSha).toBe("def456")
  })

  it("returns to waiting for pr when a branch-associated pr disappears", () => {
    const nextState = updateIssueStateForGitHubInspection({
      issue,
      issueStates: new Map([
        [
          issue.id,
          {
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
              baseRefName: "main",
              headRefName: "pet-47",
              headSha: "def456",
              isDraft: false,
              number: 42,
              owner: "peterje",
              provider: "github" as const,
              repo: "orca2",
              state: "open" as const,
              title: "feat: run implementation attempts",
              url: "https://github.com/peterje/orca2/pull/42",
            },
            lastError: null,
            retryCount: 0,
            retryDueAt: null,
            state: "WaitingForCi" as const,
            worktreePath: "/repo/.orca/worktrees/pet-47",
          },
        ],
      ]),
      inspection: {
        branchNames: ["pet-47"],
        kind: "missing-pr",
      },
    })

    expect(nextState.get(issue.id)).toEqual({
      branchName: "pet-47",
      checkSummary: null,
      currentHeadSha: null,
      currentPullRequest: null,
      lastError: null,
      retryCount: 0,
      retryDueAt: null,
      state: "WaitingForPr",
      worktreePath: "/repo/.orca/worktrees/pet-47",
    })
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

    expect(nextState.get(issue.id)).toEqual({
      branchName: null,
      checkSummary: null,
      currentHeadSha: null,
      currentPullRequest: null,
      lastError: "multiple pull requests matched branch pet-47 for PET-47",
      retryCount: 0,
      retryDueAt: null,
      state: "ManualIntervention",
      worktreePath: null,
    })
  })
})
