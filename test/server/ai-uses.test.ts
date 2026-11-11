import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { AGENT_PERMISSIONS, agentArgs, AgentRunner } from '../../src/server/ai/agent.ts'
import type { BoardOptions } from '../../src/server/board/board.ts'
import { defaultConfig } from '../../src/server/environment/config.ts'
import { startTestBoard as startBoard } from '../support/helpers.ts'
import type { Knowledge } from '../../src/server/environment/knowledge.ts'
import { aiRun, translateArgs } from '../../src/server/ai/translate.ts'
import { CODEX_LOCKED, failureOf, agentArgs as programArgs, readCodexEvent, readCodexStatus, textArgs, usePath, useProvider } from '../../src/server/ai/harness.ts'
import { choiceFor, defaultChoices, forProvider, parseChoice, parseChoices, parseThreadChoices } from '../../src/shared/ai-uses.ts'

const DEFAULT_CHOICES = defaultChoices('claude')

const temp: string[] = []
afterEach(() => {
  delete process.env.BOARD_CLAUDE
  delete process.env.BOARD_CODEX
  usePath('claude', null)
  useProvider('claude')
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-models-'))
  temp.push(dir)
  return dir
}
const post = (url: string, body: unknown = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify(body) })

/** A stand-in for Claude Code that writes down how it was started, so no test spends anything. */
function fakeClaude() {
  const dir = tempDir()
  const seen = join(dir, 'seen.txt')
  const script = `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)) + '\\n')
process.stdin.resume()
process.stdin.on('end', () => process.stdout.write(process.argv.includes('stream-json') ? JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }) + '\\n' : 'done'))
`
  writeFileSync(join(dir, 'claude.cjs'), script)
  process.env.BOARD_CLAUDE = join(dir, 'claude.cjs')
  return () => readFileSync(seen, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[])
}
const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)

describe('the choices', () => {
  it('lets only known models and efforts through', () => {
    assert.deepEqual(parseChoice({ model: 'opus', effort: 'max' }), { model: 'opus', effort: 'max' })
    assert.deepEqual(parseChoice({ model: '', effort: '' }), { model: '', effort: '' })
    for (const bad of [{ model: '--allowedTools', effort: '' }, { model: 'opus', effort: 'x' }, { model: 'opus' }, { effort: 'low' }, null, 'opus', [], { model: ['opus'], effort: '' }]) assert.equal(parseChoice(bad), null)
  })

  it('reads a damaged file as the defaults, and a translation always names a model', () => {
    assert.deepEqual(parseChoices(undefined), DEFAULT_CHOICES)
    assert.deepEqual(parseChoices('x'), DEFAULT_CHOICES)
    const read = parseChoices({ reply: { model: 'sonnet', effort: 'high' }, synthesis: { model: 'nope', effort: '' }, translation: { model: '', effort: 'low' }, other: { model: 'opus', effort: '' } })
    assert.deepEqual(read.reply, { model: 'sonnet', effort: 'high' })
    assert.deepEqual(read.synthesis, DEFAULT_CHOICES.synthesis)
    assert.deepEqual(read.translation, DEFAULT_CHOICES.translation)
    assert.ok(!('other' in read))
  })

  it('keeps under a thread only what differs, and only what runs in a thread', () => {
    const kept = parseThreadChoices({ reply: { model: 'opus', effort: '' }, synthesis: { model: '', effort: '' }, translation: { model: 'opus', effort: '' }, summary: { model: 'x', effort: '' }, draft: { model: '--x', effort: '' } })
    assert.deepEqual(kept, { reply: { model: 'opus', effort: '' }, summary: { model: 'x', effort: '' } }, 'a thread keeps what any program could run')
    assert.deepEqual(forProvider(kept, 'claude'), { reply: { model: 'opus', effort: '' } }, 'and the program that runs takes only what it knows')
    assert.deepEqual(forProvider({ reply: { model: 'opus', effort: 'max' } }, 'codex'), {}, 'nothing of Claude Code reaches Codex')
    assert.deepEqual(forProvider({ reply: { model: 'gpt-6-luna', effort: 'minimal' } }, 'codex'), { reply: { model: 'gpt-6-luna', effort: 'minimal' } })
    assert.deepEqual(parseThreadChoices(null), {})
  })

  it('knows each program’s models, and what Codex’s catalogue adds', () => {
    assert.deepEqual(parseChoice({ model: 'gpt-6-luna', effort: 'minimal' }, 'codex'), { model: 'gpt-6-luna', effort: 'minimal' })
    assert.equal(parseChoice({ model: 'opus', effort: '' }, 'codex'), null)
    assert.equal(parseChoice({ model: 'gpt-7-new', effort: '' }, 'codex'), null)
    assert.deepEqual(parseChoice({ model: 'gpt-7-new', effort: '' }, 'codex', ['gpt-7-new']), { model: 'gpt-7-new', effort: '' })
    assert.equal(parseChoice({ model: 'rm -rf', effort: '' }, 'codex', ['rm -rf']), null)
    assert.deepEqual(defaultChoices('codex').translation, { model: 'gpt-6-luna', effort: '' })
  })

  it('takes a thread over the settings, field by field, and never for a translation', () => {
    const general = parseChoices({ reply: { model: 'sonnet', effort: 'high' } })
    assert.deepEqual(choiceFor(general, { reply: { model: '', effort: 'max' } }, 'reply'), { model: 'sonnet', effort: 'max' })
    assert.deepEqual(choiceFor(general, { reply: { model: 'opus', effort: '' } }, 'reply'), { model: 'opus', effort: 'high' })
    assert.deepEqual(choiceFor(general, undefined, 'reply'), { model: 'sonnet', effort: 'high' })
    assert.deepEqual(choiceFor(general, { reply: { model: 'opus', effort: '' } }, 'translation'), DEFAULT_CHOICES.translation)
  })
})

