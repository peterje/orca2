# Orca Specification

Status: Draft

Purpose: define an Effect-native daemon that works Linear issues in a single repository, runs a coding agent in a git worktree, manages the GitHub PR review loop, and stops only when the PR is ready for merge or a human must intervene.

This document is intentionally optimized for personal software. It prefers a small built-in workflow over generality.

## 1. Practical Constraints

Orca assumes all of the following:

- Linear is the only tracker.
- GitHub is the only forge.
- The repo uses the Linear + GitHub integration.
- The agent is expected to open PRs that reference the Linear issue, for example `closes PET-30`.
- Greptile is part of the normal workflow and is a required gate.
- Human review is also required before the work is considered done-for-now.
- Only one issue is actively worked at a time.
- Polling every 5 seconds is acceptable.
- If the runtime cannot confidently understand PR state, it should stop and wait for a human.

## 2. Goals

- read eligible issues from Linear
- maintain one authoritative orchestrator state
- run one coding agent in one git worktree at a time
- treat PR waiting and feedback loops as first-class runtime behavior
- automatically re-run the agent for Greptile or human review feedback
- stop redispatch once the PR is in `ReadyForMerge`
- recover after restart from Linear, GitHub, local worktrees, and a small manual-state file
- use `Schema` aggressively at every external boundary

## 3. Non-Goals

- multi-tracker support
- multi-forge support
- workflow DSLs
- YAML or markdown workflow files
- templating languages for prompts
- hot reload
- webhook infrastructure
- HTTP control planes
- runtime writes to Linear
- runtime edits to PR title/body/metadata beyond the built-in Greptile summon comment
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
  - parses Greptile state from the current Greptile comment body
  - posts the Greptile summon comment once per head SHA

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
    terminalStates: ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"]
  },
  github: {
    token: process.env.GITHUB_TOKEN,
    apiUrl: "https://api.github.com",
    owner: "peterje",
    repo: "orca",
    baseBranch: "main"
  },
  polling: {
    intervalMs: 5_000
  },
  worktree: {
    repoRoot: ".",
    root: ".orca/worktrees"
  },
  agent: {
    maxTurns: 12,
    maxRetryBackoffMs: 300_000
  },
  codex: {
    executable: "codex",
    args: ["app-server"],
    turnTimeoutMs: 3_600_000,
    readTimeoutMs: 5_000,
    stallTimeoutMs: 300_000
  },
  greptile: {
    enabled: true,
    summonComment: "@greptileai",
    requiredScore: 5
  },
  humanReview: {
    requireApproval: true,
    requireNoUnresolvedThreads: true
  }
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

## 6. Prompt Construction

Orca does not use a template language.

Prompt construction is plain TypeScript.

Required prompt builders:

- `buildImplementationPrompt(issue)`
- `buildGreptileFeedbackPrompt(issue, pr)`
- `buildHumanFeedbackPrompt(issue, pr)`

Each builder SHOULD accept schema-backed normalized inputs and return a string.

Prompt builders SHOULD include:

- issue identifier, title, description, labels, blockers
- PR URL and branch when present
- failed checks summary when resuming from CI failure
- the latest Greptile score and relevant Greptile comment body when resuming from Greptile feedback
- human review comments and unresolved threads when resuming from human feedback

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
- `GreptileStatus`
- `RunAttempt`
- `WaitCondition`
- `RuntimeSnapshot`

`RuntimeSnapshot` SHOULD expose at least:

- current orchestrator state per claimed issue
- current PR number and head SHA when present
- current Greptile score when present
- current worktree path when present
- retry due time when present

### 7.2 Greptile status schema

Normalized Greptile state SHOULD include:

- `status`: `not_requested | pending | completed | malformed`
- `score`: `number | null`
- `commentId`: `string | null`
- `updatedAt`: `timestamp | null`
- `body`: `string | null`

If the runtime finds a Greptile comment but cannot confidently parse the score, the issue MUST enter `ManualIntervention`.

### 7.3 Manual state file

`orca.manual-state.json` is the only required local persistence.

It SHOULD store at least:

- blocked issue identifiers or ids
- a human note
- timestamp

It MUST be schema-decoded on load.

## 8. Linear and GitHub Rules

### 8.1 Linear is read-only for the runtime

Orca reads Linear state. It does not write Linear state.

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

### 8.4 Greptile review contract

Greptile review is modeled as a single PR comment that is updated in place.

The runtime MUST:

- identify the current Greptile comment on the PR
- read its current body as the authoritative Greptile state
- parse `Confidence Score: {N}/5` directly from that body

Greptile comment identification rules:

- inspect PR issue comments, not only review comments
- prefer comments authored by a Greptile bot account when that can be determined reliably
- otherwise prefer comments whose body contains `Confidence Score:`
- if multiple candidate Greptile comments exist, choose the most recently updated one
- if multiple equally plausible candidates remain, enter `ManualIntervention`

Interpretation rules:

- no Greptile comment yet and current head SHA has not been summoned -> post summon comment
- Greptile comment exists but no score yet -> `pending`
- `Confidence Score: 5/5` -> Greptile is green
- score below `5/5` -> Greptile feedback is actionable
- malformed comment body -> `ManualIntervention`

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
- `WaitingForGreptile`
- `AddressingGreptileFeedback`
- `WaitingForHumanReview`
- `AddressingHumanFeedback`
- `ReadyForMerge`
- `RetryQueued`
- `ManualIntervention`
- `Released`

