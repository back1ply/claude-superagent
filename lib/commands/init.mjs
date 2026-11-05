// superagent init: write .superagent/config.json and start listening from now.

import fs from 'node:fs'
import path from 'node:path'
import { ghJson } from '../github.mjs'
import { repoRoot, Store } from '../store.mjs'
import { DEFAULT_BANNER } from '../messages.mjs'
import { UserError } from '../words.mjs'

function excludeStateDir(root) {
  const exclude = path.join(root, '.git', 'info', 'exclude')
  if (!fs.existsSync(path.dirname(exclude))) return
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : ''
  if (!current.split('\n').includes('/.superagent/')) fs.appendFileSync(exclude, '\n/.superagent/\n')
}

function noreplyEmail(login) {
  const user = ghJson(['api', `users/${login}`, '--jq', '{id: .id}'])
  return `${user.id}+${login}@users.noreply.github.com`
}

export function init(opts) {
  if (!opts.repo || !opts.allowed) throw new UserError('init needs --repo <owner/name> and --allowed <login,login|*>.')
  const root = repoRoot()
  const store = new Store(root)
  const account = opts.account ?? ghJson(['api', 'user', '--jq', '{login: .login}']).login
  const repoInfo = ghJson(['repo', 'view', opts.repo, '--json', 'defaultBranchRef'])
  const previous = fs.existsSync(store.path('config.json')) ? store.config() : {}

  const config = {
    ...previous,
    repo: opts.repo,
    account,
    mention: opts.mention ?? `@${account}`,
    allowed: opts.allowed.split(',').map((s) => s.trim()).filter(Boolean),
    acceptOwn: Boolean(opts['accept-own']),
    send: Boolean(opts.send),
    baseBranch: repoInfo.defaultBranchRef.name,
    banner: previous.banner ?? DEFAULT_BANNER,
    commitAuthor: previous.commitAuthor ?? { name: account, email: noreplyEmail(account) },
    workRoot: previous.workRoot ?? '.superagent/work',
    policy: previous.policy ?? { mode: 'observe', rules: [] },
  }
  store.saveConfig(config)

  const ledger = store.ledger()
  // Initial history is context only: start listening from now.
  ledger.started ??= new Date().toISOString()
  ledger.cursor ??= ledger.started
  store.saveLedger(ledger)
  excludeStateDir(root)
  return { config_file: store.path('config.json'), listening_since: ledger.cursor, config }
}
