// A fake gh. GitHub's state lives in the JSON file named by FAKE_FORGE_STATE.

import fs from 'node:fs'

// FAKE_GH_SLEEP_MS slows every call, to hold a poll open while another command runs.
if (process.env.FAKE_GH_SLEEP_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_GH_SLEEP_MS))

const file = process.env.FAKE_FORGE_STATE
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
const args = process.argv.slice(2)
const has = (s) => args.some((a) => a.includes(s))
const out = (v) => process.stdout.write(JSON.stringify(v))

function post() {
  const endpoint = args.find((a) => a.startsWith('repos/'))
  const body = args.find((a) => a.startsWith('body=')).slice(5)
  const id = 9000 + state.posts.length
  state.posts.push({ endpoint, body })
  fs.writeFileSync(file, JSON.stringify(state, null, 2))
  out({ id, html_url: `https://github.com/o/r/issues/5#issuecomment-${id}` })
}

if (args[0] === 'repo') out({ defaultBranchRef: { name: 'main' } })
else if (args[0] === 'pr') out({ state: state.prState ?? 'OPEN', headRefOid: 'abc', statusCheckRollup: [], url: 'https://github.com/o/r/pull/7' })
else if (has('--method') && has('POST')) post()
else if (args[1] === 'user') out({ login: 'agent-bot' })
else if (has('/issues/comments?')) out([state.comments])
else if (has('/issues?')) out([state.issues ?? []])
else if (has('/pulls/comments?')) out([state.reviewComments ?? []])
else if (has('/reviews?')) out([[]])
else if (/\/issues\/\d+\/comments/.test(args.join(' '))) out([state.comments])
else if (/repos\/o\/r\/issues\/\d+$/.test(args[1] ?? '')) out({ title: 'Typo in README', state: 'open' })
else {
  process.stderr.write(`fake gh: unhandled ${args.join(' ')}\n`)
  process.exit(1)
}
