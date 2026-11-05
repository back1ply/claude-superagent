// The only place that posts to GitHub on the host's behalf (acks and orchestrator replies).
// Adds the automated-agent banner, enforces the 100-word ceiling and dedupes resends.

import crypto from 'node:crypto'
import { postIssueComment, postReviewReply } from './github.mjs'
import { assertWordLimit } from './words.mjs'

export const DEFAULT_BANNER = 'This is by an automated agent, not a human.'
export const MESSAGE_WORD_LIMIT = 100

export function withBanner(config, text) {
  const banner = config.banner ?? DEFAULT_BANNER
  return text.startsWith(banner) ? text : `${banner}\n\n${text}`
}

// Where a reply to a trigger goes: its review thread for a review comment, else its issue/PR conversation.
export function targetOf(trigger) {
  if (trigger.kind === 'review_comment') return { number: trigger.number, reviewRoot: trigger.review_root }
  return { number: trigger.number }
}

// Returns { status: 'sent' | 'duplicate' | 'dry-run', url? }.
export function send(store, ledger, { key, target, text }) {
  assertWordLimit(text, MESSAGE_WORD_LIMIT, 'The message')
  const config = store.config()
  const hash = crypto.createHash('sha256').update(`${key}\n${text}`).digest('hex').slice(0, 16)
  if (ledger.sent[hash]) return { status: 'duplicate', url: ledger.sent[hash].url }

  const body = withBanner(config, text)
  let url = null
  if (config.send) {
    const posted = target.reviewRoot
      ? postReviewReply(config.repo, target.number, target.reviewRoot, body)
      : postIssueComment(config.repo, target.number, body)
    url = posted?.html_url ?? null
  }
  store.appendLog('outbox.jsonl', { key, target, body, sent: Boolean(config.send), url })
  ledger.sent[hash] = { key, url, at: new Date().toISOString() }
  return { status: config.send ? 'sent' : 'dry-run', url }
}
