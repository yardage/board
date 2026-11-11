import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { REPORT_THEME, reportTheme } from '../../src/server/board/personal-settings.ts'
import { startTestBoard as startBoard } from '../support/helpers.ts'
import { coloursOf, contrast, derive, FIXED_ROLES, isTheme, PRESET_COLOURS, themeOf, themeProblem, WINDOW_COLOURS, windowColours } from '../../src/shared/themes.ts'

const temp: string[] = []
afterEach(() => {
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const styles = new URL('../../src/client/styles/', import.meta.url)
const css = readFileSync(new URL('tokens.css', styles), 'utf8')
const roles = (block: string) => Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
const blockOf = (selector: string) => {
  const start = css.indexOf(`${selector} {`)
  assert.notEqual(start, -1, selector)
  return roles(css.slice(start, css.indexOf('}', start)))
}
const defaults = blockOf(':root')
const cssRoles = { default: defaults, omarchy: { ...defaults, ...blockOf("html[data-theme='omarchy']") } }

describe('the themes', () => {
  it('say the same thing in the stylesheet, the window and a report page', () => {
    for (const theme of ['omarchy'] as const) {
      const report = roles(REPORT_THEME[theme].replace('}', ';}'))
      assert.equal(WINDOW_COLOURS[theme].background, cssRoles[theme]['--bg'], theme)
      assert.equal(WINDOW_COLOURS[theme].symbols, cssRoles[theme]['--fg'], theme)
      assert.equal(report['--background'], cssRoles[theme]['--bg'], theme)
      for (const n of [1, 2, 3, 4, 5, 6]) assert.equal(report[`--chart-${n}`], cssRoles[theme][`--chart-${n}`], `${theme} chart ${n}`)
    }
  })

  it('gives the themes made of three colours the same window, report page and roles', () => {
    for (const theme of ['default', 'custom'] as const) {
      const colours = coloursOf(theme, null)
      const roles = derive(colours)
      const report = roles && Object.fromEntries([...reportTheme(theme, null).replace('}body', ';}body').matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
      assert.equal(windowColours(theme, null).background, roles['--bg'], theme)
      assert.equal(windowColours(theme, null).symbols, roles['--fg'], theme)
      assert.equal(report['--background'], roles['--bg'], theme)
      assert.equal(report['--chart-1'], FIXED_ROLES['--chart-1'], theme)
    }
    const mine = { bg: '#101820', text: '#e8f0f8', accent: '#ffb347' }
    assert.equal(windowColours('custom', mine).background, '#101820')
    assert.match(reportTheme('custom', mine), /--primary:#ffb347/)
  })

  it('keeps the presets as the stylesheet has them', () => {
    for (const theme of ['default', 'omarchy'] as const) {
      assert.equal(PRESET_COLOURS[theme].bg, cssRoles[theme]['--bg'], theme)
      assert.equal(PRESET_COLOURS[theme].accent, cssRoles[theme]['--accent'], theme)
    }
  })

  it('writes at the top of the stylesheet what the default theme derives, so the first drawing has it', () => {
    assert.deepEqual(Object.fromEntries(Object.entries(defaults).filter(([role]) => role in derive(PRESET_COLOURS.default))), derive(PRESET_COLOURS.default))
  })

  it('only makes a theme of colours that can be read on a dark surface', () => {
    for (const preset of Object.values(PRESET_COLOURS)) assert.equal(themeProblem(preset), null)
    assert.match(themeProblem({ bg: '#ffffff', text: '#000000', accent: '#333333' }) ?? '', /sombre/)
    assert.match(themeProblem({ bg: '#101010', text: '#303030', accent: '#d0d0d0' }) ?? '', /texte/i)
    assert.match(themeProblem({ bg: '#101010', text: '#f0f0f0', accent: '#202020' }) ?? '', /accent/i)
    assert.match(themeProblem({ bg: 'red', text: '#f0f0f0', accent: '#d0d0d0' }) ?? '', /inconnue/)
    assert.match(themeProblem(null) ?? '', /inconnue/)
    for (const preset of Object.values(PRESET_COLOURS)) {
      const roles = derive(preset)
      assert.ok(contrast(roles['--muted'], roles['--bg']) >= 4.5, 'muted text stays readable')
      assert.ok(contrast(roles['--faint'], roles['--bg']) >= 3, 'faint text stays visible')
    }
  })

  it('reads the names of themes from before as the ones that replace them', () => {
    assert.equal(themeOf('board'), 'omarchy')
    assert.equal(themeOf('site'), 'default')
    assert.equal(themeOf('ink'), 'default')
    assert.equal(themeOf('custom'), 'custom')
    assert.equal(themeOf('t3'), null)
  })

  it('has no colour of its own outside the roles', () => {
    const rules = readdirSync(styles).filter((file) => file.endsWith('.css') && file !== 'tokens.css').map((file) => readFileSync(new URL(file, styles), 'utf8')).join('\n')
    assert.match(rules, /box-sizing/)
    assert.doesNotMatch(rules, /#[0-9a-f]{3,8}\b|rgb\(/i)
  })

  it('reads the theme that was removed as the default, and refuses it', async () => {
    assert.equal(isTheme('t3'), false)
    process.env.BOARD_PERSON = 'victor'
    const root = mkdtempSync(join(tmpdir(), 'board-themes-'))
    temp.push(root)
    execFileSync('git', ['init', '-q', root])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'test'])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid'])
    writeFileSync(join(root, '.gitignore'), '.cache\nclient\n')
    execFileSync('git', ['-C', root, 'add', '.gitignore'])
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'start'])
    mkdirSync(join(root, 'client'))
    writeFileSync(join(root, 'client', 'index.html'), 'page')
    mkdirSync(join(root, '.cache'))
    writeFileSync(join(root, '.cache', 'settings.json'), JSON.stringify({ language: 'fr', theme: 't3' }))
    const running = await startBoard({ root, client: join(root, 'client'), port: 4833, loops: false, claude: { status: async () => ({ installed: true, version: '1', loggedIn: true, method: null, plan: null }), login: async () => undefined } })
    try {
      assert.equal(running.theme(), 'default')
      const choose = (theme: string) => fetch(`${running.url}/api/settings/theme`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify({ theme }) })
      assert.equal((await choose('t3')).status, 400)
      assert.equal((await choose('omarchy')).status, 200)
      assert.equal(running.theme(), 'omarchy')
      assert.equal(running.themeColours(), null)
      assert.equal((await choose('default')).status, 200)
      assert.equal(running.theme(), 'default')
      const send = (body: unknown) => fetch(`${running.url}/api/settings/theme`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify(body) })
      const mine = { bg: '#101820', text: '#e8f0f8', accent: '#ffb347' }
      assert.equal((await send({ theme: 'custom' })).status, 400, 'no colours yet')
      assert.equal((await send({ theme: 'custom', colours: { ...mine, bg: '#ffffff' } })).status, 400)
      assert.equal(running.theme(), 'default', 'a refused choice changes nothing')
      assert.equal((await send({ theme: 'custom', colours: mine })).status, 200)
      assert.deepEqual(running.themeColours(), mine)
      assert.deepEqual(JSON.parse(readFileSync(join(root, '.cache', 'settings.json'), 'utf8')).themeColours, mine)
      assert.equal((await choose('omarchy')).status, 200)
      assert.deepEqual(running.themeColours(), mine, 'the colours wait for the next time')
      assert.equal((await choose('custom')).status, 200, 'and come back')
      assert.equal(running.theme(), 'custom')
      const status = await (await fetch(`${running.url}/api/me`)).json()
      assert.deepEqual(status.themeColours, mine)
      assert.deepEqual(await (await fetch(`${running.url}/api/agent-ready`)).json(), { ready: true })
    } finally {
      await running.stop()
    }
  })
})
