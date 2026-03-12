import { Data, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import type {
  AiReviewStatus,
  CheckSummary,
  LinkedPullRequestRef,
  NormalizedIssue,
  PullRequest,
  PullRequestCommentSummary,
  PullRequestReviewContext,
  ReviewSummary,
  ReviewThreadSummary,
} from "./domain"
import { sanitizeIssueIdentifier } from "./git-worktree"
import { emptyReviewContext, nextReviewRoundCount } from "./ai-review"

const PullRequestStateSchema = Schema.Union([
  Schema.Literal("open"),
  Schema.Literal("closed"),
])

const RawRepositorySchema = Schema.Struct({
  name: Schema.String,
  owner: Schema.Struct({
    login: Schema.String,
  }),
})

const RawPullRequestSchema = Schema.Struct({
  created_at: Schema.String,
  number: Schema.Number,
  html_url: Schema.String,
  title: Schema.String,
  state: PullRequestStateSchema,
  draft: Schema.Boolean,
  updated_at: Schema.String,
  head: Schema.Struct({
    ref: Schema.String,
    sha: Schema.String,
    repo: Schema.NullOr(RawRepositorySchema),
  }),
  base: Schema.Struct({
    ref: Schema.String,
    repo: Schema.NullOr(RawRepositorySchema),
  }),
})

const RawPullRequestsSchema = Schema.Array(RawPullRequestSchema)

const RawIssueCommentSchema = Schema.Struct({
  body: Schema.String,
  created_at: Schema.String,
  html_url: Schema.String,
  id: Schema.Number,
  user: Schema.NullOr(
    Schema.Struct({
      login: Schema.String,
    }),
  ),
})

const RawIssueCommentsSchema = Schema.Array(RawIssueCommentSchema)

const RawReviewSchema = Schema.Struct({
  body: Schema.NullOr(Schema.String),
  commit_id: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  id: Schema.Number,
  state: Schema.String,
  submitted_at: Schema.NullOr(Schema.String),
  author_association: Schema.String,
  user: Schema.NullOr(
    Schema.Struct({
      login: Schema.String,
    }),
  ),
})

const RawReviewsSchema = Schema.Array(RawReviewSchema)

const RawGraphqlReviewThreadCommentSchema = Schema.Struct({
  author: Schema.NullOr(
    Schema.Struct({
      login: Schema.String,
    }),
  ),
  body: Schema.String,
  commit: Schema.NullOr(
    Schema.Struct({
      oid: Schema.String,
    }),
  ),
  createdAt: Schema.String,
  id: Schema.String,
  originalCommit: Schema.NullOr(
    Schema.Struct({
      oid: Schema.String,
    }),
  ),
  path: Schema.NullOr(Schema.String),
  replyTo: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
    }),
  ),
  url: Schema.String,
})

const RawGraphqlReviewThreadSchema = Schema.Struct({
  comments: Schema.Struct({
    nodes: Schema.Array(RawGraphqlReviewThreadCommentSchema),
  }),
  id: Schema.String,
  isResolved: Schema.Boolean,
  path: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
})

const RawGraphqlReviewThreadsDataSchema = Schema.Struct({
  repository: Schema.NullOr(
    Schema.Struct({
      pullRequest: Schema.NullOr(
        Schema.Struct({
          reviewThreads: Schema.Struct({
            nodes: Schema.Array(RawGraphqlReviewThreadSchema),
            pageInfo: Schema.Struct({
              endCursor: Schema.NullOr(Schema.String),
              hasNextPage: Schema.Boolean,
            }),
          }),
        }),
      ),
    }),
  ),
})

const RawCommitSchema = Schema.Struct({
  commit: Schema.Struct({
    author: Schema.Struct({
      date: Schema.String,
    }),
    committer: Schema.NullOr(
      Schema.Struct({
        date: Schema.String,
      }),
    ),
  }),
})

const CombinedStatusStateSchema = Schema.Union([
  Schema.Literal("pending"),
  Schema.Literal("success"),
  Schema.Literal("failure"),
  Schema.Literal("error"),
])

const CombinedStatusResponseSchema = Schema.Struct({
  state: CombinedStatusStateSchema,
  total_count: Schema.Number,
})

const CheckRunStatusSchema = Schema.Union([
  Schema.Literal("queued"),
  Schema.Literal("in_progress"),
  Schema.Literal("completed"),
  Schema.Literal("waiting"),
  Schema.Literal("pending"),
  Schema.Literal("requested"),
])

const CheckRunConclusionSchema = Schema.NullOr(
  Schema.Union([
    Schema.Literal("success"),
    Schema.Literal("failure"),
    Schema.Literal("neutral"),
    Schema.Literal("cancelled"),
    Schema.Literal("skipped"),
    Schema.Literal("timed_out"),
    Schema.Literal("action_required"),
    Schema.Literal("stale"),
    Schema.Literal("startup_failure"),
  ]),
)

const CheckRunsResponseSchema = Schema.Struct({
  total_count: Schema.Number,
  check_runs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: CheckRunStatusSchema,
      conclusion: CheckRunConclusionSchema,
    }),
  ),
})

type RawPullRequest = Schema.Schema.Type<typeof RawPullRequestSchema>
type RawIssueComment = Schema.Schema.Type<typeof RawIssueCommentSchema>
type RawReview = Schema.Schema.Type<typeof RawReviewSchema>
type RawGraphqlReviewThread = Schema.Schema.Type<
  typeof RawGraphqlReviewThreadSchema
>
type RawGraphqlReviewThreadsData = Schema.Schema.Type<
  typeof RawGraphqlReviewThreadsDataSchema
