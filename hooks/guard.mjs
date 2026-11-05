// PreToolUse guard for the plugin's own subagents. It never touches the user's main session.
// Router: reads only inside the repository and has no shell, since it reads strangers' text.
// Both: never give themselves work (`superagent ask`) or edit .superagent/ state outside ticket worktrees.
// Worker: no merging, closing issues or approving on any forge; forge posts start with the banner;
//         Bitbucket only through `superagent bitbucket-api`; with no forge configured, nothing leaves the machine.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROUTER = /^superagent:router$/
const WORKER = /^superagent:worker$/
const DEFAULT_BANNER = 'This is by an automated agent, not a human.'
const READ_TOOLS = ['Read', 'Grep', 'Glob']
const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit']
const SHELLS = ['Bash', 'PowerShell']

const MERGES_ARE_HUMAN = 'A person merges and approves; the worker never merges, enables auto-merge or approves.'
const WORKER_FORBIDDEN = [
  [/\bgh\s+pr\s+merge\b|\bmergePullRequest\b|\benablePullRequestAutoMerge\b/, MERGES_ARE_HUMAN],
  [/\bgh\s+pr\s+review\b[^\n]*--approve/, MERGES_ARE_HUMAN],
  [/\bglab\s+mr\s+(merge|approve)\b|\bglab\s+api\b[^\n]*\/merge_requests\/\d+\/(merge|approve)\b/, MERGES_ARE_HUMAN],
  [/\b(gh|glab)\s+issue\s+close\b/, 'Workers never close issues.'],
  [/api\.bitbucket\.org|BITBUCKET_API_TOKEN|BITBUCKET_EMAIL/, 'Call Bitbucket only through `superagent bitbucket-api`; never read its credentials.'],
  [/\bsuperagent\s+(ask|init|source|route|reply|poll|request-status|messages)\b/, 'Workers never route, reply for the orchestrator or give themselves work.'],
]

// The state outside ticket worktrees belongs to the host.
const STATE_PATH = /\.superagent[\\/]+(?!work[\\/])/

// Commands that publish text on a forge. `gh api` / `glab api` only write with a write method or fields.
const POSTS_CLI = /\bgh\s+(pr|issue)\s+(comment|create)\b|\bgh\s+pr\s+review\b|\bglab\s+(mr|issue)\s+(note|create|comment)\b/
const API_TEXT = /\b(gh|glab)\s+api\b[^\n]*\/(comments|replies|reviews|notes|discussions)\b/
const API_WRITE = /(?:-X|--method)\s+(?:POST|PATCH|PUT)\b|\s(?:-f|-F|--field|--raw-field|--input)\s/i
const API_GET = /(?:-X|--method)\s+GET\b/i
const NETWORK_WRITE = /\bgit\s+push\b|\bsuperagent\s+bitbucket-api\b[^\n]*--method\s+(?!GET)/i

// Text a posting command publishes: the command itself plus any body file it names.
function postedText(command, readFile) {
  const files = [...command.matchAll(/(?:--body-file|--description-file|-F\s+body=@|--field\s+body=@)\s*(?:"([^"]+)"|'([^']+)'|(\S+))/g)]
  return [command, ...files.map((m) => readFile(m[1] ?? m[2] ?? m[3]))].join('\n')
}

function isPost(command) {
  if (POSTS_CLI.test(command)) return true
  return API_TEXT.test(command) && API_WRITE.test(command) && !API_GET.test(command)
}

function normalize(p) {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function inside(child, parent) {
  const rel = path.relative(normalize(parent), normalize(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// Paths a file tool call touches: file_path / notebook_path, path, and an absolute glob pattern.
function touchedPaths(input) {
  const { file_path: file, notebook_path: notebook, path: dir, pattern } = input.tool_input ?? {}
  const absolutePattern = pattern && path.isAbsolute(pattern) ? pattern.split(/[*?{[]/)[0] : null
  return [file, notebook, dir, absolutePattern].filter(Boolean).map((p) => path.resolve(input.cwd ?? '.', p))
}

function hostState(projectDir) {
  const state = normalize(path.join(projectDir, '.superagent'))
  const work = normalize(path.join(projectDir, '.superagent', 'work'))
  return (p) => inside(p, state) && !inside(p, work)
}

function routerDecision(input, { projectDir }) {
  if (!READ_TOOLS.includes(input.tool_name)) return deny('The router only routes: no shell and no edits. Return decisions as JSON instead.')
  const outside = touchedPaths(input).find((p) => !inside(p, projectDir))
  return outside ? deny(`The router reads only inside the repository, not ${outside}.`) : null
}

function leavesMachine(command, posts) {
  return posts || NETWORK_WRITE.test(command)
}

function shellDecision(command, { banner, readFile, forges }) {
  if (STATE_PATH.test(command)) return deny('Leave .superagent/ to the host: use the superagent commands for ticket state.')
  for (const [pattern, reason] of WORKER_FORBIDDEN) if (pattern.test(command)) return deny(reason)
  const posts = isPost(command)
  if (!forges.length && leavesMachine(command, posts)) {
    return deny('No forge is configured, so this ticket is local only: commit on the ticket branch and do not push or post.')
  }
  if (posts && !postedText(command, readFile).includes(banner)) return deny(`Every forge message starts with this line: ${banner}`)
  return null
}

function workerDecision(input, options) {
  if (WRITE_TOOLS.includes(input.tool_name)) {
    const state = touchedPaths(input).find(hostState(options.projectDir))
    return state ? deny(`Leave ${state} to the host: use the superagent commands for ticket state.`) : null
  }
  if (!SHELLS.includes(input.tool_name)) return null
  return shellDecision(input.tool_input?.command ?? '', options)
}

export function decide(input, options = {}) {
  const agent = input.agent_type ?? ''
  const full = { banner: DEFAULT_BANNER, readFile: safeRead, projectDir: input.cwd ?? '.', forges: [], ...options }
  if (ROUTER.test(agent)) return routerDecision(input, full)
  if (WORKER.test(agent)) return workerDecision(input, full)
  return null
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function deny(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
}

function settings(projectDir) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(projectDir, '.superagent', 'config.json'), 'utf8'))
    const forges = Object.values(config.sources ?? {}).filter((s) => s.kind !== 'local' && s.enabled !== false)
    return { banner: config.banner ?? DEFAULT_BANNER, forges }
  } catch {
    return { banner: DEFAULT_BANNER, forges: [] }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'))
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd
  const result = decide(input, { ...settings(projectDir), projectDir })
  if (result) process.stdout.write(JSON.stringify(result))
}
