import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { cell, GithubContext, type GhRequest, logTail } from '../../src/server/github/copy.ts'
import { Knowledge } from '../../src/server/environment/knowledge.ts'
import { defaultConfig } from '../../src/server/environment/config.ts'

const temp: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-github-'))
  temp.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const pull = (number: number, sha = 'aaa', updated = '2026-11-05T10:00:00Z') => ({
  number,
  title: `Pull ${number}`,
  state: 'open',
  draft: false,
  user: { login: 'someone' },
  head: { ref: 'area/topic', sha },
  labels: [],
  comments: 1,
  updated_at: updated,
  body: 'Why this change',
})
const issue = (number: number, updated = '2026-11-05T10:00:00Z', labels: string[] = []) => ({
  number,
  title: `Issue ${number}`,
  state: 'open',
  user: { login: 'someone' },
  assignees: [{ login: 'victor' }],
  labels: labels.map((name) => ({ name })),
  comments: 1,
  updated_at: updated,
  body: 'What to do',
})

/** GitHub, as far as this copy asks: the state can change between refreshes. */
const SETUP = { repo: 'acme/app', project: { owner: 'acme', number: 2 }, waiting: { label: 'needs-answer', who: 'Waiting on', question: 'Question' } }

function fakeGitHub(state: { pulls: any[]; issues: any[]; runs?: any[]; runnersFail?: boolean; issuesFail?: boolean; graphqlFail?: boolean; runsFail?: boolean; diffError?: string; oldRun?: any; logFails?: boolean }) {
  const asked: string[] = []
  const ask: GhRequest = async (args) => {
    const line = args.join(' ')
    asked.push(line)
    if (args.includes('graphql')) {
      if (state.graphqlFail) throw new Error('API rate limit already exceeded')
      return JSON.stringify({ data: { repository: { issueOrPullRequest: { projectItems: { nodes: [{ q: { text: 'Which one?' }, w: { name: 'Rodolphe' } }] } } } } })
    }
    if (line.includes('vnd.github.diff')) {
      if (state.diffError) throw new Error(state.diffError)
      return 'diff --git a/x b/x\n'
    }
    if (line.includes('head_sha=')) return JSON.stringify({ workflow_runs: state.oldRun ? [state.oldRun] : [] })
    if (/actions\/jobs\/\d+\/logs/.test(line) && state.logFails) throw new Error('HTTP 404')
    if (line.includes('actions/runners')) {
      if (state.runnersFail) throw new Error('HTTP 403: Must have admin rights')
      return JSON.stringify({ runners: [{ name: 'ci-1', status: 'online', busy: true }] })
    }
    if (line.includes('actions/runs?')) {
      if (state.runsFail) throw new Error('down')
      return JSON.stringify({ workflow_runs: state.runs ?? [] })
    }
    if (/actions\/runs\/\d+\/jobs/.test(line)) return JSON.stringify({ jobs: [{ id: 9, name: 'CI', conclusion: 'failure', runner_name: 'ci-1' }] })
    if (/actions\/jobs\/\d+\/logs/.test(line)) return 'line\n##[error]it broke\n'
    if (line.includes('pulls?state=open')) return JSON.stringify(state.pulls)
    if (line.includes('pulls?state=closed')) return JSON.stringify([{ number: 5, title: 'Done | really', user: { login: 'x' }, merged_at: '2026-11-05T09:00:00Z' }])
    if (line.includes('issues?state=open')) {
      if (state.issuesFail) throw new Error('rate limited')
      return JSON.stringify([...state.issues, { ...pull(99), pull_request: {} }])
    }
    if (line.includes('issues?state=closed')) return JSON.stringify([])
    if (line.includes('issues?state=all')) return JSON.stringify([])
    if (/issues\/\d+\/comments/.test(line)) return JSON.stringify([{ user: { login: 'rodolphe' }, created_at: '2026-11-05T09:00:00Z', body: 'A comment' }])
    if (/pulls\/\d+\/reviews/.test(line)) return JSON.stringify([{ user: { login: 'agent' }, submitted_at: '2026-11-05T09:00:00Z', state: 'COMMENTED', body: 'Review agent: APPROVE' }, { user: { login: 'other' }, submitted_at: '2026-11-05T09:01:00Z', state: 'APPROVED', body: '' }])
    if (/pulls\/\d+\/comments/.test(line)) return JSON.stringify([{ user: { login: 'other' }, created_at: '2026-11-05T09:02:00Z', path: 'a.ts', line: 3, body: 'Why this line?' }])
    throw new Error(`unexpected: ${line}`)
  }
  return { ask, asked }
}