describe('the command lines', () => {
  it('adds a model and an effort to the agent, and nothing to what it may do', () => {
    const plain = agentArgs('p.txt', ['a'], { model: '', effort: '' })
    assert.ok(!plain.includes('--model') && !plain.includes('--effort'))
    const chosen = agentArgs('p.txt', ['a'], { model: 'opus', effort: 'xhigh' })
    assert.equal(flag(chosen, '--model'), 'opus')
    assert.equal(flag(chosen, '--effort'), 'xhigh')
    assert.deepEqual(chosen.slice(1, 1 + AGENT_PERMISSIONS.length), AGENT_PERMISSIONS)
    assert.equal(flag(chosen, '--tools'), 'Read,Grep,Glob')
    assert.equal(flag(chosen, '--permission-mode'), 'dontAsk')
    assert.ok(!chosen.includes('--allowedTools'))
  })

  it('adds a model and an effort to a translation, which keeps no tool at all', () => {
    const args = translateArgs('sonnet', 'file.txt', 'low')
    assert.equal(flag(args, '--model'), 'sonnet')
    assert.equal(flag(args, '--effort'), 'low')
    assert.equal(flag(args, '--tools'), '')
    assert.ok(!args.includes('--allowedTools'))
    assert.ok(!translateArgs('haiku', 'file.txt').includes('--effort'))
  })

  it('starts the program with them, for a reply, a task and a translation', async () => {
    const seen = fakeClaude()
    const home = tempDir()
    const knowledge = { agentDirs: [join(home, 'a'), join(home, 'b')], boardRoot: home } as unknown as Knowledge
    const asked: string[] = []
    const owner = { login: 'vbarbanneau', name: 'Victor', admin: false }
    const runner = new AgentRunner({
      knowledge,
      onActivity: () => undefined,
      setup: () => ({ owner, members: [owner], config: defaultConfig('test'), language: 'fr' }),
      choice: (use, threadId) => {
        asked.push(`${use}:${threadId}`)
        return use === 'reply' ? { model: 'opus', effort: 'max' } : { model: 'sonnet', effort: '' }
      },
    })
    const thread = { id: 't1', title: 'x', kind: 'topic', author: 'vbarbanneau', createdAt: new Date().toISOString() } as never
    const run = { thread, messages: [], now: 'now', task: 't', asker: 'vbarbanneau', act: false }
    assert.equal((await runner.answer({ ...run, use: 'reply', streams: true })).body, 'done')
    assert.equal((await runner.answer({ ...run, use: 'synthesis', doing: 'd', streams: false })).body, 'done')
    assert.equal(await aiRun(() => ({ model: 'fable', effort: 'low' }))('system', 'text'), 'done')
    assert.deepEqual(asked, ['reply:t1', 'synthesis:t1'])
    const [reply, synthesis, translation] = seen()
    assert.equal(flag(reply, '--model'), 'opus')
    assert.equal(flag(reply, '--effort'), 'max')
    assert.equal(flag(reply, '--tools'), 'Read,Grep,Glob')
    assert.equal(flag(synthesis, '--model'), 'sonnet')
    assert.equal(flag(synthesis, '--effort'), undefined)
    assert.equal(flag(translation, '--model'), 'fable')
    assert.equal(flag(translation, '--effort'), 'low')
    assert.equal(flag(translation, '--tools'), '')
  })
})

describe('where the program is', () => {
  it('is where the member said, for every run', async () => {
    const seen = fakeClaude()
    const script = process.env.BOARD_CLAUDE as string
    delete process.env.BOARD_CLAUDE
    usePath('claude', script)
    assert.equal(await aiRun(() => ({ model: 'haiku', effort: '' }))('system', 'text'), 'done')
    assert.equal(flag(seen()[0], '--model'), 'haiku')
  })
})

