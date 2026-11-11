import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { startTestBoard as startBoard } from '../support/helpers.ts'
import { DEFAULT_TEXT_SIZE, stepTextSize, TEXT_SIZES, TEXT_ZOOM } from '../../src/shared/text-size.ts'

const temp: string[] = []
afterEach(() => {
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function clone() {
  const root = mkdtempSync(join(tmpdir(), 'board-size-'))
  temp.push(root)
  execFileSync('git', ['init', '-q', root])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'test'])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid'])
  writeFileSync(join(root, '.gitignore'), '.cache\nclient\n')
  execFileSync('git', ['-C', root, 'add', '.gitignore'])
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'start'])
  mkdirSync(join(root, 'client'))
  writeFileSync(join(root, 'client', 'index.html'), 'page')
  return root
}
const claude = { status: async () => ({ installed: true, version: '1', loggedIn: true, method: null, plan: null }), login: async () => undefined }

describe('the size of the app', () => {
  it('keeps the size it always had as the default, called large', () => {
    assert.equal(DEFAULT_TEXT_SIZE, 'large')
    assert.equal(TEXT_ZOOM.large, 1)
  })

  it('grows with each size, and stops at the ends', () => {
    const zooms = TEXT_SIZES.map((size) => TEXT_ZOOM[size])
    assert.deepEqual(zooms, [...zooms].sort((a, b) => a - b))
    assert.equal(stepTextSize('small', -1), 'small')
    assert.equal(stepTextSize('small', 1), 'medium')
    assert.equal(stepTextSize('larger', 1), 'larger')
    assert.equal(stepTextSize('larger', -1), 'large')
  })

  it('is saved and handed to the window, and refused when unknown', async () => {
    process.env.BOARD_PERSON = 'victor'
    const root = clone()
    const told: number[] = []
    const running = await startBoard({ root, client: join(root, 'client'), port: 4832, loops: false, claude, onTextSize: (zoom) => told.push(zoom) })
    try {
      const choose = (size: unknown) => fetch(`${running.url}/api/settings/text-size`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify({ size }) })
      assert.equal(running.textSize(), 'large')
      assert.equal((await choose('huge')).status, 400)
      assert.deepEqual(told, [])
      assert.equal((await choose('small')).status, 200)
      assert.equal(running.textSize(), 'small')
      assert.deepEqual(told, [0.8])
      assert.equal(JSON.parse(readFileSync(join(root, '.cache', 'settings.json'), 'utf8')).textSize, 'small')
      assert.equal((await (await fetch(`${running.url}/api/me`)).json()).textSize, 'small')
    } finally {
      await running.stop()
    }
    const again = await startBoard({ root, client: join(root, 'client'), port: 4832, loops: false, claude })
    try {
      assert.equal(again.textSize(), 'small', 'it comes back after a restart')
      assert.equal((await (await fetch(`${again.url}/api/me`)).json()).textSize, null, 'a browser keeps its own zoom')
    } finally {
      await again.stop()
    }
  })
})
