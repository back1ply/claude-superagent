// Commands a ticket's worker calls: assignment, inbox, ack, report, handback, unrelated.

import fs from 'node:fs'
import { REPORT_STATES } from '../domain.mjs'
import { openStore } from '../store.mjs'
import { UserError } from '../words.mjs'
import { ack as postAck } from './route.mjs'

function load(ticketId) {
  const store = openStore()
  return { store, config: store.config(), ledger: store.ledger(), ticket: store.ticket(ticketId) }
}

function findTrigger(ledger, triggerId) {
  const seen = ledger.seen[triggerId]
  if (!seen?.trigger) throw new UserError(`Unknown trigger ${triggerId}.`)
  return seen.trigger
}

// Everything a worker needs to start or resume: the mandate, environment and waiting inputs.
export function assignment(ticketId) {
  const { store, config, ticket } = load(ticketId)
  ticket.assignment = 'running'
  store.saveTicket(ticket)
  return {
    ticket: { id: ticket.id, title: ticket.title, state: ticket.state, strength: ticket.strength, matched_rules: ticket.matched_rules },
    source_trigger: ticket.source,
    routing_note: ticket.note,
    environment: {
      repository: config.repo,
      agent_account: config.account,
      commit_author: config.commitAuthor,
      base_branch: config.baseBranch,
      directory: ticket.dir,
      branch: ticket.branch,
      pr: ticket.pr,
      banner: config.banner,
    },
    policy_rules: ticket.strength === 'proactive' ? config.policy.rules.filter((r) => ticket.matched_rules.includes(r.id)) : [],
    threads: ticket.threads,
    attention: ticket.attention,
    previous_reports: ticket.reports.slice(-3),
    inputs: store.takeInputs(ticket.id),
  }
}

export function inbox(ticketId) {
  const { store } = load(ticketId)
  return { inputs: store.takeInputs(ticketId) }
}

export function ack(ticketId, triggerId, text) {
  if (!text) throw new UserError('ack needs the trigger id and a request-specific text.')
  const { store, ledger, ticket } = load(ticketId)
  const result = postAck({ store, ledger }, ticket, findTrigger(ledger, triggerId), text)
  store.saveLedger(ledger)
  store.saveTicket(ticket)
  return result
}

function summaryOf(opts) {
  if (opts['summary-file']) return fs.readFileSync(opts['summary-file'], 'utf8')
  return opts.summary ?? ''
}

function applyAttention(ticket, opts) {
  if (opts['human-action'] === undefined) return
  if (opts['human-action'] === 'null' || opts['human-action'] === '') {
    ticket.attention = null
    return
  }
  // Repeating the same question reuses its request; a different one replaces it.
  if (ticket.attention?.question === opts['human-action']) return
  ticket.attention = {
    question: opts['human-action'],
    for_trigger: opts['question-for-trigger'] ?? null,
    raised: new Date().toISOString(),
    delivered: false,
  }
}

function bindPr(ticket, prNumber) {
  if (prNumber === undefined || prNumber === 'null') return
  const n = Number(prNumber)
  if (!Number.isInteger(n) || n < 1) throw new UserError('--pr must be the actual PR number.')
  ticket.pr = n
  if (!ticket.threads.includes(`#${n}`)) ticket.threads.push(`#${n}`)
}

export function report(ticketId, opts) {
  const state = opts.state
  if (!REPORT_STATES.includes(state)) throw new UserError(`--state must be one of ${REPORT_STATES.join(', ')}.`)
  const { store, ticket } = load(ticketId)
  bindPr(ticket, opts.pr)
  applyAttention(ticket, opts)
  if (state === 'ready') ticket.attention = null
  if (opts['reply-to-trigger']) ticket.answer_permit = opts['reply-to-trigger']
  ticket.reports.push({ at: new Date().toISOString(), state, pr: ticket.pr, summary: summaryOf(opts) })
  if (state !== 'progress') endTurn(ticket, state)
  const pending = requeueLateInputs(store, ticket)
  store.saveTicket(ticket)
  return { ticket: ticket.id, state, pr: ticket.pr, attention: ticket.attention, pending_inputs: pending }
}

function endTurn(ticket, state) {
  ticket.assignment = 'ended'
  ticket.person_message_since = null
  if (state === 'dropped') Object.assign(ticket, { state: 'ended', ended_reason: 'dropped' })
}

// Inputs that arrived after the worker's last inbox check need another turn.
function requeueLateInputs(store, ticket) {
  const pending = store.countInputs(ticket.id)
  const turnOver = ticket.state === 'open' && ticket.assignment === 'ended'
  if (pending && turnOver) ticket.assignment = 'pending'
  return pending
}

// A request beyond this ticket goes back to the router once every ticket it reached hands it back.
export function handback(ticketId, triggerId, reason) {
  if (!reason) throw new UserError('handback needs a one-sentence reason.')
  const { store, ledger, ticket } = load(ticketId)
  const seen = ledger.seen[triggerId]
  if (!seen?.trigger) throw new UserError(`Unknown trigger ${triggerId}.`)
  seen.handed_back = [...(seen.handed_back ?? []).filter((h) => h.ticket !== ticket.id), { ticket: ticket.id, reason }]
  const owners = seen.tickets ?? [ticket.id]
  const allBack = owners.every((id) => seen.handed_back.some((h) => h.ticket === id))
  if (allBack) Object.assign(seen, { disposition: 'candidate', strength: 'explicit', decided: null })
  store.saveLedger(ledger)
  return { trigger_id: triggerId, queued_for_router: allBack }
}

export function unrelated(ticketId, thread, reason) {
  if (!reason) throw new UserError('unrelated needs the thread key and a one-sentence reason.')
  const { store, ticket } = load(ticketId)
  ticket.threads = ticket.threads.filter((t) => t !== thread)
  ticket.unrelated = [...(ticket.unrelated ?? []), { thread, reason }]
  store.saveTicket(ticket)
  return { ticket: ticket.id, threads: ticket.threads }
}
