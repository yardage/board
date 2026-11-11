import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { systemPrompt } from '../../src/server/ai/agent.ts'
import { type AgentFolders, agentFile, agentPath, globMatcher, runFileTool } from '../../src/server/ai/file-tools.ts'
import { useProvider } from '../../src/server/ai/harness.ts'
import { runTool, type ToolContext, toolsFor } from '../../src/server/ai/tools.ts'
import { startTestBoard, testConfig } from '../support/helpers.ts'

/**
 * A board's folders and, beside them, a canary an agent must never read: by its full path, through `..`, through a
 * link or a junction inside the folders, or by a name Windows reads otherwise than it looks.
 */
let base: string
let folders: AgentFolders
let canary: string
const CANARY = 'canary-words-never-read'
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4510000000049454e44ae426082', 'hex')

before(() => {
  base = mkdtempSync(join(tmpdir(), 'board-files-'))
  const board = join(base, 'board')
  folders = { work: join(board, '.cache', 'knowledge'), named: { reports: join(board, 'reports'), threads: join(board, 'threads') } }
  const outside = join(base, 'outside')
  mkdirSync(outside, { recursive: true })
  canary = join(outside, 'secret.txt')
  writeFileSync(canary, `${CANARY}\n`)
  const repo = join(folders.work, 'repos', 'acme', 'app')
  mkdirSync(join(repo, 'docs', 'deep'), { recursive: true })
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(folders.work, 'github'), { recursive: true })
  mkdirSync(join(folders.named.reports), { recursive: true })
  mkdirSync(join(folders.named.threads, 't1', 'attachments'), { recursive: true })
  writeFileSync(join(board, '.cache', 'agent.json'), '{}')
  writeFileSync(join(repo, 'README.md'), '# App\nThe probe runs every minute.\nSee docs.\n')
  writeFileSync(join(repo, 'docs', 'deep', 'notes.md'), 'Deep notes: PROBE in capitals.\n')
  writeFileSync(join(repo, 'main.ts'), 'export const probe = 1\n')
  writeFileSync(join(repo, '.git', 'config'), `[remote] ${CANARY}\n`)
  writeFileSync(join(repo, 'blob.bin'), Buffer.from([1, 0, 2, 3]))
  writeFileSync(join(repo, 'empty.md'), '')
  writeFileSync(join(repo, 'long.txt'), Array.from({ length: 2500 }, (_, at) => `line ${at + 1}`).join('\n'))
  writeFileSync(join(folders.work, 'github', 'README.md'), 'Copied at noon.\n')
  writeFileSync(join(folders.named.reports, '2026-11-09-day.json'), '{"day":"2026-11-09"}\n')
  writeFileSync(join(folders.named.threads, 't1', 'attachments', 'shot.png'), PNG)
  // A link to a folder outside, and one to the canary itself: Windows makes the first without rights, as a junction.
  symlinkSync(outside, join(repo, 'out'), process.platform === 'win32' ? 'junction' : 'dir')
  try {
    symlinkSync(canary, join(repo, 'secret-link.txt'), 'file')
  } catch {
    // A file link needs rights Windows doesn't give everyone: the junction covers the same case.
  }
})

after(() => rmSync(base, { recursive: true, force: true }))

const call = (name: string, input: unknown) => runFileTool(name, input, folders)

describe('a path an agent gives', () => {
  it('names a file of its folders, relative to its working directory or by reports/ and threads/', () => {
    assert.equal(agentFile('github/README.md', folders), join(folders.work, 'github', 'README.md'))
    assert.equal(agentFile('reports/2026-11-09-day.json', folders), join(folders.named.reports, '2026-11-09-day.json'))
    assert.equal(agentFile('threads\\t1\\attachments\\shot.png', folders), join(folders.named.threads, 't1', 'attachments', 'shot.png'))
    assert.equal(agentFile(join(folders.named.threads, 't1', 'attachments', 'shot.png'), folders), join(folders.named.threads, 't1', 'attachments', 'shot.png'), 'an attached file by its full path')
    assert.equal(agentFile('', folders), folders.work)
    assert.equal(agentPath(join(folders.named.reports, 'a.json'), folders), 'reports/a.json')
    assert.equal(agentPath(join(folders.work, 'repos', 'x.md'), folders), 'repos/x.md')
  })

  it('never leaves them, whatever Windows would read', () => {
    for (const path of [
      canary,
      '../agent.json',
      'repos/../../agent.json',
      'reports/../.cache/agent.json',
      'repos/acme/app/.git/config',
      'repos/acme/app/.GIT/config',
      'repos/acme/app/.git./config',
      'repos/acme/app/.git /config',
      'repos/acme/app/README.md:hidden',
      'repos/acme/app/nul',
      'repos/acme/app/CON.txt',
      '\\\\localhost\\c$\\Windows\\win.ini',
      '//?/C:/Windows/win.ini',
      '/etc/passwd',
      'C:relative.txt',
      'repos/*.md',
      42,
      null,
    ]) {
      assert.equal(agentFile(path, folders), null, String(path))
    }
  })
})

