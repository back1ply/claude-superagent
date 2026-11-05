// Commands the main session calls: reply, tickets, show, request-status.

import { needsPerson, stageOf } from '../domain.mjs'
import { send, targetOf } from '../messages.mjs'
import { openStore } from '../store.mjs'
import { UserError } from '../words.mjs'

function sourceTarget(ledger, ticket, triggerId) {
  const trigger = triggerId ? ledger.seen[triggerId]?.trigger : null
  return targetOf(trigger ?? ticket.source)
}

// The reply tool enforces a purpose, as upstream's orchestrator_reply does.
const PURPOSES = {
  result(ticket) {
    const last = ticket.reports.at(-1)
    if (last?.state !== 'ready' && ticket.state !== 'ended') throw new UserError('result needs a ready report from the worker.')
    return { triggerId: null }
  },
  attention(ticket, opts) {
    if (!ticket.attention) throw new UserError('attention needs the ticket\'s current structured request.')
    if (opts['human-action'] !== ticket.attention.question) throw new UserError('Copy attention.question exactly into --human-action.')
    return { triggerId: ticket.attention.for_trigger, after: () => { ticket.attention.delivered = true } }
  },
  answer(ticket, opts) {
    if (!opts.trigger || ticket.answer_permit !== opts.trigger) throw new UserError('answer needs the worker to have reported --reply-to-trigger for that question.')
    return { triggerId: opts.trigger, after: () => { ticket.answer_permit = null } }
  },
}

export function reply(ticketId, opts) {
  const purpose = PURPOSES[opts.purpose]
  if (!purpose) throw new UserError('--purpose must be result, attention or answer.')
  if (!opts.text) throw new UserError('reply needs --text.')
  const store = openStore()
  const ledger = store.ledger()
  const ticket = store.ticket(ticketId)
  const { triggerId, after } = purpose(ticket, opts)
  const text = opts.purpose === 'attention' && !opts.text.includes(opts['human-action'])
    ? `${opts.text}\n\n${opts['human-action']}`
    : opts.text
  const result = send(store, ledger, { key: `${opts.purpose}:${ticket.id}`, target: sourceTarget(ledger, ticket, triggerId), text })
  after?.()
  store.saveLedger(ledger)
  store.saveTicket(ticket)
  return result
}

function row(t) {
  return {
    id: t.id,
    stage: stageOf(t),
    assignment: t.assignment,
    title: t.title,
    pr: t.pr,
    source: t.source?.url,
    question: t.attention?.question ?? null,
    last_report: t.reports.at(-1)?.state ?? null,
  }
}

// What waits for a person first; a healthy state takes no space.
export function tickets(opts) {
  const all = openStore().tickets()
  const shown = opts.all ? all : all.filter((t) => t.state === 'open')
  return shown
    .sort((a, b) => Number(needsPerson(b)) - Number(needsPerson(a)) || a.created.localeCompare(b.created))
    .map(row)
}

export function show(ticketId) {
  return openStore().ticket(ticketId)
}

// Ask an idle worker that ended without a report for one: queue a status request input.
export function requestStatus(ticketId) {
  const store = openStore()
  const ticket = store.ticket(ticketId)
  if (stageOf(ticket) !== 'idle') throw new UserError(`${ticketId} is ${stageOf(ticket)}, not idle.`)
  store.pushInput(ticket.id, { type: 'status_request' })
  ticket.assignment = 'pending'
  store.saveTicket(ticket)
  return { ticket: ticket.id, status: 'queued' }
}
