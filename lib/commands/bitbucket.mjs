// superagent bitbucket-api: the workers' way to call Bitbucket Cloud (it has no official CLI).
// The rules a guard hook can only guess at for gh and glab are exact here:
// no merging or approving, writes only to the source's own repository, and posts carry the banner.

import fs from 'node:fs'
import { api } from '../sources/bitbucket.mjs'
import { DEFAULT_BANNER } from '../messages.mjs'
import { openStore } from '../store.mjs'
import { UserError } from '../words.mjs'

const FORBIDDEN = /\/(merge|approve|request-changes)(\/|\?|$)/

function pickSource(config, name) {
  const entries = Object.entries(config.sources).filter(([, c]) => c.kind === 'bitbucket')
  const found = name ? entries.find(([n]) => n === name) : entries[0]
  if (!found) throw new UserError(name ? `No bitbucket source named ${name}.` : 'No bitbucket source is configured.')
  return found[1]
}

function bodyOf(opts) {
  if (opts['json-file']) return JSON.parse(fs.readFileSync(opts['json-file'], 'utf8'))
  return opts.json ? JSON.parse(opts.json) : undefined
}

// Text a write publishes: comment content and PR or issue descriptions.
function publishedText(body) {
  return [body?.content?.raw, body?.description].filter((t) => typeof t === 'string')
}

function checkWrite(conf, banner, path, body) {
  const own = `repositories/${conf.workspace}/${conf.repo}`
  if (!`${path.replace(/^\//, '')}/`.startsWith(`${own}/`)) throw new UserError(`Writes go only to ${own}.`)
  if (FORBIDDEN.test(path)) throw new UserError('A person merges and approves; the worker never does.')
  if (publishedText(body).some((t) => !t.startsWith(banner))) throw new UserError(`Every Bitbucket message starts with this line: ${banner}`)
}

export async function bitbucketApi([path], opts) {
  if (!path) throw new UserError('bitbucket-api needs an API path such as repositories/<ws>/<repo>/pullrequests.')
  const config = openStore().config()
  const conf = pickSource(config, opts.source)
  const method = String(opts.method ?? 'GET').toUpperCase()
  const body = bodyOf(opts)
  if (method !== 'GET') checkWrite(conf, config.banner ?? DEFAULT_BANNER, path, body)
  return api(conf, path, { method, body })
}
