import type { NormalizedIssue } from "./domain"

const formatList = (values: ReadonlyArray<string>) =>
  values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : "- none"

const formatBlockers = (issue: NormalizedIssue) =>
  issue.blockers.length > 0
    ? issue.blockers
        .map(
          (blocker) =>
            `- ${blocker.identifier}: ${blocker.title} (${blocker.stateName}; ${blocker.terminal ? "terminal" : "active"})`,
        )
        .join("\n")
    : "- none"

export const buildImplementationPrompt = (issue: NormalizedIssue) => {
  const description = issue.description?.trim() || "No description provided."

  return [
    `Implement Linear issue ${issue.identifier}: ${issue.title}`,
    "",
    "Context",
    `- identifier: ${issue.identifier}`,
    `- title: ${issue.title}`,
    `- current linear state: ${issue.stateName}`,
    "",
    "Description",
    description,
    "",
    "Labels",
    formatList(issue.labels),
    "",
    "Blockers",
    formatBlockers(issue),
    "",
    "Instructions",
    "- work only in the current git worktree",
    "- make the implementation end-to-end in this repository",
    "- run focused verification for the changes you make",
    "- leave the branch ready for a pull request",
  ].join("\n")
}
