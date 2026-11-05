// The only place that posts on the host's behalf (acks and orchestrator replies), through the
// trigger's own source. Forge posts get the automated-agent banner; every message keeps the 100-word
// ceiling and is sent once.

import crypto from 'node:crypto'
import { assertWordLimit, UserError } from './words.mjs'

export const DEFAULT_BANNER = 'This is by an automated agent, not a human.'
export const MESSAGE_WORD_LIMIT = 100

export function withBanner(config, text) {
  const banner = config.banner ?? DEFAULT_BANNER
  return text.startsWith(banner) ? text : `${banner}\n\n${text}`
}

// Returns { status: 'sent' | 'duplicate' | 'dry-run', url? }.
// `send` off keeps forge posts in .superagent/outbox.jsonl; local replies never leave the machine anyway.
export async function send({ store, ledger, config, sources }, { key, trigger, text }) {
  assertWordLimit(text, MESSAGE_WORD_LIMIT, 'The message')
  const source = sources.get(trigger.source)
  if (!source) throw new UserError(`Source ${trigger.source} is not enabled; cannot reply there.`)
  const hash = crypto.createHash('sha256').update(`${key}\n${text}`).digest('hex').slice(0, 16)
  if (ledger.sent[hash]) return { status: 'duplicate', url: ledger.sent[hash].url }

  const body = source.forge ? withBanner(config, text) : text
  const live = !source.forge || Boolean(config.send)
  const url = live ? (await source.reply(trigger.address, body)).url : null
  store.appendLog('outbox.jsonl', { key, source: source.name, address: trigger.address, body, sent: live, url })
  ledger.sent[hash] = { key, url, at: new Date().toISOString() }
  return { status: live ? 'sent' : 'dry-run', url }
}
