---
name: status
description: Show Superagent tickets for this repository, the ones waiting for a person first. Use when the user asks what superagent is doing, what needs them, or about a ticket.
allowed-tools: Bash(superagent *)
---

# Superagent status

Run `superagent tickets` (add `--all` if the user asks about ended tickets too). For a ticket the user names, run `superagent show <id>`.

Show what waits for a person first, as a short table: ticket, stage, title, PR link, and the question for `person / answer` tickets. Then one line for everything else, such as "3 working, 1 idle". A healthy state takes no space: if nothing waits for a person, say so in one line.

If `.superagent/outbox.jsonl` has entries and `send` is off in `.superagent/config.json`, mention how many messages are waiting in dry-run.
