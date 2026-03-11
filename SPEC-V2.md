# Orca Specification

Status: Draft

Purpose: define an Effect-native daemon that works Linear issues in a single repository, runs a coding agent in a git worktree, manages an AI-review plus human-review GitHub PR loop, and stops only when the PR is ready for merge or a human must intervene.

This document is intentionally optimized for personal software. It prefers a small built-in workflow over generality.

## 1. Practical Constraints

Orca assumes all of the following:

- Linear is the only tracker.
- GitHub is the only forge.
- The repo uses the Linear + GitHub integration.
- The agent is expected to create or update PRs that reference the Linear issue, for example `closes PET-30`, and to request AI review as part of its workflow prompt.
- An AI reviewer is part of the normal workflow. Greptile is the initial implementation, but Orca should not depend on provider-specific review formats.
- Human review is also required before the work is considered done-for-now.
- Only one issue is actively worked at a time.
- Polling every 5 seconds is acceptable.
- If the runtime cannot confidently understand PR state, it should stop and wait for a human.

## 2. Goals

- read eligible issues from Linear
- maintain one authoritative orchestrator state
- run one coding agent in one git worktree at a time
- treat PR waiting and feedback loops as first-class runtime behavior
- automatically re-run the agent for AI review or human review feedback
- stop redispatch once the PR is in `ReadyForMerge`
- recover after restart from Linear, GitHub, local worktrees, and a small manual-state file
- use `Schema` aggressively at every external boundary
- keep review judgment mostly in prompts and agent outputs rather than hard-coded orchestrator heuristics

## 3. Non-Goals

- multi-tracker support
- multi-forge support
- workflow DSLs
- YAML or markdown workflow files
- templating languages for prompts
- hot reload
- webhook infrastructure
- HTTP control planes
- provider-specific parsing of AI review scores or prose in orchestrator code
- direct orchestrator writes to Linear outside agent-directed backlog ticket creation for deferred review feedback
- orchestrator-owned PR creation or AI-review request logic
- database-backed persistence

## 4. Effect Architecture

### 4.1 Required primitives

The implementation SHOULD be built from:

- `ServiceMap.Service`
- `Layer`
- `Schema`
- `Config` and `effect/unstable/cli`
- `HttpClient` with `FetchHttpClient` for GitHub and Linear
- `SubscriptionRef`
- `Queue`
- `PubSub` (optional)
- `effect/unstable/process` child-process services for agent execution

### 4.2 Required services

- `AppConfig`
  - loads `orca.config.ts`
  - validates it with `Schema`

- `ManualStateStore`
  - loads and saves `orca.manual-state.json`
  - persists manual blocks

- `LinearClient`
  - fetches active issues
  - fetches terminal issues for cleanup
  - fetches current issue states during reconciliation
  - extracts linked PR refs from the Linear + GitHub integration payload

- `GitHubClient`
  - fetches the PR, checks, reviews, review threads, and issue comments

- `WorktreeManager`
  - creates, reuses, and removes per-issue git worktrees

- `PromptBuilder`
  - exposes plain TypeScript functions for prompt construction

- `AgentRunner`
  - runs the coding agent in the worktree
  - streams events and returns structured outcomes

- `Orchestrator`
  - owns runtime state, polling, dispatch, reconciliation, retries, and transitions

## 5. Configuration

### 5.1 Canonical config file

Orca uses `orca.config.ts`, not `WORKFLOW.md`.

The file SHOULD export a plain object. Orca MUST validate that object with `Schema` at startup.

Recommended shape:

```ts
export default {
  linear: {
    apiKey: process.env.LINEAR_API_KEY,
    endpoint: "https://api.linear.app/graphql",
    projectSlug: "core",
    activeStates: ["Todo", "In Progress"],
    terminalStates: ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"],
  },
  github: {
    token: process.env.GITHUB_TOKEN,
    apiUrl: "https://api.github.com",
    owner: "peterje",
    repo: "orca",
    baseBranch: "main",
  },
  polling: {
    intervalMs: 5_000,
  },
  worktree: {
    repoRoot: ".",
    root: ".orca/worktrees",
  },
  agent: {
    maxRetries: 5,
    maxTurns: 12,
    maxRetryBackoffMs: 300_000,
  },
  opencode: {
    startupTimeoutMs: 5_000,
    turnTimeoutMs: 3_600_000,
  },
  humanReview: {
    requireApproval: true,
    requireNoUnresolvedThreads: true,
  },
} as const
```

