// Copies what the board wrote before environments existed into an environment's clone, then commits and pushes it.
//   node scripts/import-board.mjs --from <a checkout of the app's repository from before environments> --to <the environment's clone>
// Threads and reports are copied as they are: a file already in the environment is left alone, so the script
// can run again at the cut-over to bring what was written since. Presence isn't copied: it is now in the
// environment's variables. Old author names are read through the configuration's `aliases`.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const option = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const from = option('from')
const to = option('to')
if (!from || !to || !existsSync(join(to, 'board.json'))) {
  console.error('Usage: node scripts/import-board.mjs --from <old board checkout> --to <environment clone with board.json>')
  process.exit(1)
}

const git = (...args) => execFileSync('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', ...args], { cwd: to, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()

let copied = 0
let kept = 0
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const source = join(dir, name)
    const path = relative(from, source)
    const target = join(to, path)
    if (statSync(source).isDirectory()) {
      walk(source)
      continue
    }
    if (existsSync(target)) {
      kept++
      continue
    }
    mkdirSync(join(target, '..'), { recursive: true })
    copyFileSync(source, target)
    copied++
  }
}
for (const folder of ['threads', 'reports']) if (existsSync(join(from, folder))) walk(join(from, folder))
console.log(`${copied} files copied, ${kept} already there.`)
if (!copied) process.exit(0)
git('pull', '--rebase', '--quiet')
git('add', '--force', '--', 'threads', 'reports')
git('commit', '--quiet', '-m', 'board: imported threads and reports from before environments')
git('push', '--quiet')
console.log('Committed and pushed.')
