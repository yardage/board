import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { systemPrompt } from '../../src/server/ai/agent.ts'
import { startTestBoard as startBoard } from '../support/helpers.ts'
import { defaultConfig } from '../../src/server/environment/config.ts'
import { Store } from '../../src/server/environment/store.ts'
import { parseMermaid } from '../../src/client/lib/mermaid.ts'
import { parseAllChoices } from '../../src/shared/ai-uses.ts'
import { detectLanguage, figureDifference, fillPage, keepFigures, protectCode, REPORT_PATH, restoreCode, sameFigures, splitMarkdown, splitPage, systemFor, translateArgs, type TranslateRun, Translator } from '../../src/server/ai/translate.ts'

const temp: string[] = []
afterEach(() => {
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-translate-'))
  temp.push(dir)
  return dir
}
const post = (url: string, body: unknown = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify(body) })
/** A model that keeps everything, and shows it went through it in words that read as French. */
const marking: TranslateRun = async (_system, text) => `T: le la les des une et est dans pour que qui sur avec pas ce au du mais ${text}`
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise((done) => setTimeout(done, 10))
  }
  assert.fail('never happened')
}

const DAY = `# 2026-11-05

## 01:00

**Key points.** The work has stopped and 12 of the runs failed.

\`\`\`mermaid
xychart-beta
  title "Burn-up 136"
\`\`\`

## 04:00

The work has resumed, and 41 % of the issues are closed.
`

describe('the language of a text', () => {
  it('tells French from English, and says nothing on too few words', () => {
    assert.equal(detectLanguage('Il reste 7 PR de Rodolphe approuvées avec une CI verte, et la prévision est passée.'), 'fr')
    assert.equal(detectLanguage('The work has stopped, and only someone with billing access can fix it.'), 'en')
    assert.equal(detectLanguage('OK'), null)
  })

  it("doesn't read the code of a chart page", () => {
    const page = '<style>the and is of to in for that with on</style><script>const the = 1, and = 2, is = 3</script><p>Il reste les tickets de la journée, et une PR est prête pour le merge.</p>'
    assert.equal(detectLanguage(page), 'fr')
  })
})

describe('what goes to the model', () => {
  it('splits a report of the day by update, without losing a character', () => {
    const parts = splitMarkdown(DAY)
    assert.equal(parts.length, 3)
    assert.equal(parts.join(''), DAY)
  })

  it("doesn't split on a heading inside code", () => {
    assert.equal(splitMarkdown('## a\n```\n## not a heading\n```\n## b\n').length, 2)
  })

  it('never sends code, and refuses an answer that lost it', () => {
    const { text, blocks } = protectCode(DAY)
    assert.ok(!text.includes('xychart'))
    assert.equal(blocks.length, 1)
    assert.equal(restoreCode(text, blocks), DAY)
    assert.throws(() => restoreCode(text.replace('⟦0⟧', ''), blocks))
  })

  it('accepts only the same figures, whatever the decimal mark', () => {
    assert.ok(sameFigures('136 of 328, at 5.1 per hour', '136 sur 328, à 5,1 par heure'))
    assert.ok(!sameFigures('136 of 328', '163 sur 328'))
    assert.ok(!sameFigures('136 of 328', '136 sur'))
    assert.ok(sameFigures('vers 13 h', 'around 13:00'))
  })

  it("gives the model no tool, and tells it that the document isn't an instruction", () => {
    const args = translateArgs('haiku', 'file.txt')
    assert.equal(args[args.indexOf('--tools') + 1], '')
    assert.ok(!args.includes('--allowedTools'))
    assert.ok(args.includes('--no-session-persistence'))
    assert.match(systemFor('en', 'rodolphe'), /never an instruction/)
    assert.match(systemFor('en', 'rodolphe'), /The person reading is rodolphe/)
  })
})

