// Thin wrapper over the gh CLI. Every call names the repository explicitly.

import { execFileSync } from 'node:child_process'

const TEXT_CUT = 4000

export function gh(args, input) {
  const options = { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 }
  // Tests point SUPERAGENT_GH at a fake gh written in JavaScript.
  const fake = process.env.SUPERAGENT_GH
  return fake ? execFileSync(process.execPath, [fake, ...args], options) : execFileSync('gh', args, options)
}

export function ghJson(args) {
  const out = gh(args).trim()
  return out ? JSON.parse(out) : null
}

// `gh api --paginate` prints one JSON array per page; --slurp merges them.
function ghPages(endpoint) {
  const pages = ghJson(['api', '--paginate', '--slurp', endpoint]) ?? []
  return pages.flat()
}

function cut(text) {
  const body = String(text ?? '')
  return body.length > TEXT_CUT ? { text: body.slice(0, TEXT_CUT), cut_from: body.length } : { text: body }
}

function author(user) {
  const login = user?.login ?? 'ghost'
  return { author: login, bot: user?.type === 'Bot' || login.endsWith('[bot]') }
}

function numberFromUrl(url) {
  return Number(String(url).split('/').pop())
}

export function issueComment(c) {
  const number = numberFromUrl(c.issue_url)
  return {
    id: `gh:ic:${c.id}`,
    kind: 'issue_comment',
    thread: `#${number}`,
    number,
    at: c.created_at,
    url: c.html_url,
    ...author(c.user),
    ...cut(c.body),
  }
}

export function issueOpened(i) {
  return {
    id: `gh:is:${i.number}`,
    kind: i.pull_request ? 'pull_request' : 'issue',
    thread: `#${i.number}`,
    number: i.number,
    at: i.created_at,
    url: i.html_url,
    title: i.title,
    ...author(i.user),
    ...cut(`${i.title}\n\n${i.body ?? ''}`),
  }
}

export function reviewComment(c) {
  const number = numberFromUrl(c.pull_request_url)
  return {
    id: `gh:rc:${c.id}`,
    kind: 'review_comment',
    thread: `#${number}`,
    number,
    review_root: c.in_reply_to_id ?? c.id,
    path: c.path,
    line: c.line ?? c.original_line,
    at: c.created_at,
    url: c.html_url,
    ...author(c.user),
    ...cut(c.body),
  }
}

export function review(number, r) {
  return {
    id: `gh:rv:${r.id}`,
    kind: 'review',
    thread: `#${number}`,
    number,
    review_state: r.state,
    at: r.submitted_at,
    url: r.html_url,
    ...author(r.user),
    ...cut(r.body),
  }
}

// Everything new on the repository since `since`, oldest first.
export function fetchTriggers(repo, since) {
  const q = `since=${encodeURIComponent(since)}&per_page=100`
  const triggers = [
    ...ghPages(`repos/${repo}/issues/comments?${q}`).map(issueComment),
    ...ghPages(`repos/${repo}/issues?state=all&${q}`)
      .filter((i) => i.created_at >= since)
      .map(issueOpened),
    ...ghPages(`repos/${repo}/pulls/comments?${q}`)
      .filter((c) => c.created_at >= since)
      .map(reviewComment),
  ]
  return triggers.sort((a, b) => a.at.localeCompare(b.at))
}

export function fetchReviews(repo, number, since) {
  return ghPages(`repos/${repo}/pulls/${number}/reviews?per_page=100`)
    .filter((r) => r.submitted_at && r.submitted_at >= since)
    .map((r) => review(number, r))
}

export function threadTitle(repo, number) {
  return ghJson(['api', `repos/${repo}/issues/${number}`, '--jq', '{title: .title, state: .state}'])
}

export function threadComments(repo, number) {
  return ghPages(`repos/${repo}/issues/${number}/comments?per_page=100`).map(issueComment)
}

export function pullStatus(repo, number) {
  return ghJson([
    'pr', 'view', String(number), '--repo', repo,
    '--json', 'state,headRefOid,statusCheckRollup,url',
  ])
}

export function postIssueComment(repo, number, body) {
  return ghJson(['api', '--method', 'POST', `repos/${repo}/issues/${number}/comments`, '-f', `body=${body}`])
}

export function postReviewReply(repo, number, rootId, body) {
  return ghJson([
    'api', '--method', 'POST', `repos/${repo}/pulls/${number}/comments/${rootId}/replies`, '-f', `body=${body}`,
  ])
}