### 5.2 Boot CLI

CLI should stay tiny. Recommended flags:

- `--config`
- `--log-level`

If `--config` is omitted, default to `orca.config.ts` in the current working directory.

### 5.3 Config validation rules

- missing or invalid config fails startup
- secrets may come from env, but the final loaded object is still schema-decoded
- config is read once at startup; restart to apply changes
- `worktree.repoRoot` MUST point at the canonical repository checkout used to create worktrees
- there is intentionally no `aiReview` config block; PR creation and AI-review request behavior belong in prompts, not static orchestrator config

## 6. Prompt Construction

Orca does not use a template language.

Prompt construction is plain TypeScript.

Repository-specific instructions for PR creation and AI-review requests belong in prompts, not in orchestrator configuration.

Required prompt builders:

- `buildImplementationPrompt(issue)`
- `buildAiReviewEvaluationPrompt(issue, pr, reviewRoundCount)`
- `buildAiReviewRemediationPrompt(issue, pr)`
- `buildHumanFeedbackPrompt(issue, pr)`

Each builder SHOULD accept schema-backed normalized inputs and return a string.

Prompt builders SHOULD include:

- issue identifier, title, description, labels, blockers
- PR URL and branch when present
- the expectation that implementation and remediation runs should create or update the PR and request AI review according to repository workflow conventions
- failed checks summary when resuming from CI failure
- relevant PR comments, reviews, unresolved threads, and any AI-review artifacts already present on the PR when evaluating or addressing AI review feedback
- human review comments and unresolved threads when resuming from human feedback

`buildAiReviewEvaluationPrompt(...)` MUST require structured output matching `AiReviewDecision`.

The AI-review evaluation prompt SHOULD instruct the evaluator agent to:

- read the PR diff, PR comments, reviews, and unresolved threads
- decide whether the PR should continue the AI-review loop or move to human review
- use any AI-review artifacts on the PR as evidence, not as a required parsed contract
- create a backlog ticket through the `linear` CLI before advancing when it chooses to defer a legitimate non-blocking suggestion

## 7. Schema-Backed Domain Model

All external data MUST be schema-decoded before the runtime trusts it.

### 7.1 Required schemas

At minimum, define schemas for:

- `OrcaConfig`
- `ManualStateFile`
- `Issue`
- `BlockerRef`
- `LinkedPullRequestRef`
- `PullRequest`
- `CheckSummary`
- `ReviewSummary`
- `ReviewThreadSummary`
- `AiReviewStatus`
- `AiReviewDecision`
- `RunAttempt`
- `WaitCondition`
- `RuntimeSnapshot`

`RuntimeSnapshot` SHOULD expose at least:

- current orchestrator state per claimed issue
- current PR number and head SHA when present
- current AI review status when present
- current AI review round count when present
- current worktree path when present
- retry due time when present

### 7.2 AI review status and decision schemas

Normalized AI review status SHOULD include:

- `status`: `not_requested | pending | completed | ambiguous`
- `headSha`: `string | null`
- `waitingSince`: `timestamp | null`
- `lastObservedReviewActivityAt`: `timestamp | null`

Normalized AI review decision SHOULD include:

- `decision`: `continue_ai_loop | waiting_for_human_review | manual_intervention`
- `rationale`: `string`
- `reviewRoundCount`: `number`
- `createdFollowUpIssueIdentifiers`: `ReadonlyArray<string>`

If the runtime cannot confidently determine the AI review status for the current head SHA, or cannot schema-decode the evaluator output, the issue MUST enter `ManualIntervention`.

### 7.3 Manual state file

`orca.manual-state.json` is the only required local persistence.

It SHOULD store at least:

- blocked issue identifiers or ids
- a human note
- timestamp

It MUST be schema-decoded on load.

## 8. Linear and GitHub Rules

### 8.1 Linear is mostly read-only for the orchestrator

Orca's built-in orchestrator reads Linear state. It does not directly mutate Linear workflow state.

The only planned write path is agent-directed backlog ticket creation for deferred non-blocking AI review suggestions, typically through the `linear` CLI during `EvaluatingAiReview`.

State changes in Linear happen through:

- the agent
- the human
- the GitHub + Linear integration when a PR merges

### 8.2 PR association

PR association precedence:

1. PR linked on the Linear issue through the integration
2. fallback GitHub lookup by branch name

The fallback branch source precedence is:

