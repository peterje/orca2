import { Effect } from "effect"
import { describe, expect, it } from "bun:test"
import {
  applyAiReviewDecision,
  emptyReviewContext,
  runAiReviewEvaluationAttempt,
} from "./ai-review"

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

const config = {
  agent: {
    maxRetries: 5,
    maxRetryBackoffMs: 300_000,
    maxTurns: 1,
  },
  github: {
    apiUrl: "https://api.github.com",
    baseBranch: "main",
    owner: "peterje",
    repo: "orca2",
    token: "github-token",
  },
  greptile: {
    enabled: true,
    requiredScore: 4,
    summonComment: "@greptileai",
  },
  humanReview: {
    requireApproval: true,
    requireNoUnresolvedThreads: true,
  },
  linear: {
    activeStates: ["Todo", "In Progress"],
    apiKey: "linear-token",
    endpoint: "https://api.linear.app/graphql",
    projectSlug: "orca",
    terminalStates: ["Done", "Canceled"],
  },
  opencode: {
    startupTimeoutMs: 100,
    turnTimeoutMs: 1_000,
  },
  polling: {
    intervalMs: 5_000,
  },
  worktree: {
    repoRoot: "/repo",
    root: "/repo/.orca/worktrees",
  },
} as const

describe("ai review", () => {
  it("decodes evaluator output for the continue loop path", async () => {
    const result = await Effect.runPromise(
      runAiReviewEvaluationAttempt({
        config,
        ensureWorktree: () =>
          Effect.succeed({
            branchName: "pet-47",
            path: "/repo/.orca/worktrees/pet-47",
            reused: true,
          }),
        issue,
        pullRequest,
        reviewContext: emptyReviewContext,
        reviewRoundCount: 2,
        runAgent: () =>
          Effect.succeed(
            JSON.stringify({
              createdFollowUpIssueIdentifiers: [],
              decision: "continue_ai_loop",
              rationale: "A correctness issue remains in the diff.",
              reviewRoundCount: 2,
            }),
          ),
      }),
    )

    expect(result.decision.decision).toBe("continue_ai_loop")
  })

  it("maps a ready for human review decision", () => {
    expect(
      applyAiReviewDecision({
        currentHeadSha: "abc123",
        decision: {
          createdFollowUpIssueIdentifiers: ["PET-88"],
          decision: "waiting_for_human_review",
          rationale: "Only low-risk polish remains.",
          reviewRoundCount: 3,
        },
      }),
    ).toEqual({
      lastError: null,
      nextState: "WaitingForHumanReview",
    })
  })

  it("maps a manual intervention decision", () => {
    expect(
      applyAiReviewDecision({
        currentHeadSha: "abc123",
        decision: {
          createdFollowUpIssueIdentifiers: [],
          decision: "manual_intervention",
          rationale: "The feedback conflicts and needs a human call.",
          reviewRoundCount: 3,
        },
      }),
    ).toEqual({
      lastError: "The feedback conflicts and needs a human call. (head abc123)",
      nextState: "ManualIntervention",
    })
  })
})