describe('Codex', () => {
  it('reads its version and its login', () => {
    assert.deepEqual(readCodexStatus('codex-cli 0.166.0', 'Logged in using ChatGPT'), { installed: true, version: '0.166.0', loggedIn: true, method: 'ChatGPT', plan: null })
    assert.equal(readCodexStatus('codex-cli 0.166.0', 'Not logged in').loggedIn, false)
    assert.equal(readCodexStatus('codex-cli 0.166.0', '').loggedIn, null)
    assert.equal(readCodexStatus('', '').installed, false)
  })

  it('never gets its shell, its image viewer, the web or the person’s apps, in any run', () => {
    const text = textArgs('codex', { model: '', effort: '' }, 'system.txt', 'out.txt')
    const agent = programArgs('codex', 'p.txt', ['a'], { model: '', effort: '' }, { file: 'mcp.json', command: ['node', 'board.mjs', 'mcp'], env: {}, tools: ['read_file'] })
    const bare = programArgs('codex', 'p.txt', ['a'], { model: '', effort: '' }, null)
    for (const args of [text, agent, bare]) {
      // `--disable` fails closed: a Codex that doesn't know one of these refuses to start.
      for (const feature of ['shell_tool', 'unified_exec', 'view_image']) assert.ok(args.some((arg, at) => arg === feature && args[at - 1] === '--disable'), feature)
      for (const feature of ['apps', 'plugins', 'browser_use', 'computer_use']) assert.ok(args.includes(`features.${feature}=false`), feature)
      assert.ok(args.includes('web_search="disabled"'))
      assert.equal(flag(args, '--sandbox'), 'read-only')
      assert.ok(!args.some((arg) => /danger|workspace-write|enable/i.test(arg)))
    }
    assert.ok(CODEX_LOCKED.includes('shell_tool'))
    // Its folders are read through the board's tools: without them it can't read, so the run stops.
    assert.ok(agent.includes('mcp_servers.board.required=true'))
    assert.ok(agent.includes('mcp_servers.board.default_tools_approval_mode="approve"'))
  })

  it('says in a sentence that a Codex is too old to be locked down', () => {
    assert.match(failureOf('Error: Unknown feature flag: shell_tool'), /trop ancien/)
    assert.equal(failureOf('quota'), 'quota')
  })

  it('gets the board’s instructions, no settings of the person’s, a read-only sandbox and the board’s tools', () => {
    const text = textArgs('codex', { model: 'gpt-6-luna', effort: 'low' }, 'C:\\tmp\\system.txt', 'out.txt')
    assert.equal(flag(text, '-m'), 'gpt-6-luna')
    assert.ok(text.includes('model_reasoning_effort="low"'))
    assert.ok(text.includes('model_instructions_file="C:/tmp/system.txt"'))
    assert.ok(text.includes('--ignore-user-config') && text.includes('--ephemeral') && flag(text, '--sandbox') === 'read-only')
    assert.equal(flag(text, '-o'), 'out.txt')
    const agent = programArgs('codex', 'p.txt', ['a'], { model: '', effort: '' }, { file: 'mcp.json', command: ['node', 'C:\\x\\board.mjs', 'mcp'], env: { BOARD_TOOLS_TOKEN: 't"1' }, tools: ['github_read'] })
    assert.ok(!agent.includes('-m'))
    assert.ok(agent.includes('mcp_servers.board.command="node"'))
    assert.ok(agent.includes('mcp_servers.board.args=["C:\\\\x\\\\board.mjs", "mcp"]'))
    assert.ok(agent.includes('mcp_servers.board.env={ BOARD_TOOLS_TOKEN = "t\\"1" }'))
    assert.ok(agent.includes('--json'))
    assert.ok(!agent.some((arg) => arg.includes('danger')))
  })

  it('reads what it says, and what it does', () => {
    const path = (p: string) => (p.includes('knowledge') ? 'github/README.md' : null)
    assert.deepEqual(readCodexEvent(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hello' } }), path), { result: 'hello' })
    assert.deepEqual(readCodexEvent(JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'board', tool: 'github_issue', arguments: { repo: 'a/b', number: 3 } } }), path), { doing: 'Lit GitHub : github_issue a/b#3' })
    const read = (tool: string, args: Record<string, unknown>) => readCodexEvent(JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'board', tool, arguments: args } }), (p) => (p === 'github/README.md' ? p : null))
    assert.deepEqual(read('read_file', { path: 'github/README.md' }), { doing: 'Lit le fichier github/README.md', source: 'github/README.md' })
    assert.deepEqual(read('read_file', { path: 'C:/elsewhere/secret.txt' }), { doing: 'Lit le fichier C:/elsewhere/secret.txt', source: undefined }, 'a path outside is never a source')
    assert.deepEqual(read('search_files', { text: 'probe' }), { doing: 'Cherche dans les fichiers : probe' })
    assert.deepEqual(read('list_files', { pattern: '**/*.md' }), { doing: 'Cherche dans les fichiers : **/*.md' })
    const own = JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'codex', tool: 'list_mcp_resources', arguments: {} } })
    assert.deepEqual(readCodexEvent(own, path), {}, 'Codex’s own tools say nothing of what the agent does')
    assert.deepEqual(readCodexEvent(JSON.stringify({ type: 'turn.failed', error: { message: 'quota' } }), path), { error: 'quota' })
    assert.deepEqual(readCodexEvent('not json', path), {})
  })

  it('runs a text through it and reads the file it writes', async () => {
    const dir = tempDir()
    const script = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
process.stdin.resume()
process.stdin.on('end', () => { fs.writeFileSync(args[args.indexOf('-o') + 1], 'codex says ' + args[args.indexOf('-m') + 1]) })
`
    writeFileSync(join(dir, 'codex.cjs'), script)
    process.env.BOARD_CODEX = join(dir, 'codex.cjs')
    useProvider('codex')
    assert.equal(await aiRun(() => ({ model: 'gpt-6-luna', effort: '' }))('system', 'text'), 'codex says gpt-6-luna')
  })
})

describe('the board', () => {
  async function board(extra: Partial<BoardOptions> = {}) {
    process.env.BOARD_PERSON = 'victor'
    const root = tempDir()
    execFileSync('git', ['init', '-q', root])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'test'])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid'])
    writeFileSync(join(root, '.gitignore'), '.cache\nclient\n')
    execFileSync('git', ['-C', root, 'add', '.gitignore'])
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'start'])
    mkdirSync(join(root, 'client'))
    writeFileSync(join(root, 'client', 'index.html'), 'page')
    const start = () => startBoard({ root, client: join(root, 'client'), port: 4831, loops: false, claude: { status: async () => ({ installed: true, version: '1', loggedIn: true, method: null, plan: null }), login: async () => undefined }, ...extra })
    return { root, start }
  }

  it('keeps a choice on this computer only, and refuses what it does not know', async () => {
    const { root, start } = await board()
    let running = await start()
    try {
      const api = `${running.url}/api`
      assert.equal((await post(`${api}/settings/models`, { use: 'reply', model: 'opus', effort: 'high' })).status, 200)
      assert.equal((await post(`${api}/settings/models`, { use: 'reply', model: '--allowedTools', effort: '' })).status, 400)
      assert.equal((await post(`${api}/settings/models`, { use: 'nope', model: 'opus', effort: '' })).status, 400)
      assert.equal((await post(`${api}/settings/models`, { use: 'translation', model: '', effort: '' })).status, 400)
      assert.deepEqual(running.aiChoice('reply'), { model: 'opus', effort: 'high' })

      const thread = (await (await post(`${api}/threads`, { body: 'Une question ?', models: { reply: { model: 'fable', effort: '' }, summary: { model: 'x', effort: '' } } })).json()) as { id: string }
      assert.deepEqual(running.aiChoice('reply', thread.id), { model: 'fable', effort: 'high' })
      assert.deepEqual(running.aiChoice('summary', thread.id), DEFAULT_CHOICES.summary)

      const models = `${api}/threads/${thread.id}/models`
      assert.equal((await post(models, { use: 'synthesis', model: 'haiku', effort: 'low' })).status, 200)
      assert.equal((await post(models, { use: 'translation', model: 'opus', effort: '' })).status, 400)
      assert.equal((await post(`${api}/threads/2026-01-01-absent-0000/models`, { use: 'reply', model: 'opus', effort: '' })).status, 404)
      const read = (await (await fetch(models)).json()) as { ai: { thread: Record<string, unknown> } }
      assert.deepEqual(read.ai.thread.synthesis, { model: 'haiku', effort: 'low' })
      assert.ok(!('status' in read.ai), 'a thread’s panel never waits for the program')
      assert.deepEqual(running.aiChoice('synthesis', thread.id), { model: 'haiku', effort: 'low' })
      assert.equal((await post(models, { use: 'synthesis', model: '', effort: '' })).status, 200)
      assert.deepEqual(running.aiChoice('synthesis', thread.id), DEFAULT_CHOICES.synthesis)

      const history = execFileSync('git', ['-C', root, 'log', '-p', '--all', '--format=']).toString()
      assert.doesNotMatch(history, /fable|"effort"/)
      assert.match(readFileSync(join(root, '.cache', 'settings.json'), 'utf8'), /fable/)
      await running.stop()

      running = await start()
      assert.deepEqual(running.aiChoice('reply', thread.id), { model: 'fable', effort: 'high' })
    } finally {
      await running.stop()
    }
  })
})
