import { Schema } from "effect"

const NormalizedStateSchema = Schema.Union([
  Schema.Literal("runnable"),
  Schema.Literal("linked-pr-detected"),
  Schema.Literal("terminal"),
])

export const OrcaIssueStateSchema = Schema.Union([
  Schema.Literal("Todo"),
  Schema.Literal("Implementing"),
  Schema.Literal("WaitingForPr"),
  Schema.Literal("WaitingForCi"),
  Schema.Literal("WaitingForAiReview"),
  Schema.Literal("EvaluatingAiReview"),
  Schema.Literal("AddressingAiReviewFeedback"),
  Schema.Literal("WaitingForHumanReview"),
  Schema.Literal("AddressingHumanFeedback"),
  Schema.Literal("ReadyForMerge"),
  Schema.Literal("RetryQueued"),
  Schema.Literal("ManualIntervention"),
  Schema.Literal("Released"),
])

export type OrcaIssueState = Schema.Schema.Type<typeof OrcaIssueStateSchema>

export const LinkedPullRequestRefSchema = Schema.Struct({
  provider: Schema.Literal("github"),
  owner: Schema.String,
  repo: Schema.String,
  number: Schema.Number,
  url: Schema.String,
  title: Schema.NullOr(Schema.String),
  attachmentId: Schema.String,
})

export type LinkedPullRequestRef = Schema.Schema.Type<
  typeof LinkedPullRequestRefSchema
>

export const PullRequestSchema = Schema.Struct({
  provider: Schema.Literal("github"),
  owner: Schema.String,
  repo: Schema.String,
  number: Schema.Number,
  url: Schema.String,
  title: Schema.String,
  state: Schema.Union([Schema.Literal("open"), Schema.Literal("closed")]),
  isDraft: Schema.Boolean,
  headRefName: Schema.String,
  headSha: Schema.String,
  baseRefName: Schema.String,
})

export type PullRequest = Schema.Schema.Type<typeof PullRequestSchema>

export const CheckSummarySchema = Schema.Struct({
  status: Schema.Union([
    Schema.Literal("pending"),
    Schema.Literal("passed"),
    Schema.Literal("failed"),
    Schema.Literal("ambiguous"),
  ]),
  totalCount: Schema.Number,
  pendingCount: Schema.Number,
  successfulCount: Schema.Number,
  failedCount: Schema.Number,
})

export type CheckSummary = Schema.Schema.Type<typeof CheckSummarySchema>

export const PullRequestCommentSummarySchema = Schema.Struct({
  authorLogin: Schema.NullOr(Schema.String),
  body: Schema.String,
  createdAt: Schema.String,
  htmlUrl: Schema.String,
  id: Schema.String,
})

export type PullRequestCommentSummary = Schema.Schema.Type<
  typeof PullRequestCommentSummarySchema
>

export const ReviewSummarySchema = Schema.Struct({
  authorAssociation: Schema.NullOr(Schema.String),
  authorLogin: Schema.NullOr(Schema.String),
  body: Schema.String,
  commitId: Schema.NullOr(Schema.String),
  htmlUrl: Schema.String,
  id: Schema.String,
  state: Schema.String,
  submittedAt: Schema.NullOr(Schema.String),
})

export type ReviewSummary = Schema.Schema.Type<typeof ReviewSummarySchema>

export const ReviewThreadCommentSummarySchema = Schema.Struct({
  authorLogin: Schema.NullOr(Schema.String),
  body: Schema.String,
  commitId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  htmlUrl: Schema.String,
  id: Schema.String,
  inReplyToId: Schema.NullOr(Schema.String),
  originalCommitId: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
})

export type ReviewThreadCommentSummary = Schema.Schema.Type<
  typeof ReviewThreadCommentSummarySchema
>

export const ReviewThreadSummarySchema = Schema.Struct({
  comments: Schema.Array(ReviewThreadCommentSummarySchema),
  id: Schema.String,
  isResolved: Schema.Boolean,
  path: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
})

export type ReviewThreadSummary = Schema.Schema.Type<
  typeof ReviewThreadSummarySchema
>

export const PullRequestReviewContextSchema = Schema.Struct({
  issueComments: Schema.Array(PullRequestCommentSummarySchema),
  reviewThreads: Schema.Array(ReviewThreadSummarySchema),
  reviews: Schema.Array(ReviewSummarySchema),
})

export type PullRequestReviewContext = Schema.Schema.Type<
  typeof PullRequestReviewContextSchema
>

export const AiReviewStatusSchema = Schema.Struct({
  headSha: Schema.NullOr(Schema.String),
  lastObservedReviewActivityAt: Schema.NullOr(Schema.String),
  status: Schema.Union([
    Schema.Literal("not_requested"),
    Schema.Literal("pending"),
    Schema.Literal("completed"),
    Schema.Literal("ambiguous"),
  ]),
  waitingSince: Schema.NullOr(Schema.String),
})

export type AiReviewStatus = Schema.Schema.Type<typeof AiReviewStatusSchema>

export const AiReviewDecisionSchema = Schema.Struct({
  createdFollowUpIssueIdentifiers: Schema.Array(Schema.String),
  decision: Schema.Union([
    Schema.Literal("continue_ai_loop"),
    Schema.Literal("waiting_for_human_review"),
    Schema.Literal("manual_intervention"),
  ]),
  rationale: Schema.String,
  reviewRoundCount: Schema.Number,
})

export type AiReviewDecision = Schema.Schema.Type<typeof AiReviewDecisionSchema>

export const BlockerRefSchema = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  stateName: Schema.String,
  terminal: Schema.Boolean,
})

export type BlockerRef = Schema.Schema.Type<typeof BlockerRefSchema>

export const NormalizedIssueSchema = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  branchName: Schema.NullOr(Schema.String),
  priority: Schema.Number,
  priorityRank: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  stateName: Schema.String,
  stateType: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.String),
  linkedPullRequests: Schema.Array(LinkedPullRequestRefSchema),
  blockers: Schema.Array(BlockerRefSchema),
  normalizedState: NormalizedStateSchema,
})

export type NormalizedIssue = Schema.Schema.Type<typeof NormalizedIssueSchema>

export const SelectedRunnableIssueSchema = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  normalizedState: Schema.Literal("runnable"),
})

export type SelectedRunnableIssue = Schema.Schema.Type<
  typeof SelectedRunnableIssueSchema
>

export const ClaimedIssueSchema = Schema.Struct({
  aiReviewRoundCount: Schema.NullOr(Schema.Number),
  aiReviewStatus: Schema.NullOr(AiReviewStatusSchema),
  issueId: Schema.String,
  issueIdentifier: Schema.String,
  state: OrcaIssueStateSchema,
  branchName: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  retryDueAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  currentPullRequest: Schema.NullOr(PullRequestSchema),
  currentHeadSha: Schema.NullOr(Schema.String),
  checkSummary: Schema.NullOr(CheckSummarySchema),
})

export type ClaimedIssue = Schema.Schema.Type<typeof ClaimedIssueSchema>

export const RuntimeSnapshotSchema = Schema.Struct({
  updatedAt: Schema.String,
  activeIssues: Schema.Array(NormalizedIssueSchema),
  runnableIssue: Schema.NullOr(SelectedRunnableIssueSchema),
  claimedIssues: Schema.Array(ClaimedIssueSchema),
})

export type RuntimeSnapshot = Schema.Schema.Type<typeof RuntimeSnapshotSchema>
