import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * The window has no title bar: its top row and the headers drag it. On Windows a drag area takes every click and hover
 * over it, and its children inherit it, so whatever can be clicked, hovered or opened takes it back.
 * Checked in the installed app at 125%, asking Windows what each spot is; this keeps the rule from drifting.
 */
const STYLES = join(import.meta.dirname, '..', '..', 'src', 'client', 'styles')
const css = Object.fromEntries(readdirSync(STYLES).filter((name) => name.endsWith('.css')).map((name) => [name, readFileSync(join(STYLES, name), 'utf8')]))
const rules = (text: string) => [...text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }))
const list = (selector: string) => selector.split(',').map((part) => part.trim().replace(/\s+/g, ' ')).filter(Boolean)

describe('the areas that drag the window', () => {
  const shell = rules(css['shell.css'])
  const dragged = shell.filter((rule) => /app-region:\s*drag/.test(rule.body))
  const headers = dragged.filter((rule) => !['.drag-strip', '.window-drag'].includes(rule.selector))
  const givenBack = shell.find((rule) => /app-region:\s*no-drag/.test(rule.body) && rule.selector.startsWith(':where('))

  it('are the headers, in one rule, and the top row of the window, and only in the shell', () => {
    assert.equal(headers.length, 1)
    assert.deepEqual(dragged.map((rule) => rule.selector).filter((selector) => selector !== headers[0].selector).sort(), ['.drag-strip', '.window-drag'])
    for (const [name, text] of Object.entries(css)) {
      if (name === 'shell.css') continue
      assert.ok(!/app-region:\s*drag/.test(text), `${name} makes its own drag area`)
    }
  })

  it('lie under every screen when they cover the whole top of the window', () => {
    const row = shell.find((rule) => rule.selector === '.window-drag')?.body ?? ''
    assert.match(row, /position:\s*fixed/)
    assert.match(row, /z-index:\s*-1/)
  })

  it('give back, wherever it is, what is clicked, hovered or opened, without outweighing a header', () => {
    assert.ok(givenBack, 'no rule gives the page back its controls')
    const inside = list(givenBack.selector.slice(':where('.length, givenBack.selector.lastIndexOf(')')))
    for (const needed of ['button', 'a', 'input', '[title]', '[data-says]', '[tabindex]', '[role]', '.menu', '.people']) assert.ok(inside.includes(needed), needed)
  })

  it('never lie under what closes on a click beside it', () => {
    const overlays = shell.find((rule) => /app-region:\s*no-drag/.test(rule.body) && rule.selector.includes('.overlay'))
    assert.deepEqual(list(overlays?.selector ?? ''), ['.overlay', '.palette-back', '.set-ask-scrim'])
  })
})
