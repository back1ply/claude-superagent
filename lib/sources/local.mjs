// Local Source: requests from `superagent ask` and from files in .superagent/requests/.
// No network. Each request is a thread R<n>; a ticket can also get its own thread T<n> for follow-ups.
// Messages live in .superagent/local/threads/<thread>.jsonl; the agent's replies are read with `superagent messages`.

import fs from 'node:fs'
import path from 'node:path'
import { cut, keyed, matchReferences } from './common.mjs'
import { readJson, writeJson } from '../store.mjs'

export const LOCAL = 'local'
const TITLE_LENGTH = 80

export class LocalThreads {
  constructor(store) {
    this.store = store
    this.dir = store.path('local', 'threads')
    this.stateFile = store.path('local', 'state.json')
  }

  state() {
    return readJson(this.stateFile, { seq: 0, files: {}, read: {} })
  }

  saveState(state) {
    writeJson(this.stateFile, state)
  }

  messages(thread) {
    const file = path.join(this.dir, `${thread}.jsonl`)
    if (!fs.existsSync(file)) return []
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  }

  threads() {
    if (!fs.existsSync(this.dir)) return []
    return fs.readdirSync(this.dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length))
  }

  append(thread, from, text, extra = {}) {
    fs.mkdirSync(this.dir, { recursive: true })
    const index = this.messages(thread).length + 1
    const message = { id: `${thread}:${index}`, thread, from, at: new Date().toISOString(), text, ...extra }
    fs.appendFileSync(path.join(this.dir, `${thread}.jsonl`), `${JSON.stringify(message)}\n`)
    return message
  }

  newRequest(text, extra = {}) {
    const state = this.state()
    state.seq += 1
    this.saveState(state)
    return this.append(`R${state.seq}`, 'you', text, extra)
  }

  requestFiles() {
    const folder = this.store.path('requests')
    return fs.existsSync(folder) ? fs.readdirSync(folder).filter((f) => f.endsWith('.md')).sort() : []
  }

  // Files already there at setup are not requests; only ones added later are.
  markExistingRequestFiles() {
    const state = this.state()
    for (const file of this.requestFiles()) state.files[file] ??= 'before-setup'
    this.saveState(state)
  }

  // Each new .md file in .superagent/requests/ becomes a request once; later edits are ignored.
  takeRequestFiles() {
    for (const file of this.requestFiles()) {
      if (this.state().files[file]) continue
      const message = this.newRequest(fs.readFileSync(path.join(this.store.path('requests'), file), 'utf8'), { file })
      const state = this.state()
      state.files[file] = message.thread
      this.saveState(state)
    }
  }
}

function titleOf(text) {
  const line = String(text).split('\n').find((l) => l.trim()) ?? ''
  return line.replace(/^#+\s*/, '').slice(0, TITLE_LENGTH)
}

export function configure() {
  return { kind: 'local', deliver: 'branch' }
}

export function open(name, conf, store) {
  const threads = new LocalThreads(store)
  const trigger = (m, index) => ({
    id: keyed(name, m.id),
    source: name,
    kind: index === 0 && m.thread.startsWith('R') ? 'request' : 'message',
    thread: keyed(name, m.thread),
    at: m.at,
    url: m.file ? `.superagent/requests/${m.file}` : null,
    author: 'you',
    bot: false,
    address: { thread: m.thread },
    ...(index === 0 ? { title: titleOf(m.text) } : {}),
    ...cut(m.text),
  })

  return {
    name,
    kind: 'local',
    forge: false,
    poll({ since: from }) {
      threads.takeRequestFiles()
      const fromYou = (m) => m.from === 'you' && m.at >= from
      return threads.threads().flatMap((t) => threads.messages(t).map((m, i) => (fromYou(m) ? trigger(m, i) : null)).filter(Boolean))
    },
    thread(t) {
      const first = threads.messages(t.address.thread)[0]
      return { title: titleOf(first?.text ?? ''), state: 'open' }
    },
    window(t) {
      return threads.messages(t.address.thread).map((m, i) => ({ ...trigger(m, i), author: m.from }))
    },
    references(text) {
      return matchReferences(name, text, [[/\bR(\d+)\b/g, (n) => `R${n}`]])
    },
    changeThread: () => null,
    change: () => null,
    reply(address, body) {
      const m = threads.append(address.thread, 'agent', body)
      return { url: `local:${m.id}` }
    },
    describe: () => ({ name, kind: 'local', deliver: conf.deliver ?? 'branch', skill: 'superagent:local' }),
  }
}
