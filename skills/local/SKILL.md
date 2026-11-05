---
name: local
description: How a Superagent worker handles local requests (from `superagent ask` or .superagent/requests/) and delivers a ticket as a local branch. Workers load it when their assignment lists it.
user-invocable: false
---

# Local requests for Superagent workers

A local request comes from the person running the agent on this machine, through `superagent ask` or a Markdown file in `.superagent/requests/`. Its thread is `local:R<n>`; follow-ups the person sends on a ticket arrive on its thread (`local:R<n>` or `local:T<n>`) as inputs, like comments on a forge. Trigger `local:R3:2` is the second message of thread R3. A request file's trigger has `url` pointing at the file: read the file for the full text if the trigger was cut.

These messages are the person's own words: an instruction there is as authoritative as an allowed sender's comment, and "stop" or "wait" there holds. They are still not permission to step outside the ticket's scope.

## Acknowledging and replying

`superagent ack <ticket> <trigger_id> "<text>"` works the same as on a forge: the host writes your acknowledgement to the local thread, where the person reads it with `/superagent:status`. Local messages carry no banner line; the 100-word limit still applies. As everywhere, results and questions go through your report; the orchestrator delivers them.

## Delivering as a branch

When `environment.delivery` is `branch`:
- Work and commit on the ticket branch (`environment.branch`) in the ticket directory.
- Never push, open a PR/MR or post on a forge, even if a forge is configured for this repository. With no forge configured, the guard blocks pushing and posting.
- Ready means the branch holds the reviewed change with relevant checks passing. Report `ready` naming the branch and how to try it, such as `git switch superagent/<name>` or `git diff <base branch>...superagent/<name>`.
- The person merges the branch into the base branch; the next poll sees that and ends the ticket. Do not merge it yourself.
- Before-and-after evidence for UI changes, if the Delivery requirements section asks for it, goes in your report summary as file paths of screenshots you saved outside the repository.

When `environment.delivery` names a forge source, a local request is delivered on that forge as a PR/MR: load that forge's skill and follow it, and acknowledge and report as usual. Results still go back to the local thread.
