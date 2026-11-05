// superagent poll: read what is new on every source, deliver it to subscribed tickets,
// and write candidate cards for the router. Prints a JSON summary.

import { execFileSync } from 'node:child_process'
import { canInstruct, classify, referencedTickets, subscribers, windowAround } from '../domain.mjs'
import { openContext } from '../context.mjs'
import { nativeOf, sourceNameOf } from '../sources/common.mjs'
import { assertNotCommitted, writeJson } from '../store.mjs'

// Our clock and a forge's differ, and new items can take a moment to list:
// look back a little and let the seen ledger drop repeats.
const LOOKBACK_MS = 10 * 60 * 1000

// Each source keeps its own cursor, so one that fails is read again from where it stopped.
function sinceFor(ledger, name) {
  return new Date(Date.parse(ledger.cursors?.[name] ?? ledger.cursor) - LOOKBACK_MS).toISOString()
}

// Initial history is context only: nothing created before setup, or before its source joined, is new work.
function afterSetup(ledger, config) {
  return (trigger) => trigger.at >= (config.sources[trigger.source]?.added ?? ledger.started ?? '')
}

function deliver(ctx, ticket, trigger) {
  const { store, out } = ctx
  store.pushInput(ticket.id, { type: 'trigger', trigger })
  if (!trigger.bot) {
    ticket.person_message_since = trigger.at
    // A person's message on an ended ticket resumes it, unless a person stopped it.
    if (ticket.state === 'ended') ticket.state = 'open'
    out.follow_ups.push({ trigger_id: trigger.id, author: trigger.author, url: trigger.url, tickets: [ticket.id] })
  }
  // Bots and CI never wake an ended ticket; their input waits for the next resume.
  if (ticket.state !== 'open') return
  if (ticket.assignment !== 'running') ticket.assignment = 'pending'
  out.wake.add(ticket.id)
}

function brief(t) {
  return { id: t.id, title: t.title, state: t.state, stopped: Boolean(t.stopped), change: t.change ?? null }
}

async function card(ctx, trigger, strength) {
  const source = ctx.sources.get(trigger.source)
  const card = {
    trigger_id: trigger.id,
    strength,
    trigger,
    thread: { key: trigger.thread, ...(await source.thread(trigger)) },
    thread_tickets: subscribers(ctx.tickets, trigger.thread).map(brief),
    referenced_tickets: referencedTickets(trigger.text, source.references(trigger.text), ctx.tickets),
  }
  if (strength === 'proactive') card.window = windowAround(await source.window(trigger), trigger.id)
  return card
}

async function routeTrigger(ctx, trigger) {
  const { config, ledger, tickets, out } = ctx
  if (ledger.seen[trigger.id]) return
  const result = classify(trigger, config.sources[trigger.source], config, tickets)
  // Keep the trigger itself where a later handback or route needs it.
  const keep = result.disposition === 'candidate' || result.disposition === 'delivered'
  ledger.seen[trigger.id] = { at: trigger.at, ...result, ...(keep ? { trigger } : {}) }
  if (result.disposition === 'delivered') {
    for (const id of result.tickets) deliver(ctx, tickets.find((t) => t.id === id), trigger)
    followUpCard(ctx, trigger, result.tickets)
  } else if (result.disposition === 'candidate') {
    out.candidates.push(await card(ctx, trigger, result.strength))
  }
}

// A person who may instruct the agent can stop a ticket from its own thread. Upstream lets the
// orchestrator act on such a follow-up only to stop; the card lets the router decide that.
function followUpCard(ctx, trigger, ticketIds) {
  if (trigger.bot || !canInstruct(trigger, ctx.config.sources[trigger.source])) return
  ctx.ledger.seen[trigger.id].follow_up = true
  ctx.out.candidates.push({ trigger_id: trigger.id, strength: 'follow_up', follow_up_of: ticketIds, trigger })
}

const firstLine = (error) => String(error.message).split(/\r?\n/)[0]

