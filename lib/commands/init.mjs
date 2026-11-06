// superagent init: local-only setup, no network.
// superagent source add|remove|list: connect forges (GitHub, GitLab, Bitbucket Cloud).

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_BANNER } from '../messages.mjs'
import { DEFAULT_MAX_WORKERS } from './control.mjs'
import { FORGE_KINDS, kindModule } from '../sources/index.mjs'
import * as local from '../sources/local.mjs'
import { assertNotCommitted, openStore, repoRoot, Store } from '../store.mjs'
import { UserError } from '../words.mjs'

const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/

function git(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

function excludeStateDir(root) {
  const exclude = path.join(root, '.git', 'info', 'exclude')
  if (!fs.existsSync(path.dirname(exclude))) return
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : ''
  if (!current.split('\n').includes('/.superagent/')) fs.appendFileSync(exclude, '\n/.superagent/\n')
}

function checkDelivery(config, deliver) {
  if (deliver === 'branch' || FORGE_KINDS.includes(config.sources[deliver]?.kind)) return deliver
  throw new UserError(`--deliver must be "branch" or the name of a forge source (${Object.keys(config.sources).join(', ')}).`)
}

function currentBranch(root) {
  return git(root, ['symbolic-ref', '--short', 'HEAD']) || 'main'
}

// Commits default to the repository's own git identity.
function gitIdentity(root) {
  return {
    name: git(root, ['config', 'user.name']) || 'superagent',
    email: git(root, ['config', 'user.email']) || 'superagent@localhost',
  }
}

function workerLimit(value) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new UserError('--max-workers must be a whole number of at least 1.')
  return n
}

// Each option a later `init` can change, and how.
const OPTIONS = {
  send: (config, v) => { config.send = v === true || v === 'on' },
  deliver: (config, v) => { config.sources.local.deliver = checkDelivery(config, v) },
  'max-workers': (config, v) => { config.maxWorkers = workerLimit(v) },
  prepare: (config, v) => { config.prepare = v === 'none' || v === true ? null : v },
}

function applyOptions(config, opts) {
  for (const [key, apply] of Object.entries(OPTIONS)) if (opts[key] !== undefined) apply(config, opts[key])
}

export function init(opts) {
  const root = repoRoot()
  assertNotCommitted(root)
  const store = new Store(root)
  const previous = fs.existsSync(store.path('config.json')) ? store.config() : {}
  const config = {
    sources: { local: local.configure() },
    send: false,
    banner: DEFAULT_BANNER,
    workRoot: '.superagent/work',
    maxWorkers: DEFAULT_MAX_WORKERS,
    prepare: null,
    paused: false,
    policy: { mode: 'observe', rules: [] },
    ...previous,
    baseBranch: opts.base ?? previous.baseBranch ?? currentBranch(root),
    commitAuthor: previous.commitAuthor ?? gitIdentity(root),
  }
  applyOptions(config, opts)
  store.saveConfig(config)

  const ledger = store.ledger()
  // Initial history is context only: start listening from now.
  ledger.started ??= new Date().toISOString()
  ledger.cursor ??= ledger.started
  store.saveLedger(ledger)
  new local.LocalThreads(store).markExistingRequestFiles()
  excludeStateDir(root)
  return { config_file: store.path('config.json'), listening_since: ledger.started, config }
}

function splitList(value) {
  return String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

export async function sourceAdd(name, opts) {
  if (!NAME.test(name ?? '') || name === 'local') throw new UserError('source add needs a name (a-z, 0-9, -), other than "local".')
  if (!FORGE_KINDS.includes(opts.kind)) throw new UserError(`--kind must be one of ${FORGE_KINDS.join(', ')}.`)
  const store = openStore()
  const config = store.config()
  const allowed = splitList(opts.allowed)
  if (!allowed.length) throw new UserError('source add needs --allowed <who may give work, comma-separated, or *>.')
  const conf = await kindModule(opts.kind).configure(opts)
  config.sources[name] = {
    ...conf,
    allowed,
    acceptOwn: Boolean(opts['accept-own']),
    remote: opts.remote ?? 'origin',
    ...(opts.base ? { baseBranch: opts.base } : {}),
    // History before a source joins is context only.
    added: new Date().toISOString(),
  }
  store.saveConfig(config)
  return { source: name, ...config.sources[name] }
}

export function sourceRemove(name) {
  const store = openStore()
  const config = store.config()
  if (name === 'local' || !config.sources[name]) throw new UserError(`No forge source named ${name}.`)
  delete config.sources[name]
  if (config.sources.local.deliver === name) config.sources.local.deliver = 'branch'
  store.saveConfig(config)
  return { removed: name, sources: Object.keys(config.sources) }
}

export function sourceList() {
  const { sources } = openStore().config()
  return Object.entries(sources).map(([name, c]) => ({ name, ...c }))
}
