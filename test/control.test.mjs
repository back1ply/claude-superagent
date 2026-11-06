// Upstream behaviours: the worker limit, revalidation before resume, the processing pause, the prepare command.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fakeState, here, later, makeRepo, runner, writeDecisions } from './helpers.mjs'

function localRepo() {
  const { tmp, repo } = makeRepo({ withRemote: false })
  return { repo, sa: runner(repo, { SUPERAGENT_GH: path.join(here, 'tripwire.mjs'), TRIPWIRE: path.join(tmp, 'tripwire') }) }
}

// Ask for and accept one local request per name; tickets T1.. follow the names' order.
async function acceptLocal(sa, repo, names) {
  for (const name of names) await sa('ask', `Do ${name}`)
  await sa('poll')
  const decisions = names.map((name, i) => ({ trigger_id: `local:R${i + 1}:1`, kind: 'accept', title: name, worktree_name: name, acknowledgement: `On it: ${name}.` }))
  return sa('route', writeDecisions(repo, 'accept.json', decisions))
}

const config = (repo) => path.join(repo, '.superagent', 'config.json')
const editConfig = (repo, fn) => {
  const c = JSON.parse(fs.readFileSync(config(repo), 'utf8'))
  fn(c)
  fs.writeFileSync(config(repo), JSON.stringify(c))
}

test('the worker limit, with a spare slot for a person', async () => {
  const { repo, sa } = localRepo()
  await sa('init', '--max-workers', '1')
  await acceptLocal(sa, repo, ['one', 'two', 'three'])

  const first = await sa('dispatch')
  assert.deepEqual(first.start, ['T1'])
  assert.deepEqual(first.queued, ['T2', 'T3'])
  assert.deepEqual((await sa('dispatch')).start, [], 'a running ticket holds its slot')

  await sa('ask', 'T3', 'and make it blue')
  await sa('poll')
  const urgent = await sa('dispatch')
  assert.deepEqual(urgent.start, ['T3'], "a person's message takes the spare slot")
  assert.deepEqual(urgent.queued, ['T2'])

  await sa('report', 'T1', '--state', 'ready', '--summary', 'done')
  assert.deepEqual((await sa('dispatch')).start, [], 'the spare slot does not admit new work')
  await sa('report', 'T3', '--state', 'ready', '--summary', 'done')
  assert.deepEqual((await sa('dispatch')).start, ['T2'])
  assert.deepEqual((await sa('dispatch', '--session-start')).resume, ['T2'], 'a new session resumes what was left running')
})

test('an ended ticket resumes only while its mandate holds', async () => {
  const { tmp, repo } = makeRepo()
  const forge = fakeState(tmp, { comments: [], posts: [] })
  const sa = runner(repo, { SUPERAGENT_GH: path.join(here, 'fake-gh.mjs'), FAKE_FORGE_STATE: forge.file })
  const comment = (id, login, body) => forge.update((s) => {
    s.comments.push({ id, user: { login, type: 'User' }, body, html_url: `https://github.com/o/r/issues/5#issuecomment-${id}`, issue_url: 'https://api.github.com/repos/o/r/issues/5', created_at: later() })
  })
  await sa('init')
  await sa('source', 'add', 'github', '--kind', 'github', '--repo', 'o/r', '--allowed', 'alice,bob', '--account', 'agent-bot')
  comment(1, 'alice', '@agent-bot fix the footer')
  await sa('poll')
  await sa('route', writeDecisions(repo, 'a.json', [{ trigger_id: 'github:ic:1', kind: 'accept', title: 'Fix', worktree_name: 'fix', acknowledgement: 'On it: fixing the footer.' }]))
  await sa('report', 'T1', '--state', 'dropped', '--summary', 'Not reproducible.')

  editConfig(repo, (c) => { c.sources.github.allowed = ['bob'] })
  comment(2, 'alice', 'it is back, please look again')
  assert.deepEqual((await sa('poll')).wake, [], 'removing the requester revokes the mandate')
  assert.equal((await sa('tickets', '--all'))[0].stage, 'ended')

  comment(3, 'bob', '@agent-bot please reopen T1')
  await sa('poll')
  const attach = await sa('route', writeDecisions(repo, 'b.json', [{ trigger_id: 'github:ic:3', kind: 'attach', ticket_id: 'T1' }]))
  assert.match(attach.results[0].refused, /mandate no longer holds/)
})

test('the processing pause keeps what arrives and routes it after resume', async () => {
  const { repo, sa } = localRepo()
  await sa('init')
  await sa('pause')
  await sa('ask', 'Fix the footer')
  const paused = await sa('poll')
  assert.equal(paused.paused, true)
  assert.equal(paused.deferred, 1)
  assert.equal(paused.candidates, 0)
  assert.match((await sa('route', writeDecisions(repo, 'p.json', []))).error, /paused/)
  assert.equal((await sa('dispatch')).paused, true)

  await sa('resume')
  const resumed = await sa('poll')
  assert.equal(resumed.candidates, 1)
  assert.equal(JSON.parse(fs.readFileSync(resumed.candidates_file, 'utf8'))[0].trigger_id, 'local:R1:1')
  assert.equal((await sa('poll')).candidates, 0, 'a deferred candidate comes back once')
})

test('the prepare command runs once per ticket directory, and its failure fails the ticket', async () => {
  const { repo, sa } = localRepo()
  await sa('init', '--prepare', 'echo "$SUPERAGENT_TICKET" > prepared.txt')
  await acceptLocal(sa, repo, ['good'])
  const assignment = await sa('assignment', 'T1')
  assert.equal(fs.readFileSync(path.join(assignment.environment.directory, 'prepared.txt'), 'utf8').trim(), 'T1')
  assert.ok((await sa('show', 'T1')).prepared)

  await sa('init', '--prepare', 'echo missing dependency; exit 3')
  await sa('ask', 'Do bad')
  await sa('poll')
  await sa('route', writeDecisions(repo, 'bad.json', [{ trigger_id: 'local:R2:1', kind: 'accept', title: 'bad', worktree_name: 'bad', acknowledgement: 'On it: bad.' }]))
  assert.match((await sa('assignment', 'T2')).error, /prepare command failed.*missing dependency/s)
  const t2 = (await sa('tickets')).find((t) => t.id === 'T2')
  assert.equal(t2.stage, 'person / failed')
  assert.ok((await sa('assignment', 'T1')).ticket, 'an already prepared ticket does not prepare again')
})
