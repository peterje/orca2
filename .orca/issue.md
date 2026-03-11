# Linear issue

Identifier: PET-47
Title: Orca run implementation attempts in git worktrees

## Description

## What to build

Add the first execution slice: for a runnable issue with no linked PR, create or reuse a git worktree, build the implementation prompt with plain TypeScript, run Codex in that worktree, and transition to `WaitingForPr` after one short missing-PR retry. Reference `SPEC-V2.md` sections 6, 9, 10.3, 11.2, and 13.

## Acceptance criteria

- [ ] For a runnable issue, Orca creates or reuses a worktree under the configured root and runs the coding agent with that worktree as cwd.
- [ ] The agent runner enforces startup handshake, read, stall, and turn timeouts and maps failures into retryable agent failures.
- [ ] If no linked PR appears after one short retry, the issue transitions to `WaitingForPr`, with tests covering worktree lifecycle and agent startup/error handling.

## Dependency graph

- PET-51 Orca persist manual blocks and recover orchestrator state [blocked, priority: None, direct]
   \- dependency: PET-50 Orca handle human review and ReadyForMerge [blocked, priority: None, direct]
      \- dependency: PET-49 Orca automate the Greptile review loop [blocked, priority: None, direct]
         \- dependency: PET-48 Orca reconcile linked PRs and CI state [blocked, priority: None, direct]
            \- dependency: PET-47 Orca run implementation attempts in git worktrees [actionable, priority: None, direct]

- PET-50 Orca handle human review and ReadyForMerge [blocked, priority: None, direct]
   \- dependency: PET-49 Orca automate the Greptile review loop [blocked, priority: None, direct]
      \- dependency: PET-48 Orca reconcile linked PRs and CI state [blocked, priority: None, direct]
         \- dependency: PET-47 Orca run implementation attempts in git worktrees [actionable, priority: None, direct]

- PET-49 Orca automate the Greptile review loop [blocked, priority: None, direct]
   \- dependency: PET-48 Orca reconcile linked PRs and CI state [blocked, priority: None, direct]
      \- dependency: PET-47 Orca run implementation attempts in git worktrees [actionable, priority: None, direct]

- PET-48 Orca reconcile linked PRs and CI state [blocked, priority: None, direct]
   \- dependency: PET-47 Orca run implementation attempts in git worktrees [actionable, priority: None, direct]

- PET-47 Orca run implementation attempts in git worktrees [actionable, priority: None, direct]

## Repo instructions

# Information
- The base branch for this repository is `main`.
- The package manager used is `bun`.
- The runtime used is Bun

# Learning more about the "effect" & "@effect/\*" packages
`~/.reference/effect-v4` is an authoritative source of information about the
"effect" and "@effect/\*" packages. Read this before looking elsewhere for
information about these packages. It contains the best practices for using
effect. Use this for learning more about the library, rather than browsing the code in
`node_modules/`. Effect provides many utilities and composition patterns: Services and Layers, data strctures, Schema, and even CLI builders. Always search for and leverage Effect-native solutions where possible. Never rewrite your own code that can be modeled with Effect, eg parsing / validation / concurrency.

## Code Style
- use kebab-case for all file names.

# Testing
Test everything with `bun test`

# Git Workflow
- test and typecheck before committing.
- commit directly to main
- always use conventional commits.
- prefer lowercase.
   - "cli", not "CLI"
   - "github", not "GitHub"
   - "http", not "HTTP"
- write commits and descriptions in imperative mood
- all pr commits will be squashed: ensure pr titles follow the same rules as commits
</git>


## Orca execution constraints

- Work only in the current worktree on branch `orca/PET-47-orca-run-implementation-attempts-in-git-worktree`.
- Base branch is `main`.
- Implement the selected issue end-to-end in this repository.
- Do not ask for permission; pick reasonable defaults and keep going.
- Do not mutate unrelated git state.
- Do not commit secrets or any files under `.orca/`.
- Use a conventional commit message if you create a commit.
- Prefer a draft pull request unless there is already an open PR for this branch.

## Verification commands

- `bun run check`
- `bun run build`

## Required git outcome

- Have the branch ready for review.
- Use a conventional commit message every time you create a commit.
- If you open a PR, use a lowercase conventional commit title.
- Create the PR with `gh pr create` and a HEREDOC body so the formatting is preserved.
- Write the PR body with bold section labels instead of markdown headings: `**closes**`, `**summary**`, and `**verification**`.
- Under `**closes**`, link the Linear ticket as `[PET-47](https://linear.app/peteredm/issue/PET-47)`.
- Keep the prose lowercase unless code or ticket identifiers require otherwise.
- Make the `**summary**` section a readable narrative that explains what changed and why it matters, and avoid file-by-file implementation details.
