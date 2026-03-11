import { describe, expect, it } from "bun:test"
import { buildImplementationPrompt } from "./prompts"

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
})
