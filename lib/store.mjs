// State on disk, under <repo>/.superagent/. Every write is atomic (temp file + rename).

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { UserError } from './words.mjs'

export function repoRoot(cwd = process.cwd()) {
  // The common git dir is the same from the main checkout and from every ticket worktree.
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
  }).trim()
  return path.dirname(common)
}

export function stateDir(root) {
  return path.join(root, '.superagent')
}

export function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

export class Store {
  constructor(root) {
    this.root = root
    this.dir = stateDir(root)
  }

  path(...parts) {
    return path.join(this.dir, ...parts)
  }

  config() {
    const config = readJson(this.path('config.json'), null)
    if (!config) throw new UserError('No .superagent/config.json here. Run /superagent:setup first.')
    return config
  }

  saveConfig(config) {
    writeJson(this.path('config.json'), config)
  }

  ledger() {
    return readJson(this.path('ledger.json'), { cursor: null, seq: 0, seen: {}, acks: {}, sent: {} })
  }

  saveLedger(ledger) {
    writeJson(this.path('ledger.json'), ledger)
  }

  ticket(id) {
    const ticket = readJson(this.path('tickets', `${id}.json`), null)
    if (!ticket) throw new UserError(`Unknown ticket ${id}.`)
    return ticket
  }

  saveTicket(ticket) {
    writeJson(this.path('tickets', `${ticket.id}.json`), ticket)
  }

  tickets() {
    const dir = this.path('tickets')
    if (!fs.existsSync(dir)) return []
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson(path.join(dir, name)))
  }

  // Inputs waiting for a ticket's worker: one JSON object per line, appended by poll and route.
  pushInput(ticketId, input) {
    const file = this.path('inbox', `${ticketId}.jsonl`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify(input)}\n`)
  }

  countInputs(ticketId) {
    const file = this.path('inbox', `${ticketId}.jsonl`)
    if (!fs.existsSync(file)) return 0
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length
  }

  takeInputs(ticketId) {
    const file = this.path('inbox', `${ticketId}.jsonl`)
    if (!fs.existsSync(file)) return []
    const taken = `${file}.${process.pid}.taken`
    fs.renameSync(file, taken)
    const lines = fs.readFileSync(taken, 'utf8').split('\n').filter(Boolean)
    fs.rmSync(taken)
    return lines.map((line) => JSON.parse(line))
  }

  appendLog(name, entry) {
    const file = this.path(name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
  }
}

export function openStore(cwd) {
  return new Store(repoRoot(cwd))
}