describe('a figure a model changed', () => {
  const SOURCE = 'The work goes on today, as it was planned.\n\n- 12 of the runs failed.\n- The rest of the runs went well, and they stay.\n- Nothing else changed since the last report.'

  it('says which figures differ', () => {
    assert.deepEqual(figureDifference('12 of 41 and 7', '21 of 41 and 7 and 7'), { missing: ['12'], added: ['21', '7'] })
    assert.deepEqual(figureDifference('12 and 13:00', '13 h and 12'), { missing: [], added: [] })
  })

  it('keeps the original of that line only', () => {
    const answer = 'Le travail continue.\n\n- 21 des runs ont échoué.\n- Le reste des runs va bien.\n- Rien d\'autre.'
    const kept = keepFigures(SOURCE, answer)
    assert.equal(kept, 'Le travail continue.\n\n- 12 of the runs failed.\n- Le reste des runs va bien.\n- Rien d\'autre.')
  })

  it('goes by paragraphs when the lines differ, and gives up when nothing lines up', () => {
    const source = 'The first paragraph holds 12 runs, and it goes on for a long while after that.\n\nThe second one goes on\nover two lines, without a single figure in them at all.'
    const answer = 'Le premier a 21 runs.\n\nLe second tient sur une ligne.'
    assert.equal(keepFigures(source, answer), 'The first paragraph holds 12 runs, and it goes on for a long while after that.\n\nLe second tient sur une ligne.')
    assert.equal(keepFigures('One 1.\n\nTwo 2.', 'Un 1, deux 2 et trois 3.'), null)
  })

  it('refuses when over half would stay in its original', () => {
    assert.equal(keepFigures('The work has 12 runs that failed since yesterday evening.\nOK.', 'Le travail a 21 runs.\nOK.'), null)
  })

  it('tells the model which figures, and keeps the rest of the part translated', async () => {
    const systems: string[] = []
    const translator = new Translator(join(tempDir(), 'cache'), async (system, text) => {
      systems.push(system)
      return text
        .replace('The work goes on today, as it was planned.', 'Le travail continue, et il est dans le plan pour une fois.')
        .replace('12 of the runs failed.', '21 des runs ont échoué.')
        .replace('The rest of the runs went well, and they stay.', 'Le reste des runs va bien.')
        .replace('Nothing else changed since the last report.', "Rien d'autre dans le rapport.")
    }, 'victor')
    const path = 'roadmap/docs/roadmap/2026-11-05.md'
    const report = `## 01:00\n\n${SOURCE}\n`
    await translator.start(path, report, 'fr')
    await until(async () => translator.state(path, 'fr').status !== 'running')
    assert.equal(systems.length, 2)
    assert.match(systems[1], /figures of the document were missing: 12\./)
    assert.match(systems[1], /not in the document: 21\./)
    const state = translator.state(path, 'fr')
    assert.equal(state.kept, 0)
    assert.equal(state.error, null)
    const shown = await translator.assemble(path, report, 'fr')
    assert.match(shown, /- 12 of the runs failed\./, 'the figure stays right')
    assert.doesNotMatch(shown, /21/)
    assert.match(shown, /Le travail continue/)
  })

  it('gives what an older check refused another chance', async () => {
    let calls = 0
    const dir = join(tempDir(), 'cache')
    const translator = new Translator(dir, async (_system, text) => {
      calls += 1
      return text
    }, 'victor')
    const path = 'roadmap/docs/roadmap/2026-11-05.md'
    const text = '## 01:00\n\nThe work has stopped and it is not in the plan.\n'
    await translator.start(path, text, 'fr')
    await until(async () => translator.state(path, 'fr').status !== 'running')
    assert.equal(calls, 2)
    for (const file of readdirSync(dir).filter((one) => one.endsWith('.refused2'))) renameSync(join(dir, file), join(dir, file.replace('.refused2', '.refused')))
    await translator.start(path, text, 'fr')
    await until(async () => translator.state(path, 'fr').status !== 'running')
    assert.equal(calls, 4)
  })
})

