import type {
  NormalizedIssue,
  PullRequest,
  PullRequestReviewContext,
} from "./domain"

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

const formatIssueComments = (reviewContext: PullRequestReviewContext) =>
  reviewContext.issueComments.length > 0
    ? reviewContext.issueComments
        .map(
          (comment) =>
            `- ${comment.authorLogin ?? "unknown"} at ${comment.createdAt}: ${comment.body}`,
        )
        .join("\n")
    : "- none"

const formatReviews = (reviewContext: PullRequestReviewContext) =>
  reviewContext.reviews.length > 0
    ? reviewContext.reviews
        .map(
          (review) =>
            `- ${review.state} by ${review.authorLogin ?? "unknown"} at ${review.submittedAt ?? "unknown"} on ${review.commitId ?? "no commit"}: ${review.body}`,
        )
        .join("\n")
    : "- none"

const formatReviewThreads = (reviewContext: PullRequestReviewContext) =>
  reviewContext.reviewThreads.length > 0
    ? reviewContext.reviewThreads
        .map((thread) => {
          const comments =
            thread.comments.length > 0
              ? thread.comments
                  .map(
                    (comment) =>
                      `  - ${comment.authorLogin ?? "unknown"} at ${comment.createdAt}: ${comment.body}`,
                  )
                  .join("\n")
              : "  - none"

          return [
            `- thread ${thread.id} on ${thread.path ?? "unknown file"} (${thread.isResolved ? "resolved" : "unresolved"}, updated ${thread.updatedAt})`,
            comments,
          ].join("\n")
        })
        .join("\n")
    : "- none"

const formatPullRequestContext = (pullRequest: PullRequest) =>
  [
    `- pr: ${pullRequest.url}`,
    `- branch: ${pullRequest.headRefName}`,
    `- head sha: ${pullRequest.headSha}`,
    `- base branch: ${pullRequest.baseRefName}`,
  ].join("\n")

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
    "- create or update the pull request before you finish",
    "- request AI review using this repository's workflow conventions after opening or updating the pull request",
    "- leave the branch ready for a pull request",
  ].join("\n")
}

export const buildAiReviewEvaluationPrompt = ({
  issue,
  pullRequest,
  reviewContext,
  reviewRoundCount,
}: {
  readonly issue: NormalizedIssue
  readonly pullRequest: PullRequest
  readonly reviewContext: PullRequestReviewContext
  readonly reviewRoundCount: number
}) =>
  [
    `Evaluate AI review feedback for Linear issue ${issue.identifier}: ${issue.title}`,
    "",
    "Context",
    `- identifier: ${issue.identifier}`,
    `- title: ${issue.title}`,
    `- review round: ${reviewRoundCount}`,
    formatPullRequestContext(pullRequest),
    "",
    "Description",
    issue.description?.trim() || "No description provided.",
    "",
    "Labels",
    formatList(issue.labels),
    "",
    "Blockers",
    formatBlockers(issue),
    "",
    "PR comments",
    formatIssueComments(reviewContext),
    "",
    "Reviews",
    formatReviews(reviewContext),
    "",
    "Review threads",
    formatReviewThreads(reviewContext),
    "",
    "Instructions",
    "- read the PR diff, comments, reviews, and unresolved threads before deciding",
    "- use any AI review artifacts on the PR as evidence only, not as a required parsed contract",
    "- choose continue_ai_loop for correctness, reliability, security, or substantive maintainability issues",
    "- choose waiting_for_human_review when the remaining work is mostly nits, polish, cleanup, or low-risk follow-up",
    "- if you defer a legitimate non-blocking suggestion, create a backlog Linear ticket with the linear cli before advancing and include the created identifiers in the response",
    '- respond with JSON only matching this shape exactly: {"decision":"continue_ai_loop"|"waiting_for_human_review"|"manual_intervention","rationale":"string","reviewRoundCount":number,"createdFollowUpIssueIdentifiers":["PET-123"]}',
  ].join("\n")

export const buildAiReviewRemediationPrompt = ({
  issue,
  pullRequest,
  reviewContext,
  reviewRoundCount,
}: {
  readonly issue: NormalizedIssue
  readonly pullRequest: PullRequest
  readonly reviewContext: PullRequestReviewContext
  readonly reviewRoundCount: number
}) =>
  [
    `Address AI review feedback for Linear issue ${issue.identifier}: ${issue.title}`,
    "",
    "Context",
    `- identifier: ${issue.identifier}`,
    `- title: ${issue.title}`,
    `- review round: ${reviewRoundCount}`,
    formatPullRequestContext(pullRequest),
    "",
    "Description",
    issue.description?.trim() || "No description provided.",
    "",
    "PR comments",
    formatIssueComments(reviewContext),
    "",
    "Reviews",
    formatReviews(reviewContext),
    "",
    "Review threads",
    formatReviewThreads(reviewContext),
    "",
    "Instructions",
    "- work only in the current git worktree",
    "- address the substantive AI review feedback in the codebase",
    "- run focused verification for the changes you make",
    "- create or update the pull request before you finish",
    "- request AI review using this repository's workflow conventions after updating the pull request",
  ].join("\n")
