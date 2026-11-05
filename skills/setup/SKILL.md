---
name: setup
description: Set up the Superagent workflow for the current repository - local requests out of the box, and optionally GitHub, GitLab (gitlab.com or self-hosted) and Bitbucket Cloud, in any combination. Use when the user wants to start using superagent here, or to add or remove a forge.
allowed-tools: Bash(superagent *) Bash(git remote*) Bash(git symbolic-ref*) Bash(gh auth status*) Bash(glab auth status*) Bash(node --version)
---

# Set up Superagent

Ask one short question at a time, show the full plan once, then apply it.

1. **Check.** `node --version` (22+), and that this is a git repository. Nothing else is needed for local use.
2. **Local first.** `superagent init [--base <branch>]` works with no network: requests come from `/superagent:ask` and from Markdown files in `.superagent/requests/`, and workers deliver a ready local branch that the user merges. The base branch defaults to the current one. If config already exists, init keeps it.
3. **Forges (optional, any number).** Run `git remote -v` and offer the forges its remotes point at. For each one the user wants:
   - Who may give work (`--allowed`): start narrow, just the user. On Bitbucket, use account ids (the user's own is shown by `source add` as `account`).
   - Which account the agent posts as: the one the CLI is logged in as. A separate bot account is best. If it is the user's own, add `--accept-own` and a `--mention` other than their own login, such as `/superagent`.
   - Which remote and base branch, if not `origin` and the init base.

   | Forge | Prerequisite | Command |
   | --- | --- | --- |
   | GitHub | `gh auth status` | `superagent source add github --kind github --repo <owner/name> --allowed <logins>` |
   | GitLab | `glab auth status` (for self-hosted, `glab auth login --hostname <host>`) | `superagent source add gitlab --kind gitlab --project <group/name> [--host <host>] --allowed <usernames>` |
   | Bitbucket Cloud | An Atlassian API token with Bitbucket read and write scopes for repositories, pull requests and issues, in the environment as `BITBUCKET_EMAIL` and `BITBUCKET_API_TOKEN` (or names given with `--email-env` / `--token-env`). Never write the token into a file in the repository. | `superagent source add bitbucket --kind bitbucket --workspace <ws> --repo <slug> --allowed <account ids>` |

   Names are free: two GitHub sources can be `github` and `github-mirror`.
4. **Where local requests are delivered.** By default as a local branch. If the user prefers PRs for them too: `superagent init --deliver <forge source name>`.
5. **Sending.** Forge posts start in dry-run: acknowledgements and replies go to `.superagent/outbox.jsonl` instead of the forge. `superagent init --send on` once what the agent would have said looks right. Local replies are never held back.

Show the plan, apply it, and then tell the user in a few lines:
- `/superagent:ask <request>` for local work; `/superagent:run` for one pass, or `/loop 5m /superagent:run` while this session is open; `/superagent:status` for what needs them.
- Workers run commands unattended in `.superagent/work/<name>`, so use a permission mode that allows that (auto mode, or allow rules for git, the forge CLIs and the project's test commands).
- With no forge configured, workers cannot push or post anywhere.
- Proactive work (`policy.rules` in `config.json`, `policy.mode` `observe` or `auto`) stays off until they add rules. Observe mode only records what the agent would have done.
- Team sections can be overridden per repository in `.superagent/team/communication.md`, `scope.md` and `delivery.md`.