describe('a report of the day', () => {
  it('translates each part once, then only what the next update adds', async () => {
    const seen: string[] = []
    const run: TranslateRun = async (system, text) => {
      seen.push(text)
      return marking(system, text)
    }
    const translator = new Translator(join(tempDir(), 'cache'), run, 'victor')
    const path = 'roadmap/docs/roadmap/2026-11-05.md'
    await translator.start(path, DAY, 'fr')
    await until(async () => translator.state(path, 'fr').status === 'done')
    assert.equal(seen.length, 2, 'two updates; the title has nothing to translate')
    assert.ok(seen.every((text) => !text.includes('xychart')))

    const shown = await translator.assemble(path, DAY, 'fr')
    assert.match(shown, /T: .*## 01:00/)
    assert.match(shown, /title "Burn-up 136"/, 'its chart comes back as it was')

    const next = `${DAY}\n## 07:00\n\nThe work goes on, and 3 of the issues remain open.\n`
    await translator.start(path, next, 'fr')
    await until(async () => translator.state(path, 'fr').status === 'done')
    assert.equal(seen.length, 3)
  })

  it('keeps the charts of a real report of the day drawable once translated', async () => {
    const chart = '```mermaid\n---\nconfig:\n  xyChart:\n    height: 280\n  themeVariables:\n    xyChart:\n      plotColorPalette: "#8957e5, #3fb950"\n---\nxychart-beta\n  title "Burn-up: All issues"\n  x-axis ["3/11", "22h", "now"]\n  y-axis "Issues" 0 --> 479\n  line [0, 110, 435]\n  line [0, 6, 241]\n```'
    const report = `# 2026-11-06\n\n## 14:00\n\nThe work goes on, and it is on the plan for today.\n\n${chart}\n\nThe second chart comes next.\n\n${chart}\n`
    const translator = new Translator(join(tempDir(), 'cache'), marking, 'victor')
    const path = 'roadmap/docs/roadmap/2026-11-06.md'
    await translator.start(path, report, 'fr')
    await until(async () => translator.state(path, 'fr').status === 'done')
    const shown = await translator.assemble(path, report, 'fr')
    assert.match(shown, /^T: /m)
    const blocks = [...shown.matchAll(/^```mermaid\n([\s\S]*?)^```/gm)].map((match) => match[1])
    assert.equal(blocks.length, 2)
    for (const block of blocks) {
      const drawn = parseMermaid(block)
      assert.equal(drawn?.kind, 'chart')
      assert.deepEqual(drawn?.kind === 'chart' && drawn.series.map((one) => one.color), ['#8957e5', '#3fb950'])
    }
  })

  it('leaves a part in its original when the figures changed, and says so', async () => {
    const translator = new Translator(join(tempDir(), 'cache'), async (system, text) => marking(system, text.replace('12', '21')), 'victor')
    const path = 'roadmap/docs/roadmap/2026-11-05.md'
    await translator.start(path, DAY, 'fr')
    await until(async () => translator.state(path, 'fr').status !== 'running')
    const state = translator.state(path, 'fr')
    assert.equal(state.status, 'done')
    assert.equal(state.kept, 1)
    assert.match(state.error ?? '', /chiffres/)
    assert.match(await translator.assemble(path, DAY, 'fr'), /12 of the runs failed/)
  })

  it("refuses a model that gives the original back", async () => {
    const translator = new Translator(join(tempDir(), 'cache'), async (_system, text) => text, 'victor')
    const path = 'roadmap/docs/roadmap/2026-11-05.md'
    await translator.start(path, DAY, 'fr')
    await until(async () => translator.state(path, 'fr').status !== 'running')
    assert.equal(translator.state(path, 'fr').status, 'failed')
    assert.match(translator.state(path, 'fr').error ?? '', /original/)
  })

  it('tries twice when a check refuses an answer, and not when Claude Code fails', async () => {
    let calls = 0
    const once = new Translator(join(tempDir(), 'once'), async (system, text) => {
      calls += 1
      return calls === 1 ? text : marking(system, text)
    }, 'victor')
    assert.match(await once.text('The work has stopped and it is not in the plan.', 'fr'), /^T: /)
    assert.equal(calls, 2)

    let failures = 0
    const failing = new Translator(join(tempDir(), 'failing'), async () => {
      failures += 1
      throw new Error('not logged in')
    }, 'victor')
    await assert.rejects(failing.text('The work has stopped and it is not in the plan.', 'fr'))
    assert.equal(failures, 1)
  })

  it('remembers a refusal, and tries again only when asked', async () => {
    let calls = 0
    const translator = new Translator(join(tempDir(), 'cache'), async (_system, text) => {
      calls += 1
      return text
    }, 'victor')
    const path = 'roadmap/docs/roadmap/2026-11-05.md'
    const text = '## 01:00\n\nThe work has stopped and it is not in the plan.\n'
    await translator.start(path, text, 'fr')
    await until(async () => translator.state(path, 'fr').status !== 'running')
    assert.equal(calls, 2, 'one try, then one more')
    await translator.start(path, text, 'fr')
    assert.equal(calls, 2, 'opening it again costs nothing')
    assert.equal(translator.state(path, 'fr').kept, 1)
    await translator.start(path, text, 'fr', true)
    await until(async () => translator.state(path, 'fr').status !== 'running')
    assert.equal(calls, 4)
  })

  it('shows what is translated even if the rest fails', async () => {
    const path = 'roadmap/docs/roadmap/2026-11-05.md'
    const dir = join(tempDir(), 'cache')
    const first = new Translator(dir, marking, 'victor')
    await first.start(path, DAY, 'fr')
    await until(async () => first.state(path, 'fr').status !== 'running')
    const later = `${DAY}\n## 07:00\n\nThe work goes on and it is not over.\n`
    const second = new Translator(dir, async () => Promise.reject(new Error('out of quota')), 'victor')
    await second.start(path, later, 'fr')
    await until(async () => second.state(path, 'fr').status !== 'running')
    assert.equal(second.state(path, 'fr').status, 'done')
    assert.equal(second.state(path, 'fr').kept, 1)
    assert.match(await second.assemble(path, later, 'fr'), /T: .*## 01:00/)
  })

  it('stops taking parts when stopped or cancelled', async () => {
    const parts = Array.from({ length: 9 }, (_, index) => `## 0${index}:00\n\nThe work is not over and it goes on.\n`).join('')
    const path = 'roadmap/docs/roadmap/2026-11-05.md'
    let calls = 0
    const translator = new Translator(join(tempDir(), 'cache'), async (system, text) => {
      calls += 1
      await new Promise((done) => setTimeout(done, 30))
      return marking(system, text)
    }, 'victor')
    await translator.start(path, parts, 'fr')
    translator.cancel(path, 'fr')
    await until(async () => translator.state(path, 'fr').status !== 'running')
    assert.ok(calls <= 3, `${calls} started`)
  })

  it("starts one run when asked twice at once, and a click's message once", async () => {
    let calls = 0
    const run: TranslateRun = async (system, text) => {
      calls += 1
      return marking(system, text)
    }
    const path = 'roadmap/docs/roadmap/2026-11-05.md'
    const translator = new Translator(join(tempDir(), 'cache'), run, 'victor')
    await Promise.all([translator.start(path, DAY, 'fr'), translator.start(path, DAY, 'fr')])
    await until(async () => translator.state(path, 'fr').status !== 'running')
    assert.equal(calls, 2)
    calls = 0
    const text = 'The message is not long and it says so.'
    await Promise.all([translator.text(text, 'fr'), translator.text(text, 'fr')])
    assert.equal(calls, 1)
  })

  it('treats a damaged saved answer as missing', async () => {
    const dir = join(tempDir(), 'cache')
    const translator = new Translator(dir, marking, 'victor')
    const text = 'The work is not over.\n\n```\ncode 1\n```\n'
    await translator.text(text, 'fr')
    const { readdirSync } = await import('node:fs')
    for (const name of readdirSync(dir)) writeFileSync(join(dir, name), '')
    assert.equal(await translator.cachedText(text, 'fr'), null)
    assert.match(await translator.text(text, 'fr'), /code 1/)
  })

  it('reports a failure when nothing could be translated', async () => {
    const translator = new Translator(join(tempDir(), 'cache'), async () => Promise.reject(new Error('not logged in')), 'victor')
    const path = 'roadmap/docs/roadmap/2026-11-05.md'
    await translator.start(path, DAY, 'fr')
    await until(async () => translator.state(path, 'fr').status !== 'running')
    assert.equal(translator.state(path, 'fr').status, 'failed')
    assert.equal(await translator.assemble(path, DAY, 'fr'), DAY)
  })
})

const PAGE = `<!doctype html><html lang="fr"><head><style>.kpi{color:red}</style></head><body>
<div class="kpi"><b>12</b><span>PR mergées</span></div>
<div class="tip" id="tip"></div>
<script>
const NS="http://www.w3.org/2000/svg";
line("bu1",xs,[{n:"Total",c:"var(--s1)",d:[0,107]},{n:"Fermés",c:"var(--s2)",d:[0,3]}]);
el("rect",{"text-anchor":"end","viewBox":"L",fill:"#86b6ef"});
</script></body></html>`

describe('a chart page', () => {
  it('finds what it shows, and leaves its code alone', () => {
    const split = splitPage(PAGE)
    assert.ok(split)
    assert.ok(split.body.includes('PR mergées'))
    assert.ok(!split.body.includes('<script'))
    assert.deepEqual(split.strings, ['Total', 'Fermés'])
    assert.equal(fillPage(split, split.body, new Map()), PAGE)
  })

  it('takes no event, selector or CSS rule for a label', () => {
    const split = splitPage('<body><p>Mot</p><script>on("DOMContentLoaded",".kpi b","#tip b","text-align:right","Tickets fermés");</script></body>')
    assert.deepEqual(split?.strings, ['Tickets fermés'])
  })

  it("keeps the page's scripts if a label would break them", () => {
    const page = '<body><p>Mot</p><script>const a="Un mot";</script></body>'
    const split = splitPage(page)
    assert.ok(split)
    assert.ok(fillPage(split, split.body, new Map([['Un mot', 'A word']])).includes('const a="A word"'))
    const broken = { ...split, after: '<script>const a=\'Dit "Un mot" ici\';</script></body>' }
    assert.equal(fillPage(broken, split.body, new Map([['Un mot', "it's"]])), split.before + split.body + broken.after)
  })

  it('puts the translated labels into its scripts, as valid strings', () => {
    const split = splitPage(PAGE)
    assert.ok(split)
    const filled = fillPage(split, split.body, new Map([['Fermés', 'Closed "now"']]))
    assert.ok(filled.includes('{n:"Closed \\"now\\"",c:"var(--s2)"'))
    assert.ok(filled.includes('c:"var(--s1)"'))
  })

  it('keeps a label whose figures changed, and the others', async () => {
    const page = PAGE.replace('{n:"Total"', '{n:"M1 Total"')
    const translator = new Translator(join(tempDir(), 'labels'), async (_system, text) => (text.startsWith('{') ? JSON.stringify({ 0: 'M2 Total', 1: 'Closed' }) : text.replace('PR mergées', 'PRs merged')), 'rodolphe')
    const path = 'reports/2026-11-05-1300.html'
    await translator.start(path, page, 'en')
    await until(async () => translator.state(path, 'en').status !== 'running')
    const shown = await translator.assemble(path, page, 'en')
    assert.match(shown, /n:"M1 Total"/)
    assert.match(shown, /n:"Closed"/)
  })

  it('translates a page, and refuses an answer that changes its markup', async () => {
    const path = 'reports/2026-11-05-1300.html'
    const good: TranslateRun = async (_system, text) => (text.startsWith('{') ? JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(text)).map(([key, label]) => [key, `T ${label}`]))) : text.replace('PR mergées', 'PRs merged'))
    const translator = new Translator(join(tempDir(), 'good'), good, 'rodolphe')
    await translator.start(path, PAGE, 'en')
    await until(async () => translator.state(path, 'en').status !== 'running')
    const shown = await translator.assemble(path, PAGE, 'en')
    assert.match(shown, /PRs merged/)
    assert.match(shown, /n:"T Fermés"/)
    assert.match(shown, /<style>\.kpi\{color:red\}<\/style>/)

    const broken = new Translator(join(tempDir(), 'broken'), async (_system, text) => text.replace('<b>12</b>', '12'), 'rodolphe')
    await broken.start(path, PAGE, 'en')
    await until(async () => broken.state(path, 'en').status !== 'running')
    assert.equal(broken.state(path, 'en').kept, 2, 'and its labels came back in French')
    assert.equal(await broken.assemble(path, PAGE, 'en'), PAGE)
  })
})

