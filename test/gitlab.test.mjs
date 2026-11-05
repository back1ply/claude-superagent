// GitLab source end to end with a fake glab: notes, discussions, MR binding and merge.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fakeState, here, later, makeRepo, runner, writeDecisions } from './helpers.mjs'

const old = '2020-01-01T00:00:00Z'
const note = (id, username, body, extra = {}) => ({ id, body, author: { username }, created_at: later(), system: false, ...extra })

test('gitlab: a note becomes a ticket, its MR is followed, and a merge ends it', async () => {
  const { tmp, repo } = makeRepo()
  const forge = fakeState(tmp, {
    issues: [{ iid: 5, title: 'Footer date is wrong', description: '', author: { username: 'carol' }, created_at: old, updated_at: later(), state: 'opened', web_url: 'https://gl.example/g/p/-/issues/5' }],
    mrs: [],
    discussions: {
      'issue:5': [
        { id: 'd0', individual_note: true, notes: [note(500, 'alice', 'changed the description', { system: true })] },
        { id: 'd1', individual_note: true, notes: [note(501, 'alice', '@agent-bot please fix this')] },
        { id: 'd9', individual_note: true, notes: [note(509, 'project_42_bot_abc', '@agent-bot fix')] },
      ],
    },
    posts: [],
  })
  const sa = runner(repo, { SUPERAGENT_GLAB: path.join(here, 'fake-glab.mjs'), FAKE_FORGE_STATE: forge.file })

  await sa('init', '--send', 'on')
  const added = await sa('source', 'add', 'gitlab', '--kind', 'gitlab', '--project', 'g/p', '--host', 'gl.example', '--allowed', 'alice')
  assert.equal(added.account, 'agent-bot')
  assert.equal(added.host, 'gl.example')

  const first = await sa('poll')
  assert.equal(first.candidates, 1, 'system notes and bots are not requests')
  const routed = await sa('route', writeDecisions(repo, 'd.json', [{ trigger_id: 'gitlab:n:501', kind: 'accept', title: 'Fix footer date', worktree_name: 'footer', acknowledgement: 'On it: fixing the footer date.' }]))
  assert.equal(routed.results[0].status, 'accepted')
  assert.equal(forge.read().posts[0].path, 'issues/5/notes', 'a top-level note is answered with a new note')
  assert.match(forge.read().posts[0].body, /^This is by an automated agent/)

  const assignment = await sa('assignment', 'T1')
  assert.deepEqual(assignment.skills, ['superagent:gitlab'])
  forge.update((s) => {
    s.mrs.push({ iid: 9, title: 'Fix footer date', description: '', author: { username: 'agent-bot' }, created_at: later(), updated_at: later(), state: 'opened', sha: 'abc', head_pipeline: { status: 'running' }, web_url: 'https://gl.example/g/p/-/merge_requests/9' })
  })
  await sa('report', 'T1', '--state', 'progress', '--change', '9')
  assert.ok((await sa('show', 'T1')).threads.includes('gitlab:!9'))

  forge.update((s) => {
    s.discussions['mr:9'] = [{ id: 'd2', individual_note: false, notes: [note(601, 'bob', 'Use ISO dates here', { type: 'DiffNote', position: { new_path: 'footer.js', new_line: 3 } })] }]
  })
  const second = await sa('poll')
  assert.deepEqual(second.wake, ['T1'])
  const inputs = (await sa('inbox', 'T1')).inputs.map((i) => i.trigger)
  const review = inputs.find((t) => t.id === 'gitlab:n:601')
  assert.equal(review.kind, 'review_comment')
  assert.equal(review.path, 'footer.js')
  await sa('ack', 'T1', 'gitlab:n:601', 'On it: switching to ISO dates.')
  assert.equal(forge.read().posts[1].path, 'merge_requests/9/discussions/d2/notes', 'a thread reply stays in its discussion')

  forge.update((s) => { s.mrs[0].state = 'merged' })
  const merged = await sa('poll')
  assert.match(merged.notices[0].reason, /gitlab change 9 merged/)
})