async function readSource(ctx, source, started) {
  const open = ctx.tickets.filter((t) => t.state === 'open')
  const followed = open.flatMap((t) => t.threads).filter((k) => sourceNameOf(k) === source.name).map(nativeOf)
  const changes = open.filter((t) => t.change?.source === source.name).map((t) => t.change.number)
  const triggers = await source.poll({ since: sinceFor(ctx.ledger, source.name), followed, changes })
  ctx.ledger.cursors = { ...ctx.ledger.cursors, [source.name]: started }
  return triggers
}

// One failing source (a forge that is down, an expired token) never stops the others.
async function readSources(ctx, started) {
  const triggers = []
  for (const source of ctx.sources.values()) {
    try {
      triggers.push(...(await readSource(ctx, source, started)))
    } catch (error) {
      ctx.out.errors.push({ source: source.name, message: firstLine(error) })
    }
  }
  return triggers.filter(afterSetup(ctx.ledger, ctx.config)).sort((a, b) => a.at.localeCompare(b.at))
}

function endTicket(ctx, ticket, reason, notice) {
  Object.assign(ticket, { state: 'ended', ended_reason: reason })
  ctx.out.notices.push({ ticket: ticket.id, reason, ...notice })
}

// A change request that merged or closed ends its ticket; changed CI is delivered to it.
async function checkChange(ctx, ticket) {
  const source = ctx.sources.get(ticket.change.source)
  const change = await source.change(ticket.change.number)
  if (change.state !== 'open') return endTicket(ctx, ticket, `${ticket.change.source} change ${ticket.change.number} ${change.state}`, { url: change.url })
  if (change.fingerprint === ticket.ci_fingerprint) return
  ticket.ci_fingerprint = change.fingerprint
  const thread = `${source.name}:${source.changeThread(ticket.change.number)}`
  deliver(ctx, ticket, { id: `ci:${change.fingerprint}`, source: source.name, kind: 'ci', thread, bot: true, at: new Date().toISOString(), text: (change.checks ?? []).join('\n') })
}

// A ticket delivered as a local branch ends once a person merges that branch into the base branch.
function checkBranch(ctx, ticket) {
  if (ticket.reports.at(-1)?.state !== 'ready') return
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ticket.branch, ctx.config.baseBranch], { cwd: ctx.store.root, stdio: 'ignore' })
    endTicket(ctx, ticket, `branch ${ticket.branch} merged into ${ctx.config.baseBranch}`, {})
  } catch {
    // Not merged yet.
  }
}

async function checkDelivery(ctx, ticket) {
  if (ticket.change && ctx.sources.has(ticket.change.source)) await checkChange(ctx, ticket)
  else if (ticket.delivery === 'branch') checkBranch(ctx, ticket)
}

async function checkDeliveries(ctx) {
  for (const ticket of ctx.tickets.filter((t) => t.state === 'open')) {
    try {
      await checkDelivery(ctx, ticket)
    } catch (error) {
      ctx.out.errors.push({ source: ticket.change?.source, ticket: ticket.id, message: firstLine(error) })
    }
  }
}

function pendingHandbacks(ledger) {
  return Object.entries(ledger.seen)
    .filter(([, s]) => s.disposition === 'candidate' && s.handed_back && !s.decided)
    .map(([id, s]) => ({ trigger_id: id, strength: 'explicit', handed_back: s.handed_back, trigger: s.trigger }))
}

export async function poll() {
  const ctx = { ...openContext(), out: { candidates: [], follow_ups: [], notices: [], errors: [], wake: new Set() } }
  const { store, ledger, tickets, out } = ctx
  assertNotCommitted(store.root)
  const started = new Date().toISOString()

  for (const trigger of await readSources(ctx, started)) await routeTrigger(ctx, trigger)
  await checkDeliveries(ctx)
  out.candidates.push(...pendingHandbacks(ledger))

  for (const ticket of tickets) store.saveTicket(ticket)
  ledger.cursor = started
  store.saveLedger(ledger)

  let candidatesFile = null
  if (out.candidates.length) {
    candidatesFile = store.path('inbox', `candidates-${started.replace(/[:.]/g, '-')}.json`)
    writeJson(candidatesFile, out.candidates)
  }
  return { candidates: out.candidates.length, candidates_file: candidatesFile, follow_ups: out.follow_ups, notices: out.notices, errors: out.errors, wake: [...out.wake] }
}
