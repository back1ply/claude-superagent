// Argument parsing and command dispatch for bin/superagent.

import { init } from './commands/init.mjs'
import { poll } from './commands/poll.mjs'
import { route } from './commands/route.mjs'
import { ack, assignment, handback, inbox, report, unrelated } from './commands/worker.mjs'
import { reply, requestStatus, show, tickets } from './commands/orchestrator.mjs'
import { UserError } from './words.mjs'

const USAGE = `superagent <command>

Setup
  init --repo <owner/name> --allowed <a,b|*> [--account <login>] [--mention <text>] [--send] [--accept-own]

Main session (orchestrator)
  poll                                   read GitHub, deliver to tickets, write candidate cards
  route <decisions.json>                 apply the router's decisions
  reply <ticket> --purpose result|attention|answer --text <t> [--human-action <q>] [--trigger <id>]
  tickets [--all]                        tickets, the ones waiting for a person first
  show <ticket>                          one ticket in full
  request-status <ticket>                ask an idle worker for its missing report

Worker
  assignment <ticket>                    mandate, environment and waiting inputs; marks it running
  inbox <ticket>                         inputs that arrived since
  ack <ticket> <trigger> <text>          acknowledge a request once, in its thread
  report <ticket> --state progress|ready|blocked|failed|dropped [--summary <t> | --summary-file <f>]
         [--pr <n>] [--human-action <q> | null] [--question-for-trigger <id>] [--reply-to-trigger <id>]
  handback <ticket> <trigger> <reason>   return a request beyond this ticket to the router
  unrelated <ticket> <thread> <reason>   drop a thread attached by mistake`

export function parseArgs(argv) {
  const positional = []
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) opts[key] = true
    else opts[key] = argv[++i]
  }
  return { positional, opts }
}

const COMMANDS = {
  init: (p, o) => init(o),
  poll: () => poll(),
  route: ([file]) => route(file),
  reply: ([id], o) => reply(id, o),
  tickets: (p, o) => tickets(o),
  show: ([id]) => show(id),
  'request-status': ([id]) => requestStatus(id),
  assignment: ([id]) => assignment(id),
  inbox: ([id]) => inbox(id),
  ack: ([id, trigger, ...text]) => ack(id, trigger, text.join(' ')),
  report: ([id], o) => report(id, o),
  handback: ([id, trigger, ...reason]) => handback(id, trigger, reason.join(' ')),
  unrelated: ([id, thread, ...reason]) => unrelated(id, thread, reason.join(' ')),
}

export function main(argv) {
  const [name, ...rest] = argv
  const command = COMMANDS[name]
  if (!command) {
    console.log(USAGE)
    return name ? 1 : 0
  }
  const { positional, opts } = parseArgs(rest)
  try {
    console.log(JSON.stringify(command(positional, opts), null, 2))
    return 0
  } catch (error) {
    const message = error instanceof UserError ? error.message : `${error.message}\n${error.stack}`
    console.log(JSON.stringify({ error: message }, null, 2))
    return 1
  }
}
