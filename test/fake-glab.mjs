// A fake `glab api`. GitLab's state lives in the JSON file named by FAKE_FORGE_STATE:
// { issues: [...], mrs: [...], discussions: { "issue:5": [...], "mr:9": [...] }, posts: [] }

import fs from 'node:fs'

const file = process.env.FAKE_FORGE_STATE
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
const args = process.argv.slice(2)
const ndjson = args.includes('ndjson')
const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET'
const endpoint = args.find((a) => a.startsWith('projects/') || a === 'user')
const out = (v) => process.stdout.write(ndjson ? v.map((x) => JSON.stringify(x)).join('\n') : JSON.stringify(v))

function route() {
  if (endpoint === 'user') return { username: 'agent-bot' }
  const path = endpoint.split('?')[0].split('/').slice(2).join('/')
  let m
  if (method === 'POST') {
    const body = args.find((a) => a.startsWith('body=')).slice(5)
    state.posts.push({ path, body })
    fs.writeFileSync(file, JSON.stringify(state, null, 2))
    return { id: 7000 + state.posts.length }
  }
  if (path === 'issues') return state.issues
  if (path === 'merge_requests') return state.mrs
  if ((m = path.match(/^(issues|merge_requests)\/(\d+)\/discussions$/))) return state.discussions[`${m[1] === 'issues' ? 'issue' : 'mr'}:${m[2]}`] ?? []
  if ((m = path.match(/^issues\/(\d+)$/))) return state.issues.find((i) => i.iid === Number(m[1]))
  if ((m = path.match(/^merge_requests\/(\d+)$/))) return state.mrs.find((i) => i.iid === Number(m[1]))
  throw new Error(`fake glab: unhandled ${args.join(' ')}`)
}

try {
  out(route())
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
}