>
type RawCommit = Schema.Schema.Type<typeof RawCommitSchema>
type CombinedStatusResponse = Schema.Schema.Type<
  typeof CombinedStatusResponseSchema
>
type CheckRunsResponse = Schema.Schema.Type<typeof CheckRunsResponseSchema>

export class GitHubApiError extends Data.TaggedError("GitHubApiError")<{
  readonly message: string
}> {}

export interface GitHubConfig {
  readonly token: string
  readonly apiUrl: string
  readonly owner: string
  readonly repo: string
}

export interface HumanReviewConfig {
  readonly requireApproval: boolean
  readonly requireNoUnresolvedThreads: boolean
}

export interface HumanReviewStatus {
  readonly actionableFeedbackCount: number
  readonly approvalCount: number
  readonly hasActionableFeedback: boolean
  readonly hasFreshApproval: boolean
  readonly isGreen: boolean
  readonly unresolvedThreadCount: number
}

export type GitHubInspectionResult =
  | {
      readonly kind: "missing-pr"
      readonly branchNames: ReadonlyArray<string>
    }
  | {
      readonly kind: "ambiguous"
      readonly message: string
      readonly branchNames: ReadonlyArray<string>
    }
  | {
      readonly kind: "found-pr"
      readonly associationSource: "linear" | "branch"
      readonly aiReviewStatus: AiReviewStatus | null
      readonly branchNames: ReadonlyArray<string>
      readonly headCommitCommittedAt: string | null
      readonly humanReviewStatus: HumanReviewStatus | null
      readonly pullRequest: PullRequest
      readonly headSha: string
      readonly reviewContext: PullRequestReviewContext
      readonly reviewRoundCount: number | null
      readonly checkSummary: CheckSummary
    }

const githubApiVersion = "2022-11-28"
const githubAcceptHeader = "application/vnd.github+json"
const githubCheckRunsPerPage = 100
const githubReviewActivityPerPage = 100
const maxCheckRunPages = 10
const maxReviewActivityPages = 10
const reviewThreadCommentsPerPage = 100
const reviewThreadsPerPage = 100

const toPullRequest = ({
  fallbackOwner,
  fallbackRepo,
  raw,
}: {
  readonly fallbackOwner?: string | null | undefined
  readonly fallbackRepo?: string | null | undefined
  readonly raw: RawPullRequest
}) => {
  const owner =
    raw.head.repo?.owner.login ?? raw.base.repo?.owner.login ?? fallbackOwner
  const repo = raw.head.repo?.name ?? raw.base.repo?.name ?? fallbackRepo

  if (!owner || !repo) {
    return Effect.fail(
      new GitHubApiError({
        message: `github omitted repository metadata for pull request #${raw.number}`,
      }),
    )
  }

  return Effect.succeed({
    provider: "github",
    owner,
    repo,
    number: raw.number,
    url: raw.html_url,
    title: raw.title,
    state: raw.state,
    isDraft: raw.draft,
    headRefName: raw.head.ref,
    headSha: raw.head.sha,
    baseRefName: raw.base.ref,
  } satisfies PullRequest)
}

export const normalizeCheckSummary = ({
  checkRuns,
  combinedStatus,
}: {
  readonly checkRuns: CheckRunsResponse
  readonly combinedStatus: CombinedStatusResponse
}): CheckSummary => {
  let pendingCount = 0
  let successfulCount = 0
  let failedCount = 0

  for (const checkRun of checkRuns.check_runs) {
    if (checkRun.status !== "completed") {
      pendingCount += 1
      continue
    }

    if (
      checkRun.conclusion === "success" ||
      checkRun.conclusion === "neutral"
    ) {
      successfulCount += 1
      continue
    }

    if (checkRun.conclusion === "skipped") {
      successfulCount += 1
      continue
    }

    if (
      checkRun.conclusion === "cancelled" ||
      checkRun.conclusion === "stale"
    ) {
      continue
    }

    failedCount += 1
  }

  if (combinedStatus.total_count > 0) {
    if (combinedStatus.state === "pending") {
      pendingCount += combinedStatus.total_count
    } else if (combinedStatus.state === "success") {
      successfulCount += combinedStatus.total_count
    } else if (
      combinedStatus.state === "failure" ||
      combinedStatus.state === "error"
    ) {
      failedCount += combinedStatus.total_count
    }
  }

  const totalCount =
    checkRuns.total_count +
    (combinedStatus.total_count > 0 ? combinedStatus.total_count : 0)

  if (failedCount > 0) {
    return {
      status: "failed",
      totalCount,
      pendingCount,
      successfulCount,
      failedCount,
    }
  }

  if (pendingCount > 0) {
    return {
      status: "pending",
      totalCount,
      pendingCount,
      successfulCount,
      failedCount,
    }
  }

  if (successfulCount > 0) {
    return {
      status: "passed",
      totalCount,
      pendingCount,
      successfulCount,
      failedCount,
    }
  }

  return {
    status: "ambiguous",
    totalCount,
    pendingCount,
    successfulCount,
    failedCount,
  }
}

