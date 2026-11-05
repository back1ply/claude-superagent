import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide } from '../hooks/guard.mjs'

const BANNER = 'This is by an automated agent, not a human.'
const verdict = (result) => result?.hookSpecificOutput.permissionDecision ?? 'pass'
const run = (agent, command, files = {}) =>
  verdict(decide({ agent_type: agent, tool_name: 'Bash', tool_input: { command } }, { banner: BANNER, readFile: (f) => files[f] ?? '' }))
const read = (tool, toolInput) =>
  verdict(decide({ agent_type: 'superagent:router', tool_name: tool, cwd: '/repo', tool_input: toolInput }, { projectDir: '/repo' }))

test('the main session is never touched', () => {
  assert.equal(run('', 'gh pr merge 3'), 'pass')
  assert.equal(run('Explore', 'gh issue close 3'), 'pass')
})

test('the router has no shell', () => {
  assert.equal(run('superagent:router', 'ls'), 'deny')
})

test('the router reads only inside the repository', () => {
  assert.equal(read('Read', { file_path: '/repo/.superagent/tickets/T1.json' }), 'pass')
  assert.equal(read('Grep', { pattern: 'token', path: 'src' }), 'pass')
  assert.equal(read('Glob', { pattern: '**/*.md' }), 'pass')
  assert.equal(read('Read', { file_path: '/home/me/.config/gh/hosts.yml' }), 'deny')
  assert.equal(read('Read', { file_path: '/repo/../etc/passwd' }), 'deny')
  assert.equal(read('Grep', { pattern: 'x', path: '/' }), 'deny')
  assert.equal(read('Glob', { pattern: '/home/me/**/*.yml' }), 'deny')
})

test('workers cannot merge, close issues or approve', () => {
  assert.equal(run('superagent:worker', 'gh pr merge 3 --squash'), 'deny')
  assert.equal(run('superagent:worker', 'cd /x && gh issue close 4'), 'deny')
  assert.equal(run('superagent:worker', 'gh pr review 3 --approve'), 'deny')
})

test('worker GitHub posts need the banner', () => {
  assert.equal(run('superagent:worker', 'gh pr comment 3 --body "done"'), 'deny')
  assert.equal(run('superagent:worker', `gh pr comment 3 --body "${BANNER}\n\ndone"`), 'pass')
  assert.equal(run('superagent:worker', 'gh pr create --title t --body-file /tmp/b.md', { '/tmp/b.md': `${BANNER}\n\nBody` }), 'pass')
  assert.equal(run('superagent:worker', 'gh pr create --title t --body-file /tmp/b.md', { '/tmp/b.md': 'Body' }), 'deny')
  assert.equal(run('superagent:worker', 'gh api repos/o/r/pulls/3/comments/9/replies --method POST -f body="ok"'), 'deny')
})

test('worker reads are allowed', () => {
  assert.equal(run('superagent:worker', 'gh api repos/o/r/pulls/3/comments'), 'pass')
  assert.equal(run('superagent:worker', 'gh api "repos/o/r/issues/3/comments?per_page=100" --paginate'), 'pass')
  assert.equal(run('superagent:worker', 'gh api repos/o/r/issues/3/comments -X GET -f per_page=100'), 'pass')
  assert.equal(run('superagent:worker', 'gh pr view 3 --json state'), 'pass')
})
