import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, referencedTickets, stageOf, windowAround } from '../lib/domain.mjs'
import { countWords } from '../lib/words.mjs'

const config = { account: 'agent-bot', mention: '@agent-bot', allowed: ['alice'], policy: { rules: [] } }
const trigger = (over) => ({ id: 'gh:ic:1', thread: '#5', author: 'alice', bot: false, text: '@agent-bot fix the typo', ...over })
const ticket = (over) => ({ id: 'T1', state: 'open', threads: ['#5'], reports: [], assignment: 'running', ...over })

test('counts English and Chinese words', () => {
  assert.equal(countWords('Fix submitted: ready for review.'), 5)
  assert.ok(countWords('修复了日期显示') >= 2)
})

test('an allowed mention becomes an explicit candidate', () => {
  assert.deepEqual(classify(trigger(), config, []), { disposition: 'candidate', strength: 'explicit' })
})

test('a stranger mentioning the agent is filtered', () => {
  assert.equal(classify(trigger({ author: 'mallory' }), config, []).disposition, 'filtered')
})

test('anything on a subscribed thread goes to its tickets, bots included', () => {
  const result = classify(trigger({ author: 'ci[bot]', bot: true, text: 'build failed' }), config, [ticket()])
  assert.deepEqual(result, { disposition: 'delivered', tickets: ['T1'] })
})

test('a stopped ticket receives nothing', () => {
  assert.equal(classify(trigger(), config, [ticket({ stopped: true })]).disposition, 'candidate')
})

test('the agent ignores its own comments unless told otherwise', () => {
  assert.equal(classify(trigger({ author: 'Agent-Bot' }), config, []).disposition, 'own')
  assert.equal(classify(trigger({ author: 'agent-bot' }), { ...config, acceptOwn: true, allowed: ['agent-bot'] }, []).disposition, 'candidate')
})

test('enabled rules make other messages proactive candidates', () => {
  const withRule = { ...config, policy: { rules: [{ id: 'r1', enabled: true }] } }
  assert.equal(classify(trigger({ author: 'bob', text: 'typo here' }), withRule, []).strength, 'proactive')
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

test('referenced tickets come from #numbers and links', () => {
  const tickets = [ticket({ id: 'T1', threads: ['#5', '#9'] }), ticket({ id: 'T2', threads: ['#7'] })]
  assert.deepEqual(referencedTickets('see https://github.com/o/r/pull/9', tickets), ['T1'])
  assert.deepEqual(referencedTickets('dup of #7', tickets), ['T2'])
})

test('window keeps the first five and five around the trigger', () => {
  const messages = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, author: 'a', at: '', text: 'x' }))
  const window = windowAround(messages, 'm20')
  const full = window.filter((m) => !m.stub).map((m) => m.id)
  assert.deepEqual(full, ['m0', 'm1', 'm2', 'm3', 'm4', 'm15', 'm16', 'm17', 'm18', 'm19', 'm20', 'm21', 'm22', 'm23', 'm24', 'm25'])
})