const executeGithubJson = <A>(
  config: GitHubConfig,
  url: string,
  schema: Schema.Schema<A>,
): Effect.Effect<A | null, GitHubApiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const response = yield* httpClient
      .execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeader(
            "Authorization",
            `Bearer ${config.token}`,
          ),
          HttpClientRequest.setHeader("Accept", githubAcceptHeader),
          HttpClientRequest.setHeader("X-GitHub-Api-Version", githubApiVersion),
        ),
      )
      .pipe(
        Effect.mapError(
          (error) =>
            new GitHubApiError({
              message: `github request failed for ${url}: ${String(error)}`,
            }),
        ),
      )

    if (response.status === 404) {
      return null
    }

    if (response.status < 200 || response.status >= 300) {
      return yield* new GitHubApiError({
        message: `github request failed with status ${response.status} for ${url}`,
      })
    }

    const payload = yield* response.json.pipe(
      Effect.mapError(
        (error) =>
          new GitHubApiError({
            message: `github returned invalid json for ${url}: ${String(error)}`,
          }),
      ),
      Effect.flatMap((json) =>
        Schema.decodeUnknownEffect(schema)(json).pipe(
          Effect.mapError(
            (error) =>
              new GitHubApiError({
                message: `github response schema mismatch for ${url}: ${String(error)}`,
              }),
          ),
        ),
      ),
    )

    return payload
  }) as Effect.Effect<A | null, GitHubApiError, HttpClient.HttpClient>

const executeGithubGraphqlData = <A>({
  config,
  description,
  query,
  schema,
  variables,
}: {
  readonly config: GitHubConfig
  readonly description: string
  readonly query: string
  readonly schema: Schema.Schema<A>
  readonly variables: Record<string, unknown>
}): Effect.Effect<A, GitHubApiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const response = yield* httpClient
      .execute(
        HttpClientRequest.post(
          new URL("/graphql", config.apiUrl).toString(),
        ).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyJsonUnsafe({
            query,
            variables,
          }),
          HttpClientRequest.setHeader(
            "Authorization",
            `Bearer ${config.token}`,
          ),
          HttpClientRequest.setHeader("Accept", githubAcceptHeader),
          HttpClientRequest.setHeader("X-GitHub-Api-Version", githubApiVersion),
        ),
      )
      .pipe(
        Effect.mapError(
          (error) =>
            new GitHubApiError({
              message: `github graphql request failed for ${description}: ${String(error)}`,
            }),
        ),
      )

    if (response.status < 200 || response.status >= 300) {
      return yield* new GitHubApiError({
        message: `github graphql request failed with status ${response.status} for ${description}`,
      })
    }

    const payload = (yield* response.json.pipe(
      Effect.mapError(
        (error) =>
          new GitHubApiError({
            message: `github graphql returned invalid json for ${description}: ${String(error)}`,
          }),
      ),
    )) as unknown

    const payloadRecord =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)
        : null

    const graphqlErrors = Array.isArray(payloadRecord?.errors)
      ? payloadRecord.errors
          .flatMap((error: unknown) => {
            if (
              typeof error === "object" &&
              error !== null &&
              "message" in error &&
              typeof error.message === "string"
            ) {
              return [error.message]
            }

            return []
          })
          .filter((message: string) => message.length > 0)
      : []
    if (graphqlErrors.length > 0) {
      return yield* new GitHubApiError({
        message: `github graphql returned errors for ${description}: ${graphqlErrors.join("; ")}`,
      })
    }

    if (payloadRecord === null || !("data" in payloadRecord)) {
      return yield* new GitHubApiError({
        message: `github graphql response omitted data for ${description}`,
      })
    }

    return yield* Schema.decodeUnknownEffect(schema)(payloadRecord.data).pipe(
      Effect.mapError(
        (error) =>
          new GitHubApiError({
            message: `github graphql response schema mismatch for ${description}: ${String(error)}`,
          }),
      ),
    )
  }) as Effect.Effect<A, GitHubApiError, HttpClient.HttpClient>

const pullRequestUrl = ({
  apiUrl,
  owner,
  repo,
  number,
}: {
  readonly apiUrl: string
  readonly owner: string
  readonly repo: string
  readonly number: number
}) =>
  new URL(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
    apiUrl,
  ).toString()

const pullRequestsByBranchUrl = ({
  apiUrl,
  owner,
  repo,
  branchName,
}: {
  readonly apiUrl: string
  readonly owner: string
  readonly repo: string
  readonly branchName: string
}) => {
  const url = new URL(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
    apiUrl,
  )
  url.searchParams.set("head", `${owner}:${branchName}`)
  url.searchParams.set("per_page", "10")
  url.searchParams.set("state", "open")
  return url.toString()
}

const combinedStatusUrl = ({
  apiUrl,
  owner,
  repo,
  sha,
}: {
  readonly apiUrl: string
  readonly owner: string
  readonly repo: string
  readonly sha: string
}) =>
  new URL(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}/status`,
    apiUrl,
  ).toString()

const checkRunsUrl = ({
  apiUrl,
  owner,
  page = 1,
  perPage = githubCheckRunsPerPage,
  repo,
  sha,
}: {
  readonly apiUrl: string
  readonly owner: string
  readonly page?: number
  readonly perPage?: number
  readonly repo: string
  readonly sha: string
}) => {
  const url = new URL(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}/check-runs`,
    apiUrl,
  )
  url.searchParams.set("page", String(page))
  url.searchParams.set("per_page", String(perPage))
  return url.toString()
}

const issueCommentsUrl = ({
  apiUrl,
  owner,
  page = 1,
  perPage = githubReviewActivityPerPage,
  repo,
  pullRequestNumber,
}: {
  readonly apiUrl: string
  readonly owner: string
  readonly page?: number
  readonly perPage?: number
  readonly repo: string
  readonly pullRequestNumber: number
}) => {
  const url = new URL(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${pullRequestNumber}/comments`,
    apiUrl,
  )
  url.searchParams.set("page", String(page))
  url.searchParams.set("per_page", String(perPage))
  return url.toString()
}

const reviewsUrl = ({
  apiUrl,
  owner,
  page = 1,
  perPage = githubReviewActivityPerPage,
  repo,
  pullRequestNumber,
}: {
  readonly apiUrl: string
  readonly owner: string
  readonly page?: number
  readonly perPage?: number
  readonly repo: string
  readonly pullRequestNumber: number
}) => {
  const url = new URL(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullRequestNumber}/reviews`,
    apiUrl,
  )
  url.searchParams.set("page", String(page))
  url.searchParams.set("per_page", String(perPage))
  return url.toString()
}

