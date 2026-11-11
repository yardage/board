import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { downloadTo } from '../../src/server/host/download.ts'

const folder = mkdtempSync(join(tmpdir(), 'board-download-'))
after(() => rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
const file = (name: string) => join(folder, name)
const node = (script: string) => ['-e', script]

describe('downloading an update', () => {
  it('writes the whole file and reports its progress', async () => {
    const seen: number[] = []
    await downloadTo(process.execPath, node("process.stdout.write('abc');setTimeout(()=>process.stdout.write('de'),20)"), file('whole'), 5, (ratio) => seen.push(ratio))
    assert.equal(readFileSync(file('whole'), 'utf8'), 'abcde')
    assert.equal(seen.at(-1), 1)
  })

  it('refuses a file that came in part, and says why', async () => {
    await assert.rejects(downloadTo(process.execPath, node("process.stdout.write('abc')"), file('short'), 5, () => undefined), /3 octets sur 5/)
    await assert.rejects(downloadTo(process.execPath, node("console.error('HTTP 404');process.exit(1)"), file('error'), 5, () => undefined), /HTTP 404/)
  })

  it('gives up when nothing comes, and stops the command', async () => {
    await assert.rejects(downloadTo(process.execPath, node('setTimeout(()=>{},60000)'), file('stall'), 5, () => undefined, 100), /ne progresse plus/)
  })

  it('fails when the command does not exist', async () => {
    await assert.rejects(downloadTo('board-no-such-command', [], file('none'), 5, () => undefined))
  })
})
