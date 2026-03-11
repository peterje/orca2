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
  Schema.Literal("RetryQueued"),
  Schema.Literal("ManualIntervention"),
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
  issueId: Schema.String,
  issueIdentifier: Schema.String,
  state: OrcaIssueStateSchema,
  worktreePath: Schema.NullOr(Schema.String),
  retryDueAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
})

export type ClaimedIssue = Schema.Schema.Type<typeof ClaimedIssueSchema>

export const RuntimeSnapshotSchema = Schema.Struct({
  updatedAt: Schema.String,
  activeIssues: Schema.Array(NormalizedIssueSchema),
  runnableIssue: Schema.NullOr(SelectedRunnableIssueSchema),
  claimedIssues: Schema.Array(ClaimedIssueSchema),
})

export type RuntimeSnapshot = Schema.Schema.Type<typeof RuntimeSnapshotSchema>
