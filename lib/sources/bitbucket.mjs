// Bitbucket Cloud Source, through the REST API with an Atlassian API token (Basic auth: email + token).
// Credentials come only from environment variables, never from config.json.
// Pull requests and issues have separate number spaces: thread `!<id>` for a PR, `#<id>` for an issue.
// People are named by account_id, which is stable; nicknames are not unique.

import { cut, keyed, matchReferences, since } from './common.mjs'
import { UserError } from '../words.mjs'

const API = () => process.env.SUPERAGENT_BITBUCKET_API ?? 'https://api.bitbucket.org/2.0'
const PR_STATES = ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']
const TYPES = { pr: { path: 'pullrequests', mark: '!' }, issue: { path: 'issues', mark: '#' } }

function auth(conf) {
  const email = process.env[conf.emailEnv ?? 'BITBUCKET_EMAIL']
  const token = process.env[conf.tokenEnv ?? 'BITBUCKET_API_TOKEN']
  if (!email || !token) throw new UserError(`Set ${conf.emailEnv ?? 'BITBUCKET_EMAIL'} and ${conf.tokenEnv ?? 'BITBUCKET_API_TOKEN'} for Bitbucket.`)
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
}

// One API call. `path` is relative to the API root, or an absolute `next` link.
export async function api(conf, path, { method = 'GET', body } = {}) {
  const url = path.startsWith('http') ? path : `${API()}/${path.replace(/^\//, '')}`
  const response = await fetch(url, {
    method,
    headers: { Authorization: auth(conf), Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  if (response.status === 404) return null
  if (!response.ok) throw new UserError(`Bitbucket ${method} ${path} failed: ${response.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

async function all(conf, path) {
  const values = []
  for (let page = await api(conf, path); page; page = page.next ? await api(conf, page.next) : null) values.push(...page.values)
  return values
}

const stateOf = (state) => ({ OPEN: 'open', MERGED: 'merged', new: 'open', open: 'open', submitted: 'open' })[state] ?? 'closed'

export async function configure(opts) {
  if (!opts.workspace || !opts.repo) throw new UserError('A bitbucket source needs --workspace <workspace> and --repo <repo slug>.')
  const conf = { kind: 'bitbucket', workspace: opts.workspace, repo: opts.repo, emailEnv: opts['email-env'] ?? 'BITBUCKET_EMAIL', tokenEnv: opts['token-env'] ?? 'BITBUCKET_API_TOKEN' }
  const me = opts.account ? { account_id: opts.account } : await api(conf, 'user')
  // Bitbucket writes a mention as @{account_id} in raw text, so the default address is a keyword.
  return { ...conf, account: me.account_id, mention: opts.mention ?? '/superagent' }
}

export function open(name, conf) {
  const repo = `repositories/${conf.workspace}/${conf.repo}`
  const person = (user) => ({ author: user?.nickname ?? user?.display_name ?? 'unknown', author_id: user?.account_id ?? null, bot: user?.type === 'app_user' })

  const opened = (type, item) => ({
    id: keyed(name, `${type}:${item.id}`), source: name, kind: type === 'pr' ? 'pull_request' : 'issue',
    thread: keyed(name, `${TYPES[type].mark}${item.id}`), number: item.id, at: item.created_on, url: item.links?.html?.href,
    title: item.title, address: { type, id: item.id, parent: null },
    ...person(type === 'pr' ? item.author : item.reporter), ...cut(`${item.title}\n\n${item.description ?? item.content?.raw ?? ''}`),
  })

  const comment = (type, item) => (c) => ({
    id: keyed(name, `${type}c:${c.id}`), source: name, kind: c.inline ? 'review_comment' : 'comment',
    thread: keyed(name, `${TYPES[type].mark}${item.id}`), number: item.id, at: c.created_on, url: c.links?.html?.href,
    path: c.inline?.path, line: c.inline?.to ?? c.inline?.from,
    // Replies nest under the comment they answer.
    address: { type, id: item.id, parent: c.id },
    ...person(c.user), ...cut(c.content?.raw),
  })

  const commentsOf = async (type, item) =>
    (await all(conf, `${repo}/${TYPES[type].path}/${item.id}/comments?pagelen=100`)).filter((c) => !c.deleted).map(comment(type, item))

  // Whether a new comment bumps a PR's updated_on is not documented, so every open PR is read too.
  async function items(from, followed) {
    // Bitbucket's documented datetime form: no milliseconds, explicit offset.
    const q = encodeURIComponent(`updated_on > ${from.replace(/\.\d+Z$|Z$/, '+00:00')}`)
    const states = PR_STATES.map((s) => `state=${s}`).join('&')
    const found = new Map()
    for (const pr of await all(conf, `${repo}/pullrequests?${states}&q=${q}&pagelen=50`)) found.set(`pr:${pr.id}`, ['pr', pr])
    for (const pr of await all(conf, `${repo}/pullrequests?state=OPEN&pagelen=50`)) found.set(`pr:${pr.id}`, ['pr', pr])
    // Many repositories have the issue tracker off: a 404 means no issues.
    for (const issue of await all(conf, `${repo}/issues?q=${q}&pagelen=50`)) found.set(`issue:${issue.id}`, ['issue', issue])
    for (const native of followed) {
      const type = native.startsWith('!') ? 'pr' : 'issue'
      if (!found.has(`${type}:${native.slice(1)}`)) {
        const item = await api(conf, `${repo}/${TYPES[type].path}/${native.slice(1)}`)
        if (item) found.set(`${type}:${item.id}`, [type, item])
      }
    }
    return [...found.values()]
  }

  const typeOf = (trigger) => (trigger.thread.endsWith(`!${trigger.number}`) ? 'pr' : 'issue')
  const itemOf = (trigger) => api(conf, `${repo}/${TYPES[typeOf(trigger)].path}/${trigger.number}`)

  return {
    name,
    kind: 'bitbucket',
    forge: true,
    async poll({ since: from, followed }) {
      const triggers = []
      for (const [type, item] of await items(from, followed)) {
        if (item.created_on >= from) triggers.push(opened(type, item))
        triggers.push(...since(await commentsOf(type, item), 'at', from))
      }
      return triggers
    },
    async thread(trigger) {
      const item = await itemOf(trigger)
      return { title: item?.title, state: stateOf(item?.state) }
    },
    async window(trigger) {
      return commentsOf(typeOf(trigger), await itemOf(trigger))
    },
    references(text) {
      return matchReferences(name, text, [
        [/\/pull-requests\/(\d+)|pull request #(\d+)/gi, (n) => `!${n}`],
        [/\/issues\/(\d+)|(?:^|[^\w])#(\d+)/g, (n) => `#${n}`],
      ])
    },
    changeThread: (id) => `!${id}`,
    async change(id) {
      const pr = await api(conf, `${repo}/pullrequests/${id}`)
      const statuses = await all(conf, `${repo}/pullrequests/${id}/statuses?pagelen=100`)
      const checks = statuses.map((s) => `${s.key}:${s.state}`).sort()
      return { state: stateOf(pr.state), fingerprint: `${pr.source?.commit?.hash}|${checks.join(',')}`, checks, url: pr.links?.html?.href }
    },
    async reply(address, body) {
      const posted = await api(conf, `${repo}/${TYPES[address.type].path}/${address.id}/comments`, {
        method: 'POST',
        body: { content: { raw: body }, ...(address.parent ? { parent: { id: address.parent } } : {}) },
      })
      return { url: posted?.links?.html?.href ?? null }
    },
    describe: () => ({ name, kind: 'bitbucket', workspace: conf.workspace, repo: conf.repo, account_id: conf.account, cli: `superagent bitbucket-api --source ${name}`, skill: 'superagent:bitbucket' }),
  }
}
