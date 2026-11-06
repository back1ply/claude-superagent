// The prepare command: run once in a new ticket directory before its first assignment, such as `npm ci`.
// It runs outside the state lock (it can take minutes) and records its outcome under the lock.

import { execFileSync } from 'node:child_process'
import { openStore, withLock } from '../store.mjs'
import { UserError } from '../words.mjs'

const PREPARE_TIMEOUT_MS = 10 * 60 * 1000
const OUTPUT_TAIL = 1500

function run(command, ticket, config) {
  const shell = process.platform === 'win32' ? 'bash' : 'sh'
  const env = {
    ...process.env,
    SUPERAGENT_TICKET: ticket.id,
    SUPERAGENT_DIR: ticket.dir,
    SUPERAGENT_BRANCH: ticket.branch,
    SUPERAGENT_BASE: config.sources[ticket.delivery]?.baseBranch ?? config.baseBranch,
  }
  try {
    execFileSync(shell, ['-c', command], { cwd: ticket.dir, env, timeout: PREPARE_TIMEOUT_MS, encoding: 'utf8', stdio: 'pipe' })
    return null
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() || error.message
    return output.slice(-OUTPUT_TAIL)
  }
}

function record(ticketId, failure) {
  return withLock(() => {
    const store = openStore()
    const ticket = store.ticket(ticketId)
    if (failure) {
      ticket.reports.push({ at: new Date().toISOString(), state: 'failed', change: ticket.change, summary: `The prepare command failed: ${failure}` })
      ticket.assignment = 'ended'
    } else {
      ticket.prepared = new Date().toISOString()
    }
    store.saveTicket(ticket)
  })
}

export async function prepareIfNeeded(ticketId) {
  const store = openStore()
  const config = store.config()
  const ticket = store.ticket(ticketId)
  if (ticket.prepared || !config.prepare) return
  const failure = run(config.prepare, ticket, config)
  await record(ticketId, failure)
  if (failure) throw new UserError(`The prepare command failed, so this ticket cannot start. Stop and end your turn. Output: ${failure}`)
}
