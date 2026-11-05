// Helpers every Source shares.
//
// A Source turns one place people talk (local requests, a GitHub repo, a GitLab project, a Bitbucket repo)
// into Triggers, and sends replies back. Every persisted id is `<source name>:<native id>`, so two
// sources of the same kind can live side by side.
//
// A Source instance has:
//   name, kind, forge (false only for local)
//   poll({ since, followed, changes }) -> Trigger[]
//       followed: native thread ids open tickets follow here; changes: their PR/MR numbers here
//   thread(trigger)             -> { title, state }
//   window(trigger)             -> messages of the trigger's thread, oldest first
//   references(text)            -> thread keys the text names
//   changeThread(number)        -> native thread id of a change request (PR/MR) number
//   change(number)              -> { state: open|merged|closed, fingerprint, url }
//   reply(address, body)        -> { url }
//   describe()                  -> what a worker needs to know, including the skill to load

import { execFileSync } from 'node:child_process'

const TEXT_CUT = 4000

export function cut(text) {
  const body = String(text ?? '')
  return body.length > TEXT_CUT ? { text: body.slice(0, TEXT_CUT), cut_from: body.length } : { text: body }
}

export function keyed(name, native) {
  return `${name}:${native}`
}

export function nativeOf(key) {
  return key.slice(key.indexOf(':') + 1)
}

export function sourceNameOf(key) {
  return key.slice(0, key.indexOf(':'))
}

// Thread keys a text names, from [pattern, native-id builder] pairs.
export function matchReferences(name, text, patterns) {
  const keys = new Set()
  for (const [pattern, native] of patterns) {
    for (const m of String(text).matchAll(pattern)) keys.add(keyed(name, native(m.slice(1).find(Boolean))))
  }
  return [...keys]
}

// Run a CLI, or the fake a test names in the given environment variable.
export function runCli(command, fakeEnv, args) {
  const options = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  const fake = process.env[fakeEnv]
  return fake ? execFileSync(process.execPath, [fake, ...args], options) : execFileSync(command, args, options)
}

export function parseJson(out) {
  const text = out.trim()
  return text ? JSON.parse(text) : null
}

export function parseLines(out) {
  return out.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
}

export function since(items, field, from) {
  return items.filter((item) => item[field] && item[field] >= from)
}
