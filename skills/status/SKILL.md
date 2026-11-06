---
name: status
description: Show Superagent tickets and the agent's replies to local requests, the things waiting for a person first. Use when the user asks what superagent is doing, what needs them, or about a ticket.
allowed-tools: Bash(superagent *)
---

# Superagent status

Run `superagent messages` (the agent's unread replies to local requests: acknowledgements, results, questions) and `superagent tickets` (add `--all` if the user asks about ended tickets too). For a ticket the user names, run `superagent show <id>`.

Show, in this order:
1. **Unread replies**, each as its ticket or request id and the text, verbatim.
2. **What waits for a person**, as a short table: ticket, stage, title, and where to look: the PR/MR link, or for a local branch `git diff <base>...<branch>`. For `person / answer`, the question, and how to answer it: `/superagent:ask T<n> <answer>` for a local ticket, or a reply on the forge thread for a forge ticket.
3. One line for everything else, such as "3 working, 1 idle".

If `.superagent/config.json` has `paused: true`, say so first, with `superagent resume` to start again.

A healthy state takes no space: if nothing waits for a person and nothing is unread, say so in one line.

If `.superagent/outbox.jsonl` has forge posts with `"sent":false` and `send` is off in `.superagent/config.json`, mention how many forge messages are waiting in dry-run.
