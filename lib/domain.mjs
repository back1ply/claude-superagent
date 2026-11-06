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

// Who wrote a trigger, as the allowed list and the account name them.
// Bitbucket names people by account_id (author_id); the other forges by login.
function actor(trigger) {
  return trigger.author_id ?? trigger.author
}

function isOwn(trigger, sourceConf) {
  if (!sourceConf.account || sourceConf.acceptOwn) return false
  return actor(trigger).toLowerCase() === sourceConf.account.toLowerCase()
}

// Whether this person may give the agent instructions here: locally you, on a forge the allowed list.
export function canInstruct(trigger, sourceConf) {
  return sourceConf.kind === 'local' || isAllowed(actor(trigger), sourceConf.allowed ?? [])
}

function isExplicit(trigger, sourceConf) {
  if (sourceConf.kind === 'local') return true
  return mentions(trigger.text, sourceConf.mention) && canInstruct(trigger, sourceConf)
}

// Revalidation before resume (upstream docs/002): an ended ticket's mandate must still hold.
// Its source must still be enabled. An explicit mandate needs its requester still allowed there;
// a proactive one needs auto mode and every matched rule still enabled.
export function mandateValid(ticket, config) {
  const requester = ticket.source
  const sourceConf = config.sources[requester.source]
  if (!sourceConf || sourceConf.enabled === false) return false
  if (ticket.strength !== 'proactive') return canInstruct(requester, sourceConf)
  const enabled = new Set(enabledRules(config, requester.source).map((r) => r.id))
  return config.policy?.mode === 'auto' && (ticket.matched_rules ?? []).every((id) => enabled.has(id))
}

// Tickets that can still receive a thread's messages: open ones, and ended ones whose mandate holds.
function receivers(tickets, config) {
  return tickets.filter((t) => t.state === 'open' || mandateValid(t, config))
}

// What happens to one new trigger. Returns { disposition, tickets?, strength? }.
export function classify(trigger, sourceConf, config, tickets) {
  if (isOwn(trigger, sourceConf)) return { disposition: 'own' }
  const subscribed = subscribers(receivers(tickets, config), trigger.thread)
  if (subscribed.length) return { disposition: 'delivered', tickets: subscribed.map((t) => t.id) }
  if (trigger.bot) return { disposition: 'bot' }
  if (isExplicit(trigger, sourceConf)) return { disposition: 'candidate', strength: 'explicit' }
  if (enabledRules(config, trigger.source).length) return { disposition: 'candidate', strength: 'proactive' }
  return { disposition: 'filtered' }
}

// Enabled rules, optionally limited to the sources a rule names.
export function enabledRules(config, sourceName) {
  const applies = (r) => !sourceName || !r.sources || r.sources.includes(sourceName)
  return (config.policy?.rules ?? []).filter((r) => r.enabled && applies(r))
}

// Tickets a text names: by ticket id (T3), or through the thread keys its source found in it.
export function referencedTickets(text, threadKeys, tickets) {
  const keys = new Set(threadKeys)
  const ids = new Set([...String(text).matchAll(/\bT(\d+)\b/g)].map((m) => `T${m[1]}`))
  return tickets.filter((t) => ids.has(t.id) || t.threads.some((th) => keys.has(th))).map((t) => t.id)
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
