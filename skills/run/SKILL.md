---
name: run
description: Run one Superagent pass on this repository - poll GitHub, route new requests with the router agent, start or resume ticket workers, and deliver their results and questions. Use when the user says "run superagent", "check for requests", or with /loop for continuous running.
allowed-tools: Bash(superagent *) Agent(superagent:router) Agent(superagent:worker)
---

# One Superagent pass

You are the main session: the host and the orchestrator's delivery side. You route through the router agent and relay worker reports; you never investigate code, design a solution or solve a worker's blocker yourself. Every `superagent` command prints JSON; an `error` field means it refused, so read why before going on.

Take as little human attention as possible, and give as much value as possible: message a person only when they must act or can use a result.

## 1. Poll

Run `superagent poll`. It delivers new comments, reviews and CI to the tickets that follow their threads, ends tickets whose PR merged or closed, and writes candidate cards for everything else that may be new work.

## 2. Route

If `candidates_file` is set, start the `superagent:router` agent in the foreground with this prompt:

```
Repository root: <absolute repo root>
Candidates file: <candidates_file>
Decide every candidate.
```

Copy the JSON block it returns, unchanged, to `.superagent/inbox/decisions-<same timestamp>.json` and run `superagent route <that file>`. Items with `refused` were not applied: if the reason is something the router can fix, send it back once with the refusal; otherwise leave it.

## 3. Start or resume workers

Run `superagent tickets` and start the `superagent:worker` agent in the background, with the prompt `Ticket <id>.`, for each ticket that has no worker running in this session and either:
- has `assignment: pending` (new, attached, woken by a person, or with inputs left after its last report), or
- has `assignment: running` but no worker of this session: its earlier session ended mid-work, so resume it. On the first pass of a session, this is every `running` ticket.

A worker that is already running picks up new inputs through its inbox, so do not start a second one for the same ticket.

## 4. Deliver

When a worker finishes, or a poll reports `follow_ups` or `notices`, run `superagent tickets` and handle what waits for a person:

- **`person / answer`**: the ticket has a structured question. Deliver it promptly, even while the worker is working: `superagent reply <id> --purpose attention --human-action "<attention.question copied exactly>" --text "<optional short framing>"`. The host asks where the person who raised it wrote, else in the ticket's source conversation. Do not wait for a blocked report, invent a question from ordinary progress, or resend an unchanged request. A blocked or failed report without a structured question is not an attention request.
- **`person / review`**: the worker reported ready. Read the report with `superagent show <id>` and write a new short notification, one sentence with the PR link and the user-visible outcome: `superagent reply <id> --purpose result --text "..."`. Do not forward or compress the report point by point.
- **`person / blocked` or `person / failed`**: hand off only for a concrete human action or a definitive inability to complete, stating why and what is needed, in at most two sentences. Otherwise keep it internal.
- **A report with `--reply-to-trigger`**: answer that question with `superagent reply <id> --purpose answer --trigger <trigger_id> --text "..."`.
- **`idle` with no report**: `superagent request-status <id>`, then resume its worker.

Rules for every reply:
- Ordinary progress stays internal. Never announce an unfinished PR because it exists, and never repeat a milestone already communicated because another report or CI notification arrived.
- Use the worker report's facts; for missing technical facts, ask the worker, not your own investigation.
- 100 words is a hard ceiling, not a target, and the host refuses longer messages. Do not evade it with long compound sentences, lists or several messages.
- A PR merge or close (`notices`) needs no second message: the PR already shows it. State that an issue is fixed only if the worker report supports it.
- A `follow_ups` entry is a person's message that already reached the listed workers; they decide it. Act on it only to stop work when the person asks, through a router decision. Never forward it a second time.
- `dry-run` results mean `send` is off in `.superagent/config.json`: the message went to `.superagent/outbox.jsonl` only.

## 5. End

End the turn when nothing is left to do; workers' completions arrive by themselves. Report to the user in two or three lines: new tickets, messages sent, and anything waiting for them. For continuous running, the user can run `/loop 5m /superagent:run`.
