// superagent route <decisions.json>: apply the router's decisions, one item per candidate.
// The host rechecks every decision here; the router's word is not trusted on its own.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { enabledRules, worktreeNameOk } from '../domain.mjs'
import { openContext } from '../context.mjs'
import { send } from '../messages.mjs'
import { assertWordLimit, UserError } from '../words.mjs'

const NOTE_WORD_LIMIT = 30
const ACCEPTABLE_TARGETS = ['specified', 'existing-standard']

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

// Where a ticket's work starts: a forge delivery starts from that forge's remote base,
// a local branch delivery from the local base branch, with no network.
function startPoint(root, config, delivery) {
  if (delivery === 'branch') return config.baseBranch
  const remote = config.sources[delivery].remote ?? 'origin'
  const base = config.sources[delivery].baseBranch ?? config.baseBranch
  git(root, ['fetch', remote, base])
  return `${remote}/${base}`
}

function createWorktree(root, config, name, delivery) {
  const dir = path.resolve(root, config.workRoot, name)
  const branch = `superagent/${name}`
  if (fs.existsSync(dir)) return { dir, branch }
  const start = startPoint(root, config, delivery)
  const branchExists = git(root, ['branch', '--list', branch]) !== ''
  git(root, ['worktree', 'add', ...(branchExists ? [dir, branch] : ['-b', branch, dir, start])])
  return { dir, branch }
}

// A forge request is delivered on that forge; a local one as the local source's `deliver` says.
function deliveryFor(config, trigger) {
  const conf = config.sources[trigger.source]
  return conf.kind === 'local' ? (conf.deliver ?? 'branch') : trigger.source
}

function ensure(condition, message) {
  if (!condition) throw new UserError(message)
}

// Accept only when implementation was requested, the target is settled and no design decision remains.
function directionSettled(direction = {}) {
  const requested = Boolean(direction.implementation_requested)
  const settled = ACCEPTABLE_TARGETS.includes(direction.target_basis)
  return requested && settled && !direction.requires_design_decision
}

function matchedRules(config, assessments = []) {
  const ids = enabledRules(config).map((r) => r.id).sort()
  const assessed = assessments.map((a) => a.rule_id).sort()
  ensure(ids.join() === assessed.join(), 'rule_assessments must hold exactly one entry per enabled rule.')
  return assessments.filter((a) => a.matched).map((a) => a.rule_id)
}

function checkProactive(config, d) {
  ensure(d.intent_evidence, 'A proactive accept needs intent_evidence.')
  ensure(directionSettled(d.direction), 'A proactive accept needs implementation_requested, a specified or existing-standard target, and no open design decision.')
  const matched = matchedRules(config, d.rule_assessments)
  ensure(matched.length, 'A proactive accept needs at least one matched rule.')
  return matched
}

// Returns the matched rules, or null when observe mode only records the judgement.
function checkAccept(config, d, strength) {
  ensure(d.title && worktreeNameOk(d.worktree_name), 'accept needs a title and a short English worktree_name (a-z, 0-9, -).')
  if (strength !== 'proactive') {
    ensure(d.acknowledgement, 'An explicit accept needs an acknowledgement naming the change.')
    return []
  }
  const matched = checkProactive(config, d)
  return config.policy.mode === 'auto' ? matched : null
}

async function accept(ctx, d, seen) {
  const { store, config, ledger, tickets } = ctx
  const existing = tickets.find((t) => t.source.id === d.trigger_id)
  if (existing) return { ticket: existing.id, status: 'already accepted' }
  const rules = checkAccept(config, d, seen.strength)
  if (!rules) return { status: 'observed', would_accept: d.title }

  ledger.seq += 1
  const id = `T${ledger.seq}`
  const delivery = deliveryFor(config, seen.trigger)
  const { dir, branch } = createWorktree(store.root, config, d.worktree_name, delivery)
  const ticket = {
    id, title: d.title, state: 'open', created: new Date().toISOString(),
    source: seen.trigger, note: d.note ?? null, strength: seen.strength, matched_rules: rules,
    dir, branch, delivery, threads: [seen.trigger.thread], change: null,
    assignment: 'pending', reports: [], attention: null, acks: [],
  }
  if (d.acknowledgement) await ack(ctx, ticket, seen.trigger, d.acknowledgement)
  tickets.push(ticket)
  store.saveTicket(ticket)
  return { ticket: id, status: 'accepted', dir }
}

