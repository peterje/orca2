# Linear issue

Identifier: PET-46
Title: Orca bootstrap config and Linear discovery loop

## Description

## What to build

Build the first end-to-end Orca tracer bullet: start from `orca.config.ts`, validate config with `Schema`, poll Linear for active issues, normalize linked PR refs, and maintain an in-memory orchestrator snapshot for a single runnable issue. Reference `SPEC-V2.md` sections 4, 5, 7, 8.1, 8.2, and 11.

## Acceptance criteria

- [ ] Starting Orca with a valid `orca.config.ts` boots successfully and invalid config fails fast with a schema-backed error.
- [ ] Orca polls Linear every 5 seconds, normalizes active issues including linked pull request refs, and selects at most one runnable issue at a time.
- [ ] A runtime snapshot and structured logs show the current normalized issue state, with tests covering config decode and Linear payload normalization.

## Dependency graph

- PET-51 Orca persist manual blocks and recover orchestrator state [blocked, priority: None, direct]
   \- dependency: PET-50 Orca handle human review and ReadyForMerge [blocked, priority: None, direct]
      \- dependency: PET-49 Orca automate the Greptile review loop [blocked, priority: None, direct]
         \- dependency: PET-48 Orca reconcile linked PRs and CI state [blocked, priority: None, direct]
            \- dependency: PET-47 Orca run implementation attempts in git worktrees [blocked, priority: None, direct]
               \- dependency: PET-46 Orca bootstrap config and Linear discovery loop [actionable, priority: None, direct]

- PET-50 Orca handle human review and ReadyForMerge [blocked, priority: None, direct]
   \- dependency: PET-49 Orca automate the Greptile review loop [blocked, priority: None, direct]
      \- dependency: PET-48 Orca reconcile linked PRs and CI state [blocked, priority: None, direct]
         \- dependency: PET-47 Orca run implementation attempts in git worktrees [blocked, priority: None, direct]
            \- dependency: PET-46 Orca bootstrap config and Linear discovery loop [actionable, priority: None, direct]

- PET-49 Orca automate the Greptile review loop [blocked, priority: None, direct]
   \- dependency: PET-48 Orca reconcile linked PRs and CI state [blocked, priority: None, direct]
      \- dependency: PET-47 Orca run implementation attempts in git worktrees [blocked, priority: None, direct]
         \- dependency: PET-46 Orca bootstrap config and Linear discovery loop [actionable, priority: None, direct]

- PET-48 Orca reconcile linked PRs and CI state [blocked, priority: None, direct]
   \- dependency: PET-47 Orca run implementation attempts in git worktrees [blocked, priority: None, direct]
      \- dependency: PET-46 Orca bootstrap config and Linear discovery loop [actionable, priority: None, direct]

- PET-47 Orca run implementation attempts in git worktrees [blocked, priority: None, direct]
   \- dependency: PET-46 Orca bootstrap config and Linear discovery loop [actionable, priority: None, direct]

- PET-46 Orca bootstrap config and Linear discovery loop [actionable, priority: None, direct]

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

- Work only in the current worktree on branch `orca/PET-46-orca-bootstrap-config-and-linear-discovery-loop-2`.
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
- Under `**closes**`, link the Linear ticket as `[PET-46](https://linear.app/peteredm/issue/PET-46)`.
- Keep the prose lowercase unless code or ticket identifiers require otherwise.
- Make the `**summary**` section a readable narrative that explains what changed and why it matters, and avoid file-by-file implementation details.