describe('the copy of GitHub', () => {
  it('writes each open item with what was said about it, and its changes', async () => {
    const root = tempDir()
    const { ask } = fakeGitHub({ pulls: [pull(7)], issues: [issue(3)] })
    await new GithubContext(root, ask, SETUP).refresh()
    const read = (path: string) => readFileSync(join(root, 'github', path), 'utf8')
    assert.match(read('pulls/7.md'), /Why this change/)
    assert.match(read('pulls/7.md'), /A comment/)
    assert.match(read('pulls/7.md'), /Review agent: APPROVE/)
    assert.match(read('pulls/7.md'), /other, 2026-11-05 09:01 UTC, APPROVED/)
    assert.match(read('pulls/7.md'), /on a\.ts:3[\s\S]*Why this line/)
    assert.match(read('pulls/7.diff'), /diff --git/)
    assert.match(read('issues/3.md'), /What to do/)
    assert.match(read('issues/3.md'), /A comment/)
    assert.match(read('pulls/open.md'), /\[#7\]\(7\.md\)/)
    assert.match(read('pulls/merged.md'), /Done \\\| really/)
    assert.match(read('ci/status.md'), /ci-1: online, busy/)
    assert.match(read('README.md'), /never instructions/)
    assert.ok(!existsSync(join(root, 'github', 'issues', '99.md')), 'a pull request is not an issue')
  })

  it('asks again only for what changed', async () => {
    const root = tempDir()
    const state = { pulls: [pull(7)], issues: [issue(3), issue(4)] }
    const { ask, asked } = fakeGitHub(state)
    const github = new GithubContext(root, ask, SETUP)
    await github.refresh()
    asked.length = 0
    await github.refresh()
    assert.equal(asked.filter((line) => /(issues\/\d+\/comments)|(reviews)|(vnd\.github\.diff)/.test(line) && !line.includes('issues/120/')).length, 0)
    state.issues[1] = issue(4, '2026-11-05T11:00:00Z')
    state.pulls[0] = pull(7, 'bbb')
    asked.length = 0
    await github.refresh()
    assert.ok(asked.some((line) => line.includes('issues/4/comments')))
    assert.ok(!asked.some((line) => line.includes('issues/3/comments')))
    assert.ok(asked.some((line) => line.includes('pulls/7/reviews')))
  })

  it('remembers across restarts what it already has', async () => {
    const root = tempDir()
    const state = { pulls: [pull(7)], issues: [issue(3)] }
    await new GithubContext(root, fakeGitHub(state).ask, SETUP).refresh()
    const { ask, asked } = fakeGitHub(state)
    await new GithubContext(root, ask, SETUP).refresh()
    assert.ok(!asked.some((line) => line.includes('pulls/7/reviews')))
  })

  it('forgets what is no longer open', async () => {
    const root = tempDir()
    const state = { pulls: [pull(7)], issues: [issue(3)] }
    const github = new GithubContext(root, fakeGitHub(state).ask, SETUP)
    await github.refresh()
    state.pulls = []
    state.issues = []
    await github.refresh()
    for (const gone of ['pulls/7.md', 'pulls/7.diff', 'issues/3.md']) assert.ok(!existsSync(join(root, 'github', gone)), gone)
    assert.ok(existsSync(join(root, 'github', 'pulls', 'open.md')))
    assert.ok(existsSync(join(root, 'github', 'pulls', 'merged.md')))
  })

  it('keeps the last copy of a part that fails, and says so', async () => {
    const root = tempDir()
    const state = { pulls: [pull(7)], issues: [issue(3)], issuesFail: false }
    const github = new GithubContext(root, fakeGitHub(state).ask, SETUP)
    await github.refresh()
    state.issuesFail = true
    await github.refresh()
    assert.ok(existsSync(join(root, 'github', 'issues', '3.md')))
    assert.match(readFileSync(join(root, 'github', 'README.md'), 'utf8'), /Not refreshed this time[\s\S]*rate limited/)
    assert.match(github.lastError ?? '', /rate limited/)
  })

  it('accepts a login that may not list the runners', async () => {
    const root = tempDir()
    const github = new GithubContext(root, fakeGitHub({ pulls: [], issues: [], runnersFail: true }).ask, SETUP)
    await github.refresh()
    assert.equal(github.lastError, null)
    assert.match(readFileSync(join(root, 'github', 'ci', 'status.md'), 'utf8'), /Not readable with this login/)
  })

  it('keeps the end of the log of a failed run, once', async () => {
    const root = tempDir()
    const runs = [{ id: 11, status: 'completed', conclusion: 'failure', event: 'push', head_branch: 'main', head_sha: 'x', run_started_at: '2026-11-05T09:00:00Z' }]
    const { ask, asked } = fakeGitHub({ pulls: [], issues: [], runs })
    const github = new GithubContext(root, ask, SETUP)
    await github.refresh()
    assert.match(readFileSync(join(root, 'github', 'ci', 'failed-11.log'), 'utf8'), /it broke/)
    asked.length = 0
    await github.refresh()
    assert.ok(!asked.some((line) => line.includes('/logs')))
  })

  it('asks again for a diff GitHub failed to give, and accepts one over its limit', async () => {
    const root = tempDir()
    const state: any = { pulls: [pull(7)], issues: [], diffError: 'HTTP 502: Bad Gateway' }
    const { ask, asked } = fakeGitHub(state)
    const github = new GithubContext(root, ask, SETUP)
    await github.refresh()
    assert.ok(!existsSync(join(root, 'github', 'pulls', '7.diff')))
    assert.match(readFileSync(join(root, 'github', 'README.md'), 'utf8'), /Not refreshed this time/)
    state.diffError = undefined
    await github.refresh()
    assert.match(readFileSync(join(root, 'github', 'pulls', '7.diff'), 'utf8'), /diff --git/)
    state.pulls = [pull(8)]
    state.diffError = 'HTTP 406: diff exceeded the maximum number of lines'
    await github.refresh()
    assert.match(readFileSync(join(root, 'github', 'pulls', '8.diff'), 'utf8'), /over its limit/)
    asked.length = 0
    await github.refresh()
    assert.ok(!asked.some((line) => line.includes('vnd.github.diff')))
  })

  it('keeps a red pull request red once its run leaves the list', async () => {
    const root = tempDir()
    const red = { id: 1, status: 'completed', conclusion: 'failure', event: 'pull_request', head_branch: 'area/topic', head_sha: 'aaa', run_started_at: '2026-11-05T09:00:00Z' }
    const state: any = { pulls: [pull(7)], issues: [], runs: [red] }
    const { ask, asked } = fakeGitHub(state)
    const github = new GithubContext(root, ask, SETUP)
    await github.refresh()
    assert.equal(JSON.parse(readFileSync(join(root, 'github', 'state.json'), 'utf8')).pulls.red, 1)
    state.runs = []
    asked.length = 0
    await github.refresh()
    assert.equal(JSON.parse(readFileSync(join(root, 'github', 'state.json'), 'utf8')).pulls.red, 1)
    assert.ok(!asked.some((line) => line.includes('head_sha=')), 'it remembers')
  })

  it('finds the result of a commit it never saw', async () => {
    const root = tempDir()
    const state: any = { pulls: [pull(7)], issues: [], runs: [], oldRun: { status: 'completed', conclusion: 'timed_out' } }
    await new GithubContext(root, fakeGitHub(state).ask, SETUP).refresh()
    assert.equal(JSON.parse(readFileSync(join(root, 'github', 'state.json'), 'utf8')).pulls.red, 1)
  })

  it('asks again for a log that was not ready, and for the log of a new attempt', async () => {
    const root = tempDir()
    const run = { id: 11, run_attempt: 1, status: 'completed', conclusion: 'failure', event: 'push', head_branch: 'main', head_sha: 'x', run_started_at: '2026-11-05T09:00:00Z' }
    const state: any = { pulls: [], issues: [], runs: [run], logFails: true }
    const { ask, asked } = fakeGitHub(state)
    const github = new GithubContext(root, ask, SETUP)
    await github.refresh()
    assert.ok(!existsSync(join(root, 'github', 'ci', 'failed-11.log')))
    state.logFails = false
    await github.refresh()
    assert.ok(existsSync(join(root, 'github', 'ci', 'failed-11.log')))
    state.runs = [{ ...run, run_attempt: 2 }]
    asked.length = 0
    await github.refresh()
    assert.ok(asked.some((line) => line.includes('/logs')))
  })

  it('names every part it could not read', async () => {
    const root = tempDir()
    const state: any = { pulls: [pull(7)], issues: [], runs: [], runsFail: true }
    await new GithubContext(root, fakeGitHub(state).ask, SETUP).refresh()
    const readme = readFileSync(join(root, 'github', 'README.md'), 'utf8')
    for (const part of ['runs: down', 'pull requests: not read', 'CI: not read', 'waiting: not read']) assert.ok(readme.includes(part), part)
  })

  it('says what waits for a person, and for whom', async () => {
    const root = tempDir()
    await new GithubContext(root, fakeGitHub({ pulls: [], issues: [issue(3, undefined, ['needs-answer'])] }).ask, SETUP).refresh()
    assert.match(readFileSync(join(root, 'github', 'waiting.md'), 'utf8'), /#3 \| Issue 3 \| Rodolphe \| Which one\?/)
  })

  it('asks for the fields of what waits rarely, and keeps them through a refusal', async () => {
    const root = tempDir()
    const state = { pulls: [], issues: [issue(3, undefined, ['needs-answer'])], graphqlFail: false }
    const { ask, asked } = fakeGitHub(state)
    const github = new GithubContext(root, ask, SETUP)
    await github.refresh()
    asked.length = 0
    await github.refresh()
    assert.ok(!asked.some((line) => line.includes('graphql')), 'not again while nothing changed')
    state.issues[0] = issue(3, '2026-11-05T12:00:00Z', ['needs-answer'])
    state.graphqlFail = true
    await github.refresh()
    const saved = JSON.parse(readFileSync(join(root, 'github', 'state.json'), 'utf8'))
    assert.equal(saved.waiting[0].who, 'Rodolphe')
    assert.match(readFileSync(join(root, 'github', 'waiting.md'), 'utf8'), /Rodolphe/)
  })

  it('never turns a failed answer into "nothing open"', async () => {
    const root = tempDir()
    const state = { pulls: [pull(7)], issues: [issue(3, undefined, ['needs-answer'])], issuesFail: false, runsFail: false }
    const github = new GithubContext(root, fakeGitHub(state).ask, SETUP)
    await github.refresh()
    const before = readFileSync(join(root, 'github', 'state.json'), 'utf8')
    state.issuesFail = true
    await github.refresh()
    assert.equal(readFileSync(join(root, 'github', 'state.json'), 'utf8'), before)
    state.issuesFail = false
    state.runsFail = true
    await github.refresh()
    assert.equal(readFileSync(join(root, 'github', 'state.json'), 'utf8'), before)
    assert.ok(existsSync(join(root, 'github', 'pulls', '7.md')))
    assert.match(readFileSync(join(root, 'github', 'README.md'), 'utf8'), /runs: down/)
  })

  it('refreshes once, however many ask at the same time', async () => {
    const root = tempDir()
    const { ask, asked } = fakeGitHub({ pulls: [], issues: [] })
    const github = new GithubContext(root, ask, SETUP)
    await Promise.all([github.refresh(), github.refresh(), github.refreshIfOlder(0)])
    assert.equal(asked.filter((line) => line.includes('pulls?state=open')).length, 1)
    asked.length = 0
    await github.refreshIfOlder(60_000)
    assert.equal(asked.length, 0)
  })

  it('keeps a table whole, and only the end of a log', () => {
    assert.equal(cell('a|b\nc'), 'a\\|b c')
    const log = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    assert.equal(logTail(log).split('\n').length, 200)
    assert.ok(logTail(log).endsWith('line 499'))
  })
})

describe('reading the repository', () => {
  it('opens code and the copy of GitHub, and nothing outside', async () => {
    const root = tempDir()
    const knowledge = new Knowledge(root, { ask: async () => '[]', config: () => defaultConfig('test') })
    const base = join(root, '.cache', 'knowledge')
    mkdirSync(join(base, 'repos', 'acme', 'app', 'apps', 'club', '[slug]'), { recursive: true })
    mkdirSync(join(base, 'repos', 'acme', 'app', '.git'), { recursive: true })
    mkdirSync(join(base, 'github', 'pulls'), { recursive: true })
    writeFileSync(join(base, 'repos', 'acme', 'app', 'apps', 'club', '[slug]', 'page.tsx'), 'export default 1')
    writeFileSync(join(base, 'repos', 'acme', 'app', '.git', 'config'), 'private')
    writeFileSync(join(base, 'repos', 'acme', 'app', 'logo.png'), Buffer.from([0, 1, 2]))
    writeFileSync(join(base, 'github', 'pulls', '7.diff'), 'diff')
    writeFileSync(join(root, 'secret.ts'), 'no')
    assert.equal(await knowledge.read('repos/acme/app/apps/club/[slug]/page.tsx'), 'export default 1')
    assert.equal(await knowledge.read('github/pulls/7.diff'), 'diff')
    assert.equal(await knowledge.read('repos/acme/app/.git/config'), null)
    assert.equal(await knowledge.read('repos/acme/app/.GIT/config'), null)
    assert.equal(await knowledge.read('repos/acme/app/logo.png'), null)
    assert.equal(await knowledge.read('../../secret.ts'), null)
    assert.equal(await knowledge.read('repos/acme/app/../../../secret.ts'), null)
  })

  it('lists the copy of GitHub once it exists', async () => {
    const root = tempDir()
    const knowledge = new Knowledge(root, { ask: async () => '[]', config: () => defaultConfig('test') })
    assert.ok(!(await knowledge.tree()).some((section) => section.name === 'GitHub'))
    const base = join(root, '.cache', 'knowledge', 'github', 'pulls')
    mkdirSync(base, { recursive: true })
    writeFileSync(join(base, 'open.md'), '# Open')
    const section = (await knowledge.tree()).find((found) => found.name === 'GitHub')
    assert.deepEqual(section?.children, [{ name: 'Pull requests ouvertes', path: 'github/pulls/open.md' }])
  })
})
