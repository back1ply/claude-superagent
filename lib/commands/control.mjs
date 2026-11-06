// superagent pause | resume: the processing pause. While paused, polls still record what arrives and
// deliver it to tickets, but nothing is routed and no worker starts; deferred candidates come back on resume.
// superagent dispatch: which tickets may start a worker now, within the worker limit.

import { openContext } from '../context.mjs'
import { openStore } from '../store.mjs'

export const DEFAULT_MAX_WORKERS = 3

// A person's message or a status request may use one extra slot, so new work never blocks a person.
const URGENT = ['person', 'status']

function setPaused(paused) {
  const store = openStore()
  const config = store.config()
  config.paused = paused
  store.saveConfig(config)
  return { paused }
}

export const pause = () => setPaused(true)
export const resume = () => setPaused(false)

function byPriority(a, b) {
  return Number(URGENT.includes(b.wake)) - Number(URGENT.includes(a.wake)) || a.created.localeCompare(b.created)
}

// Claims a slot for each ticket it returns in `start`: the caller starts one worker for each.
// With --session-start it also returns, in `resume`, tickets left running by an earlier session.
export function dispatch(opts) {
  const { store, config, tickets } = openContext()
  if (config.paused) return { paused: true, start: [], resume: [] }
  const max = config.maxWorkers ?? DEFAULT_MAX_WORKERS
  const open = tickets.filter((t) => t.state === 'open')
  const running = open.filter((t) => t.assignment === 'running')
  let used = running.length
  const start = []
  const queued = []
  for (const ticket of open.filter((t) => t.assignment === 'pending').sort(byPriority)) {
    const limit = URGENT.includes(ticket.wake) ? max + 1 : max
    if (used >= limit) {
      queued.push(ticket.id)
      continue
    }
    Object.assign(ticket, { assignment: 'running', wake: null })
    store.saveTicket(ticket)
    used += 1
    start.push(ticket.id)
  }
  return { max_workers: max, running: used, start, resume: opts['session-start'] ? running.map((t) => t.id) : [], queued }
}
