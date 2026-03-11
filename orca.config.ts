export default {
  linear: {
    apiKey: process.env.LINEAR_API_KEY,
    endpoint: "https://api.linear.app/graphql",
    projectSlug: "orca",
    activeStates: ["Todo", "In Progress"],
    terminalStates: ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"],
  },
  github: {
    token: process.env.GITHUB_TOKEN,
    apiUrl: "https://api.github.com",
    owner: "peterje",
    repo: "orca2",
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
    maxTurns: 12,
    maxRetryBackoffMs: 300_000,
  },
  opencode: {
    startupTimeoutMs: 5_000,
    turnTimeoutMs: 3_600_000,
  },
  greptile: {
    enabled: true,
    summonComment: "@greptileai",
    requiredScore: 4,
  },
  humanReview: {
    requireApproval: true,
    requireNoUnresolvedThreads: true,
  },
} as const
