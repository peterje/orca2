import { Data, Effect, Schema } from "effect"
import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import type {
  BlockerRef,
  LinkedPullRequestRef,
  NormalizedIssue,
} from "./domain"

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

const IssueStateSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.NullOr(Schema.String),
})

const RelatedIssueSchema = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  state: IssueStateSchema,
})

const IssueRelationSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  issue: RelatedIssueSchema,
  relatedIssue: RelatedIssueSchema,
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
  state: IssueStateSchema,
  labels: Schema.Struct({
    nodes: Schema.Array(LabelSchema),
  }),
  attachments: Schema.Struct({
    nodes: Schema.Array(AttachmentSchema),
  }),
  relations: Schema.optional(
    Schema.Struct({
      nodes: Schema.Array(IssueRelationSchema),
    }),
  ),
  inverseRelations: Schema.optional(
    Schema.Struct({
      nodes: Schema.Array(IssueRelationSchema),
    }),
  ),
})

type RawIssue = Schema.Schema.Type<typeof RawIssueSchema>
type RawAttachment = RawIssue["attachments"]["nodes"][number]
type RawRelatedIssue = Schema.Schema.Type<typeof RelatedIssueSchema>
type RawIssueRelation = Schema.Schema.Type<typeof IssueRelationSchema>
type ActiveIssuesPage = NonNullable<ActiveIssuesResponse["data"]>["issues"]

const PageInfoSchema = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
})

const LinearGraphqlErrorSchema = Schema.Struct({
  message: Schema.String,
})

export const ActiveIssuesResponseSchema = Schema.Struct({
  data: Schema.NullOr(
    Schema.Struct({
      issues: Schema.Struct({
        nodes: Schema.Array(RawIssueSchema),
        pageInfo: PageInfoSchema,
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
  query ActiveIssues($projectSlug: String!, $activeStates: [String!]!, $after: String) {
    issues(
      first: 100
      after: $after
      filter: {
        project: { slug: { eq: $projectSlug } }
        state: { name: { in: $activeStates } }
      }
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
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
        relations {
          nodes {
            id
            type
            issue {
              id
              identifier
              title
              state {
                id
                name
                type
              }
            }
            relatedIssue {
              id
              identifier
              title
              state {
                id
                name
                type
              }
            }
          }
        }
        inverseRelations {
          nodes {
            id
            type
            issue {
              id
              identifier
              title
              state {
                id
                name
                type
              }
            }
            relatedIssue {
              id
              identifier
              title
              state {
                id
                name
                type
              }
            }
          }
        }
      }
    }
  }
`

const pullRequestUrlPattern =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i

const toLinkedPullRequestRef = ({
  attachment,
  owner,
  repo,
  number,
}: {
  readonly attachment: RawAttachment
  readonly owner: string
  readonly repo: string
  readonly number: number
}): LinkedPullRequestRef => ({
  provider: "github",
  owner,
  repo,
  number,
  url: attachment.url,
  title: attachment.title,
  attachmentId: attachment.id,
})

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

    const existing = deduped.get(key)
    if (existing) {
      if (existing.title === null && attachment.title !== null) {
        deduped.set(
          key,
          toLinkedPullRequestRef({
            attachment,
            owner,
            repo,
            number,
          }),
        )
      }

      continue
    }

    deduped.set(
      key,
      toLinkedPullRequestRef({
        attachment,
        owner,
        repo,
        number,
      }),
    )
  }

  return [...deduped.values()].sort((left, right) => left.number - right.number)
}

const toPriorityRank = (priority: number) => (priority > 0 ? priority : 5)

const isTerminalIssueState = (
  state: Pick<RawIssue["state"], "name" | "type">,
  terminalStates: ReadonlyArray<string>,
) =>
  terminalStates.includes(state.name) ||
  state.type === "completed" ||
  state.type === "cancelled"

const toBlockerRef = ({
  blocker,
  terminalStates,
}: {
  readonly blocker: RawRelatedIssue
  readonly terminalStates: ReadonlyArray<string>
}): BlockerRef => ({
  id: blocker.id,
  identifier: blocker.identifier,
  title: blocker.title,
  stateName: blocker.state.name,
  terminal: isTerminalIssueState(blocker.state, terminalStates),
})

const findBlockerIssue = ({
  issue,
  relation,
}: {
  readonly issue: RawIssue
  readonly relation: RawIssueRelation
}) => {
  if (relation.type.toLowerCase() !== "blocks") {
    return null
  }

  if (relation.relatedIssue.id === issue.id) {
    return relation.issue
  }

  return null
}

const normalizeBlockers = ({
  issue,
  terminalStates,
}: {
  readonly issue: RawIssue
  readonly terminalStates: ReadonlyArray<string>
}): Array<BlockerRef> => {
  const deduped = new Map<string, BlockerRef>()

  for (const relation of [
    ...(issue.relations?.nodes ?? []),
    ...(issue.inverseRelations?.nodes ?? []),
  ]) {
    const blocker = findBlockerIssue({ issue, relation })
    if (blocker === null) {
      continue
    }

    deduped.set(
      blocker.id,
      toBlockerRef({
        blocker,
        terminalStates,
      }),
    )
  }

  return [...deduped.values()].sort((left, right) =>
    left.identifier.localeCompare(right.identifier),
  )
}

export const normalizeActiveIssues = (
  response: ActiveIssuesResponse,
  terminalStates: ReadonlyArray<string>,
): Array<NormalizedIssue> => {
  const nodes = response.data?.issues.nodes ?? []

  return nodes.map((issue) => {
    const linkedPullRequests = normalizeLinkedPullRequests(
      issue.attachments.nodes,
    )
    const blockers = normalizeBlockers({ issue, terminalStates })
    const terminal = isTerminalIssueState(issue.state, terminalStates)
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
      blockers,
      normalizedState,
    }
  })
}

const fetchActiveIssuesPage = ({
  config,
  after,
}: {
  readonly config: LinearConfig
  readonly after: string | null
}) =>
  Effect.gen(function* () {
    const body = yield* HttpBody.json({
      query: activeIssuesQuery,
      variables: {
        projectSlug: config.projectSlug,
        activeStates: [...config.activeStates],
        after,
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

    return payload.data.issues
  })

export interface LinearConfig {
  readonly apiKey: string
  readonly endpoint: string
  readonly projectSlug: string
  readonly activeStates: ReadonlyArray<string>
  readonly terminalStates: ReadonlyArray<string>
}

export const maxActiveIssuePages = 50

export const fetchActiveIssues = (config: LinearConfig) =>
  Effect.gen(function* () {
    const nodes: Array<RawIssue> = []
    let after: string | null = null
    let pageCount = 0

    while (true) {
      pageCount += 1

      if (pageCount > maxActiveIssuePages) {
        return yield* new LinearApiError({
          message: `linear active issue pagination exceeded ${maxActiveIssuePages} pages`,
        })
      }

      const page: ActiveIssuesPage = yield* fetchActiveIssuesPage({
        config,
        after,
      })
      nodes.push(...page.nodes)

      if (!page.pageInfo.hasNextPage) {
        break
      }

      if (page.pageInfo.endCursor === null) {
        return yield* new LinearApiError({
          message:
            "linear reported additional issue pages without an end cursor",
        })
      }

      after = page.pageInfo.endCursor
    }

    return normalizeActiveIssues(
      {
        data: {
          issues: {
            nodes,
            pageInfo: {
              hasNextPage: false,
              endCursor: null,
            },
          },
        },
      },
      config.terminalStates,
    )
  })
