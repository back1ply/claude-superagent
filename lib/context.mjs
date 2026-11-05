// Everything a command works with, loaded once.

import { openSources } from './sources/index.mjs'
import { openStore } from './store.mjs'

export function openContext() {
  const store = openStore()
  const config = store.config()
  return { store, config, ledger: store.ledger(), tickets: store.tickets(), sources: openSources(store, config) }
}

export function findTrigger(ledger, triggerId) {
  return ledger.seen[triggerId]?.trigger ?? null
}