1. `issue.branchName`
2. current git branch in the worktree
3. sanitized issue identifier

If fallback lookup yields multiple plausible PRs, enter `ManualIntervention`.

### 8.3 GitHub API usage

Use Effect `HttpClient` with the fetch-based client.

It is acceptable to use a small mix of REST and GraphQL if that keeps the implementation simpler, but all decoded responses MUST go through `Schema`.

### 8.4 AI review contract

AI review is workflow behavior driven by agent prompts, not by provider-specific orchestrator code. Greptile is the initial workflow, but the orchestrator MUST NOT depend on provider-specific comment bodies, score formats, summon syntax, or prose conventions.

The orchestrator MUST NOT create PRs or request AI review directly.

The runtime MUST:

- observe PR comments, reviews, and review-thread activity for the current head SHA
- determine whether AI review for the current head SHA is `not_requested`, `pending`, `completed`, or `ambiguous`
- collect the PR diff, issue comments, reviews, review threads, and any AI-review artifacts needed by the evaluator prompt
- track the AI review round count for the PR

The implementation and remediation prompts SHOULD instruct the agent to create or update the PR and request AI review according to repository conventions, for example by commenting `@greptileai` after opening or updating the PR.

When AI review is `completed`, Orca MUST dispatch an evaluator agent.

The evaluator agent MUST:

- read the PR diff, PR comments, reviews, and unresolved threads
- decide whether the PR should continue the AI-review loop or move to human review
- use any AI-review artifacts as evidence only, not as a mandatory parsed contract
- create a backlog ticket through the `linear` CLI before advancing when it chooses to defer a legitimate non-blocking suggestion
- return structured output matching `AiReviewDecision`

`pending` SHOULD mean Orca is waiting for new review activity on the PR after the latest relevant agent-authored update for the current head SHA.

`completed` SHOULD mean Orca has observed new review activity on the PR and has enough material to dispatch the evaluator for the current head SHA.

The evaluator SHOULD prefer continuing the AI-review loop when the remaining issues appear to involve correctness, reliability, security, or substantive maintainability risk.

The evaluator MAY advance the PR to human review when the remaining issues are mostly nits, polish, cleanup, or low-risk follow-up work.

The evaluator SHOULD be more willing to advance after repeated AI review rounds that are no longer surfacing substantive problems.

### 8.5 Human review contract

Human review is green only when all are true:

- at least one GitHub approval exists for the current PR state
- there are no unresolved review threads if `requireNoUnresolvedThreads = true`
- there is no newer human review comment requiring response

Operational rule: any new human review comment wakes the issue back up.

Approval freshness rules:

- if the GitHub API can associate an approval with the current head SHA, only approvals for the current head SHA count
- if the API cannot prove an approval applies to the current head SHA, a newly observed head SHA MUST conservatively reset human-review green until a fresh approval is observed
- any human review comment or `changes requested` review newer than the latest head SHA change is actionable until a later agent-authored commit changes the head SHA again

## 9. Git Worktree Model

Use `git worktree`, not custom workspace directories.

### 9.1 Worktree path

Recommended path:

- `<worktree.root>/<sanitized-issue-identifier>`

The resolved worktree path MUST remain under `worktree.root` after normalization.

### 9.2 Worktree branch

Branch name precedence:

1. `issue.branchName`
2. sanitized issue identifier

If the branch does not exist yet, create the worktree from `github.baseBranch` in `worktree.repoRoot`.

### 9.3 Worktree behavior

- reuse an existing worktree for the issue when possible
- do not delete worktrees after successful attempts
- delete worktrees when the Linear issue becomes terminal
- if an existing worktree is dirty in a way Orca cannot safely interpret, enter `ManualIntervention`
- if a worktree is broken or inconsistent, enter `ManualIntervention`

## 10. Built-In State Machine

These are internal Orca states, not Linear states.

- `Todo`
- `Implementing`
- `WaitingForPr`
- `WaitingForCi`
- `WaitingForAiReview`
- `EvaluatingAiReview`
- `AddressingAiReviewFeedback`
- `WaitingForHumanReview`
- `AddressingHumanFeedback`
- `ReadyForMerge`
- `RetryQueued`
- `ManualIntervention`
- `Released`

### 10.1 Meaning of key states

- `WaitingForAiReview`
  - Orca is waiting for review activity to appear on the PR for the current head SHA after the latest relevant agent-authored update

