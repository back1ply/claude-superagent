# claude-superagent

DeepSeek's [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype) workflow, ported to a Claude Code plugin and made local-first.

You give the agent work: locally, with `/superagent:ask` or a Markdown file, or in comments on GitHub, GitLab or Bitbucket. A router decides what each request is. A worker takes each accepted ticket to a result in its own git worktree. For a local request, the result is a branch you merge. For a forge request, it's a pull or merge request. The agent speaks only when someone must act or can use a result. The design rule is unchanged from the original: **take as little human attention as possible, and give as much value as possible.** See upstream's [000 Philosophy](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md).

This is a community port, not affiliated with DeepSeek.

## Sources

| Source | Requests come from | Delivered as | Needs |
| --- | --- | --- | --- |
| **local** (always on) | `/superagent:ask`, `.superagent/requests/*.md` | a local branch you merge (or a PR/MR on a forge you choose) | nothing; no network |
| **GitHub** | issue and PR comments, reviews | pull request | `gh` |
| **GitLab** (gitlab.com or self-hosted) | issue and MR notes, discussions | merge request | `glab` |
| **Bitbucket Cloud** | PR and issue comments | pull request | an Atlassian API token in the environment; each pass reads every open PR, so busy repos may want a longer `/loop` interval |

A repository can use any combination: local only, or local plus one or more forges, such as a project mirrored on GitHub and GitLab. Each forge has its own allowed senders, mention text and agent account. With no forge configured, nothing leaves the machine: the guard blocks pushing and posting.

## How it maps to the original

| Original (DeepSeek Harness) | This plugin |
| --- | --- |
| Main Session (orchestrator) | Your Claude Code session running `/superagent:run`, plus the `superagent:router` agent |
| Executor Session per ticket | `superagent:worker` agent, one per ticket, in `.superagent/work/<name>` on branch `superagent/<name>` |
| Sources (GitHub, Feishu) | Sources: local, GitHub, GitLab, Bitbucket Cloud, in `lib/sources/` |
| Host tools (`orchestrator_route`, `_ack`, `_report`, `_reply`, `_trigger_handback`, ...) | The `superagent` CLI in `bin/`, which enforces the same rules in code |
| Web panel | `/superagent:status` |
| Team prompt sections | The `team` skill; override per repo in `.superagent/team/*.md` |
| Router and worker tool presets | Agent tool lists plus the `hooks/guard.mjs` hook |

What the host enforces, as upstream does:
- **Who can start work:** on a forge, only allowed senders who mention the agent. Bitbucket matches account ids, not nicknames. Locally, you.
- **Messages:** each request is acknowledged once. Messages are capped at 100 words and routing notes at 30. Every forge post starts with `This is by an automated agent, not a human.`
- **Replies need a purpose:** a result needs a ready report, a question needs the stored question copied exactly, and an answer needs the worker's permit.
- **Handbacks:** a request a worker handed back can't be attached to the same ticket again.
- **Stops:** a person's stop holds.

The guard adds these limits:
- **Router:** no shell, no edits, and reads only inside the repository.
- **Workers, on any forge:** cannot merge, close issues or approve.
- **Workers, everywhere:** cannot give themselves work or edit host state.
- **Workers, on Bitbucket:** go through the `superagent bitbucket-api` wrapper, which refuses merges, approvals, writes to other repositories and posts without the banner. Direct API calls are blocked. The token still sits in environment variables, which a worker could print (like `gh auth token`), so use a token scoped to this repository.

### Not ported (yet)

- **Always-on running.** It runs while a Claude Code session is open (`/loop 5m /superagent:run`), not as a background service.
- **Feishu.**
- **Bitbucket Data Center.** Only Bitbucket Cloud is supported.
- **The web panel and prompt versioning.**
- **Auto-merge.** A person merges every change.

## Install

```
/plugin marketplace add back1ply/claude-superagent
/plugin install superagent@claude-superagent
```

Needs Node.js 22+. Forges also need `gh`, `glab`, or a Bitbucket API token.

## Use

In a git repository:

1. `/superagent:setup` sets up local use and offers the forges your remotes point at. Config lives in `.superagent/config.json`, which git ignores.
2. `/superagent:ask fix the date format in the footer` gives local work. Follow up or answer a question with `/superagent:ask T1 use ISO dates`, and stop a ticket with `/superagent:ask T1 stop`. For longer requests, drop a Markdown file into `.superagent/requests/`.
3. `/superagent:run` makes one pass: it reads every source, routes, starts or resumes workers, and delivers results and questions. Use `/loop 5m /superagent:run` to keep it going.
4. `/superagent:status` shows the agent's replies and what is waiting for you.

Forge posts start in dry-run (`.superagent/outbox.jsonl`) until you turn sending on with `superagent init --send on`. Workers run commands unattended in their worktrees, so use a permission mode that allows that.

## Proactive work

Upstream can also take work nobody asked for, when a rule the team wrote allows it. Add rules to `config.json`, optionally limited to some sources:

```json
"policy": {
  "mode": "observe",
  "rules": [{ "id": "typos", "enabled": true, "sources": ["github"], "instruction": "Fix spelling mistakes in docs that a maintainer pointed out." }]
}
```

`observe` only records what the router would have accepted. `auto` creates tickets.

## Development

```
npm test
claude --plugin-dir .
```

The tests run each source end to end against fakes (gh, glab, and a local Bitbucket API server). The local test fails if anything touches the network.

## License

MIT. Original work © 2026 DeepSeek Harness Team; port © 2026 back1ply. See [LICENSE](LICENSE).
