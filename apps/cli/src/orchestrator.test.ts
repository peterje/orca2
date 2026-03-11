import { describe, expect, it } from "bun:test"
import { applyImplementationOutcome } from "./orchestrator"

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
  it("clears an implementing issue when Linear already reports a linked pr", () => {
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

    expect(nextState.has(issue.id)).toBe(false)
  })
})