- `EvaluatingAiReview`
  - AI review has completed for the current head SHA and Orca is running an evaluator agent to decide whether to continue AI remediation or move to human review

- `WaitingForHumanReview`
  - the evaluator has decided the PR is ready to leave the AI-review loop and wait for human review or approval

- `ReadyForMerge`
  - the AI-review gate and human review are green, the PR is still open, and Orca must not redispatch unless the PR changes again

- `ManualIntervention`
  - Orca cannot safely continue without a human decision

### 10.2 Dispatch eligibility

An issue is runnable only if all are true:

- Linear state is active
- Linear state is not terminal
- it is not already running
- it is not in `WaitingForPr`, `WaitingForCi`, `WaitingForAiReview`, `EvaluatingAiReview`, `WaitingForHumanReview`, `ReadyForMerge`, or `ManualIntervention`
- it is not blocked by a non-terminal blocker when in `Todo`
- there is no other active issue currently running

### 10.3 Main transitions

- active Linear issue with no PR -> `Todo`
- `Todo` -> agent with implementation prompt -> `Implementing`
- successful `Implementing` attempt:
  - one short retry if the PR link has not appeared yet
  - if still no PR -> `WaitingForPr`
  - if PR checks are pending -> `WaitingForCi`
  - if the current head SHA has no new review activity yet -> `WaitingForAiReview`
  - if AI review is pending -> `WaitingForAiReview`
  - if AI review is completed -> `EvaluatingAiReview`
  - if the current head SHA already has an evaluator decision of `waiting_for_human_review` and human review is not yet green -> `WaitingForHumanReview`
  - if the current head SHA already has an evaluator decision of `waiting_for_human_review` and human review is green -> `ReadyForMerge`
- `EvaluatingAiReview` -> agent with AI review evaluation prompt -> on `continue_ai_loop` `AddressingAiReviewFeedback`, on `waiting_for_human_review` `WaitingForHumanReview`
- `AddressingAiReviewFeedback` -> agent with AI review remediation prompt -> on success re-enter the AI-review loop
- `WaitingForHumanReview` -> if new human feedback exists `AddressingHumanFeedback`
- `WaitingForHumanReview` -> if human review is green `ReadyForMerge`
- `AddressingHumanFeedback` -> agent with human feedback prompt -> on success re-enter the AI-review loop
- worker failure / timeout -> `RetryQueued`
- ambiguous PR state / ambiguous AI review status / invalid evaluator output / broken worktree -> `ManualIntervention`
- PR merged or Linear terminal -> `Released`

### 10.4 Preventing redispatch after success

`ReadyForMerge` is the state that prevents redispatch.

While an issue is in `ReadyForMerge`, Orca must not run the agent again unless one of these wake conditions occurs:

- a new human review comment appears
- a new `changes requested` review appears
- checks fail
- a new commit lands on the PR head SHA, invalidating the current AI-review result
- the issue enters `ManualIntervention`

If the PR merges, the GitHub + Linear integration should move the Linear issue to `Done`, which Orca then detects during normal polling.

## 11. Polling and Retry

### 11.1 Poll loop

Poll every 5 seconds.

Each poll cycle SHOULD:

1. read active issues from Linear
2. reconcile running issues against current Linear state
3. reconcile waiting and `ReadyForMerge` issues against current GitHub state
4. transition issues whose PR state changed
5. sort runnable issues by priority ascending, then oldest `createdAt`, then `identifier`
6. dispatch one runnable issue if nothing else is running

Orca is intentionally poll-only.

### 11.2 Retry rules

- missing PR after a successful implementation attempt:
  - one short retry after about 1 second
  - then `WaitingForPr`
- agent failure:
  - exponential backoff capped by `agent.maxRetryBackoffMs`
  - after `agent.maxRetries`, escalate to `ManualIntervention`
- GitHub or AI review ambiguity:
  - do not thrash
  - enter `ManualIntervention`

## 12. Manual Intervention

`ManualIntervention` is a hard stop.

The issue remains blocked indefinitely until a human explicitly clears it.

Recommended causes:

- multiple candidate PRs
- inability to determine AI review status for the current head SHA
- evaluator output that cannot be schema-decoded
- repeated GitHub inspection failure for the same issue
- broken worktree state
- any PR state the runtime cannot confidently classify

Recommended operator actions:

- `resume <issue-identifier>`
- `block <issue-identifier> <note>`
- `delete-worktree <issue-identifier>`