describe('read_file', () => {
  it('reads a text with its line numbers, and a long one in parts', async () => {
    const readme = await call('read_file', { path: 'repos/acme/app/README.md' })
    assert.equal(readme.isError, undefined)
    assert.match(readme.text, /^repos\/acme\/app\/README\.md:\n1\t# App\n2\tThe probe runs every minute\.\n3\tSee docs\.$/)
    const first = await call('read_file', { path: 'repos/acme/app/long.txt' })
    assert.match(first.text, /2000\tline 2000\n\(Lines 1 to 2000 of 2500: read on with offset 2001\.\)$/)
    const rest = await call('read_file', { path: 'repos/acme/app/long.txt', offset: 2400, limit: 3 })
    assert.match(rest.text, /^repos\/acme\/app\/long\.txt:\n2400\tline 2400\n2401\tline 2401\n2402\tline 2402\n/)
    assert.equal((await call('read_file', { path: 'repos/acme/app/long.txt', offset: 3000 })).isError, true)
    assert.match((await call('read_file', { path: 'repos/acme/app/empty.md' })).text, /is empty/)
  })

  it('reads an image as one, and refuses what isn’t text', async () => {
    const image = await call('read_file', { path: join(folders.named.threads, 't1', 'attachments', 'shot.png') })
    assert.equal(image.image?.mimeType, 'image/png')
    assert.equal(image.image?.data, PNG.toString('base64'))
    const blob = await call('read_file', { path: 'repos/acme/app/blob.bin' })
    assert.equal(blob.isError, true)
    assert.match(blob.text, /isn't text/)
    assert.match((await call('read_file', { path: 'repos/acme/app/docs' })).text, /is a folder/)
  })

  it('refuses the canary by every way to it, and never says what is in it', async () => {
    for (const path of [canary, '../../../outside/secret.txt', 'repos/acme/app/out/secret.txt', 'repos/acme/app/secret-link.txt', 'repos/acme/app/.git/config', 'repos/acme/app/.git./config']) {
      const found = await call('read_file', { path })
      assert.equal(found.isError, true, path)
      assert.ok(!found.text.includes(CANARY), path)
    }
  })
})

describe('list_files', () => {
  it('lists a folder, and the working directory with its neighbours', async () => {
    const top = await call('list_files', {})
    assert.deepEqual(top.text.split('\n'), ['.:', 'github/', 'repos/', 'reports/', 'threads/'])
    const app = await call('list_files', { path: 'repos/acme/app' })
    assert.ok(app.text.includes('README.md') && app.text.includes('docs/'))
    assert.ok(!app.text.includes('.git') && !app.text.includes('out'), 'no .git, and no link')
    assert.deepEqual((await call('list_files', { path: 'reports' })).text.split('\n'), ['reports:', '2026-11-09-day.json'])
  })

  it('finds files by a pattern, never through a link or in .git', async () => {
    const found = (await call('list_files', { pattern: '**/*.md' })).text.split('\n')
    assert.deepEqual(found, ['github/README.md', 'repos/acme/app/docs/deep/notes.md', 'repos/acme/app/empty.md', 'repos/acme/app/README.md'])
    assert.deepEqual((await call('list_files', { path: 'repos/acme/app', pattern: '*.md' })).text.split('\n'), ['repos/acme/app/empty.md', 'repos/acme/app/README.md'])
    assert.match((await call('list_files', { pattern: '**/secret*' })).text, /^Nothing matches/)
    assert.equal((await call('list_files', { pattern: '*'.repeat(30) })).isError, true)
    assert.equal((await call('list_files', { path: canary })).isError, true)
  })
})

describe('search_files', () => {
  it('finds a text as it is written, with where it is', async () => {
    const found = (await call('search_files', { text: 'probe' })).text.split('\n')
    assert.deepEqual(found, ['repos/acme/app/docs/deep/notes.md:1: Deep notes: PROBE in capitals.', 'repos/acme/app/main.ts:1: export const probe = 1', 'repos/acme/app/README.md:2: The probe runs every minute.'])
    assert.equal((await call('search_files', { text: 'probe', case_sensitive: true, pattern: '**/*.md' })).text, 'repos/acme/app/README.md:2: The probe runs every minute.')
    assert.equal((await call('search_files', { text: '.*', path: 'repos/acme/app/README.md' })).text, 'Nothing found.', 'never a regular expression')
    assert.equal((await call('search_files', { text: 'noon', path: 'github/README.md' })).text, 'github/README.md:1: Copied at noon.')
  })

  it('never finds the canary', async () => {
    for (const path of [undefined, 'repos/acme/app', 'repos/acme/app/out', canary]) {
      const found = await call('search_files', { text: CANARY, path })
      assert.ok(!found.text.includes(CANARY) || found.isError, String(path))
      assert.ok(!found.text.includes('secret.txt'), String(path))
    }
  })
})

describe('a pattern of names', () => {
  it('matches as a shell would', () => {
    const md = globMatcher('*.md')!
    assert.ok(md('a.md') && !md('x/a.md'))
    const deep = globMatcher('**/*.md')!
    assert.ok(deep('a.md') && deep('x/y/a.MD') && !deep('a.mdx'))
    const docs = globMatcher('docs/**')!
    assert.ok(docs('docs/a/b.ts') && !docs('src/docs/a'))
    const one = globMatcher('v?.txt')!
    assert.ok(one('v1.txt') && !one('v10.txt') && !one('v/.txt'))
    assert.equal(globMatcher(''), null)
    assert.equal(globMatcher('x'.repeat(201)), null)
  })

  it('takes no time on a pattern made to be slow', () => {
    const slow = globMatcher(`${'*a'.repeat(10)}b`)!
    const started = Date.now()
    for (let at = 0; at < 100; at++) assert.equal(slow('a'.repeat(250)), false)
    assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`)
  })
})

describe('a run’s tools', () => {
  const context = (files: AgentFolders | null): ToolContext => ({
    github: null as never,
    config: testConfig(),
    owner: 'vbarbanneau',
    asker: 'vbarbanneau',
    act: false,
    members: ['vbarbanneau'],
    thread: { id: 't1', title: 'T' },
    files,
  })

  it('is told how its program reads: Claude Code with its own tools, Codex with the board’s', () => {
    const member = { login: 'vbarbanneau', name: 'Victor', admin: false }
    const setup = { owner: member, members: [member], config: testConfig(), language: 'en' as const, act: false }
    const claude = systemPrompt(setup)
    const codex = systemPrompt({ ...setup, boardFiles: true })
    assert.match(claude, /search with Grep and Glob/)
    assert.ok(!claude.includes('read_file'))
    assert.match(codex, /read_file, list_files and search_files/)
    assert.match(codex, /tools\.mcp__board__read_file/)
    assert.ok(!codex.includes('Grep'))
  })

  it('has the file tools only when its program reads through the board', async () => {
    const names = (files: AgentFolders | null) => toolsFor(context(files)).map((tool) => tool.name)
    assert.deepEqual(names(folders).slice(0, 3), ['read_file', 'list_files', 'search_files'])
    assert.ok(!names(null).includes('read_file'))
    assert.match((await runTool('read_file', { path: 'github/README.md' }, context(null))).text, /Unknown tool/)
    assert.match((await runTool('read_file', { path: 'github/README.md' }, context(folders))).text, /Copied at noon/)
  })
})

/**
 * A stand-in for Codex that does what Codex does with the board's tools: it starts the bridge from its command line,
 * lists the tools and calls them, then answers. It writes down what it was given and what it got, and spends nothing.
 */
const STAND_IN = String.raw`#!/usr/bin/env node
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const [seen, calls] = [process.env.STAND_IN_SEEN, JSON.parse(process.env.STAND_IN_CALLS)]
const args = process.argv.slice(2)
const value = (key) => (args.find((arg) => arg.startsWith(key + '=')) ?? '').slice(key.length + 1)
const env = {}
for (const found of value('mcp_servers.board.env').matchAll(/(\w+) = ("(?:[^"\\]|\\.)*")/g)) env[found[1]] = JSON.parse(found[2])
const bridge = spawn(JSON.parse(value('mcp_servers.board.command')), JSON.parse(value('mcp_servers.board.args')), { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] })
let buffer = ''
const waiting = new Map()
bridge.stdout.setEncoding('utf8').on('data', (chunk) => {
  buffer += chunk
  for (let at; (at = buffer.indexOf('\n')) >= 0; ) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (line.trim()) { const answer = JSON.parse(line); waiting.get(answer.id)?.(answer) }
  }
})
let next = 1
const ask = (method, params) => new Promise((done) => { const id = next++; waiting.set(id, done); bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
process.stdin.resume()
process.stdin.on('end', async () => {
  await ask('initialize', { protocolVersion: '2025-06-18' })
  const tools = (await ask('tools/list', {})).result.tools
  const results = []
  for (const [name, input] of calls) {
    process.stdout.write(JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'board', tool: name, arguments: input } }) + '\n')
    results.push((await ask('tools/call', { name, arguments: input })).result)
  }
  bridge.kill()
  fs.writeFileSync(seen, JSON.stringify({ args, tools, results }))
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Read what I could.' } }) + '\n')
})
`

describe('a Codex run', () => {
  it('reads its folders through the board, and nothing beside them', async () => {
    const root = join(base, 'run')
    mkdirSync(join(root, 'client'), { recursive: true })
    execFileSync('git', ['init', '-q', root])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'test'])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid'])
    writeFileSync(join(root, '.gitignore'), '.cache\nclient\n')
    execFileSync('git', ['-C', root, 'add', '.gitignore'])
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'start'])
    writeFileSync(join(root, 'client', 'index.html'), 'page')
    const knowledge = join(root, '.cache', 'knowledge')
    mkdirSync(join(knowledge, 'github'), { recursive: true })
    writeFileSync(join(knowledge, 'github', 'README.md'), 'Copied at noon.\n')
    symlinkSync(join(base, 'outside'), join(knowledge, 'github', 'out'), process.platform === 'win32' ? 'junction' : 'dir')
    const seen = join(base, 'seen.json')
    const script = join(base, 'codex.cjs')
    writeFileSync(script, STAND_IN)
    process.env.BOARD_CODEX = script
    process.env.STAND_IN_SEEN = seen
    process.env.STAND_IN_CALLS = JSON.stringify([
      ['read_file', { path: 'github/README.md' }],
      ['read_file', { path: canary }],
      ['read_file', { path: 'github/out/secret.txt' }],
      ['search_files', { text: CANARY }],
      ['list_files', { pattern: '**/*' }],
    ])
    process.env.BOARD_PERSON = 'victor'
    const running = await startTestBoard({
      root,
      client: join(root, 'client'),
      tools: { command: [process.execPath, '--disable-warning=ExperimentalWarning', resolve('src/cli/board.ts'), 'mcp'], env: {} },
    })
    // After the board has read its settings, which choose Claude Code.
    useProvider('codex')
    try {
      const api = `${running.url}/api/threads`
      const post = (url: string, body: unknown = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify(body) })
      const { id } = (await (await post(api, { body: 'Où en est la copie ?' })).json()) as { id: string }
      assert.equal((await post(`${api}/${id}/draft`)).status, 202)
      let view: { draft: { body: string } | null; agentError: string | null } = { draft: null, agentError: null }
      for (let at = 0; at < 600 && !view.draft && !view.agentError; at++) {
        await new Promise((done) => setTimeout(done, 50))
        view = (await (await fetch(`${api}/${id}`)).json()) as typeof view
      }
      assert.equal(view.agentError, null)
      assert.equal(view.draft?.body, 'Read what I could.')
      assert.ok(existsSync(seen))
      const { args, tools, results } = JSON.parse(readFileSync(seen, 'utf8')) as { args: string[]; tools: { name: string; annotations: { readOnlyHint: boolean } }[]; results: { content: { text: string }[]; isError: boolean }[] }
      assert.ok(args.includes('shell_tool') && args.includes('unified_exec') && args.includes('view_image'))
      assert.deepEqual(tools.slice(0, 3).map((tool) => tool.name), ['read_file', 'list_files', 'search_files'])
      assert.ok(tools.every((tool) => tool.annotations.readOnlyHint === !['issue_create', 'comment', 'item_update', 'project_set'].includes(tool.name)))
      const [inside, full, linked, searched, listed] = results.map((result) => ({ text: result.content[0].text, isError: result.isError }))
      assert.match(inside.text, /Copied at noon/)
      for (const refused of [full, linked]) assert.equal(refused.isError, true)
      for (const answer of [full, linked, searched, listed]) assert.ok(!answer.text.includes(CANARY) && !answer.text.includes('secret.txt'), answer.text)
      assert.equal(listed.text, 'github/README.md', 'no link followed')
    } finally {
      await running.stop()
      useProvider('claude')
      for (const key of ['BOARD_CODEX', 'STAND_IN_SEEN', 'STAND_IN_CALLS']) delete process.env[key]
    }
  })
})