### 10.1 Meaning of key states

- `WaitingForHumanReview`
  - Greptile is green and the PR is waiting for human review or approval

- `ReadyForMerge`
  - Greptile is green, human review is green, the PR is still open, and Orca must not redispatch unless the PR changes again

- `ManualIntervention`
  - Orca cannot safely continue without a human decision

### 10.2 Dispatch eligibility

An issue is runnable only if all are true:

- Linear state is active
- Linear state is not terminal
- it is not already running
- it is not in `WaitingForPr`, `WaitingForCi`, `WaitingForGreptile`, `WaitingForHumanReview`, `ReadyForMerge`, or `ManualIntervention`
- it is not blocked by a non-terminal blocker when in `Todo`
- there is no other active issue currently running

### 10.3 Main transitions

- active Linear issue with no PR -> `Todo`
- `Todo` -> agent with implementation prompt -> `Implementing`
- successful `Implementing` attempt:
  - one short retry if the PR link has not appeared yet
  - if still no PR -> `WaitingForPr`
  - if PR checks are pending -> `WaitingForCi`
  - if Greptile needs to be summoned for the current head SHA -> post summon comment, then `WaitingForGreptile`
  - if Greptile is pending -> `WaitingForGreptile`
  - if Greptile score is below target -> `AddressingGreptileFeedback`
  - if human feedback exists -> `AddressingHumanFeedback`
  - if Greptile is green and human review is not yet green -> `WaitingForHumanReview`
  - if Greptile is green and human review is green -> `ReadyForMerge`
- `AddressingGreptileFeedback` -> agent with Greptile feedback prompt -> on success re-enter the Greptile loop
- `AddressingHumanFeedback` -> agent with human feedback prompt -> on success re-enter the Greptile loop
- worker failure / timeout -> `RetryQueued`
- ambiguous PR state / malformed Greptile parsing / broken worktree -> `ManualIntervention`
- PR merged or Linear terminal -> `Released`

### 10.4 Preventing redispatch after success

`ReadyForMerge` is the state that prevents redispatch.

While an issue is in `ReadyForMerge`, Orca must not run the agent again unless one of these wake conditions occurs:

- a new human review comment appears
- a new `changes requested` review appears
- checks fail
- a new commit lands on the PR head SHA, invalidating the current Greptile result
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
- GitHub or Greptile ambiguity:
  - do not thrash
  - enter `ManualIntervention`

## 12. Manual Intervention

`ManualIntervention` is a hard stop.

The issue remains blocked indefinitely until a human explicitly clears it.

Recommended causes:

- multiple candidate PRs
- malformed or missing Greptile score in an otherwise Greptile-authored comment
- repeated GitHub inspection failure for the same issue
- broken worktree state
- any PR state the runtime cannot confidently classify

Recommended operator actions:

- `resume <issue-identifier>`
- `block <issue-identifier> <note>`
- `delete-worktree <issue-identifier>`

## 13. Agent Runner

The default agent transport is the Codex app-server over stdio.

Required behavior:

- run in the issue worktree as cwd
- stream stdout protocol messages
- treat stderr as diagnostics
- enforce read timeout, stall timeout, and total turn timeout
- stop after `agent.maxTurns`
- require a successful startup handshake or readiness signal within `codex.readTimeoutMs`
- treat malformed stdout protocol payloads as agent protocol failures

Error mapping:

- startup timeout -> retryable agent failure
- stall timeout -> retryable agent failure
- total turn timeout -> retryable agent failure
- repeated malformed protocol payloads for the same issue -> `ManualIntervention`

## 14. Observability

Orca requires:

- structured logs
- a runtime snapshot in memory, ideally via `SubscriptionRef`

Recommended log fields:

- `issue_id`
- `issue_identifier`
- `pr_number`
- `head_sha`
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
- `WaitingForGreptile`
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
- Greptile parse failure
- worktree failure
- agent protocol failure

Recovery rules:

- invalid config -> fail startup
- Linear poll failure -> skip that tick
- GitHub ambiguity for a specific issue -> `ManualIntervention`
- Greptile parse failure for a specific issue -> `ManualIntervention`
- agent failure -> retry with backoff

Secrets and operational safety:

- never log API tokens or decoded secret values
- never run the agent outside the resolved worktree path
- keep orchestrator-owned GitHub writes limited to the Greptile summon comment

## 17. Test Matrix

At minimum, test:

- config decode from `orca.config.ts`
- manual-state decode from `orca.manual-state.json`
- Linear issue normalization including linked PR refs
- GitHub PR normalization
- Greptile score extraction from edited comment bodies
- human review green detection
- `ReadyForMerge` reconstruction after restart
- missing-PR short retry then `WaitingForPr`
- Greptile re-summon once per head SHA
- manual intervention on malformed Greptile state
- git worktree create / reuse / cleanup

## 18. Implementation Checklist

Required:

- `orca.config.ts`
- schema validation for config, API payloads, and manual state
- Linear-only issue source
- GitHub-only PR source
- git worktree management
- one active issue at a time
- built-in Greptile loop
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

