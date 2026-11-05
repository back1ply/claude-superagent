// GitLab Source (gitlab.com or self-hosted), through glab. Issues and merge requests have separate
// number spaces: thread `#<iid>` for an issue, `!<iid>` for a merge request.
// Comments are read and answered through the discussions API, so a reply lands in its own thread.

import { cut, keyed, matchReferences, parseJson, parseLines, runCli, since } from './common.mjs'

const TYPES = { issue: { path: 'issues', mark: '#' }, mr: { path: 'merge_requests', mark: '!' } }

// Project and group access-token users, and GitLab's own placeholder accounts.
const BOT = /^(project|group)_\d+_bot|_bot$|^ghost$|^support-bot$|^alert-bot$/

function stateOf(state) {
  return { opened: 'open', merged: 'merged', closed: 'closed', locked: 'closed' }[state] ?? state
}

export function configure(opts) {
  if (!opts.project) throw new Error('A gitlab source needs --project <group/name>.')
  const host = opts.host ?? 'gitlab.com'
  const account = opts.account ?? parseJson(runCli('glab', 'SUPERAGENT_GLAB', ['api', '--hostname', host, 'user'])).username
  return { kind: 'gitlab', host, project: opts.project, account, mention: opts.mention ?? `@${account}` }
}

export function open(name, conf) {
  const project = `projects/${encodeURIComponent(conf.project)}`
  const glab = (args) => runCli('glab', 'SUPERAGENT_GLAB', ['api', '--hostname', conf.host, ...args])
  const list = (endpoint) => parseLines(glab(['--paginate', '--output', 'ndjson', `${project}/${endpoint}`]))
  const get = (endpoint) => parseJson(glab([`${project}/${endpoint}`]))

  const person = (user) => ({ author: user?.username ?? 'ghost', bot: BOT.test(user?.username ?? 'ghost') })

  const opened = (type, item) => ({
    id: keyed(name, `${type}:${item.iid}`), source: name, kind: type === 'mr' ? 'merge_request' : 'issue',
    thread: keyed(name, `${TYPES[type].mark}${item.iid}`), number: item.iid, at: item.created_at, url: item.web_url,
    title: item.title, address: { type, iid: item.iid, discussion: null },
    ...person(item.author), ...cut(`${item.title}\n\n${item.description ?? ''}`),
  })

  const note = (type, item, discussion) => (n) => ({
    id: keyed(name, `n:${n.id}`), source: name, kind: n.type === 'DiffNote' ? 'review_comment' : 'comment',
    thread: keyed(name, `${TYPES[type].mark}${item.iid}`), number: item.iid, at: n.created_at, url: `${item.web_url}#note_${n.id}`,
    path: n.position?.new_path, line: n.position?.new_line,
    // A one-note discussion is a top-level comment: answer it with a new note, not a thread reply.
    address: { type, iid: item.iid, discussion: discussion.individual_note ? null : discussion.id },
    ...person(n.author), ...cut(n.body),
  })

  const notesOf = (type, item) =>
    list(`${TYPES[type].path}/${item.iid}/discussions?per_page=100`).flatMap((d) =>
      d.notes.filter((n) => !n.system).map(note(type, item, d)),
    )

  const itemOf = (trigger) => get(`${TYPES[typeOf(trigger)].path}/${trigger.number}`)
  const typeOf = (trigger) => (trigger.thread.endsWith(`!${trigger.number}`) ? 'mr' : 'issue')

  // Items updated since `from`, plus the ones open tickets follow, each once.
  function updatedItems(from, followed) {
    const q = `updated_after=${encodeURIComponent(from)}&per_page=100`
    const items = new Map()
    for (const i of list(`issues?${q}`)) items.set(`issue:${i.iid}`, ['issue', i])
    for (const m of list(`merge_requests?state=all&${q}`)) items.set(`mr:${m.iid}`, ['mr', m])
    for (const native of followed) {
      const type = native.startsWith('!') ? 'mr' : 'issue'
      const iid = native.slice(1)
      if (!items.has(`${type}:${iid}`)) items.set(`${type}:${iid}`, [type, get(`${TYPES[type].path}/${iid}`)])
    }
    return [...items.values()]
  }

  return {
    name,
    kind: 'gitlab',
    forge: true,
    poll({ since: from, followed }) {
      return updatedItems(from, followed).flatMap(([type, item]) => [
        ...(item.created_at >= from ? [opened(type, item)] : []),
        ...since(notesOf(type, item), 'at', from),
      ])
    },
    thread(trigger) {
      const item = itemOf(trigger)
      return { title: item.title, state: stateOf(item.state) }
    },
    window(trigger) {
      return notesOf(typeOf(trigger), itemOf(trigger))
    },
    references(text) {
      return matchReferences(name, text, [
        [/(?:^|[^\w&])#(\d+)|\/-\/issues\/(\d+)/g, (n) => `#${n}`],
        [/(?:^|[^\w])!(\d+)|\/-\/merge_requests\/(\d+)/g, (n) => `!${n}`],
      ])
    },
    changeThread: (iid) => `!${iid}`,
    change(iid) {
      const mr = get(`merge_requests/${iid}`)
      const pipeline = mr.head_pipeline?.status ?? 'none'
      return { state: stateOf(mr.state), fingerprint: `${mr.sha}|${pipeline}`, checks: [`pipeline:${pipeline}`], url: mr.web_url }
    },
    reply(address, body) {
      const base = `${project}/${TYPES[address.type].path}/${address.iid}`
      const endpoint = address.discussion ? `${base}/discussions/${address.discussion}/notes` : `${base}/notes`
      const posted = parseJson(glab(['-X', 'POST', endpoint, '-f', `body=${body}`]))
      return { url: posted?.id ? `#note_${posted.id}` : null }
    },
    describe: () => ({ name, kind: 'gitlab', host: conf.host, project: conf.project, account: conf.account, cli: `glab (always pass --hostname ${conf.host} or -R ${conf.host}/${conf.project})`, skill: 'superagent:gitlab' }),
  }
}
