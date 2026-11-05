---
name: ask
description: Give the local Superagent a request, or follow up on a ticket or request - answer its question, add detail, or tell it to stop. Use when the user types /superagent:ask, or asks the superagent to do something in this repository without going through GitHub, GitLab or Bitbucket.
argument-hint: '[T3|R2] <request text>'
allowed-tools: Bash(superagent *)
---

# Ask the local Superagent

Arguments: $ARGUMENTS

1. If the arguments start with a ticket id (`T3`) or request id (`R2`), this is a follow-up: run `superagent ask <id> "<the rest, verbatim>"`. Otherwise it is a new request: run `superagent ask "<the arguments, verbatim>"`. Quote the text exactly as given; do not rewrite, expand or plan it. The workers derive what to do from the person's own words.
2. If the arguments are empty, ask the user what they want done, in one short question, and stop.
3. Then run one `/superagent:run` pass so the request is picked up now, unless the user said to only queue it.

Longer requests can also be written as Markdown files in `.superagent/requests/`; each new file becomes a request on the next pass.
