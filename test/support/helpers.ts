import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type BoardOptions, openBoard, type RunningBoard } from '../../src/server/board/board.ts'
import { CONFIG_FILE, defaultConfig, type EnvironmentConfig, formatConfig, MARK_FILE, type Member } from '../../src/server/environment/config.ts'
import { Github } from '../../src/server/github/client.ts'
import { appServer, listenFrom } from '../../src/server/host/host.ts'
import type { Live } from '../../src/server/environment/live.ts'

/**
 * A board opened the way the app opens one, on a folder of the test's, with nothing that reaches the
 * network: GitHub refuses, and who is online is empty unless a test says otherwise. The two members
 * keep their old names as aliases, as the real environment's configuration does.
 */

export const MEMBERS: Member[] = [
  { login: 'rodolphebarbanneau', name: 'Rodolphe', admin: true },
  { login: 'vbarbanneau', name: 'Victor', admin: false },
]
export const LOGIN_OF: Record<string, string> = { victor: 'vbarbanneau', rodolphe: 'rodolphebarbanneau' }

export const testConfig = (change: Partial<EnvironmentConfig> = {}): EnvironmentConfig => ({
  ...defaultConfig('test', 'Europe/Paris'),
  aliases: {
    victor: { login: 'vbarbanneau', agent: false },
    rodolphe: { login: 'rodolphebarbanneau', agent: false },
    'agent-victor': { login: 'vbarbanneau', agent: true },
    'agent-rodolphe': { login: 'rodolphebarbanneau', agent: true },
  },
  ...change,
})

/** GitHub that answers nothing: a test that needs it says what it answers. */
export const offline = () => new Github({ token: async () => 'test', fetch: (async () => new Response('{"message":"no network in tests"}', { status: 503 })) as typeof fetch })

export const quietLive = (members: { login: string; online: boolean; reply: 'off' | 'auto' | 'draft' }[] = []) => {
  const state = { members: members.map((member) => ({ ...member, at: new Date().toISOString() })), hosts: [], at: Date.now(), error: null }
  return { read: async () => state, last: state, announce: async () => undefined } as unknown as Live
}

/** A program that says it is there and signed in, without running: its real state reads the person's login. */
export const readyProgram = () => ({ status: async () => ({ installed: true, version: 'test', loggedIn: true, method: null, plan: null }), login: async () => undefined })

export interface TestBoard extends RunningBoard {
  url: string
  /** The old name of the person this board belongs to. */
  person: string
}

export async function startTestBoard(
  options: Partial<BoardOptions> & { root: string; client: string; port?: number; person?: string; config?: Partial<EnvironmentConfig> },
): Promise<TestBoard> {
  const person = options.person ?? process.env.BOARD_PERSON ?? 'victor'
  const login = LOGIN_OF[person] ?? person
  mkdirSync(join(options.root, 'config'), { recursive: true })
  if (!existsSync(join(options.root, MARK_FILE))) writeFileSync(join(options.root, MARK_FILE), '{"board":1}\n')
  if (!existsSync(join(options.root, CONFIG_FILE)) || options.config) writeFileSync(join(options.root, CONFIG_FILE), formatConfig(testConfig(options.config)))
  let port = 0
  const { root, client, person: _person, config: _config, port: wanted, personHome: given, ...rest } = options
  // A home of the test's own: the developer's keeps their programs' folders, and Codex's catalogue in one.
  const personHome = given ?? mkdtempSync(join(tmpdir(), 'board-person-'))
  const board = await openBoard({
    root,
    client,
    repo: 'acme/agora',
    github: offline(),
    settingsFile: join(root, '.cache', 'settings.json'),
    personHome,
    url: () => `http://127.0.0.1:${port}`,
    login,
    members: MEMBERS,
    live: quietLive(),
    loops: false,
    claude: readyProgram(),
    codex: readyProgram(),
    ...rest,
  })
  const server = appServer(client, () => port, (req, res, url) => board.handle(req, res, url))
  // Any free port, unless a test asks for one: two boards in one test can then never collide.
  port = await listenFrom(server, wanted ?? 0)
  return {
    ...board,
    url: `http://127.0.0.1:${port}`,
    person,
    stop: async () => {
      await board.stop()
      await new Promise<void>((done) => server.close(() => done()))
      if (!given) rmSync(personHome, { recursive: true, force: true })
    },
  }
}
