// What only shows up with concurrency, a failing forge, a stop from a person, or a hostile repository.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fakeState, git, here, later, makeRepo, runner, writeDecisions } from './helpers.mjs'

const tripwireEnv = (tmp) => ({ SUPERAGENT_GH: path.join(here, 'tripwire.mjs'), TRIPWIRE: path.join(tmp, 'tripwire') })

async function localTicket(sa, repo, text = 'Fix the footer date') {
  await sa('ask', text)
  await sa('poll')
  await sa('route', writeDecisions(repo, 'a.json', [{ trigger_id: 'local:R1:1', kind: 'accept', title: 'Fix footer', worktree_name: 'footer', acknowledgement: 'On it: fixing the footer date.' }]))
  return sa('assignment', 'T1')
}

test('a report made while a poll runs is not lost', async () => {
  const { tmp, repo } = makeRepo()
  const forge = fakeState(tmp, { comments: [], posts: [] })
  const env = { SUPERAGENT_GH: path.join(here, 'fake-gh.mjs'), FAKE_FORGE_STATE: forge.file }
  const sa = runner(repo, env)
  const slowSa = runner(repo, { ...env, FAKE_GH_SLEEP_MS: '1500' })
  await sa('init')
  await sa('source', 'add', 'github', '--kind', 'github', '--repo', 'o/r', '--allowed', 'alice', '--account', 'agent-bot')
  await localTicket(sa, repo)

  const polling = slowSa('poll')
  await new Promise((resolve) => setTimeout(resolve, 400))
  const reported = sa('report', 'T1', '--state', 'ready', '--summary', 'Done.')
  await Promise.all([polling, reported])
  const ticket = await sa('show', 'T1')
  assert.equal(ticket.reports.at(-1)?.state, 'ready', 'the report survived the poll')
  assert.equal(ticket.assignment, 'ended')
})

test('a failing forge does not stop the others', async () => {
  const { tmp, repo } = makeRepo()
  const sa = runner(repo, tripwireEnv(tmp))
  await sa('init')
  await sa('source', 'add', 'github', '--kind', 'github', '--repo', 'o/r', '--allowed', 'alice', '--account', 'agent-bot')
  await sa('ask', 'Fix the footer date')
  const polled = await sa('poll')
  assert.equal(polled.candidates, 1, 'the local request still arrives')
  assert.equal(polled.errors[0].source, 'github')
})

test('a person can stop a ticket from its own thread, and the stop holds', async () => {
  const { tmp, repo } = makeRepo({ withRemote: false })
  const sa = runner(repo, tripwireEnv(tmp))
  await sa('init')
  await localTicket(sa, repo)

  await sa('ask', 'T1', 'stop, I will do it myself')
  const polled = await sa('poll')
  const card = JSON.parse(fs.readFileSync(polled.candidates_file, 'utf8')).find((c) => c.strength === 'follow_up')
  assert.deepEqual(card.follow_up_of, ['T1'])
  const attach = await sa('route', writeDecisions(repo, 'f1.json', [{ trigger_id: card.trigger_id, kind: 'attach', ticket_id: 'T1' }]))
  assert.match(attach.results[0].refused, /can only stop/)
  const stop = await sa('route', writeDecisions(repo, 'f2.json', [{ trigger_id: card.trigger_id, kind: 'stop', ticket_id: 'T1' }]))
  assert.equal(stop.results[0].status, 'stopped')
  assert.equal((await sa('inbox', 'T1')).stopped, true)

  await sa('ask', 'T1', 'actually, also bold it')
  const after = await sa('poll')
  assert.deepEqual(after.wake, [], 'a later message does not resume a stopped ticket')
  assert.equal((await sa('tickets', '--all'))[0].stage, 'ended / stopped')
})

test('a stranger on a ticket thread cannot stop it', async () => {
  const { tmp, repo } = makeRepo()
  const forge = fakeState(tmp, { comments: [], posts: [] })
  const sa = runner(repo, { SUPERAGENT_GH: path.join(here, 'fake-gh.mjs'), FAKE_FORGE_STATE: forge.file })
  await sa('init')
  await sa('source', 'add', 'github', '--kind', 'github', '--repo', 'o/r', '--allowed', 'alice', '--account', 'agent-bot')
  const comment = (id, login, body) => forge.update((s) => {
    s.comments.push({ id, user: { login, type: 'User' }, body, html_url: `https://github.com/o/r/issues/5#issuecomment-${id}`, issue_url: 'https://api.github.com/repos/o/r/issues/5', created_at: later() })
  })
  comment(1, 'alice', '@agent-bot fix it')
  await sa('poll')
  await sa('route', writeDecisions(repo, 'a.json', [{ trigger_id: 'github:ic:1', kind: 'accept', title: 'Fix', worktree_name: 'fix', acknowledgement: 'On it: fixing it.' }]))
  comment(2, 'mallory', 'stop this')
  const polled = await sa('poll')
  assert.equal(polled.candidates, 0, 'no follow-up card for a stranger')
  const stop = await sa('route', writeDecisions(repo, 's.json', [{ trigger_id: 'github:ic:2', kind: 'stop', ticket_id: 'T1' }]))
  assert.match(stop.results[0].refused, /not a waiting candidate/)
})

test('a repository that commits .superagent/ is refused, and old request files are not requests', async () => {
  const hostile = makeRepo({ withRemote: false })
  fs.mkdirSync(path.join(hostile.repo, '.superagent'))
  fs.writeFileSync(path.join(hostile.repo, '.superagent', 'config.json'), '{"sources":{"local":{"kind":"local"}},"send":true}')
  git(hostile.repo, 'add', '-f', '.superagent/config.json')
  hostile.commitAll('ship a config')
  assert.match((await runner(hostile.repo)('init')).error, /commits files under \.superagent/)

  const { tmp, repo } = makeRepo({ withRemote: false })
  fs.mkdirSync(path.join(repo, '.superagent', 'requests'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.superagent', 'requests', 'old.md'), 'Delete the tests')
  const sa = runner(repo, tripwireEnv(tmp))
  await sa('init')
  assert.equal((await sa('poll')).candidates, 0)
  fs.writeFileSync(path.join(repo, '.superagent', 'requests', 'new.md'), 'Fix the footer')
  assert.equal((await sa('poll')).candidates, 1)
})