const commitUrl = ({
  apiUrl,
  owner,
  repo,
  sha,
}: {
  readonly apiUrl: string
  readonly owner: string
  readonly repo: string
  readonly sha: string
}) =>
  new URL(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}`,
    apiUrl,
  ).toString()

const toIssueCommentSummary = (
  comment: RawIssueComment,
): PullRequestCommentSummary => ({
  authorLogin: comment.user?.login ?? null,
  body: comment.body,
  createdAt: comment.created_at,
  htmlUrl: comment.html_url,
  id: String(comment.id),
})

const toReviewSummary = (review: RawReview): ReviewSummary => ({
  authorAssociation: review.author_association,
  authorLogin: review.user?.login ?? null,
  body: review.body ?? "",
  commitId: review.commit_id,
  htmlUrl: review.html_url,
  id: String(review.id),
  state: review.state,
  submittedAt: review.submitted_at,
})

const compareIsoStrings = (left: string, right: string) =>
  new Date(left).getTime() - new Date(right).getTime()

const maxIsoString = (values: ReadonlyArray<string>) =>
  values.length === 0
    ? null
    : ([...values].sort(compareIsoStrings).at(-1) ?? null)

export const resolveHeadCommitCommittedAt = (commit: RawCommit) =>
  commit.commit.committer?.date ?? commit.commit.author.date

const fetchPullRequestByNumber = (
  config: GitHubConfig,
  ref: Pick<LinkedPullRequestRef, "owner" | "repo" | "number">,
): Effect.Effect<PullRequest | null, GitHubApiError, HttpClient.HttpClient> =>
  executeGithubJson(
    config,
    pullRequestUrl({
      apiUrl: config.apiUrl,
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
    }),
    RawPullRequestSchema,
  ).pipe(
    Effect.flatMap((pullRequest) =>
      pullRequest === null
        ? Effect.succeed(null)
        : toPullRequest({
            fallbackOwner: ref.owner,
            fallbackRepo: ref.repo,
            raw: pullRequest,
          }),
    ),
  )

const listPullRequestsByBranch = (
  config: GitHubConfig,
  branchName: string,
): Effect.Effect<Array<PullRequest>, GitHubApiError, HttpClient.HttpClient> =>
  executeGithubJson(
    config,
    pullRequestsByBranchUrl({
      apiUrl: config.apiUrl,
      owner: config.owner,
      repo: config.repo,
      branchName,
    }),
    RawPullRequestsSchema,
  ).pipe(
    Effect.flatMap((pullRequests) =>
      Effect.forEach(pullRequests ?? [], (pullRequest) =>
        toPullRequest({
          fallbackOwner: config.owner,
          fallbackRepo: config.repo,
          raw: pullRequest,
        }),
      ),
    ),
  )

const fetchCheckRuns = (
  config: GitHubConfig,
  pullRequest: PullRequest,
): Effect.Effect<CheckRunsResponse, GitHubApiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const checkRuns: Array<CheckRunsResponse["check_runs"][number]> = []
    let page = 1
    let totalCount = 0

    while (true) {
      if (page > maxCheckRunPages) {
        return yield* new GitHubApiError({
          message: `github check run pagination exceeded ${maxCheckRunPages} pages for ${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`,
        })
      }

      const response = yield* executeGithubJson(
        config,
        checkRunsUrl({
          apiUrl: config.apiUrl,
          owner: pullRequest.owner,
          page,
          perPage: githubCheckRunsPerPage,
          repo: pullRequest.repo,
          sha: pullRequest.headSha,
        }),
        CheckRunsResponseSchema,
      )

      if (response === null) {
        return yield* new GitHubApiError({
          message: `missing github check runs for ${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number} at ${pullRequest.headSha}`,
        })
      }

      totalCount = response.total_count
      checkRuns.push(...response.check_runs)

      if (
        response.check_runs.length < githubCheckRunsPerPage ||
        checkRuns.length >= totalCount
      ) {
        return {
          check_runs: checkRuns,
          total_count: totalCount,
        } satisfies CheckRunsResponse
      }

      page += 1
    }
  })

const fetchCheckSummary = (
  config: GitHubConfig,
  pullRequest: PullRequest,
): Effect.Effect<CheckSummary, GitHubApiError, HttpClient.HttpClient> =>
  Effect.all({
    checkRuns: fetchCheckRuns(config, pullRequest),
    combinedStatus: executeGithubJson(
      config,
      combinedStatusUrl({
        apiUrl: config.apiUrl,
        owner: pullRequest.owner,
        repo: pullRequest.repo,
        sha: pullRequest.headSha,
      }),
      CombinedStatusResponseSchema,
    ),
  }).pipe(
    Effect.flatMap(({ checkRuns, combinedStatus }) => {
      if (combinedStatus === null) {
        return Effect.fail(
          new GitHubApiError({
            message: `missing github combined status for ${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number} at ${pullRequest.headSha}`,
          }),
        )
      }

      return Effect.succeed(
        normalizeCheckSummary({
          checkRuns,
          combinedStatus,
        }),
      )
    }),
  )

const fetchPaginatedGithubCollection = <A>({
  config,
  description,
  perPage = githubReviewActivityPerPage,
  schema,
  urlForPage,
}: {
  readonly config: GitHubConfig
  readonly description: string
  readonly perPage?: number
  readonly schema: Schema.Schema<ReadonlyArray<A>>
  readonly urlForPage: (page: number) => string
}): Effect.Effect<ReadonlyArray<A>, GitHubApiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const items: Array<A> = []
    let page = 1

    while (true) {
      if (page > maxReviewActivityPages) {
        return yield* new GitHubApiError({
          message: `github ${description} pagination exceeded ${maxReviewActivityPages} pages`,
        })
      }

      const response = yield* executeGithubJson(
        config,
        urlForPage(page),
        schema,
      )
      const pageItems = response ?? []
      items.push(...pageItems)

      if (pageItems.length < perPage) {
        return items
      }

      page += 1
    }
  })

const fetchIssueComments = (config: GitHubConfig, pullRequest: PullRequest) =>
  fetchPaginatedGithubCollection({
    config,
    description: `issue comments for ${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`,
    schema: RawIssueCommentsSchema,
    urlForPage: (page) =>
      issueCommentsUrl({
        apiUrl: config.apiUrl,
        owner: pullRequest.owner,
        page,
        repo: pullRequest.repo,
        pullRequestNumber: pullRequest.number,
      }),
  }).pipe(
    Effect.map((comments) =>
      comments
        .map(toIssueCommentSummary)
        .sort((left, right) =>
          compareIsoStrings(left.createdAt, right.createdAt),
        ),
    ),
  )

const fetchReviews = (config: GitHubConfig, pullRequest: PullRequest) =>
  fetchPaginatedGithubCollection({
    config,
    description: `reviews for ${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`,
    schema: RawReviewsSchema,
    urlForPage: (page) =>
      reviewsUrl({
        apiUrl: config.apiUrl,
        owner: pullRequest.owner,
        page,
        repo: pullRequest.repo,
        pullRequestNumber: pullRequest.number,
      }),
  }).pipe(
    Effect.map((reviews) =>
      reviews
        .map(toReviewSummary)
        .sort((left, right) =>
          compareIsoStrings(
            left.submittedAt ?? new Date(0).toISOString(),
            right.submittedAt ?? new Date(0).toISOString(),
          ),
        ),
    ),
  )

const reviewThreadsGraphqlQuery = `
  query OrcaPullRequestReviewThreads(
    $owner: String!
    $repo: String!
    $number: Int!
    $after: String
    $commentsFirst: Int!
    $threadsFirst: Int!
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: $threadsFirst, after: $after) {
          nodes {
            comments(first: $commentsFirst) {
              nodes {
                author {
                  login
                }
                body
                commit {
                  oid
                }
                createdAt
                id
                originalCommit {
                  oid
                }
                path
                replyTo {
                  id
                }
                url
              }
            }
            id
            isResolved
            path
            updatedAt
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
    }
  }
`

const toReviewThreadSummary = (
  thread: RawGraphqlReviewThread,
): ReviewThreadSummary => ({
  comments: [...thread.comments.nodes]
    .map((comment) => ({
      authorLogin: comment.author?.login ?? null,
      body: comment.body,
      commitId: comment.commit?.oid ?? null,
      createdAt: comment.createdAt,
      htmlUrl: comment.url,
      id: comment.id,
      inReplyToId: comment.replyTo?.id ?? null,
      originalCommitId: comment.originalCommit?.oid ?? null,
      path: comment.path,
    }))
    .sort((left, right) => compareIsoStrings(left.createdAt, right.createdAt)),
  id: thread.id,
  isResolved: thread.isResolved,
  path: thread.path,
  updatedAt: thread.updatedAt,
})

const fetchReviewThreads = (config: GitHubConfig, pullRequest: PullRequest) =>
  Effect.gen(function* () {
    const reviewThreads: Array<ReviewThreadSummary> = []
    let cursor: string | null = null
    let page = 1

    while (true) {
      if (page > maxReviewActivityPages) {
        return yield* new GitHubApiError({
          message: `github review thread pagination exceeded ${maxReviewActivityPages} pages for ${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`,
        })
      }

      const data: RawGraphqlReviewThreadsData = yield* executeGithubGraphqlData(
        {
          config,
          description: `review threads for ${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`,
          query: reviewThreadsGraphqlQuery,
          schema: RawGraphqlReviewThreadsDataSchema,
          variables: {
            after: cursor,
            commentsFirst: reviewThreadCommentsPerPage,
            number: pullRequest.number,
            owner: pullRequest.owner,
            repo: pullRequest.repo,
            threadsFirst: reviewThreadsPerPage,
          },
        },
      )

      const reviewThreadsPage =
        data.repository?.pullRequest?.reviewThreads ?? null
      if (reviewThreadsPage === null) {
        return reviewThreads.sort((left, right) =>
          compareIsoStrings(left.updatedAt, right.updatedAt),
        )
      }

      reviewThreads.push(...reviewThreadsPage.nodes.map(toReviewThreadSummary))

      if (!reviewThreadsPage.pageInfo.hasNextPage) {
        return reviewThreads.sort((left, right) =>
          compareIsoStrings(left.updatedAt, right.updatedAt),
        )
      }

      cursor = reviewThreadsPage.pageInfo.endCursor
      if (cursor === null) {
        return yield* new GitHubApiError({
          message: `github review thread pagination omitted endCursor for ${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`,
        })
      }

      page += 1
    }
  })

const fetchHeadCommitCommittedAt = (
  config: GitHubConfig,
  pullRequest: PullRequest,
) =>
  executeGithubJson(
    config,
    commitUrl({
      apiUrl: config.apiUrl,
      owner: pullRequest.owner,
      repo: pullRequest.repo,
      sha: pullRequest.headSha,
    }),
    RawCommitSchema,
  ).pipe(
    Effect.flatMap((commit) =>
      commit === null
        ? Effect.fail(
            new GitHubApiError({
              message: `missing github commit metadata for ${pullRequest.owner}/${pullRequest.repo}@${pullRequest.headSha}`,
            }),
          )
        : Effect.succeed(resolveHeadCommitCommittedAt(commit)),
    ),
  )

const timestampAfter = (timestamp: string, baseline: string) =>
  Number.isFinite(new Date(timestamp).getTime()) &&
  Number.isFinite(new Date(baseline).getTime()) &&
  new Date(timestamp).getTime() > new Date(baseline).getTime()

export const deriveAiReviewStatus = ({
  currentHeadSha,
  headCommitCommittedAt,
  issueComments,
  previousStatus,
  reviewThreads,
  reviews,
  summonComment,
}: {
  readonly currentHeadSha: string
  readonly headCommitCommittedAt: string | null
  readonly issueComments: ReadonlyArray<PullRequestCommentSummary>
  readonly previousStatus?: AiReviewStatus | null | undefined
  readonly reviewThreads: ReadonlyArray<ReviewThreadSummary>
  readonly reviews: ReadonlyArray<ReviewSummary>
  readonly summonComment?: string | null | undefined
}): AiReviewStatus => {
  const sameHead = previousStatus?.headSha === currentHeadSha
  const reviewSummon = summonComment?.trim() ?? ""
  const activityBaseline =
    sameHead && previousStatus?.waitingSince
      ? previousStatus.waitingSince
      : headCommitCommittedAt

  if (activityBaseline === null) {
    return {
      headSha: currentHeadSha,
      lastObservedReviewActivityAt: null,
      status: "ambiguous",
      waitingSince: null,
    }
  }

  const pendingIssueComments = issueComments.filter(
    (comment) =>
      timestampAfter(
        comment.createdAt,
        headCommitCommittedAt ?? activityBaseline,
      ) &&
      reviewSummon.length > 0 &&
      comment.body.includes(reviewSummon),
  )

  const reviewActivityTimestamps = [
    ...reviews
      .filter(
        (review) =>
          review.commitId === currentHeadSha &&
          review.submittedAt !== null &&
          timestampAfter(review.submittedAt, activityBaseline),
      )
      .map((review) => review.submittedAt as string),
    ...reviewThreads.flatMap((thread) =>
      thread.comments
        .filter(
          (comment) =>
            (comment.commitId === currentHeadSha ||
              comment.originalCommitId === currentHeadSha) &&
            timestampAfter(comment.createdAt, activityBaseline),
        )
        .map((comment) => comment.createdAt),
    ),
  ]
  const lastObservedReviewActivityAt = maxIsoString(reviewActivityTimestamps)

  if (lastObservedReviewActivityAt !== null) {
    return {
      headSha: currentHeadSha,
      lastObservedReviewActivityAt,
      status: "completed",
      waitingSince:
        previousStatus?.waitingSince ??
        pendingIssueComments.at(-1)?.createdAt ??
        activityBaseline,
    }
  }

  if (sameHead && previousStatus?.waitingSince) {
    return {
      headSha: currentHeadSha,
      lastObservedReviewActivityAt: null,
      status: "pending",
      waitingSince: previousStatus.waitingSince,
    }
  }

  const lastPendingCommentAt = pendingIssueComments.at(-1)?.createdAt ?? null
  if (lastPendingCommentAt !== null) {
    return {
      headSha: currentHeadSha,
      lastObservedReviewActivityAt: null,
      status: "pending",
      waitingSince: lastPendingCommentAt,
    }
  }

  return {
    headSha: currentHeadSha,
    lastObservedReviewActivityAt: null,
    status: "not_requested",
    waitingSince: null,
  }
}

const humanReviewStates = new Set([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
])

const latestReviewsByAuthor = (reviews: ReadonlyArray<ReviewSummary>) => {
  const latestByAuthor = new Map<string, ReviewSummary>()

  for (const review of reviews) {
    if (
      review.authorLogin === null ||
      review.submittedAt === null ||
      !humanReviewStates.has(review.state)
    ) {
      continue
    }

    const current = latestByAuthor.get(review.authorLogin)
    if (
      current === undefined ||
      compareIsoStrings(
        current.submittedAt ?? new Date(0).toISOString(),
        review.submittedAt,
      ) <= 0
    ) {
      latestByAuthor.set(review.authorLogin, review)
    }
  }

  return [...latestByAuthor.values()]
}

export const deriveHumanReviewStatus = ({
  config,
  currentHeadSha,
  headCommitCommittedAt,
  issueComments,
  previousHeadSha,
  reviewThreads,
  reviews,
  summonComment,
}: {
  readonly config: HumanReviewConfig
  readonly currentHeadSha: string
  readonly headCommitCommittedAt: string | null
  readonly issueComments: ReadonlyArray<PullRequestCommentSummary>
  readonly previousHeadSha?: string | null | undefined
  readonly reviewThreads: ReadonlyArray<ReviewThreadSummary>
  readonly reviews: ReadonlyArray<ReviewSummary>
  readonly summonComment?: string | null | undefined
}): HumanReviewStatus => {
  const summon = summonComment?.trim() ?? ""
  const latestHumanReviews = latestReviewsByAuthor(reviews)
  const freshHeadApprovalReviews = latestHumanReviews.filter(
    (review) =>
      review.state === "APPROVED" && review.commitId === currentHeadSha,
  )
  const fallbackApprovalReviews = latestHumanReviews.filter(
    (review) => review.state === "APPROVED" && review.commitId === null,
  )
  const headChanged =
    previousHeadSha !== undefined && previousHeadSha !== currentHeadSha
  const hasFreshApproval =
    freshHeadApprovalReviews.length > 0 ||
    (!headChanged && fallbackApprovalReviews.length > 0)

  const isActionableIssueComment = (comment: PullRequestCommentSummary) =>
    headCommitCommittedAt !== null &&
    timestampAfter(comment.createdAt, headCommitCommittedAt) &&
    (summon.length === 0 || !comment.body.includes(summon))

  const isActionableThreadComment = (
    comment: ReviewThreadSummary["comments"][number],
  ) =>
    headCommitCommittedAt !== null &&
    timestampAfter(comment.createdAt, headCommitCommittedAt) &&
    (summon.length === 0 || !comment.body.includes(summon))

  const actionableIssueCommentCount = issueComments.filter(
    isActionableIssueComment,
  ).length
  const actionableThreadCommentCount = reviewThreads
    .filter((thread) => !thread.isResolved)
    .flatMap((thread) => thread.comments)
    .filter(isActionableThreadComment).length
  const actionableReviewCount = latestHumanReviews.filter(
    (review) =>
      headCommitCommittedAt !== null &&
      review.submittedAt !== null &&
      timestampAfter(review.submittedAt, headCommitCommittedAt) &&
      (review.state === "CHANGES_REQUESTED" ||
        (review.state === "COMMENTED" && review.body.trim().length > 0)),
  ).length
  const actionableFeedbackCount =
    actionableIssueCommentCount +
    actionableThreadCommentCount +
    actionableReviewCount

  const unresolvedThreadCount = config.requireNoUnresolvedThreads
    ? reviewThreads.filter((thread) => !thread.isResolved).length
    : 0

  const isGreen =
    (!config.requireApproval || hasFreshApproval) &&
    (!config.requireNoUnresolvedThreads || unresolvedThreadCount === 0) &&
    actionableFeedbackCount === 0

  return {
    actionableFeedbackCount,
    approvalCount:
      freshHeadApprovalReviews.length + fallbackApprovalReviews.length,
    hasActionableFeedback: actionableFeedbackCount > 0,
    hasFreshApproval,
    isGreen,
    unresolvedThreadCount,
  }
}

const fetchReviewContext = (config: GitHubConfig, pullRequest: PullRequest) =>
  Effect.all({
    headCommitCommittedAt: fetchHeadCommitCommittedAt(config, pullRequest),
    issueComments: fetchIssueComments(config, pullRequest),
    reviewThreads: fetchReviewThreads(config, pullRequest),
    reviews: fetchReviews(config, pullRequest),
  }).pipe(
    Effect.map(
      ({ headCommitCommittedAt, issueComments, reviewThreads, reviews }) => ({
        headCommitCommittedAt,
        reviewContext: {
          issueComments,
          reviewThreads,
          reviews,
        } satisfies PullRequestReviewContext,
      }),
    ),
  )

const buildFallbackBranchNames = ({
  issue,
  trackedBranchName,
}: {
  readonly issue: NormalizedIssue
  readonly trackedBranchName?: string | null | undefined
}) => {
  const branchNames: Array<string> = []
  const seen = new Set<string>()

  const pushBranchName = ({
    candidate,
    includeSanitized,
  }: {
    readonly candidate: string | null | undefined
    readonly includeSanitized: boolean
  }) => {
    const trimmed = candidate?.trim()
    if (!trimmed) {
      return
    }

    const candidates = includeSanitized
      ? [trimmed, sanitizeIssueIdentifier(trimmed)]
      : [trimmed]

    for (const branchName of candidates) {
      if (!branchName || seen.has(branchName)) {
        continue
      }

      seen.add(branchName)
      branchNames.push(branchName)
    }
  }

  pushBranchName({
    candidate: issue.branchName,
    includeSanitized: true,
  })
  pushBranchName({
    candidate: trackedBranchName,
    includeSanitized: true,
  })
  pushBranchName({
    candidate: sanitizeIssueIdentifier(issue.identifier),
    includeSanitized: false,
  })

  return branchNames
}

export const inspectIssueGitHubState = ({
  currentAiReviewStatus,
  currentHeadSha,
  currentReviewRoundCount,
  config,
  fetchCheckSummary: fetchCheckSummaryImpl = fetchCheckSummary,
  fetchReviewContext: fetchReviewContextImpl = fetchReviewContext,
  fetchPullRequestByNumber:
    fetchPullRequestByNumberImpl = fetchPullRequestByNumber,
  humanReviewConfig,
  issue,
  listPullRequestsByBranch:
    listPullRequestsByBranchImpl = listPullRequestsByBranch,
  summonComment,
  trackedBranchName,
}: {
  readonly currentAiReviewStatus?: AiReviewStatus | null | undefined
  readonly currentHeadSha?: string | null | undefined
  readonly currentReviewRoundCount?: number | null | undefined
  readonly config: GitHubConfig
  readonly fetchCheckSummary?: (
    config: GitHubConfig,
    pullRequest: PullRequest,
  ) => Effect.Effect<CheckSummary, GitHubApiError, HttpClient.HttpClient>
  readonly fetchReviewContext?: (
    config: GitHubConfig,
    pullRequest: PullRequest,
  ) => Effect.Effect<
    {
      readonly headCommitCommittedAt: string
      readonly reviewContext: PullRequestReviewContext
    },
    GitHubApiError,
    HttpClient.HttpClient
  >
  readonly fetchPullRequestByNumber?: (
    config: GitHubConfig,
    ref: Pick<LinkedPullRequestRef, "owner" | "repo" | "number">,
  ) => Effect.Effect<PullRequest | null, GitHubApiError, HttpClient.HttpClient>
  readonly humanReviewConfig: HumanReviewConfig
  readonly issue: NormalizedIssue
  readonly listPullRequestsByBranch?: (
    config: GitHubConfig,
    branchName: string,
  ) => Effect.Effect<
    ReadonlyArray<PullRequest>,
    GitHubApiError,
    HttpClient.HttpClient
  >
  readonly summonComment?: string | null | undefined
  readonly trackedBranchName?: string | null | undefined
}): Effect.Effect<
  GitHubInspectionResult,
  GitHubApiError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const inspectFoundPullRequest = ({
      associationSource,
      branchNames,
      pullRequest,
    }: {
      readonly associationSource: "linear" | "branch"
      readonly branchNames: ReadonlyArray<string>
      readonly pullRequest: PullRequest
    }) =>
      Effect.gen(function* () {
        const checkSummary = yield* fetchCheckSummaryImpl(config, pullRequest)

        if (checkSummary.status !== "passed" || pullRequest.isDraft) {
          return {
            kind: "found-pr",
            associationSource,
            aiReviewStatus: null,
            branchNames,
            checkSummary,
            headSha: pullRequest.headSha,
            headCommitCommittedAt: null,
            humanReviewStatus: null,
            pullRequest,
            reviewContext: emptyReviewContext,
            reviewRoundCount: null,
          } satisfies GitHubInspectionResult
        }

        const { headCommitCommittedAt, reviewContext } =
          yield* fetchReviewContextImpl(config, pullRequest)
        const aiReviewStatus = deriveAiReviewStatus({
          currentHeadSha: pullRequest.headSha,
          headCommitCommittedAt,
          issueComments: reviewContext.issueComments,
          previousStatus: currentAiReviewStatus,
          reviewThreads: reviewContext.reviewThreads,
          reviews: reviewContext.reviews,
          summonComment,
        })
        const humanReviewStatus = deriveHumanReviewStatus({
          config: humanReviewConfig,
          currentHeadSha: pullRequest.headSha,
          headCommitCommittedAt,
          issueComments: reviewContext.issueComments,
          previousHeadSha: currentHeadSha,
          reviewThreads: reviewContext.reviewThreads,
          reviews: reviewContext.reviews,
          summonComment,
        })

        return {
          kind: "found-pr",
          associationSource,
          aiReviewStatus,
          branchNames,
          checkSummary,
          headSha: pullRequest.headSha,
          headCommitCommittedAt,
          humanReviewStatus,
          pullRequest,
          reviewContext,
          reviewRoundCount: nextReviewRoundCount({
            currentHeadSha: currentHeadSha ?? null,
            nextHeadSha: pullRequest.headSha,
            previousReviewRoundCount: currentReviewRoundCount ?? null,
          }),
        } satisfies GitHubInspectionResult
      })

    if (issue.linkedPullRequests.length > 1) {
      return {
        kind: "ambiguous",
        message: `multiple pull requests are linked to ${issue.identifier}`,
        branchNames: [],
      } satisfies GitHubInspectionResult
    }

    if (issue.linkedPullRequests.length === 1) {
      const linkedPullRequest = issue.linkedPullRequests[0]
      if (linkedPullRequest === undefined) {
        return {
          kind: "ambiguous",
          message: `missing linked pull request data for ${issue.identifier}`,
          branchNames: [],
        } satisfies GitHubInspectionResult
      }

      const pullRequest = yield* fetchPullRequestByNumberImpl(
        config,
        linkedPullRequest,
      )
      if (pullRequest === null) {
        return {
          kind: "ambiguous",
          message: `linked pull request ${linkedPullRequest.owner}/${linkedPullRequest.repo}#${linkedPullRequest.number} no longer exists`,
          branchNames: [],
        } satisfies GitHubInspectionResult
      }

      if (pullRequest.state === "closed") {
        return {
          kind: "ambiguous",
          message: `linked pull request ${linkedPullRequest.owner}/${linkedPullRequest.repo}#${linkedPullRequest.number} is closed`,
          branchNames: [pullRequest.headRefName],
        } satisfies GitHubInspectionResult
      }

      return yield* inspectFoundPullRequest({
        associationSource: "linear",
        branchNames: [pullRequest.headRefName],
        pullRequest,
      })
    }

    const branchNames = buildFallbackBranchNames({
      issue,
      trackedBranchName,
    })

    for (const branchName of branchNames) {
      const pullRequests = yield* listPullRequestsByBranchImpl(
        config,
        branchName,
      )

      if (pullRequests.length === 0) {
        continue
      }

      if (pullRequests.length > 1) {
        return {
          kind: "ambiguous",
          message: `multiple pull requests matched branch ${branchName} for ${issue.identifier}`,
          branchNames,
        } satisfies GitHubInspectionResult
      }

      const pullRequest = pullRequests[0]
      if (pullRequest === undefined) {
        return {
          kind: "ambiguous",
          message: `missing pull request data for branch ${branchName} on ${issue.identifier}`,
          branchNames,
        } satisfies GitHubInspectionResult
      }

      return yield* inspectFoundPullRequest({
        associationSource: "branch",
        branchNames,
        pullRequest,
      })
    }

    return {
      kind: "missing-pr",
      branchNames,
    } satisfies GitHubInspectionResult
  })
