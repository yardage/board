// The board in a browser, from a clone of this repository: `npm start`. The installed app is src/desktop/main.ts.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHost } from './host/host.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
/** The clone's own version, which the About page shows beside "started from the code". */
const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }).version
const host = await startHost({
  home: process.env.BOARD_HOME ?? join(homedir(), '.board'),
  client: join(root, 'dist'),
  port: Number(process.env.BOARD_PORT) || 4780,
  version,
  board: {
    // Agents reach the board's tools through this same CLI, run by Node.
    tools: { command: [process.execPath, '--disable-warning=ExperimentalWarning', join(root, 'src', 'cli', 'board.ts'), 'mcp'], env: {} },
  },
})
console.log(`Board: ${host.url}`)
