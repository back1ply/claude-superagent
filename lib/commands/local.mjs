// Local requests: `superagent ask` writes them, `superagent messages` reads the agent's replies.

import { LocalThreads, LOCAL } from '../sources/local.mjs'
import { openStore } from '../store.mjs'
import { UserError } from '../words.mjs'

const TICKET = /^T\d+$/
const REQUEST = /^R\d+$/

// A follow-up on a ticket goes to its local thread, which it then follows.
function ticketThread(store, ticketId) {
  const ticket = store.ticket(ticketId)
  const existing = ticket.threads.find((k) => k.startsWith(`${LOCAL}:`))
  if (existing) return existing.slice(LOCAL.length + 1)
  ticket.threads.push(`${LOCAL}:${ticketId}`)
  store.saveTicket(ticket)
  return ticketId
}

function requestThread(threads, id) {
  if (!threads.threads().includes(id)) throw new UserError(`No local request ${id}.`)
  return id
}

// superagent ask "<text>"            a new request
// superagent ask T3|R2 "<text>"      a follow-up, an answer, or "stop" on a ticket or request
export function ask(positional) {
  const store = openStore()
  store.config()
  const threads = new LocalThreads(store)
  const [first, ...rest] = positional
  const target = TICKET.test(first ?? '') ? ticketThread(store, first) : REQUEST.test(first ?? '') ? requestThread(threads, first) : null
  const text = (target ? rest : positional).join(' ').trim()
  if (!text) throw new UserError('ask needs the request text.')
  const message = target ? threads.append(target, 'you', text) : threads.newRequest(text)
  return { thread: `${LOCAL}:${message.thread}`, message: message.id, next: 'Run /superagent:run to pick it up.' }
}

function ticketByThread(store) {
  const map = {}
  for (const t of store.tickets()) for (const k of t.threads) if (k.startsWith(`${LOCAL}:`)) map[k.slice(LOCAL.length + 1)] = t.id
  return map
}

// The agent's replies on local threads; by default only unread ones, which this marks read.
export function messages(opts) {
  const store = openStore()
  const threads = new LocalThreads(store)
  const state = threads.state()
  const tickets = ticketByThread(store)
  const out = []
  for (const thread of threads.threads()) {
    const all = threads.messages(thread)
    const from = opts.all ? 0 : (state.read[thread] ?? 0)
    for (const m of all.slice(from)) if (m.from === 'agent') out.push({ thread, ticket: tickets[thread] ?? null, at: m.at, text: m.text })
    state.read[thread] = all.length
  }
  threads.saveState(state)
  return out.sort((a, b) => a.at.localeCompare(b.at))
}
