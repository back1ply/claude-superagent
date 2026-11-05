// Pure rules: how a trigger is routed, and what stage a ticket is in.
// No I/O here, so these are the parts the tests cover.

export const REPORT_STATES = ['progress', 'ready', 'blocked', 'failed', 'dropped']

// Stage table from upstream docs/003-execution.md; the first matching row wins.
export function stageOf(ticket) {
  if (ticket.state === 'ended') return ticket.stopped ? 'ended / stopped' : 'ended'
  return personStage(ticket) ?? workStage(ticket.assignment)
}

// The rows where the ticket cannot continue without a person.
function personStage(ticket) {
  if (ticket.attention) return 'person / answer'
  const last = ticket.reports?.at(-1)?.state
  if (last === 'ready') return 'person / review'
  // A person's message since a blocked or failed report releases it to its worker.
  if (HANDOFF_STATES.includes(last) && !ticket.person_message_since) return `person / ${last}`
  return null
}

const HANDOFF_STATES = ['blocked', 'failed']
const WORK_STAGES = { pending: 'working / queued', ended: 'idle', running: 'working' }

function workStage(assignment) {
  return WORK_STAGES[assignment ?? 'pending'] ?? 'working'
}

export function needsPerson(ticket) {
  return stageOf(ticket).startsWith('person')
}

export function subscribers(tickets, thread) {
  return tickets.filter((t) => !t.stopped && t.threads.includes(thread))
}

export function mentions(text, mention) {
  return String(text).toLowerCase().includes(String(mention).toLowerCase())
}

export function isAllowed(login, allowed) {
  const name = login.toLowerCase()
  return allowed.some((a) => a === '*' || a.toLowerCase() === name)
}

// What happens to one new trigger. Returns { disposition, tickets? , strength? }.
export function classify(trigger, config, tickets) {
  if (trigger.author.toLowerCase() === config.account.toLowerCase() && !config.acceptOwn) {
    return { disposition: 'own' }
  }
  const subscribed = subscribers(tickets, trigger.thread)
  if (subscribed.length) return { disposition: 'delivered', tickets: subscribed.map((t) => t.id) }
  if (trigger.bot) return { disposition: 'bot' }
  if (mentions(trigger.text, config.mention) && isAllowed(trigger.author, config.allowed)) {
    return { disposition: 'candidate', strength: 'explicit' }
  }
  if (enabledRules(config).length) return { disposition: 'candidate', strength: 'proactive' }
  return { disposition: 'filtered' }
}

export function enabledRules(config) {
  return (config.policy?.rules ?? []).filter((r) => r.enabled)
}

// Tickets whose PR or Issue a text names (#12, or a /issues/12 or /pull/12 link).
export function referencedTickets(text, tickets) {
  const numbers = new Set()
  for (const m of String(text).matchAll(/(?:#|\/(?:issues|pull)\/)(\d+)/g)) numbers.add(`#${m[1]}`)
  return tickets.filter((t) => t.threads.some((th) => numbers.has(th))).map((t) => t.id)
}

// The window a proactive assessment reads: first five thread messages and five either side of the trigger.
export function windowAround(messages, triggerId) {
  const index = messages.findIndex((m) => m.id === triggerId)
  const keep = new Set([0, 1, 2, 3, 4])
  for (let i = index - 5; i <= index + 5; i++) if (i >= 0) keep.add(i)
  return messages.map((m, i) => (keep.has(i) ? m : { id: m.id, author: m.author, at: m.at, stub: true }))
}

export function worktreeNameOk(name) {
  return /^[a-z0-9][a-z0-9-]{1,40}$/.test(name ?? '')
}