export async function ack(ctx, ticket, trigger, text) {
  const { ledger } = ctx
  if (ledger.acks[trigger.id]) return { status: 'duplicate' }
  const result = await send(ctx, { key: `ack:${trigger.id}`, trigger, text })
  ledger.acks[trigger.id] = { ticket: ticket.id, text }
  ticket.acks.push(trigger.id)
  return result
}

function attach(ctx, d, seen) {
  const ticket = ctx.store.ticket(d.ticket_id)
  if (ticket.stopped) throw new UserError(`${ticket.id} was stopped by a person; new work there needs an accept.`)
  if (seen.handed_back?.some((h) => h.ticket === ticket.id)) throw new UserError('Never attach a trigger back to the ticket that handed it back.')
  if (!ticket.threads.includes(seen.trigger.thread)) ticket.threads.push(seen.trigger.thread)
  ticket.state = 'open'
  ticket.person_message_since = seen.trigger.at
  if (ticket.assignment !== 'running') ticket.assignment = 'pending'
  ctx.store.pushInput(ticket.id, { type: 'trigger', trigger: seen.trigger, note: d.note ?? null })
  ctx.store.saveTicket(ticket)
  return { ticket: ticket.id, status: 'attached' }
}

function stop(ctx, d) {
  const ticket = ctx.store.ticket(d.ticket_id)
  Object.assign(ticket, { state: 'ended', stopped: true, ended_reason: `stopped by ${d.trigger_id}` })
  ctx.store.saveTicket(ticket)
  return { ticket: ticket.id, status: 'stopped' }
}

const HANDLERS = {
  accept,
  attach,
  stop,
  ignore: (ctx, d) => {
    if (!d.reason) throw new UserError('ignore needs a reason.')
    return { status: 'ignored' }
  },
  unavailable: (ctx, d) => ({ status: 'unavailable', reason: d.reason }),
}

// A person's follow-up already reached its tickets; the orchestrator may act on it only to stop one of them.
function checkFollowUp(seen, d) {
  if (!['stop', 'ignore'].includes(d.kind)) throw new UserError('A follow-up can only stop one of its tickets, or be ignored.')
  if (d.kind === 'stop' && !seen.tickets.includes(d.ticket_id)) throw new UserError(`${d.trigger_id} did not reach ${d.ticket_id}.`)
}

function waiting(seen, d) {
  if (seen?.disposition === 'candidate') return
  if (seen?.disposition === 'delivered' && seen.follow_up) return checkFollowUp(seen, d)
  throw new UserError(`${d.trigger_id} is not a waiting candidate.`)
}

async function decide(ctx, d) {
  const seen = ctx.ledger.seen[d.trigger_id]
  waiting(seen, d)
  // Decisions are idempotent by trigger ID: a repeat returns the first result.
  if (seen.decided) return { ...seen.decision.result, repeat_of: seen.decided }
  const handler = HANDLERS[d.kind]
  if (!handler) throw new UserError(`Unknown kind ${d.kind}.`)
  if (d.note) assertWordLimit(d.note, NOTE_WORD_LIMIT, 'The routing note')
  const result = await handler(ctx, d, seen)
  seen.decided = d.kind
  seen.decision = { ...d, result }
  return result
}

export async function route(file) {
  if (!file) throw new UserError('route needs a decisions JSON file.')
  const ctx = openContext()
  const { store } = ctx
  const decisions = JSON.parse(fs.readFileSync(file, 'utf8'))
  const results = []
  for (const d of decisions) {
    try {
      results.push({ trigger_id: d.trigger_id, kind: d.kind, ...(await decide(ctx, d)) })
    } catch (error) {
      if (!(error instanceof UserError)) throw error
      results.push({ trigger_id: d.trigger_id, kind: d.kind, refused: error.message })
    }
    store.saveLedger(ctx.ledger)
  }
  const dispatch = store.tickets().filter((t) => t.state === 'open' && t.assignment === 'pending').map((t) => ({ ticket: t.id, dir: t.dir }))
  return { results, dispatch }
}
