import { Data, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import type {
  CheckSummary,
  LinkedPullRequestRef,
  NormalizedIssue,
  PullRequest,
} from "./domain"
import { sanitizeIssueIdentifier } from "./git-worktree"

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
  number: Schema.Number,
  html_url: Schema.String,
  title: Schema.String,
  state: PullRequestStateSchema,
  draft: Schema.Boolean,
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
type CombinedStatusResponse = Schema.Schema.Type<typeof CombinedStatusResponseSchema>
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
      readonly branchNames: ReadonlyArray<string>
      readonly pullRequest: PullRequest
      readonly headSha: string
      readonly checkSummary: CheckSummary
    }

const githubApiVersion = "2022-11-28"
const githubAcceptHeader = "application/vnd.github+json"
const githubCheckRunsPerPage = 100
const maxCheckRunPages = 10

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

    if (checkRun.conclusion === "success" || checkRun.conclusion === "neutral") {
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
) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.execute(
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeader("Authorization", `Bearer ${config.token}`),
        HttpClientRequest.setHeader("Accept", githubAcceptHeader),
        HttpClientRequest.setHeader("X-GitHub-Api-Version", githubApiVersion),
      ),
    ).pipe(
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
  })

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

const fetchPullRequestByNumber = (
  config: GitHubConfig,
  ref: Pick<LinkedPullRequestRef, "owner" | "repo" | "number">,
) =>
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
) =>
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
) =>
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
) =>
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
  config,
  fetchCheckSummary: fetchCheckSummaryImpl = fetchCheckSummary,
  fetchPullRequestByNumber: fetchPullRequestByNumberImpl = fetchPullRequestByNumber,
  issue,
  listPullRequestsByBranch: listPullRequestsByBranchImpl = listPullRequestsByBranch,
  trackedBranchName,
}: {
  readonly config: GitHubConfig
  readonly fetchCheckSummary?: (
    config: GitHubConfig,
    pullRequest: PullRequest,
  ) => Effect.Effect<CheckSummary, GitHubApiError, unknown>
  readonly fetchPullRequestByNumber?: (
    config: GitHubConfig,
    ref: Pick<LinkedPullRequestRef, "owner" | "repo" | "number">,
  ) => Effect.Effect<PullRequest | null, GitHubApiError, unknown>
  readonly issue: NormalizedIssue
  readonly listPullRequestsByBranch?: (
    config: GitHubConfig,
    branchName: string,
  ) => Effect.Effect<ReadonlyArray<PullRequest>, GitHubApiError, unknown>
  readonly trackedBranchName?: string | null | undefined
}): Effect.Effect<GitHubInspectionResult, GitHubApiError, unknown> =>
  Effect.gen(function* () {
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

      const checkSummary = yield* fetchCheckSummaryImpl(config, pullRequest)

      return {
        kind: "found-pr",
        associationSource: "linear",
        branchNames: [pullRequest.headRefName],
        pullRequest,
        headSha: pullRequest.headSha,
        checkSummary,
      } satisfies GitHubInspectionResult
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

      const checkSummary = yield* fetchCheckSummaryImpl(config, pullRequest)

      return {
        kind: "found-pr",
        associationSource: "branch",
        branchNames,
        pullRequest,
        headSha: pullRequest.headSha,
        checkSummary,
      } satisfies GitHubInspectionResult
    }

    return {
      kind: "missing-pr",
      branchNames,
    } satisfies GitHubInspectionResult
  })
