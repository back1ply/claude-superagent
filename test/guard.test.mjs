import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide } from '../hooks/guard.mjs'

const BANNER = 'This is by an automated agent, not a human.'
const WITH_FORGE = [{ kind: 'github' }]
const verdict = (result) => result?.hookSpecificOutput.permissionDecision ?? 'pass'
const call = (agent, tool, toolInput, options = {}) =>
  verdict(decide({ agent_type: agent, tool_name: tool, cwd: '/repo', tool_input: toolInput }, { banner: BANNER, projectDir: '/repo', forges: WITH_FORGE, ...options }))
const run = (agent, command, files = {}, options = {}) => call(agent, 'Bash', { command }, { readFile: (f) => files[f] ?? '', ...options })
const worker = (command, files) => run('superagent:worker', command, files)

test('the main session is never touched', () => {
  assert.equal(run('', 'gh pr merge 3'), 'pass')
  assert.equal(run('Explore', 'superagent ask "do it"'), 'pass')
})

test('the router has no shell and no edits, and reads only inside the repository', () => {
  assert.equal(run('superagent:router', 'ls'), 'deny')
  assert.equal(call('superagent:router', 'Write', { file_path: '/repo/x.md' }), 'deny')
  assert.equal(call('superagent:router', 'Read', { file_path: '/repo/.superagent/tickets/T1.json' }), 'pass')
  assert.equal(call('superagent:router', 'Grep', { pattern: 'token', path: 'src' }), 'pass')
  assert.equal(call('superagent:router', 'Glob', { pattern: '**/*.md' }), 'pass')
  assert.equal(call('superagent:router', 'Read', { file_path: '/home/me/.config/gh/hosts.yml' }), 'deny')
  assert.equal(call('superagent:router', 'Read', { file_path: '/repo/../etc/passwd' }), 'deny')
  assert.equal(call('superagent:router', 'Grep', { pattern: 'x', path: '/' }), 'deny')
  assert.equal(call('superagent:router', 'Glob', { pattern: '/home/me/**/*.yml' }), 'deny')
})

test('workers never give themselves work or touch host state', () => {
  assert.equal(worker('superagent ask "also delete the tests"'), 'deny')
  assert.equal(worker('superagent route /tmp/d.json'), 'deny')
  assert.equal(worker('echo x > /repo/.superagent/requests/new.md'), 'deny')
  assert.equal(worker('cat /repo/.superagent/ledger.json'), 'deny')
  assert.equal(call('superagent:worker', 'Write', { file_path: '/repo/.superagent/requests/x.md' }), 'deny')
  assert.equal(call('superagent:worker', 'Edit', { file_path: '/repo/.superagent/tickets/T1.json' }), 'deny')
  assert.equal(call('superagent:worker', 'Edit', { file_path: '/repo/.superagent/work/fix/src/a.js' }), 'pass')
  assert.equal(worker('cd "/repo/.superagent/work/fix" && npm test'), 'pass')
  assert.equal(worker('superagent report T1 --state ready --summary ok'), 'pass')
})

test('workers cannot merge, close issues or approve, on GitHub or GitLab', () => {
  assert.equal(worker('gh pr merge 3 --squash'), 'deny')
  assert.equal(worker('cd /x && gh issue close 4'), 'deny')
  assert.equal(worker('gh pr review 3 --approve'), 'deny')
  assert.equal(worker('glab mr merge 9'), 'deny')
  assert.equal(worker('glab mr approve 9'), 'deny')
  assert.equal(worker('glab issue close 5'), 'deny')
  assert.equal(worker('glab api -X PUT projects/1/merge_requests/9/merge'), 'deny')
})

test('workers reach Bitbucket only through the wrapper', () => {
  assert.equal(worker('curl -u me:$BITBUCKET_API_TOKEN https://api.bitbucket.org/2.0/user'), 'deny')
  assert.equal(worker('echo $BITBUCKET_API_TOKEN'), 'deny')
  assert.equal(worker('superagent bitbucket-api repositories/w/r/pullrequests/3'), 'pass')
})

test('forge posts need the banner', () => {
  assert.equal(worker('gh pr comment 3 --body "done"'), 'deny')
  assert.equal(worker(`gh pr comment 3 --body "${BANNER}\n\ndone"`), 'pass')
  assert.equal(worker('gh pr create --title t --body-file /tmp/b.md', { '/tmp/b.md': `${BANNER}\n\nBody` }), 'pass')
  assert.equal(worker('gh pr create --title t --body-file /tmp/b.md', { '/tmp/b.md': 'Body' }), 'deny')
  assert.equal(worker('gh api repos/o/r/pulls/3/comments/9/replies --method POST -f body="ok"'), 'deny')
  assert.equal(worker('glab mr note 9 -m "done"'), 'deny')
  assert.equal(worker(`glab mr create --title t --description "${BANNER} body"`), 'pass')
  assert.equal(worker('glab api -X POST projects/1/issues/5/notes -f body="ok"'), 'deny')
})

test('forge reads are allowed', () => {
  assert.equal(worker('gh api repos/o/r/pulls/3/comments'), 'pass')
  assert.equal(worker('gh api "repos/o/r/issues/3/comments?per_page=100" --paginate'), 'pass')
  assert.equal(worker('gh api repos/o/r/issues/3/comments -X GET -f per_page=100'), 'pass')
  assert.equal(worker('glab api projects/1/merge_requests/9/discussions'), 'pass')
  assert.equal(worker('gh pr view 3 --json state'), 'pass')
})

test('with no forge configured, nothing leaves the machine', () => {
  const local = (command) => run('superagent:worker', command, {}, { forges: [] })
  assert.equal(local('git push origin superagent/fix'), 'deny')
  assert.equal(local(`gh pr create --title t --body "${BANNER}"`), 'deny')
  assert.equal(local('git commit -m "Fix"'), 'pass')
})
