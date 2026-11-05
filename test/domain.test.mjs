import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, referencedTickets, stageOf, windowAround } from '../lib/domain.mjs'
import { countWords } from '../lib/words.mjs'

const github = { kind: 'github', account: 'agent-bot', mention: '@agent-bot', allowed: ['alice'] }
const local = { kind: 'local' }
const config = { policy: { rules: [] } }
const trigger = (over) => ({ id: 'github:ic:1', source: 'github', thread: 'github:#5', author: 'alice', bot: false, text: '@agent-bot fix the typo', ...over })
const ticket = (over) => ({ id: 'T1', state: 'open', threads: ['github:#5'], reports: [], assignment: 'running', ...over })

test('counts English and Chinese words', () => {
  assert.equal(countWords('Fix submitted: ready for review.'), 5)
  assert.ok(countWords('修复了日期显示') >= 2)
})

test('an allowed mention becomes an explicit candidate', () => {
  assert.deepEqual(classify(trigger(), github, config, []), { disposition: 'candidate', strength: 'explicit' })
})

test('a stranger mentioning the agent is filtered', () => {
  assert.equal(classify(trigger({ author: 'mallory' }), github, config, []).disposition, 'filtered')
})

test('every local request is explicit, with no mention', () => {
  const t = trigger({ source: 'local', thread: 'local:R1', author: 'you', text: 'fix the date bug' })
  assert.equal(classify(t, local, config, []).strength, 'explicit')
})

test('bitbucket people are matched by account id, not nickname', () => {
  const bitbucket = { kind: 'bitbucket', account: 'acc-bot', mention: '/superagent', allowed: ['acc-alice'] }
  const t = (author_id) => trigger({ source: 'bb', author: 'alice', author_id, text: '/superagent fix it' })
  assert.equal(classify(t('acc-alice'), bitbucket, config, []).disposition, 'candidate')
  assert.equal(classify(t('acc-imposter'), bitbucket, config, []).disposition, 'filtered')
  assert.equal(classify(t('acc-bot'), bitbucket, config, []).disposition, 'own')
})

test('anything on a subscribed thread goes to its tickets, bots included', () => {
  const result = classify(trigger({ author: 'ci[bot]', bot: true, text: 'build failed' }), github, config, [ticket()])
  assert.deepEqual(result, { disposition: 'delivered', tickets: ['T1'] })
})

test('a stopped ticket receives nothing', () => {
  assert.equal(classify(trigger(), github, config, [ticket({ stopped: true })]).disposition, 'candidate')
})

test('the agent ignores its own comments unless told otherwise', () => {
  assert.equal(classify(trigger({ author: 'Agent-Bot' }), github, config, []).disposition, 'own')
  assert.equal(classify(trigger({ author: 'agent-bot' }), { ...github, acceptOwn: true, allowed: ['agent-bot'] }, config, []).disposition, 'candidate')
})

test('enabled rules make other messages proactive candidates, limited to the sources a rule names', () => {
  const withRule = (sources) => ({ policy: { rules: [{ id: 'r1', enabled: true, sources }] } })
  const t = trigger({ author: 'bob', text: 'typo here' })
  assert.equal(classify(t, github, withRule(undefined), []).strength, 'proactive')
  assert.equal(classify(t, github, withRule(['gitlab']), []).disposition, 'filtered')
})

test('stage follows the upstream table, first match wins', () => {
  assert.equal(stageOf(ticket({ attention: { question: 'A or B?' }, reports: [{ state: 'ready' }] })), 'person / answer')
  assert.equal(stageOf(ticket({ reports: [{ state: 'ready' }] })), 'person / review')
  assert.equal(stageOf(ticket({ reports: [{ state: 'blocked' }] })), 'person / blocked')
  assert.equal(stageOf(ticket({ reports: [{ state: 'blocked' }], person_message_since: 'x' })), 'working')
  assert.equal(stageOf(ticket({ assignment: 'pending' })), 'working / queued')
  assert.equal(stageOf(ticket({ assignment: 'ended' })), 'idle')
  assert.equal(stageOf(ticket({ state: 'ended', stopped: true })), 'ended / stopped')
})

test('referenced tickets come from ticket ids and the thread keys a source found', () => {
  const tickets = [ticket({ id: 'T1', threads: ['github:#5', 'github:#9'] }), ticket({ id: 'T2', threads: ['gitlab:!7'] })]
  assert.deepEqual(referencedTickets('see the PR', ['github:#9'], tickets), ['T1'])
  assert.deepEqual(referencedTickets('dup', ['gitlab:!7'], tickets), ['T2'])
  assert.deepEqual(referencedTickets('same as T2', [], tickets), ['T2'])
})

test('window keeps the first five and five around the trigger', () => {
  const messages = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, author: 'a', at: '', text: 'x' }))
  const full = windowAround(messages, 'm20').filter((m) => !m.stub).map((m) => m.id)
  assert.deepEqual(full, ['m0', 'm1', 'm2', 'm3', 'm4', 'm15', 'm16', 'm17', 'm18', 'm19', 'm20', 'm21', 'm22', 'm23', 'm24', 'm25'])
})
