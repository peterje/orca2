import { Duration, Effect, Schema } from "effect"
import type {
  AiReviewDecision,
  NormalizedIssue,
  PullRequest,
  PullRequestReviewContext,
} from "./domain"
import { AiReviewDecisionSchema } from "./domain"
import { AgentRunnerError, runOpencodeAgentText } from "./agent-runner"
import type { WorktreeHandle } from "./git-worktree"
import { WorktreeError, ensureIssueWorktree } from "./git-worktree"
import type { OrcaConfig } from "./orca-config"
import {
  buildAiReviewEvaluationPrompt,
  buildAiReviewRemediationPrompt,
  buildHumanFeedbackPrompt,
} from "./prompts"

const parseAiReviewDecision = (rawOutput: string) =>
  Effect.try({
    try: () => JSON.parse(rawOutput) as unknown,
    catch: (cause) =>
      new AgentRunnerError({
        diagnostics: [String(cause)],
        message: "evaluator output was not valid json",
        reason: "protocol-error",
        retryable: false,
      }),
  }).pipe(
    Effect.flatMap((payload) =>
      Schema.decodeUnknownEffect(AiReviewDecisionSchema)(payload).pipe(
        Effect.mapError(
          (error) =>
            new AgentRunnerError({
              diagnostics: [String(error)],
              message: "evaluator output did not match AiReviewDecision",
              reason: "protocol-error",
              retryable: false,
            }),
        ),
      ),
    ),
  )

export const emptyReviewContext: PullRequestReviewContext = {
  issueComments: [],
  reviewThreads: [],
  reviews: [],
}

const ensureReviewWorktree = ({
  config,
  issue,
}: {
  readonly config: OrcaConfig
  readonly issue: NormalizedIssue
}) =>
  ensureIssueWorktree({
    config,
    issue,
  })

export const runAiReviewEvaluationAttempt = ({
  config,
  ensureWorktree = (currentIssue: NormalizedIssue) =>
    ensureReviewWorktree({
      config,
      issue: currentIssue,
    }),
  issue,
  onWorktreeReady = () => Effect.void,
  pullRequest,
  reviewContext,
  reviewRoundCount,
  runAgent = ({
    cwd,
    prompt,
  }: {
    readonly cwd: string
    readonly prompt: string
  }) =>
    runOpencodeAgentText({
      config,
      cwd,
      prompt,
    }),
}: {
  readonly config: OrcaConfig
  readonly ensureWorktree?: (
    issue: NormalizedIssue,
  ) => Effect.Effect<WorktreeHandle, WorktreeError>
  readonly issue: NormalizedIssue
  readonly onWorktreeReady?: (worktree: WorktreeHandle) => Effect.Effect<void>
  readonly pullRequest: PullRequest
  readonly reviewContext: PullRequestReviewContext
  readonly reviewRoundCount: number
  readonly runAgent?: (params: {
    readonly cwd: string
    readonly prompt: string
  }) => Effect.Effect<string, AgentRunnerError>
}) =>
  Effect.gen(function* () {
    const worktree = yield* ensureWorktree(issue)
    yield* onWorktreeReady(worktree)

    const rawDecision = yield* runAgent({
      cwd: worktree.path,
      prompt: buildAiReviewEvaluationPrompt({
        issue,
        pullRequest,
        reviewContext,
        reviewRoundCount,
      }),
    })

    const decision = yield* parseAiReviewDecision(rawDecision)

    return {
      decision,
      worktreePath: worktree.path,
    } as const
  })

