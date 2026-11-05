// Argument parsing and command dispatch for bin/superagent.

import { bitbucketApi } from './commands/bitbucket.mjs'
import { init, sourceAdd, sourceList, sourceRemove } from './commands/init.mjs'
import { ask, messages } from './commands/local.mjs'
import { reply, requestStatus, show, tickets } from './commands/orchestrator.mjs'
import { poll } from './commands/poll.mjs'
import { route } from './commands/route.mjs'
import { ack, assignment, handback, inbox, report, unrelated } from './commands/worker.mjs'
import { withLock } from './store.mjs'
import { UserError } from './words.mjs'

const USAGE = `superagent <command>

Setup (local works with no network; forges are optional and can be combined)
  init [--base <branch>] [--deliver branch|<forge source>] [--send on|off]
  source add <name> --kind github --repo <owner/name> --allowed <a,b|*> [--account <login>] [--mention <text>]
  source add <name> --kind gitlab --project <group/name> [--host <gitlab host>] --allowed <a,b|*> [...]
  source add <name> --kind bitbucket --workspace <ws> --repo <slug> --allowed <account_id,...|*>
                    [--email-env BITBUCKET_EMAIL] [--token-env BITBUCKET_API_TOKEN] [--mention /superagent]
         common: [--remote origin] [--base <branch>] [--accept-own]
  source remove <name> | source list

You (local requests)
  ask "<text>"                           a new request
  ask T3|R2 "<text>"                     a follow-up, an answer or "stop" on a ticket or request
  messages [--all]                       the agent's replies to local requests (unread by default)

Main session (orchestrator)
  poll                                   read every source, deliver to tickets, write candidate cards
  route <decisions.json>                 apply the router's decisions
  reply <ticket> --purpose result|attention|answer --text <t> [--human-action <q>] [--trigger <id>]
  tickets [--all]                        tickets, the ones waiting for a person first
  show <ticket>                          one ticket in full
  request-status <ticket>                ask an idle worker for its missing report

Worker
  assignment <ticket>                    mandate, environment, skills to load and waiting inputs
  inbox <ticket>                         inputs that arrived since
  ack <ticket> <trigger> <text>          acknowledge a request once, where it was made
  report <ticket> --state progress|ready|blocked|failed|dropped [--summary <t> | --summary-file <f>]
         [--change <PR/MR number>] [--human-action <q> | null] [--question-for-trigger <id>] [--reply-to-trigger <id>]
  handback <ticket> <trigger> <reason>   return a request beyond this ticket to the router
  unrelated <ticket> <thread> <reason>   drop a thread attached by mistake
  bitbucket-api [--source <name>] <path> [--method M] [--json <json> | --json-file <f>]`

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

const SOURCE = {
  add: ([name], o) => sourceAdd(name, o),
  remove: ([name]) => sourceRemove(name),
  list: () => sourceList(),
}

const COMMANDS = {
  init: (p, o) => init(o),
  source: ([sub, ...rest], o) => {
    if (!SOURCE[sub]) throw new UserError('source add|remove|list')
    return SOURCE[sub](rest, o)
  },
  ask: (p) => ask(p),
  messages: (p, o) => messages(o),
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
  'bitbucket-api': (p, o) => bitbucketApi(p, o),
}

// Read-only commands, and the Bitbucket wrapper (no state), skip the state lock.
const UNLOCKED = new Set(['show', 'tickets', 'bitbucket-api'])

export async function main(argv) {
  const [name, ...rest] = argv
  const command = COMMANDS[name]
  if (!command) {
    console.log(USAGE)
    return name ? 1 : 0
  }
  const { positional, opts } = parseArgs(rest)
  try {
    const run = () => command(positional, opts)
    const result = UNLOCKED.has(name) ? await run() : await withLock(run)
    console.log(JSON.stringify(result, null, 2))
    return 0
  } catch (error) {
    const message = error instanceof UserError ? error.message : `${error.message}\n${error.stack}`
    console.log(JSON.stringify({ error: message }, null, 2))
    return 1
  }
}
