// The Source registry: which kinds exist, and opening the sources a repository configures.

import * as bitbucket from './bitbucket.mjs'
import * as github from './github.mjs'
import * as gitlab from './gitlab.mjs'
import * as local from './local.mjs'
import { sourceNameOf } from './common.mjs'
import { UserError } from '../words.mjs'

export const KINDS = { local, github, gitlab, bitbucket }
export const FORGE_KINDS = ['github', 'gitlab', 'bitbucket']

export function kindModule(kind) {
  const module = KINDS[kind]
  if (!module) throw new UserError(`Unknown source kind ${kind}. Use one of: ${FORGE_KINDS.join(', ')}.`)
  return module
}

export function openSources(store, config) {
  const sources = new Map()
  for (const [name, conf] of Object.entries(config.sources)) {
    if (conf.enabled === false) continue
    sources.set(name, kindModule(conf.kind).open(name, conf, store))
  }
  return sources
}

export function sourceFor(sources, key) {
  const source = sources.get(sourceNameOf(key))
  if (!source) throw new UserError(`No enabled source for ${key}.`)
  return source
}

export function forgeNames(config) {
  return Object.entries(config.sources).filter(([, c]) => c.kind !== 'local' && c.enabled !== false).map(([n]) => n)
}
