import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { count, dateLocale, localize, localizeData, setLanguage, t } from '../../src/shared/i18n/i18n.ts'
import { EN } from '../../src/shared/i18n/en.ts'

afterEach(() => setLanguage('fr'))

const unquote = (raw: string) => raw.replace(/\\(.)/g, (_, char) => (char === 'n' ? '\n' : char))
/** Every source file under a folder, at any depth, but the dictionary itself. */
const filesIn = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'i18n' ? [] : filesIn(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
const placeholders = (text: string) => new Set(text.match(/\{\d+\}/g) ?? [])

describe('the dictionary', () => {
  it('has the English of every text the interface and the window say', () => {
    const missing: string[] = []
    for (const file of [...filesIn('src/client'), ...filesIn('src/shared'), ...filesIn('src/desktop')]) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/\bt\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")/g)) {
        const key = unquote(match[1] ?? match[2])
        if (!(key in EN)) missing.push(`${file}: ${key}`)
      }
    }
    assert.deepEqual(missing, [])
  })

  it('has the English of every error the server sends, unless it says what a thing is called', () => {
    const missing: string[] = []
    for (const file of filesIn('src/server')) {
      for (const match of readFileSync(file, 'utf8').matchAll(/new HttpError\(\d+, '((?:\\.|[^'\\])*)'\)/g)) {
        const key = unquote(match[1])
        if (localize(key) === key && !(key in EN)) missing.push(`${file}: ${key}`)
      }
    }
    assert.deepEqual(missing, [])
  })

  it('never asks for something a text does not give', () => {
    for (const [key, english] of Object.entries(EN)) {
      const allowed = placeholders(key)
      for (const placeholder of placeholders(english)) assert.ok(allowed.has(placeholder), `${key} -> ${english}`)
      assert.ok(english.trim() !== '' || key.trim() === '', key)
    }
  })

  it('has no French left in its English', () => {
    const french = Object.entries(EN).filter(([, english]) => /[À-ÖØ-öø-ÿ«»]|\s[:?!;%]/.test(english.replace(/`[^`]*`/g, '')))
    assert.deepEqual(french.filter(([key]) => !/Français|·/.test(key)), [])
  })
})

describe('the language shown', () => {
  it('is French by default, and the key is the text', () => {
    assert.equal(t('Nouveau fil'), 'Nouveau fil')
    assert.equal(t('Votre question sur {0}…', { 0: 'PR #12' }), 'Votre question sur PR #12…')
    assert.equal(dateLocale(), 'fr-FR')
    assert.equal(localize('Serveur injoignable'), 'Serveur injoignable')
    const data = { error: 'Ce fil est clos.' }
    assert.equal(localizeData(data), data, 'in French, nothing even looks at it')
  })

  it('reads the dictionary in English, with its blanks filled', () => {
    setLanguage('en')
    assert.equal(t('Nouveau fil'), EN['Nouveau fil'])
    assert.notEqual(t('Nouveau fil'), 'Nouveau fil')
    assert.equal(dateLocale(), 'en-GB')
    assert.match(t('Votre question sur {0}…', { 0: 'PR #12' }), /PR #12/)
    assert.equal(t('Pas dans le dictionnaire'), 'Pas dans le dictionnaire')
  })

  it('counts with the right plural', () => {
    assert.equal(count(1, 'ticket'), '1 ticket')
    assert.equal(count(2, 'ticket'), '2 tickets')
    assert.equal(count(2, 'ready'), '2 ready')
    assert.equal(count(3, 'open'), '3 open')
  })
})

describe('what the server says', () => {
  it('is read in English, with what filled its blanks', () => {
    setLanguage('en')
    assert.equal(localize('Ce fil est clos.'), EN['Ce fil est clos.'])
    const translated = localize('Traduction impossible : les chiffres ne correspondent pas')
    assert.match(translated, new RegExp(EN['les chiffres ne correspondent pas']))
    assert.doesNotMatch(translated, /Traduction/)
    assert.equal(localize('Une phrase que le dictionnaire ne connaît pas.'), 'Une phrase que le dictionnaire ne connaît pas.')
  })

  it('reads a sentence of a generated report, which stays in French in the history', () => {
    setLanguage('en')
    assert.doesNotMatch(localize('**main est rouge** : le dernier run terminé a échoué, lancé à 14:02.'), /rouge|échoué/)
    assert.match(localize('**main est rouge** : le dernier run terminé a échoué, lancé à 14:02.'), /14:02/)
  })

  it('leaves what people and models wrote exactly as it is', () => {
    setLanguage('en')
    const shown = localizeData({ error: 'Ce fil est clos.', messages: [{ body: 'Ce fil est clos.', author: 'victor' }], list: ['Ce fil est clos.'], n: 3 })
    assert.equal(shown.error, EN['Ce fil est clos.'])
    assert.equal(shown.messages[0].body, 'Ce fil est clos.')
    assert.equal(shown.list[0], EN['Ce fil est clos.'])
    assert.equal(shown.n, 3)
  })

  it('never rewrites a title, a label or a reason, which can be the same words as a button and can be posted back', () => {
    setLanguage('en')
    const written = { title: 'Fermer', detail: 'Aucune réponse encore.', label: 'Réglages : thème', name: 'Rapport du lundi', reason: 'Clos', line: 'Fermer', subject: { title: 'Fermer', label: 'Fermer' }, items: [{ title: 'Épingler la PR 12' }] }
    assert.deepEqual(localizeData(written), written)
  })

  it('still reads the voice models, and leaves a model and an effort as they are', () => {
    setLanguage('en')
    const note = 'Le plus juste : rapide avec une carte graphique.'
    const shown = localizeData({ models: [{ note }], claudeChoices: { general: { reply: { model: 'opus', effort: 'max' } } } })
    assert.equal(shown.models[0].note, EN[note])
    assert.deepEqual(shown.claudeChoices.general.reply, { model: 'opus', effort: 'max' })
  })
})