export const runAiReviewRemediationAttempt = ({
  config,
  ensureWorktree = (currentIssue: NormalizedIssue) =>
    ensureReviewWorktree({
      config,
      issue: currentIssue,
    }),
  issue,
  onWorktreeReady = () => Effect.void,
  pullRequest,
  reviewContext,
  reviewRoundCount,
  runAgent = ({
    cwd,
    prompt,
  }: {
    readonly cwd: string
    readonly prompt: string
  }) =>
    runOpencodeAgentText({
      config,
      cwd,
      prompt,
    }).pipe(Effect.asVoid),
  sleep = () => Effect.sleep(Duration.millis(1_000)),
}: {
  readonly config: OrcaConfig
  readonly ensureWorktree?: (
    issue: NormalizedIssue,
  ) => Effect.Effect<WorktreeHandle, WorktreeError>
  readonly issue: NormalizedIssue
  readonly onWorktreeReady?: (worktree: WorktreeHandle) => Effect.Effect<void>
  readonly pullRequest: PullRequest
  readonly reviewContext: PullRequestReviewContext
  readonly reviewRoundCount: number
  readonly runAgent?: (params: {
    readonly cwd: string
    readonly prompt: string
  }) => Effect.Effect<void, AgentRunnerError>
  readonly sleep?: () => Effect.Effect<void>
}) =>
  Effect.gen(function* () {
    const worktree = yield* ensureWorktree(issue)
    yield* onWorktreeReady(worktree)

    yield* runAgent({
      cwd: worktree.path,
      prompt: buildAiReviewRemediationPrompt({
        issue,
        pullRequest,
        reviewContext,
        reviewRoundCount,
      }),
    })

    yield* sleep()

    return {
      branchName: worktree.branchName,
      worktreePath: worktree.path,
    } as const
  })

export const runHumanFeedbackRemediationAttempt = ({
  config,
  ensureWorktree = (currentIssue: NormalizedIssue) =>
    ensureReviewWorktree({
      config,
      issue: currentIssue,
    }),
  issue,
  onWorktreeReady = () => Effect.void,
  pullRequest,
  reviewContext,
  reviewRoundCount,
  runAgent = ({
    cwd,
    prompt,
  }: {
    readonly cwd: string
    readonly prompt: string
  }) =>
    runOpencodeAgentText({
      config,
      cwd,
      prompt,
    }).pipe(Effect.asVoid),
  sleep = () => Effect.sleep(Duration.millis(1_000)),
}: {
  readonly config: OrcaConfig
  readonly ensureWorktree?: (
    issue: NormalizedIssue,
  ) => Effect.Effect<WorktreeHandle, WorktreeError>
  readonly issue: NormalizedIssue
  readonly onWorktreeReady?: (worktree: WorktreeHandle) => Effect.Effect<void>
  readonly pullRequest: PullRequest
  readonly reviewContext: PullRequestReviewContext
  readonly reviewRoundCount: number
  readonly runAgent?: (params: {
    readonly cwd: string
    readonly prompt: string
  }) => Effect.Effect<void, AgentRunnerError>
  readonly sleep?: () => Effect.Effect<void>
}) =>
  Effect.gen(function* () {
    const worktree = yield* ensureWorktree(issue)
    yield* onWorktreeReady(worktree)

    yield* runAgent({
      cwd: worktree.path,
      prompt: buildHumanFeedbackPrompt({
        issue,
        pullRequest,
        reviewContext,
        reviewRoundCount,
      }),
    })

    yield* sleep()

    return {
      branchName: worktree.branchName,
      worktreePath: worktree.path,
    } as const
  })

export const nextReviewRoundCount = ({
  currentHeadSha,
  nextHeadSha,
  previousReviewRoundCount,
}: {
  readonly currentHeadSha: string | null
  readonly nextHeadSha: string
  readonly previousReviewRoundCount: number | null
}) => {
  if (currentHeadSha === nextHeadSha) {
    return previousReviewRoundCount ?? 1
  }

  return (previousReviewRoundCount ?? 0) + 1
}

export const applyAiReviewDecision = ({
  currentHeadSha,
  decision,
}: {
  readonly currentHeadSha: string | null
  readonly decision: AiReviewDecision
}) => {
  switch (decision.decision) {
    case "continue_ai_loop":
      return {
        lastError: null,
        nextState: "AddressingAiReviewFeedback" as const,
      }
    case "waiting_for_human_review":
      return {
        lastError: null,
        nextState: "WaitingForHumanReview" as const,
      }
    case "manual_intervention":
      return {
        lastError:
          currentHeadSha === null
            ? decision.rationale
            : `${decision.rationale} (head ${currentHeadSha})`,
        nextState: "ManualIntervention" as const,
      }
  }
}
