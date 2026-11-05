// Commands a ticket's worker calls: assignment, inbox, ack, report, handback, unrelated.

import fs from 'node:fs'
import { REPORT_STATES } from '../domain.mjs'
import { openContext } from '../context.mjs'
import { keyed, sourceNameOf } from '../sources/common.mjs'
import { UserError } from '../words.mjs'
import { ack as postAck } from './route.mjs'

function load(ticketId) {
  const ctx = openContext()
  return { ...ctx, ticket: ctx.store.ticket(ticketId) }
}

function findTrigger(ledger, triggerId) {
  const seen = ledger.seen[triggerId]
  if (!seen?.trigger) throw new UserError(`Unknown trigger ${triggerId}.`)
  return seen.trigger
}

// Everything a worker needs to start or resume: the mandate, environment and waiting inputs.
// The sources a ticket touches: its threads' and its delivery forge, each with the skill to load.
function ticketSources(sources, ticket) {
  const names = new Set([...ticket.threads.map(sourceNameOf), ticket.delivery].filter((n) => sources.has(n)))
  return [...names].map((n) => sources.get(n).describe())
}

export function assignment(ticketId) {
  const { store, config, sources, ticket } = load(ticketId)
  ticket.assignment = 'running'
  store.saveTicket(ticket)
  const touched = ticketSources(sources, ticket)
  return {
    ticket: { id: ticket.id, title: ticket.title, state: ticket.state, strength: ticket.strength, matched_rules: ticket.matched_rules },
    source_trigger: ticket.source,
    routing_note: ticket.note,
    environment: {
      directory: ticket.dir,
      branch: ticket.branch,
      base_branch: config.sources[ticket.delivery]?.baseBranch ?? config.baseBranch,
      delivery: ticket.delivery,
      change: ticket.change,
      commit_author: config.commitAuthor,
      banner: config.banner,
      sources: touched,
    },
    skills: [...new Set(touched.map((s) => s.skill))],
    policy_rules: ticket.strength === 'proactive' ? config.policy.rules.filter((r) => ticket.matched_rules.includes(r.id)) : [],
    threads: ticket.threads,
    attention: ticket.attention,
    previous_reports: ticket.reports.slice(-3),
    inputs: store.takeInputs(ticket.id),
  }
}

// A stopped ticket tells its worker to stop at its next check.
export function inbox(ticketId) {
  const { store, ticket } = load(ticketId)
  const stopped = ticket.stopped ? { stopped: true, note: 'A person stopped this ticket: stop now, change nothing more, and end your turn.' } : {}
  return { ...stopped, inputs: store.takeInputs(ticketId) }
}

export async function ack(ticketId, triggerId, text) {
  if (!text) throw new UserError('ack needs the trigger id and a request-specific text.')
  const ctx = load(ticketId)
  const { store, ledger, ticket } = ctx
  const result = await postAck(ctx, ticket, findTrigger(ledger, triggerId), text)
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

// Bind the ticket's change request (PR or MR) on its delivery forge and follow its thread.
function changeNumber(value) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new UserError('--change must be the actual PR or MR number.')
  return n
}

function deliveryForge(sources, ticket) {
  const source = sources.get(ticket.delivery)
  if (!source?.forge) throw new UserError(`${ticket.id} is delivered as a local branch; it has no PR or MR.`)
  return source
}

function bindChange(sources, ticket, value) {
  if (value === undefined || value === 'null') return
  const n = changeNumber(value)
  const source = deliveryForge(sources, ticket)
  ticket.change = { source: source.name, number: n }
  const thread = keyed(source.name, source.changeThread(n))
  if (!ticket.threads.includes(thread)) ticket.threads.push(thread)
}

export function report(ticketId, opts) {
  const state = opts.state
  if (!REPORT_STATES.includes(state)) throw new UserError(`--state must be one of ${REPORT_STATES.join(', ')}.`)
  const { store, sources, ticket } = load(ticketId)
  bindChange(sources, ticket, opts.change ?? opts.pr)
  applyAttention(ticket, opts)
  if (state === 'ready') ticket.attention = null
  if (opts['reply-to-trigger']) ticket.answer_permit = opts['reply-to-trigger']
  ticket.reports.push({ at: new Date().toISOString(), state, change: ticket.change, summary: summaryOf(opts) })
  if (state !== 'progress') endTurn(ticket, state)
  const pending = requeueLateInputs(store, ticket)
  store.saveTicket(ticket)
  return { ticket: ticket.id, state, change: ticket.change, attention: ticket.attention, pending_inputs: pending }
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
