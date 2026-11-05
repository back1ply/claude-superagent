// Local source end to end, with no remote and no forge: nothing may touch the network.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { git, here, makeRepo, runner, writeDecisions } from './helpers.mjs'

test('local: ask and request files to a merged branch, without any network call', async () => {
  const { tmp, repo } = makeRepo({ withRemote: false })
  const tripwire = path.join(tmp, 'network-was-used')
  const sa = runner(repo, { SUPERAGENT_GH: path.join(here, 'tripwire.mjs'), SUPERAGENT_GLAB: path.join(here, 'tripwire.mjs'), TRIPWIRE: tripwire })

  const init = await sa('init')
  assert.deepEqual(Object.keys(init.config.sources), ['local'])
  assert.equal(init.config.baseBranch, 'main')

  assert.equal((await sa('ask', 'Fix the date format in the footer')).thread, 'local:R1')
  fs.mkdirSync(path.join(repo, '.superagent', 'requests'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.superagent', 'requests', 'rename.md'), '# Rename the CLI\n\nCall it sa instead.')
  const polled = await sa('poll')
  assert.equal(polled.candidates, 2)
  const cards = JSON.parse(fs.readFileSync(polled.candidates_file, 'utf8'))
  assert.deepEqual(cards.map((c) => c.trigger_id), ['local:R1:1', 'local:R2:1'])
  assert.equal(cards[1].thread.title, 'Rename the CLI')
  assert.equal((await sa('poll')).candidates, 0, 'a request file is taken once')

  const decisions = writeDecisions(repo, 'd.json', [
    { trigger_id: 'local:R1:1', kind: 'accept', title: 'Fix footer date', worktree_name: 'footer-date', acknowledgement: 'On it: showing footer dates as YYYY-MM-DD.' },
    { trigger_id: 'local:R2:1', kind: 'ignore', reason: 'test' },
  ])
  assert.equal((await sa('route', decisions)).results[0].status, 'accepted')
  const messages = await sa('messages')
  assert.equal(messages[0].text, 'On it: showing footer dates as YYYY-MM-DD.', 'local replies carry no banner')
  assert.equal(messages[0].ticket, 'T1')
  assert.deepEqual(await sa('messages'), [], 'read messages are not shown again')

  const assignment = await sa('assignment', 'T1')
  assert.equal(assignment.environment.delivery, 'branch')
  assert.deepEqual(assignment.skills, ['superagent:local'])
  assert.match((await sa('report', 'T1', '--state', 'progress', '--change', '3')).error, /local branch/)

  const worktree = assignment.environment.directory
  fs.writeFileSync(path.join(worktree, 'footer.txt'), '2026-11-05\n')
  git(worktree, 'add', '.')
  git(worktree, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'Fix footer date')
  await sa('report', 'T1', '--state', 'ready', '--summary', 'Branch superagent/footer-date is ready.')
  assert.equal((await sa('reply', 'T1', '--purpose', 'result', '--text', 'Footer dates now read YYYY-MM-DD; branch superagent/footer-date is ready to merge.')).status, 'sent')

  await sa('ask', 'T1', 'Also make the date bold.')
  const followUp = await sa('poll')
  assert.deepEqual(followUp.wake, ['T1'])
  assert.equal((await sa('inbox', 'T1')).inputs[0].trigger.text, 'Also make the date bold.')
  await sa('report', 'T1', '--state', 'ready', '--summary', 'Bold too.')

  git(repo, 'merge', '-q', 'superagent/footer-date')
  const merged = await sa('poll')
  assert.match(merged.notices[0].reason, /merged into main/)
  assert.equal((await sa('tickets')).length, 0)

  assert.equal(fs.existsSync(tripwire), false, `network CLI was called: ${fs.existsSync(tripwire) && fs.readFileSync(tripwire, 'utf8')}`)
})
