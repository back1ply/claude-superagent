// GitHub Source, through the gh CLI. Issues and PRs share one number space: thread `#<n>`.

import { cut, keyed, matchReferences, parseJson, runCli, since } from './common.mjs'

const gh = (args) => runCli('gh', 'SUPERAGENT_GH', args)
const ghJson = (args) => parseJson(gh(args))

// `gh api --paginate --slurp` prints one array of pages.
function pages(endpoint) {
  return (ghJson(['api', '--paginate', '--slurp', endpoint]) ?? []).flat()
}

function person(user) {
  const login = user?.login ?? 'ghost'
  return { author: login, bot: user?.type === 'Bot' || login.endsWith('[bot]') }
}

const numberFromUrl = (url) => Number(String(url).split('/').pop())

export function configure(opts) {
  const repo = opts.repo
  if (!repo) throw new Error('A github source needs --repo <owner/name>.')
  const account = opts.account ?? ghJson(['api', 'user', '--jq', '{login: .login}']).login
  return { kind: 'github', repo, account, mention: opts.mention ?? `@${account}` }
}

export function open(name, conf) {
  const { repo } = conf
  // A trigger from one GitHub item: `at` is when it was written, `number` the issue or PR it is on.
  const base = (native, kind, item, extra) => ({
    id: keyed(name, native), source: name, kind, at: item.at, url: item.html_url,
    thread: keyed(name, `#${extra.number}`), ...person(item.user), ...cut(item.body), ...extra,
  })

  const issueComment = (c) => {
    const number = numberFromUrl(c.issue_url)
    return base(`ic:${c.id}`, 'comment', { ...c, at: c.created_at }, { number, address: { number } })
  }
  const opened = (i) => base(`is:${i.number}`, i.pull_request ? 'pull_request' : 'issue',
    { ...i, at: i.created_at, body: `${i.title}\n\n${i.body ?? ''}` },
    { number: i.number, title: i.title, address: { number: i.number } })
  const reviewComment = (c) => {
    const number = numberFromUrl(c.pull_request_url)
    return base(`rc:${c.id}`, 'review_comment', { ...c, at: c.created_at }, {
      number, path: c.path, line: c.line ?? c.original_line, address: { number, reviewRoot: c.in_reply_to_id ?? c.id },
    })
  }
  const review = (number) => (r) => base(`rv:${r.id}`, 'review', { ...r, at: r.submitted_at }, { number, review_state: r.state, address: { number } })

  return {
    name,
    kind: 'github',
    forge: true,
    poll({ since: from, changes }) {
      const q = `since=${encodeURIComponent(from)}&per_page=100`
      return [
        ...pages(`repos/${repo}/issues/comments?${q}`).map(issueComment),
        ...since(pages(`repos/${repo}/issues?state=all&${q}`), 'created_at', from).map(opened),
        ...since(pages(`repos/${repo}/pulls/comments?${q}`), 'created_at', from).map(reviewComment),
        ...changes.flatMap((n) => since(pages(`repos/${repo}/pulls/${n}/reviews?per_page=100`), 'submitted_at', from).map(review(n))),
      ]
    },
    thread(trigger) {
      return ghJson(['api', `repos/${repo}/issues/${trigger.number}`, '--jq', '{title: .title, state: .state}'])
    },
    window(trigger) {
      return pages(`repos/${repo}/issues/${trigger.number}/comments?per_page=100`).map(issueComment)
    },
    references(text) {
      return matchReferences(name, text, [[/(?:#|\/(?:issues|pull)\/)(\d+)/g, (n) => `#${n}`]])
    },
    changeThread: (number) => `#${number}`,
    change(number) {
      const pr = ghJson(['pr', 'view', String(number), '--repo', repo, '--json', 'state,headRefOid,statusCheckRollup,url'])
      const checks = (pr.statusCheckRollup ?? []).map((c) => `${c.name ?? c.context}:${c.conclusion ?? c.state ?? c.status}`)
      return { state: pr.state.toLowerCase(), fingerprint: `${pr.headRefOid}|${checks.sort().join(',')}`, checks, url: pr.url }
    },
    reply(address, body) {
      const endpoint = address.reviewRoot
        ? `repos/${repo}/pulls/${address.number}/comments/${address.reviewRoot}/replies`
        : `repos/${repo}/issues/${address.number}/comments`
      return { url: ghJson(['api', '--method', 'POST', endpoint, '-f', `body=${body}`])?.html_url ?? null }
    },
    describe: () => ({ name, kind: 'github', repository: repo, account: conf.account, cli: 'gh', skill: 'superagent:github' }),
  }
}
