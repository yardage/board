// Bundles the app's main process and the CLI: Electron can't strip types inside its archive.
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'

const shared = { bundle: true, platform: 'node', target: 'node22', logLevel: 'warning' }

/** Where this build's updates come from: the GitHub repository it was built from, so a fork or a move needs no change. */
function releases() {
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()
  const match = /github\.com[:/]([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/.exec(remote)
  if (!match) throw new Error(`The origin remote is not a GitHub repository: ${remote}`)
  return match[1]
}

await build({ ...shared, entryPoints: ['src/desktop/main.ts'], outfile: 'out/main.cjs', format: 'cjs', external: ['electron'], define: { __APP_REPOSITORY__: JSON.stringify(releases()) } })
await build({ ...shared, entryPoints: ['src/cli/board.ts'], outfile: 'out/board.mjs', format: 'esm' })
