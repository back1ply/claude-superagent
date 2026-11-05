# claude-superagent

DeepSeek's [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype) workflow, ported to a Claude Code plugin.

People ask the agent for work in GitHub comments. A router decides what each request is. A worker takes each accepted ticket to a pull request in its own git worktree. The agent speaks only when someone must act or can use a result. The design rule is unchanged from the original: **take as little human attention as possible, and give as much value as possible.** See upstream's [000 Philosophy](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md).

This is a community port, not affiliated with DeepSeek.

## How it maps to the original

| Original (DeepSeek Harness) | This plugin |
| --- | --- |
| Main Session (orchestrator) | Your Claude Code session running `/superagent:run`, plus the `superagent:router` agent |
| Executor Session per ticket | `superagent:worker` agent, one per ticket, in `.superagent/work/<name>` on branch `superagent/<name>` |
| Host tools (`orchestrator_route`, `_ack`, `_report`, `_reply`, `_trigger_handback`, ...) | The `superagent` CLI in `bin/`, which enforces the same rules in code |
| GitHub watcher | `superagent poll`, run by each `/superagent:run` pass |
| Web panel | `/superagent:status` |
| Team prompt sections | The `team` skill; override per repo in `.superagent/team/*.md` |
| Router and worker tool presets | Agent tool lists plus the `hooks/guard.mjs` hook |

What the host enforces, as upstream does:
- Only allowed senders who mention the agent can start work.
- Acknowledgements are sent once per request.
- Messages are capped at 100 words, and routing notes at 30.
- Replies need a purpose: a result needs a ready report, a question needs the stored question copied exactly, and an answer needs the worker's permit.
- A worker cannot hand a request back and then have it attached to the same ticket.
- A person's stop holds.
- The router has no shell.
- Workers cannot merge, close issues or approve, and every GitHub post must start with the line `This is by an automated agent, not a human.`

### Not ported (yet)

- **Always-on running.** It runs while a Claude Code session is open (`/loop 5m /superagent:run`), not as a background service.
- **Feishu.** GitHub is the only source.
- **The web panel and prompt versioning.**
- **Auto-merge through a second merge CLI.** A person merges every PR.

## Install

```
/plugin marketplace add back1ply/claude-superagent
/plugin install superagent@claude-superagent
```

Needs Node.js 22+ and an authenticated `gh` on PATH.

## Use

In a clone of the repository:

1. `/superagent:setup` asks which account, who may give work and how the agent is addressed, then writes `.superagent/config.json`. Sending starts off (dry run): messages go to `.superagent/outbox.jsonl` until you turn on `send`.
2. `/superagent:run` makes one pass. It polls GitHub, routes new requests, starts or resumes workers, and delivers results and questions. Use `/loop 5m /superagent:run` to keep it going.
3. `/superagent:status` lists tickets, with the ones waiting for you first.

Workers run commands unattended in their worktrees, so use a permission mode that allows that.

## Proactive work

Upstream can also take work nobody asked for, when a rule the team wrote allows it. Add rules to `config.json`:

```json
"policy": {
  "mode": "observe",
  "rules": [{ "id": "typos", "name": "Typos", "enabled": true, "instruction": "Fix spelling mistakes in docs that a maintainer pointed out." }]
}
```

`observe` only records what the router would have accepted. `auto` creates tickets.

## Development

```
npm test
claude --plugin-dir .
```

## License

MIT. Original work © 2026 DeepSeek Harness Team; port © 2026 back1ply. See [LICENSE](LICENSE).
