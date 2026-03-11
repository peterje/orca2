import { Data, Effect, Schema } from "effect"
import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import type { LinkedPullRequestRef, NormalizedIssue } from "./domain"

const LabelSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
})

const AttachmentSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.NullOr(Schema.String),
  subtitle: Schema.NullOr(Schema.String),
  url: Schema.String,
  metadata: Schema.Unknown,
  sourceType: Schema.NullOr(Schema.String),
})

const RawIssueSchema = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  branchName: Schema.NullOr(Schema.String),
  priority: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  state: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    type: Schema.NullOr(Schema.String),
  }),
  labels: Schema.Struct({
    nodes: Schema.Array(LabelSchema),
  }),
  attachments: Schema.Struct({
    nodes: Schema.Array(AttachmentSchema),
  }),
})

type RawIssue = Schema.Schema.Type<typeof RawIssueSchema>
type RawAttachment = RawIssue["attachments"]["nodes"][number]

const LinearGraphqlErrorSchema = Schema.Struct({
  message: Schema.String,
})

export const ActiveIssuesResponseSchema = Schema.Struct({
  data: Schema.NullOr(
    Schema.Struct({
      issues: Schema.Struct({
        nodes: Schema.Array(RawIssueSchema),
      }),
    }),
  ),
  errors: Schema.optional(Schema.Array(LinearGraphqlErrorSchema)),
})

export type ActiveIssuesResponse = Schema.Schema.Type<
  typeof ActiveIssuesResponseSchema
>

export class LinearApiError extends Data.TaggedError("LinearApiError")<{
  readonly message: string
}> {}

export const decodeActiveIssuesResponse = (input: unknown) =>
  Schema.decodeUnknownEffect(ActiveIssuesResponseSchema)(input)

const activeIssuesQuery = `
  query ActiveIssues($projectSlug: String!, $activeStates: [String!]!) {
    issues(
      first: 100
      filter: {
        project: { slug: { eq: $projectSlug } }
        state: { name: { in: $activeStates } }
      }
    ) {
      nodes {
        id
        identifier
        title
        description
        branchName
        priority
        createdAt
        updatedAt
        state {
          id
          name
          type
        }
        labels {
          nodes {
            id
            name
          }
        }
        attachments {
          nodes {
            id
            title
            subtitle
            url
            metadata
            sourceType
          }
        }
      }
    }
  }
`

const pullRequestUrlPattern =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i

const normalizeLinkedPullRequests = (
  attachments: ReadonlyArray<RawAttachment>,
): Array<LinkedPullRequestRef> => {
  const deduped = new Map<string, LinkedPullRequestRef>()

  for (const attachment of attachments) {
    const match = attachment.url.match(pullRequestUrlPattern)
    if (!match) {
      continue
    }

    const [, owner, repo, numberText] = match
    if (!owner || !repo || !numberText) {
      continue
    }

    const number = Number(numberText)
    const key = `${owner}/${repo}#${number}`

    if (deduped.has(key)) {
      continue
    }

    deduped.set(key, {
      provider: "github",
      owner,
      repo,
      number,
      url: attachment.url,
      title: attachment.title,
      attachmentId: attachment.id,
    })
  }

  return [...deduped.values()].sort((left, right) => left.number - right.number)
}

const toPriorityRank = (priority: number) => (priority > 0 ? priority : 5)

export const normalizeActiveIssues = (
  response: ActiveIssuesResponse,
  terminalStates: ReadonlyArray<string>,
): Array<NormalizedIssue> => {
  const nodes = response.data?.issues.nodes ?? []

  return nodes.map((issue) => {
    const linkedPullRequests = normalizeLinkedPullRequests(
      issue.attachments.nodes,
    )
    const terminal =
      terminalStates.includes(issue.state.name) ||
      issue.state.type === "completed"
    const runnable = !terminal && linkedPullRequests.length === 0
    const normalizedState = terminal
      ? "terminal"
      : runnable
        ? "runnable"
        : "linked-pr-detected"

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      branchName: issue.branchName,
      priority: issue.priority,
      priorityRank: toPriorityRank(issue.priority),
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      stateName: issue.state.name,
      stateType: issue.state.type,
      labels: issue.labels.nodes.map((label) => label.name).sort(),
      linkedPullRequests,
      blockers: [], // TODO: populate blockers once dependency discovery lands.
      normalizedState,
      runnable,
    }
  })
}

export interface LinearConfig {
  readonly apiKey: string
  readonly endpoint: string
  readonly projectSlug: string
  readonly activeStates: ReadonlyArray<string>
  readonly terminalStates: ReadonlyArray<string>
}

export const fetchActiveIssues = (config: LinearConfig) =>
  Effect.gen(function* () {
    const body = yield* HttpBody.json({
      query: activeIssuesQuery,
      variables: {
        projectSlug: config.projectSlug,
        activeStates: [...config.activeStates],
      },
    })

    const response = yield* HttpClient.execute(
      HttpClientRequest.post(config.endpoint).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeader("Authorization", config.apiKey),
        HttpClientRequest.setHeader("Content-Type", "application/json"),
        HttpClientRequest.modify({ body }),
      ),
    ).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk))

    const payload = yield* response.json.pipe(
      Effect.flatMap(decodeActiveIssuesResponse),
    )

    const errors = payload.errors ?? []

    if (errors.length > 0) {
      return yield* new LinearApiError({
        message: errors.map((error) => error.message).join("; "),
      })
    }

    if (payload.data === null) {
      return yield* new LinearApiError({
        message: "linear returned no data for the active issues query",
      })
    }

    return normalizeActiveIssues(payload, config.terminalStates)
  })
