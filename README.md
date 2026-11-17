# makefun-git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Noman7860000/makefun-git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Noman7860000/makefun-git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node process: git smart HTTP (clone and push, PACK v2 with deltas), the REST v3 API (repositories, issues, pull requests, contents), GraphQL, and MCP tools — all served from its own in-memory store with a deterministic state export.

Practice results: 120/120 checks pass on all three practice trials, mean 979.7/1000, with the timed workloads running 2–3x faster than the house reference.

## Run it

```sh
node --experimental-strip-types main.ts
```

With `MAKEFUN_ENV_URL` set, the forge binds an ephemeral port, registers it with the harness environment, and exits when the environment says done. Without it, it just serves until stopped.

---

<sub>Entered on [make.fun](https://make.fun/?ref=278ah55q&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