describe('the language over HTTP', () => {
  async function board(person: string, extra: Record<string, unknown> = {}) {
    process.env.BOARD_PERSON = person
    const root = tempDir()
    mkdirSync(join(root, 'client'))
    writeFileSync(join(root, 'client', 'index.html'), 'page')
    mkdirSync(join(root, 'reports'))
    writeFileSync(join(root, 'reports', '2026-11-05-1300.html'), PAGE)
    writeFileSync(join(root, 'reports', 'other.html'), PAGE)
    mkdirSync(join(root, 'threads'), { recursive: true })
    const running = await startBoard({ root, client: join(root, 'client'), port: 4780, loops: false, translate: marking, claude: { status: async () => ({ installed: false, version: null, loggedIn: null, method: null, plan: null }), login: async () => undefined }, ...extra })
    return { running, root, url: running.url }
  }

  it('starts with a damaged settings file', async () => {
    process.env.BOARD_PERSON = 'victor'
    const root = tempDir()
    mkdirSync(join(root, '.cache'))
    mkdirSync(join(root, 'client'))
    for (const damaged of ['', 'null', '{"language":']) {
      writeFileSync(join(root, '.cache', 'settings.json'), damaged)
      const running = await startBoard({ root, client: join(root, 'client'), port: 4780, loops: false })
      try {
        assert.equal((await (await fetch(`${running.url}/api/me`)).json()).language, 'en')
      } finally {
        await running.stop()
      }
    }
  })

  it('starts in each person’s language, and keeps a choice', async () => {
    const victor = await board('victor')
    try {
      assert.equal((await (await fetch(`${victor.url}/api/me`)).json()).language, 'en')
      assert.equal((await post(`${victor.url}/api/settings/language`, { language: 'de' })).status, 400)
      assert.equal((await post(`${victor.url}/api/settings/language`, { language: 'fr' })).status, 200)
      assert.equal((await (await fetch(`${victor.url}/api/settings`)).json()).language, 'fr')
      assert.deepEqual(JSON.parse(readFileSync(join(victor.root, '.cache', 'settings.json'), 'utf8')), { language: 'fr', theme: 'default', models: parseAllChoices(null), threadModels: {} })
    } finally {
      await victor.running.stop()
    }
    // A choice is the member's, on their computer: another member's board starts in its own.
    const rodolphe = await board('rodolphe')
    try {
      assert.equal((await (await fetch(`${rodolphe.url}/api/me`)).json()).language, 'en')
    } finally {
      await rodolphe.running.stop()
    }
  })

  it('translates only reports, and says their language', async () => {
    const { running, url } = await board('rodolphe')
    try {
      const report = 'reports/2026-11-05-1300.html'
      assert.equal((await post(`${url}/api/translate/doc`, { path: 'reports/other.html', to: 'en' })).status, 400)
      assert.equal((await post(`${url}/api/translate/doc`, { path: '../secret.md', to: 'en' })).status, 400)
      assert.equal((await post(`${url}/api/translate/doc`, { path: report, to: 'de' })).status, 400)
      assert.equal(REPORT_PATH.test('acme/docs/architecture.md'), false)
      const refused = await fetch(`${url}/api/translate/doc`, { method: 'POST', headers: { origin: 'https://evil.example', 'x-board': '1' }, body: JSON.stringify({ path: report, to: 'en' }) })
      assert.equal(refused.status, 403)
    } finally {
      await running.stop()
    }
  })

  it('says a report in a page keeps its sandbox, translated or not', async () => {
    const { running, url } = await board('victor')
    try {
      const answer = await fetch(`${url}/api/doc/page?path=${encodeURIComponent('reports/2026-11-05-1300.html')}&lang=en`)
      assert.match(answer.headers.get('content-security-policy') ?? '', /sandbox allow-scripts; default-src 'none'/)
      assert.match(await answer.text(), /color-scheme:dark/)
    } finally {
      await running.stop()
    }
  })

  it('translates a message when asked, and remembers it', async () => {
    const { running, url, root } = await board('victor')
    try {
      await post(`${url}/api/settings/language`, { language: 'fr' })
      const store = new Store(root)
      const thread = await store.createThread({ title: 'Hello', kind: 'topic', author: 'rodolphe' })
      await store.addMessage(thread.id, { author: 'rodolphe', body: 'The work has stopped and it is not in the plan.' })
      const first = await (await fetch(`${url}/api/threads/${thread.id}`)).json()
      const message = first.messages[0]
      assert.equal(message.language, 'en')
      assert.deepEqual(first.translations, {})
      const done = await (await post(`${url}/api/threads/${thread.id}/messages/${message.id}/translate`, { to: 'fr' })).json()
      assert.match(done.body, /^T: .*The work/)
      const second = await (await fetch(`${url}/api/threads/${thread.id}`)).json()
      assert.equal(second.translations[message.id], done.body)
      assert.equal((await post(`${url}/api/threads/${thread.id}/messages/nope/translate`, { to: 'fr' })).status, 404)
    } finally {
      await running.stop()
    }
  })
})

describe('an agent', () => {
  it('writes in the language its person chose', () => {
    const member = (login: string, name: string) => ({ login, name, admin: false })
    const setup = (language: 'fr' | 'en') => ({ owner: member('rodolphebarbanneau', 'Rodolphe'), members: [member('rodolphebarbanneau', 'Rodolphe'), member('vbarbanneau', 'Victor')], config: defaultConfig('test'), language, act: false })
    assert.match(systemPrompt(setup('en')), /Write in English/)
    assert.match(systemPrompt(setup('fr')), /Write in French/)
    assert.match(systemPrompt(setup('fr')), /can't change anything on GitHub in this run/)
    assert.match(systemPrompt({ ...setup('fr'), act: true }), /You may also act on GitHub/)
  })
})