## 13. Agent Runner

The default agent transport is the OpenCode SDK against a local OpenCode server.

Required behavior:

- start a local OpenCode server through the SDK
- run in the issue worktree as cwd
- scope the SDK client to the issue worktree directory
- create a session and send the appropriate prompt through the typed session API
- enforce startup timeout and total turn timeout
- configure the default build agent with `maxSteps = agent.maxTurns`
- allow evaluation-stage runs to use installed CLIs such as `linear` when the prompt calls for it
- treat missing required SDK response fields as agent protocol failures

Error mapping:

- startup timeout -> retryable agent failure
- total turn timeout -> retryable agent failure
- local server startup failure -> retryable agent failure
- assistant/provider response error -> agent failure, retryable only when the SDK error indicates it is safe to retry
- repeated malformed SDK payloads for the same issue -> `ManualIntervention`

## 14. Observability

Orca requires:

- structured logs
- a runtime snapshot in memory, ideally via `SubscriptionRef`

Recommended log fields:

- `issue_id`
- `issue_identifier`
- `pr_number`
- `head_sha`
- `ai_review_round`
- `state`

No HTTP API is required.

## 15. Startup, Shutdown, and Recovery

### 15.1 Startup

Startup SHOULD:

1. load `orca.config.ts`
2. validate config with `Schema`
3. load `orca.manual-state.json` if present
4. clean up worktrees for terminal Linear issues
5. start the poll fiber

### 15.2 Shutdown

Shutdown SHOULD:

- interrupt the running worker
- terminate child processes through finalizers
- flush logs if needed

### 15.3 Recovery

After restart, Orca reconstructs from:

- config
- manual-state file
- current active Linear issues
- current GitHub PR state
- git worktrees on disk

The runtime SHOULD be able to reconstruct:

- `WaitingForPr`
- `WaitingForCi`
- `WaitingForAiReview`
- `EvaluatingAiReview`
- `WaitingForHumanReview`
- `ReadyForMerge`
- `ManualIntervention`

No scheduler database is required.

When an issue enters `ManualIntervention`, Orca SHOULD persist that fact to `orca.manual-state.json` before releasing control back to the poll loop.

## 16. Failure Model

Failures fall into these buckets:

- config load or config decode failure
- Linear API failure
- GitHub API failure
- AI review detection failure or ambiguity
- worktree failure
- agent protocol failure

Recovery rules:

- invalid config -> fail startup
- Linear poll failure -> skip that tick
- GitHub ambiguity for a specific issue -> `ManualIntervention`
- AI review ambiguity or invalid evaluator output for a specific issue -> `ManualIntervention`
- agent failure -> retry with backoff

Secrets and operational safety:

- never log API tokens or decoded secret values
- never run the agent outside the resolved worktree path
- keep orchestrator-owned GitHub writes minimal; PR creation and AI-review requests belong in agent runs, not orchestrator code

## 17. Test Matrix

At minimum, test:

- config decode from `orca.config.ts`
- manual-state decode from `orca.manual-state.json`
- Linear issue normalization including linked PR refs
- GitHub PR normalization
- AI review status detection based on PR activity for the current head SHA
- evaluator decision decode
- transition from `EvaluatingAiReview` to `AddressingAiReviewFeedback`
- transition from `EvaluatingAiReview` to `WaitingForHumanReview`
- agent-directed backlog ticket creation path for deferred non-blocking review suggestions
- human review green detection
- `ReadyForMerge` reconstruction after restart
- missing-PR short retry then `WaitingForPr`
- AI review request once per head SHA
- manual intervention on ambiguous AI review state or invalid evaluator output
- git worktree create / reuse / cleanup

## 18. Implementation Checklist

Required:

- `orca.config.ts`
- schema validation for config, API payloads, and manual state
- Linear-only issue source
- GitHub-only PR source
- git worktree management
- one active issue at a time
- built-in AI review loop
- evaluator stage that reads the PR, comments, reviews, and threads to decide whether to continue AI review or move to human review
- evaluator-stage ability to create backlog Linear tickets for deferred non-blocking suggestions
- built-in human review loop
- `ReadyForMerge` state
- `ManualIntervention` persisted in a small local file

Deliberately omitted:

- `WORKFLOW.md`
- YAML/frontmatter parsing
- prompt templating languages
- hot reload
- HTTP API
- hooks
- generic workflows

## 19. Naming

The application name is `Orca`.
