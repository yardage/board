import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { looksSecret } from '../../src/server/lib/secrets.ts'
import { answerMark, commentBody, names, reviewBody, reviewMark, type WaitingApi, waitsFor } from '../../src/server/github/waiting.ts'
import { startTestBoard as startBoard } from '../support/helpers.ts'

const temp: string[] = []
afterEach(() => {
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-waiting-'))
  temp.push(dir)
  return dir
}

const ITEM = { number: 523, title: 'Settings', who: 'Rodolphe', question: 'Can it refuse these?' }
const REVIEW = { number: 600, title: 'A change', who: '', question: '', reviewers: ['vbarbanneau'], url: 'https://github.com/acme/app/pull/600' }
const LOGIN = { victor: 'vbarbanneau', rodolphe: 'rodolphebarbanneau' }
const RODOLPHE = { login: 'rodolphebarbanneau', name: 'Rodolphe Barbanneau' }

describe('what an answer says', () => {
  it('says who answered and what it answers, and makes the text harmless', () => {
    const body = commentBody('Rodolphe', 'Ask @someone first <!--', 'Can it <go?', 'board-answer-1')
    assert.match(body, /^\*\*Rodolphe answered, from the board\.\*\*\n\n> Can it &lt;go\?\n/)
    assert.ok(body.includes('@\u2060someone') && !body.includes(' @someone'), 'a mention notifies nobody')
    assert.ok(!body.includes('<!--'))
    assert.ok(body.endsWith('Reference: `board-answer-1`'))
  })

  it('says yes or no in its first line, and a review says whose it is', () => {
    assert.match(commentBody('Rodolphe', '', 'Can it go?', 'board-answer-2', 'approve'), /^\*\*✓ Approved by Rodolphe, from the board\.\*\*\n\n> Can it go\?\n\nReference: `board-answer-2`$/)
    assert.match(commentBody('Rodolphe', 'Not like this.', '', 'board-answer-3', 'refuse'), /^\*\*✕ Refused by Rodolphe, from the board\.\*\*\n\nNot like this\.\n\nReference/)
    assert.notEqual(answerMark('rodolphebarbanneau', 1, 'q', '', true, '', 'approve'), answerMark('rodolphebarbanneau', 1, 'q', '', true, '', 'refuse'))
    assert.equal(reviewBody('Rodolphe', '', 'board-review-1'), '**Rodolphe, from the board.**\n\nReference: `board-review-1`')
    assert.match(reviewBody('Rodolphe', 'Rename @someone <!--', 'board-review-1'), /Rename @\u2060someone &lt;!--/)
    assert.notEqual(reviewMark('a', 1, 'head1', 'approve', ''), reviewMark('a', 1, 'head2', 'approve', ''), 'a review belongs to a commit')
    assert.notEqual(reviewMark('a', 1, 'head1', 'approve', ''), reviewMark('a', 1, 'head1', 'changes', ''))
  })

  it('gives the same answer the same reference, and another answer another one', () => {
    const mark = answerMark('rodolphebarbanneau', 1, 'q', 'yes', true)
    assert.equal(mark, answerMark('RodolpheBarbanneau', 1, 'q', 'yes', true))
    assert.match(mark, /^board-answer-[0-9a-f]{16}$/)
    for (const other of [answerMark('vbarbanneau', 1, 'q', 'yes', true), answerMark('rodolphebarbanneau', 2, 'q', 'yes', true), answerMark('rodolphebarbanneau', 1, 'p', 'yes', true), answerMark('rodolphebarbanneau', 1, 'q', 'no', true), answerMark('rodolphebarbanneau', 1, 'q', 'yes', false)]) assert.notEqual(mark, other)
  })

  it('refuses what looks like a secret, not a question about one', () => {
    for (const secret of ['HQ_SIGNING_KEY=abcdef', 'AWS_SECRET_ACCESS_KEY=abcdef', 'password: hunter2', 'postgres://app:hunter2@db.example/app', 'ghp_abcdefghijklmnopqrstuvwxyz', 'github_pat_abcdefghijklmnopqrstuvwxyz', 'sk-abcdefghijklmnopqrstuvwxyz', '-----BEGIN RSA PRIVATE KEY', 'AKIAABCDEFGHIJKLMNOP', 'xoxb-1234567890-abc', 'Bearer abcdefghijklmnopqrstuvwx', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0', 'tskey-auth-abcdefghijkl']) assert.ok(looksSecret(secret), secret)
    for (const fine of ['DATABASE_URL has no password in it', 'the token: limited to one repository', 'postgres://db.example/app', 'https://github.com/acme/app/pull/523', 'see sk-learn']) assert.ok(!looksSecret(fine), fine)
  })
})

describe('whom an item waits for', () => {
  it('a member named in the project field by login, name or first name, or asked for a review', () => {
    assert.ok(names('Rodolphe', RODOLPHE))
    assert.ok(names('rodolphebarbanneau', RODOLPHE))
    assert.ok(names('rodolphe barbanneau', RODOLPHE))
    assert.ok(!names('Victor', RODOLPHE))
    assert.ok(!names('', RODOLPHE))
    assert.ok(waitsFor(REVIEW, { login: 'vbarbanneau', name: 'Victor' }))
    assert.ok(!waitsFor(REVIEW, RODOLPHE))
  })
})

describe('the routes', () => {
  const post = (url: string, body: unknown = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify(body) })
  const send = { reason: 'Yes, nothing uses them.', text: 'Yes, nothing uses them.', question: ITEM.question, settle: true }

  /** A fake GitHub that keeps its labels, with what each test changes. */
  const TRANSLATED = 'It is not a problem for me, and it is fine.'
  async function board(person: 'victor' | 'rodolphe', change: (github: { labels: string[]; who: string; question: string }) => Partial<WaitingApi> = () => ({}), translate: (text: string) => string = () => TRANSLATED) {
    const root = tempDir()
    execFileSync('git', ['init', '-q', root])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'test'])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid'])
    writeFileSync(join(root, '.gitignore'), '.cache\nclient\n')
    execFileSync('git', ['-C', root, 'add', '.gitignore'])
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'start'])
    mkdirSync(join(root, 'client'))
    writeFileSync(join(root, 'client', 'index.html'), 'page')
    mkdirSync(join(root, '.cache', 'knowledge', 'github'), { recursive: true })
    writeFileSync(join(root, '.cache', 'knowledge', 'github', 'state.json'), JSON.stringify({ at: new Date().toISOString(), waiting: [ITEM, REVIEW] }))
    const github = { labels: ['needs-answer', 'area:compute'], who: ITEM.who, question: ITEM.question }
    const comments: string[] = []
    const set: string[][] = []
    const reviews: { event: string; body: string; head: string }[] = []
    const pull = { open: true, draft: false, head: 'a'.repeat(40), author: 'rodolphebarbanneau', reviewers: ['vbarbanneau'] }
    const access = { code: false, issues: { create: false, comment: true, edit: false, close: false }, pulls: { comment: true, edit: false, review: true } }
    const running = await startBoard({
      root,
      client: join(root, 'client'),
      port: 4782,
      person,
      config: { repos: [{ name: 'acme/app', ...access }], waiting: { label: 'needs-answer', who: 'Waiting on', question: 'Question' } },
      translate: async (_system, source) => JSON.stringify({ 0: translate(JSON.parse(source)[0]) }),
      waiting: {
        login: async () => LOGIN[person],
        current: async () => ({ ...github }),
        labels: async () => github.labels,
        find: async (_number, mark) => (comments.some((body) => body.includes(mark)) ? 'https://github.com/acme/app/pull/523#issuecomment-1' : null),
        comment: async (_number, body) => {
          comments.push(body)
          return `https://github.com/acme/app/pull/523#issuecomment-${comments.length}`
        },
        setLabels: async (_number, next) => {
          set.push(next)
          github.labels = next
        },
        pull: async () => ({ ...pull }),
        findReview: async (_number, mark) => (reviews.some((review) => review.body.includes(mark)) ? 'https://github.com/acme/app/pull/600#pullrequestreview-1' : null),
        review: async (_number, event, body, head) => {
          reviews.push({ event, body, head })
          return `https://github.com/acme/app/pull/600#pullrequestreview-${reviews.length}`
        },
        ...change(github),
      },
    })
    return { running, url: `${running.url}/api/waiting`, comments, set, root, github, reviews, pull }
  }

  it('lists what waits, and says which is for this member', async () => {
    const { running, url } = await board('rodolphe')
    try {
      const data = await (await fetch(url)).json()
      assert.deepEqual(data.items.map((item: { number: number; mine: boolean; review: boolean }) => [item.number, item.mine, item.review]), [[523, true, false], [600, false, false]])
      assert.equal(data.label, 'needs-answer')
      assert.equal(data.repository, 'https://github.com/acme/app')
    } finally {
      await running.stop()
    }
    const victor = await board('victor')
    try {
      const data = await (await fetch(victor.url)).json()
      assert.deepEqual(data.items.map((item: { mine: boolean; review: boolean }) => [item.mine, item.review]), [[false, false], [true, true]])
    } finally {
      await victor.running.stop()
    }
  })

  it('posts the answer of the member it waits on, then takes the label off and keeps the others', async () => {
    const { running, url, comments, set, root } = await board('rodolphe')
    try {
      assert.equal((await post(`${url}/523/answer`, send)).status, 200)
      assert.match(comments[0], /Rodolphe answered/)
      assert.match(comments[0], /> Can it refuse these\?/)
      assert.deepEqual(set, [['area:compute']])
      // GitHub no longer has the label.
      assert.equal((await post(`${url}/523/answer`, send)).status, 409)
      assert.equal(comments.length, 1)
      // GitHub is the record: the board writes nothing of it in the history.
      assert.equal(execFileSync('git', ['-C', root, 'status', '--porcelain', '--', 'threads']).toString(), '')
    } finally {
      await running.stop()
    }
  })

  it('leaves the label when the member does not settle it, and can still answer', async () => {
    const { running, url, comments, set } = await board('rodolphe')
    try {
      assert.equal((await post(`${url}/523/answer`, { ...send, settle: false })).status, 200)
      assert.deepEqual(set, [])
      assert.equal((await post(`${url}/523/answer`, { ...send, text: 'And settled now.', settle: true })).status, 200)
      assert.equal(comments.length, 2)
      assert.deepEqual(set, [['area:compute']])
    } finally {
      await running.stop()
    }
  })

  it('only lets the member it waits on answer', async () => {
    const { running, url, comments } = await board('victor')
    try {
      const refused = await post(`${url}/523/answer`, send)
      assert.equal(refused.status, 403)
      assert.match((await refused.json()).error, /Rodolphe/)
      assert.equal(comments.length, 0)
    } finally {
      await running.stop()
    }
  })

  it('refuses when GitHub is logged in as another account', async () => {
    const { running, url, comments } = await board('rodolphe', () => ({ login: async () => 'someone-else' }))
    try {
      const refused = await post(`${url}/523/answer`, send)
      assert.equal(refused.status, 403)
      assert.match((await refused.json()).error, /someone-else/)
      assert.equal(comments.length, 0)
    } finally {
      await running.stop()
    }
  })

  it('believes GitHub rather than the copy: the label, the person and the question', async () => {
    const cases: [string, (github: { labels: string[]; who: string; question: string }) => void, number][] = [
      ['label', (github) => void (github.labels = ['area:compute']), 409],
      ['question', (github) => void (github.question = 'Something else?'), 409],
      ['person', (github) => void (github.who = 'Victor'), 403],
    ]
    for (const [name, change, status] of cases) {
      const { running, url, comments, set, github } = await board('rodolphe')
      try {
        change(github)
        assert.equal((await post(`${url}/523/answer`, send)).status, status, name)
        assert.equal(comments.length, 0, name)
        assert.equal(set.length, 0, name)
      } finally {
        await running.stop()
      }
    }
  })

  it('posts nothing when it cannot read GitHub', async () => {
    const { running, url, comments } = await board('rodolphe', () => ({
      current: async () => {
        throw new Error('HTTP 401')
      },
    }))
    try {
      const refused = await post(`${url}/523/answer`, send)
      assert.equal(refused.status, 502)
      assert.match((await refused.json()).error, /rien n'est posté.*401/)
      assert.equal(comments.length, 0)
    } finally {
      await running.stop()
    }
  })

  it('refuses no words, a secret, an unknown item, and French on GitHub', async () => {
    const { running, url, comments } = await board('rodolphe')
    try {
      assert.equal((await post(`${url}/523/answer`, { ...send, text: '  ' })).status, 400)
      assert.equal((await post(`${url}/523/preview`, { reason: '  ' })).status, 400)
      assert.equal((await post(`${url}/523/answer`, { ...send, text: 'postgres://app:hunter2@db.example/app' })).status, 400)
      assert.equal((await post(`${url}/523/answer`, { ...send, reason: 'postgres://app:hunter2@db.example/app' })).status, 400)
      assert.equal((await post(`${url}/523/preview`, { reason: 'postgres://app:hunter2@db.example/app' })).status, 400)
      assert.equal((await post(`${url}/999/answer`, send)).status, 404)
      assert.equal((await post(`${url}/523/answer`, { ...send, text: "C'est bon pour moi et je valide le ticket pour la suite." })).status, 400)
      assert.equal(comments.length, 0)
    } finally {
      await running.stop()
    }
  })

  it('posts a second answer of the same words, and only one for a retry', async () => {
    const { running, url, comments } = await board('rodolphe')
    try {
      assert.equal((await post(`${url}/523/answer`, { ...send, settle: false, attempt: 'a' })).status, 200)
      assert.equal((await post(`${url}/523/answer`, { ...send, settle: false, attempt: 'a' })).status, 200)
      assert.equal(comments.length, 1, 'the same attempt finds its comment')
      assert.equal((await post(`${url}/523/answer`, { ...send, settle: false, attempt: 'b' })).status, 200)
      assert.equal(comments.length, 2)
    } finally {
      await running.stop()
    }
  })

  it('translates before it goes on GitHub, except for a member who works in English and writes it', async () => {
    const english = 'This is fine with me, and the rest of the work can go on as it is.'
    const rodolphe = await board('rodolphe')
    try {
      const preview = async (reason: string) => (await (await post(`${rodolphe.url}/523/preview`, { reason })).json()).text
      assert.equal(await preview("Ce n'est pas un problème pour moi, et c'est bon pour la suite."), TRANSLATED)
      await post(`${rodolphe.running.url}/api/settings/language`, { language: 'en' })
      assert.equal(await preview(english), english)
    } finally {
      await rodolphe.running.stop()
    }
  })

  it('finds a comment whose answer was lost, and does not post it again', async () => {
    const comments: string[] = []
    const { running, url, set } = await board('rodolphe', () => ({
      find: async (_number, mark) => (comments.some((body) => body.includes(mark)) ? 'https://github.com/acme/app/pull/523#issuecomment-9' : null),
      comment: async (_number, body) => {
        comments.push(body)
        throw new Error('timed out')
      },
    }))
    try {
      const answered = await post(`${url}/523/answer`, send)
      assert.equal(answered.status, 200)
      assert.equal((await answered.json()).comment, 'https://github.com/acme/app/pull/523#issuecomment-9')
      assert.equal(comments.length, 1)
      assert.deepEqual(set, [['area:compute']])
    } finally {
      await running.stop()
    }
  })

  it('approves or refuses in a word, and the answer says which', async () => {
    const { running, url, comments, set } = await board('rodolphe')
    try {
      assert.equal((await post(`${url}/523/answer`, { ...send, text: '', reason: '', verdict: 'approve' })).status, 200)
      assert.match(comments[0], /^\*\*✓ Approved by Rodolphe, from the board\.\*\*/)
      assert.deepEqual(set, [['area:compute']])
      assert.equal((await post(`${url}/523/answer`, { ...send, text: '', reason: '', verdict: 'answer' })).status, 400, 'words alone need words')
    } finally {
      await running.stop()
    }
  })

  it('reviews a pull request at the commit read, once, and only as someone else than its author', async () => {
    const { running, url, reviews, pull } = await board('victor')
    try {
      const head = pull.head
      const approved = await post(`${url}/600/review`, { event: 'approve', text: '', head, attempt: 'r1' })
      assert.equal(approved.status, 200)
      assert.deepEqual(reviews.map((review) => [review.event, review.head]), [['approve', head]])
      assert.match(reviews[0].body, /^\*\*Victor, from the board\.\*\*\n\nReference: `board-review-/)
      // The same try again finds its review.
      assert.equal((await post(`${url}/600/review`, { event: 'approve', text: '', head, attempt: 'r1' })).status, 200)
      assert.equal(reviews.length, 1)
      // Words are needed to ask for changes.
      assert.equal((await post(`${url}/600/review`, { event: 'changes', text: '', head })).status, 400)
      assert.equal((await post(`${url}/600/review`, { event: 'changes', text: 'Please rename the field.', head })).status, 200)
      assert.equal(reviews[1].event, 'changes')
      assert.match(reviews[1].body, /Please rename the field\./)
      // The pull request moved since it was read.
      assert.equal((await post(`${url}/600/review`, { event: 'approve', text: '', head: 'b'.repeat(40) })).status, 409)
      // French doesn't go on GitHub, and nor does a secret or an unknown word.
      assert.equal((await post(`${url}/600/review`, { event: 'comment', text: "C'est très bien pour moi et je valide le ticket pour la suite.", head })).status, 400)
      assert.equal((await post(`${url}/600/review`, { event: 'comment', text: 'ghp_abcdefghijklmnopqrstuvwxyz', head })).status, 400)
      assert.equal((await post(`${url}/600/review`, { event: 'merge', text: '', head })).status, 400)
      assert.equal(reviews.length, 2)
    } finally {
      await running.stop()
    }
    const author = await board('rodolphe')
    try {
      assert.equal((await post(`${author.url}/600/review`, { event: 'approve', text: '' })).status, 403, 'not on your own pull request')
      assert.equal((await post(`${author.url}/600/review`, { event: 'comment', text: 'A note on my own change.' })).status, 200, 'a comment is fine')
      assert.equal((await post(`${author.url}/600/review`, { event: 'approve', text: '' , })).status, 403)
    } finally {
      await author.running.stop()
    }
  })

  it('refuses a review when the environment does not allow it, or when the pull request is closed', async () => {
    const closed = await board('victor', () => ({ pull: async () => ({ open: false, draft: false, head: 'c'.repeat(40), author: 'rodolphebarbanneau', reviewers: [] }) }))
    try {
      assert.equal((await post(`${closed.url}/600/review`, { event: 'approve', text: '' })).status, 409)
      assert.equal(closed.reviews.length, 0)
    } finally {
      await closed.running.stop()
    }
    const elsewhere = await board('victor', () => ({ login: async () => 'someone-else' }))
    try {
      assert.equal((await post(`${elsewhere.url}/600/review`, { event: 'approve', text: '' })).status, 403)
    } finally {
      await elsewhere.running.stop()
    }
  })

  it('says so when the label stays', async () => {
    const { running, url } = await board('rodolphe', () => ({
      setLabels: async () => {
        throw new Error('HTTP 500')
      },
    }))
    try {
      const answered = await (await post(`${url}/523/answer`, send)).json()
      assert.match(answered.warning, /needs-answer reste à retirer/)
    } finally {
      await running.stop()
    }
  })
})
