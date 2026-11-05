---
name: setup
description: Set up the Superagent workflow for the current repository - GitHub account, who may give it work, how it is addressed, and whether it may post. Use when the user wants to start using superagent here.
allowed-tools: Bash(superagent *) Bash(gh auth status*) Bash(gh repo view*) Bash(gh api user*)
---

# Set up Superagent

Ask one short question at a time, show the full plan once, then apply it.

1. **Check prerequisites.** `node --version` (22+), `gh auth status`, and that the current directory is a git clone of the repository with an `origin` remote. Stop and say what is missing.
2. **Repository.** Default to `gh repo view --json nameWithOwner`.
3. **Agent account.** The account `gh` is logged in as is the one the agent comments, commits and opens PRs as. A separate bot account is best: people then see clearly what the agent wrote. If the user uses their own account, its own comments are ignored by default, so they need `--accept-own` and a mention text other than their own login, such as `/superagent`.
4. **Allowed senders.** The GitHub logins whose requests the agent takes. Start narrow: just the user.
5. **Mention.** What a comment must contain to address the agent. Default `@<agent account>`.
6. **Sending.** Start with sending off (dry-run): acknowledgements and replies go to `.superagent/outbox.jsonl` instead of GitHub. Turn it on with `--send` once what the agent would have said looks right.

Show the plan, then run:

```
superagent init --repo <owner/name> --allowed <logins> [--account <login>] [--mention "<text>"] [--accept-own] [--send]
```

It writes `.superagent/config.json` (kept out of git through `.git/info/exclude`) and starts listening from now; older history is not replayed.

Then tell the user, in a few lines:
- Run `/superagent:run` for one pass, or `/loop 5m /superagent:run` to keep it running while this session is open.
- Workers run unattended commands in their worktrees under `.superagent/work/`, so use a permission mode that allows that (auto mode, or allow rules for `git`, `gh` and the project's test commands).
- Proactive work (rules in `policy.rules`, with `policy.mode` `observe` or `auto`) is off until they add rules to `config.json`. Observe mode only records what it would have done.
- Team sections can be overridden per repository in `.superagent/team/communication.md`, `scope.md` and `delivery.md`.
