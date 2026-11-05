// PreToolUse guard for the plugin's own subagents. It never touches the user's main session.
// Router: no shell, and reads only inside the repository, since it reads strangers' text.
// Worker: no merging, closing issues or approving; GitHub posts must start with the banner.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROUTER = /^superagent:router$/
const WORKER = /^superagent:worker$/
const DEFAULT_BANNER = 'This is by an automated agent, not a human.'

const WORKER_FORBIDDEN = [
  [/\bgh\s+pr\s+merge\b/, 'A person merges ticket PRs; the worker never merges or enables auto-merge.'],
  [/\bgh\s+issue\s+close\b/, 'Workers never close issues.'],
  [/\bgh\s+pr\s+review\b[^\n]*--approve/, 'Never approve on behalf of a reviewer.'],
  [/\bmergePullRequest\b|\benablePullRequestAutoMerge\b/, 'A person merges ticket PRs.'],
]

// Commands that publish text on GitHub. `gh api` only writes with a write method or with fields.
const POSTS_CLI = /\bgh\s+(pr|issue)\s+(comment|create)\b|\bgh\s+pr\s+review\b/
const API_TEXT = /\bgh\s+api\b[^\n]*\/(comments|replies|reviews)\b/
const API_WRITE = /(?:-X|--method)\s+(?:POST|PATCH|PUT)\b|\s(?:-f|-F|--field|--raw-field|--input)\s/i
const API_GET = /(?:-X|--method)\s+GET\b/i

// Text a posting command publishes: the command itself plus any body file it names.
function postedText(command, readFile) {
  const files = [...command.matchAll(/(?:--body-file|-F\s+body=@|--field\s+body=@)\s*(?:"([^"]+)"|'([^']+)'|(\S+))/g)]
  return [command, ...files.map((m) => readFile(m[1] ?? m[2] ?? m[3]))].join('\n')
}

function isPost(command) {
  if (POSTS_CLI.test(command)) return true
  return API_TEXT.test(command) && API_WRITE.test(command) && !API_GET.test(command)
}

const READ_TOOLS = ['Read', 'Grep', 'Glob']

function normalize(p) {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

// Paths a read tool call touches: file_path, path, and an absolute glob pattern.
function touchedPaths(input) {
  const { file_path: file, path: dir, pattern } = input.tool_input ?? {}
  const absolutePattern = pattern && path.isAbsolute(pattern) ? pattern.split(/[*?{[]/)[0] : null
  return [file, dir, absolutePattern].filter(Boolean).map((p) => path.resolve(input.cwd ?? '.', p))
}

function inside(child, parent) {
  const rel = path.relative(normalize(parent), normalize(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// The router reads strangers' text, so it gets no shell and reads only inside the repository.
function routerDecision(input, projectDir) {
  if (!READ_TOOLS.includes(input.tool_name)) return deny('The router only routes: it has no shell. Return decisions as JSON instead.')
  const outside = touchedPaths(input).find((p) => !inside(p, projectDir))
  return outside ? deny(`The router reads only inside the repository, not ${outside}.`) : null
}

function workerDecision(command, { banner, readFile }) {
  for (const [pattern, reason] of WORKER_FORBIDDEN) if (pattern.test(command)) return deny(reason)
  if (isPost(command) && !postedText(command, readFile).includes(banner)) {
    return deny(`Every GitHub message starts with this line: ${banner}`)
  }
  return null
}

export function decide(input, { banner = DEFAULT_BANNER, readFile = safeRead, projectDir = input.cwd ?? '.' } = {}) {
  const agent = input.agent_type ?? ''
  if (ROUTER.test(agent)) return routerDecision(input, projectDir)
  if (!WORKER.test(agent) || READ_TOOLS.includes(input.tool_name)) return null
  return workerDecision(input.tool_input?.command ?? '', { banner, readFile })
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

function bannerFor(cwd) {
  try {
    const config = JSON.parse(fs.readFileSync(`${cwd}/.superagent/config.json`, 'utf8'))
    return config.banner ?? DEFAULT_BANNER
  } catch {
    return DEFAULT_BANNER
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'))
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd
  const result = decide(input, { banner: bannerFor(projectDir), projectDir })
  if (result) process.stdout.write(JSON.stringify(result))
}
