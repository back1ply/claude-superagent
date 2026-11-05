// superagent poll: read what is new on GitHub, deliver it to subscribed tickets,
// and write candidate cards for the router. Prints a JSON summary.

import { classify, referencedTickets, subscribers, windowAround } from '../domain.mjs'
import { fetchReviews, fetchTriggers, pullStatus, threadComments, threadTitle } from '../github.mjs'
import { openStore, writeJson } from '../store.mjs'

function deliver(store, ticket, trigger, out) {
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

// GitHub's clock and ours differ, and new items can take a moment to list:
// look back a little and let the seen ledger drop repeats.
const LOOKBACK_MS = 10 * 60 * 1000

function sinceFor(ledger) {
  return new Date(Date.parse(ledger.cursor) - LOOKBACK_MS).toISOString()
}

// Initial history is context only: nothing created before setup is new work.
function afterSetup(ledger) {
  return (trigger) => !ledger.started || trigger.at >= ledger.started
}

function card({ config, tickets, titles }, trigger, strength) {
  titles[trigger.number] ??= threadTitle(config.repo, trigger.number)
  const card = {
    trigger_id: trigger.id,
    strength,
    trigger,
    thread: { key: trigger.thread, ...titles[trigger.number] },
    thread_tickets: subscribers(tickets, trigger.thread).map(brief),
    referenced_tickets: referencedTickets(trigger.text, tickets),
  }
  if (strength === 'proactive') {
    card.window = windowAround(threadComments(config.repo, trigger.number), trigger.id)
  }
  return card
}

function brief(t) {
  return { id: t.id, title: t.title, state: t.state, stopped: Boolean(t.stopped), pr: t.pr ?? null }
}

function routeTrigger(ctx, trigger) {
  const { store, config, ledger, tickets, out } = ctx
  if (ledger.seen[trigger.id]) return
  const result = classify(trigger, config, tickets)
  // Keep the trigger itself where a later handback or route needs it.
  const keep = result.disposition === 'candidate' || result.disposition === 'delivered'
  ledger.seen[trigger.id] = { at: trigger.at, ...result, ...(keep ? { trigger } : {}) }
  if (result.disposition === 'delivered') {
    for (const id of result.tickets) deliver(store, tickets.find((t) => t.id === id), trigger, out)
  } else if (result.disposition === 'candidate') {
    out.candidates.push(card(ctx, trigger, result.strength))
  }
}

// PR merge/close ends its tickets; changed CI is delivered to them.
function checkPulls(ctx) {
  const { store, config, tickets, out } = ctx
  for (const ticket of tickets.filter((t) => t.pr && t.state === 'open')) {
    const pr = pullStatus(config.repo, ticket.pr)
    if (pr.state !== 'OPEN') {
      ticket.state = 'ended'
      ticket.ended_reason = `PR #${ticket.pr} ${pr.state.toLowerCase()}`
      out.notices.push({ ticket: ticket.id, pr: ticket.pr, state: pr.state, url: pr.url })
      continue
    }
    const checks = (pr.statusCheckRollup ?? []).map((c) => `${c.name ?? c.context}:${c.conclusion ?? c.state ?? c.status}`)
    const fingerprint = `${pr.headRefOid}|${checks.sort().join(',')}`
    if (fingerprint !== ticket.ci_fingerprint) {
      ticket.ci_fingerprint = fingerprint
      deliver(store, ticket, { id: `ci:${fingerprint}`, kind: 'ci', thread: `#${ticket.pr}`, bot: true, at: new Date().toISOString(), text: checks.join('\n') }, out)
    }
  }
}

function pendingHandbacks(ledger) {
  return Object.entries(ledger.seen)
    .filter(([, s]) => s.disposition === 'candidate' && s.handed_back && !s.decided)
    .map(([id, s]) => ({ trigger_id: id, strength: 'explicit', handed_back: s.handed_back, trigger: s.trigger }))
}

export function poll() {
  const store = openStore()
  const config = store.config()
  const ledger = store.ledger()
  const tickets = store.tickets()
  const started = new Date().toISOString()
  const out = { candidates: [], follow_ups: [], notices: [], wake: new Set() }
  const ctx = { store, config, ledger, tickets, out, titles: {} }

  const since = sinceFor(ledger)
  const triggers = fetchTriggers(config.repo, since)
  for (const t of tickets.filter((t) => t.pr && t.state === 'open')) {
    triggers.push(...fetchReviews(config.repo, t.pr, since))
  }
  for (const trigger of triggers.filter(afterSetup(ledger))) routeTrigger(ctx, trigger)
  checkPulls(ctx)
  out.candidates.push(...pendingHandbacks(ledger))

  for (const ticket of tickets) store.saveTicket(ticket)
  ledger.cursor = started
  store.saveLedger(ledger)

  let candidatesFile = null
  if (out.candidates.length) {
    candidatesFile = store.path('inbox', `candidates-${started.replace(/[:.]/g, '-')}.json`)
    writeJson(candidatesFile, out.candidates)
  }
  return {
    candidates: out.candidates.length,
    candidates_file: candidatesFile,
    follow_ups: out.follow_ups,
    notices: out.notices,
    wake: [...out.wake],
  }
}
