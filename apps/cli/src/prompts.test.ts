import { describe, expect, it } from "bun:test"
import {
  buildAiReviewEvaluationPrompt,
  buildAiReviewRemediationPrompt,
  buildImplementationPrompt,
} from "./prompts"

describe("prompts", () => {
  it("includes blocker context when present", () => {
    const prompt = buildImplementationPrompt({
      blockers: [
        {
          id: "issue-2",
          identifier: "PET-46",
          title: "finish prerequisite",
          stateName: "In Progress",
          terminal: false,
        },
      ],
      branchName: null,
      createdAt: "2026-03-11T12:00:00.000Z",
      description: "implement the execution slice",
      id: "issue-1",
      identifier: "PET-47",
      labels: ["daemon"],
      linkedPullRequests: [],
      normalizedState: "runnable",
      priority: 1,
      priorityRank: 1,
      stateName: "Todo",
      stateType: "unstarted",
      title: "run implementation attempts",
      updatedAt: "2026-03-11T12:01:00.000Z",
    })

    expect(prompt).toContain("Blockers")
    expect(prompt).toContain(
      "- PET-46: finish prerequisite (In Progress; active)",
    )
  })

  it("tells implementation runs to update the pr and request ai review", () => {
    const prompt = buildImplementationPrompt({
      blockers: [],
      branchName: null,
      createdAt: "2026-03-11T12:00:00.000Z",
      description: "implement the execution slice",
      id: "issue-1",
      identifier: "PET-47",
      labels: ["daemon"],
      linkedPullRequests: [],
      normalizedState: "runnable",
      priority: 1,
      priorityRank: 1,
      stateName: "Todo",
      stateType: "unstarted",
      title: "run implementation attempts",
      updatedAt: "2026-03-11T12:01:00.000Z",
    })

    expect(prompt).toContain("create or update the pull request")
    expect(prompt).toContain("request AI review")
  })

  it("requires structured evaluator output and linear follow-up tickets", () => {
    const prompt = buildAiReviewEvaluationPrompt({
      issue: {
        blockers: [],
        branchName: null,
        createdAt: "2026-03-11T12:00:00.000Z",
        description: "implement the execution slice",
        id: "issue-1",
        identifier: "PET-47",
        labels: ["daemon"],
        linkedPullRequests: [],
        normalizedState: "runnable",
        priority: 1,
        priorityRank: 1,
        stateName: "Todo",
        stateType: "unstarted",
        title: "run implementation attempts",
        updatedAt: "2026-03-11T12:01:00.000Z",
      },
      pullRequest: {
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
      reviewContext: {
        issueComments: [],
        reviewThreads: [],
        reviews: [],
      },
      reviewRoundCount: 2,
    })

    expect(prompt).toContain("respond with JSON only")
    expect(prompt).toContain("linear cli")
    expect(prompt).toContain("createdFollowUpIssueIdentifiers")
  })

  it("tells remediation runs to update the pr and request ai review again", () => {
    const prompt = buildAiReviewRemediationPrompt({
      issue: {
        blockers: [],
        branchName: null,
        createdAt: "2026-03-11T12:00:00.000Z",
        description: "implement the execution slice",
        id: "issue-1",
        identifier: "PET-47",
        labels: ["daemon"],
        linkedPullRequests: [],
        normalizedState: "runnable",
        priority: 1,
        priorityRank: 1,
        stateName: "Todo",
        stateType: "unstarted",
        title: "run implementation attempts",
        updatedAt: "2026-03-11T12:01:00.000Z",
      },
      pullRequest: {
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
      reviewContext: {
        issueComments: [],
        reviewThreads: [],
        reviews: [],
      },
      reviewRoundCount: 2,
    })

    expect(prompt).toContain("update the pull request")
    expect(prompt).toContain("request AI review")
  })

  it("does not claim review threads are unresolved when the source cannot prove that", () => {
    const prompt = buildAiReviewEvaluationPrompt({
      issue: {
        blockers: [],
        branchName: null,
        createdAt: "2026-03-11T12:00:00.000Z",
        description: "implement the execution slice",
        id: "issue-1",
        identifier: "PET-47",
        labels: ["daemon"],
        linkedPullRequests: [],
        normalizedState: "runnable",
        priority: 1,
        priorityRank: 1,
        stateName: "Todo",
        stateType: "unstarted",
        title: "run implementation attempts",
        updatedAt: "2026-03-11T12:01:00.000Z",
      },
      pullRequest: {
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
      reviewContext: {
        issueComments: [],
        reviewThreads: [
          {
            comments: [],
            id: "thread-1",
            isResolved: false,
            path: "src/index.ts",
            updatedAt: "2026-03-11T12:05:00.000Z",
          },
        ],
        reviews: [],
      },
      reviewRoundCount: 2,
    })

    expect(prompt).not.toContain("(unresolved")
    expect(prompt).not.toContain("(resolved")
  })
})
