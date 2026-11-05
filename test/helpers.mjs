// Shared test setup: a throwaway repository and a runner for the superagent CLI.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

export const here = path.dirname(fileURLToPath(import.meta.url))
const cli = path.join(here, '..', 'bin', 'superagent')
const run = promisify(execFile)

export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const commitAll = (cwd, message) => git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', message)

// withRemote: a clone of a bare origin; otherwise a repository with no remote at all.
export function makeRepo({ withRemote = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-'))
  const repo = path.join(tmp, 'repo')
  if (withRemote) {
    const origin = path.join(tmp, 'origin.git')
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin)
    git(tmp, 'clone', '-q', origin, repo)
    commitAll(repo, 'init')
    git(repo, 'push', '-q', 'origin', 'main')
  } else {
    git(tmp, 'init', '-q', '-b', 'main', repo)
    commitAll(repo, 'init')
  }
  return { tmp, repo, commitAll: (msg) => commitAll(repo, msg) }
}

// A JSON file standing in for a forge's state, read and written by a fake CLI.
export function fakeState(tmp, initial) {
  const file = path.join(tmp, 'forge.json')
  fs.writeFileSync(file, JSON.stringify(initial))
  return {
    file,
    read: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    update(fn) {
      const s = this.read()
      fn(s)
      fs.writeFileSync(file, JSON.stringify(s))
    },
  }
}

export const later = (seconds = 60) => new Date(Date.now() + seconds * 1000).toISOString()

export function runner(repo, env = {}) {
  return async (...args) => {
    try {
      const { stdout } = await run(process.execPath, [cli, ...args], { cwd: repo, env: { ...process.env, ...env } })
      return JSON.parse(stdout)
    } catch (error) {
      return JSON.parse(error.stdout)
    }
  }
}

export function writeDecisions(repo, name, decisions) {
  const file = path.join(repo, '.superagent', 'inbox', name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(decisions))
  return file
}
