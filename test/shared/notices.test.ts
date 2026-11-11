import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { DEFAULT_NOTICES, isPaused, kindOfMessage, MORNING_HOUR, noticeFor, type NoticeSettings, parseNotices, pauseEnd } from '../../src/shared/notices.ts'
import { Store } from '../../src/server/environment/store.ts'
import { startTestBoard } from '../support/helpers.ts'

const temp: string[] = []
afterEach(() => {
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const NOW = Date.parse('2026-11-08T10:00:00Z')
const post = (url: string, body: unknown = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify(body) })

describe('the notification settings', () => {
  it('start with everything on, and keep only what they know', () => {
    assert.deepEqual(parseNotices(undefined), DEFAULT_NOTICES)
    assert.deepEqual(parseNotices('x'), DEFAULT_NOTICES)
    assert.deepEqual(parseNotices([false]), DEFAULT_NOTICES)
    const parsed = parseNotices({ enabled: false, sound: 'no', kinds: { agents: false, drafts: 1, other: false }, extra: true })
    assert.equal(parsed.enabled, false)
    assert.equal(parsed.sound, true, 'a word is not a choice')
    assert.deepEqual(parsed.kinds, { ...DEFAULT_NOTICES.kinds, agents: false })
    assert.ok(!('extra' in parsed) && !('other' in parsed.kinds))
  })

  it('keep a pause only if it ends in the coming days', () => {
    assert.equal(parseNotices({ pausedUntil: '2026-11-08T11:00:00Z' }, NOW).pausedUntil, '2026-11-08T11:00:00.000Z')
    assert.equal(parseNotices({ pausedUntil: '2026-11-08T09:00:00Z' }, NOW).pausedUntil, null, 'over')
    assert.equal(parseNotices({ pausedUntil: '2027-01-01T00:00:00Z' }, NOW).pausedUntil, null, 'too far')
    assert.equal(parseNotices({ pausedUntil: 'tomorrow' }, NOW).pausedUntil, null)
    assert.equal(parseNotices({ pausedUntil: 12 }, NOW).pausedUntil, null)
  })

  it('show a notification only when everything allows it, with or without sound and text', () => {
    assert.deepEqual(noticeFor(DEFAULT_NOTICES, 'messages', NOW), { silent: false, preview: true })
    assert.equal(noticeFor({ ...DEFAULT_NOTICES, enabled: false }, 'mentions', NOW), null)
    assert.equal(noticeFor({ ...DEFAULT_NOTICES, kinds: { ...DEFAULT_NOTICES.kinds, waiting: false } }, 'waiting', NOW), null)
    assert.deepEqual(noticeFor({ ...DEFAULT_NOTICES, kinds: { ...DEFAULT_NOTICES.kinds, waiting: false } }, 'drafts', NOW), { silent: false, preview: true })
    assert.deepEqual(noticeFor({ ...DEFAULT_NOTICES, sound: false, preview: false }, 'drafts', NOW), { silent: true, preview: false })
    const paused: NoticeSettings = { ...DEFAULT_NOTICES, pausedUntil: '2026-11-08T11:00:00.000Z' }
    assert.ok(isPaused(paused, NOW))
    assert.equal(noticeFor(paused, 'mentions', NOW), null)
    assert.deepEqual(noticeFor(paused, 'mentions', NOW + 2 * 3600_000), { silent: false, preview: true }, 'the pause is over')
  })

  it('tell a mention from a member’s message and an agent’s', () => {
    assert.equal(kindOfMessage({ lastAgent: null, lastMentions: ['vbarbanneau'] }, 'VBarbanneau'), 'mentions')
    assert.equal(kindOfMessage({ lastAgent: 'auto', lastMentions: ['vbarbanneau'] }, 'vbarbanneau'), 'mentions')
    assert.equal(kindOfMessage({ lastAgent: 'auto', lastMentions: ['someone'] }, 'vbarbanneau'), 'agents')
    assert.equal(kindOfMessage({ lastAgent: null }, 'vbarbanneau'), 'messages')
  })

  it('pause for an hour, or until the next morning', () => {
    const evening = new Date(2026, 10, 8, 21, 30)
    assert.equal(pauseEnd('hour', evening), new Date(2026, 10, 8, 22, 30).toISOString())
    assert.equal(pauseEnd('morning', evening), new Date(2026, 10, 9, MORNING_HOUR).toISOString())
    assert.equal(pauseEnd('morning', new Date(2026, 10, 8, 2, 0)), new Date(2026, 10, 8, MORNING_HOUR).toISOString(), 'this morning has not come yet')
  })
})

describe('the notification settings of a board', () => {
  async function board() {
    const root = mkdtempSync(join(tmpdir(), 'board-notices-'))
    temp.push(root)
    mkdirSync(join(root, 'client'))
    writeFileSync(join(root, 'client', 'index.html'), 'page')
    const badges: { unread: number; waiting: number }[] = []
    const running = await startTestBoard({ root, client: join(root, 'client'), onBadge: (counts) => badges.push(counts) })
    return { running, root, badges }
  }

  it('are saved on this computer, read back by the page, and keep the other settings', async () => {
    const { running, root } = await board()
    try {
      const settingsFile = join(root, '.cache', 'settings.json')
      await post(`${running.url}/api/settings/language`, { language: 'en' })
      const answer = await post(`${running.url}/api/settings/notifications`, { sound: false, kinds: { agents: false }, enabled: 'yes' })
      assert.equal(answer.status, 200)
      const { notices } = (await answer.json()) as { notices: NoticeSettings }
      assert.equal(notices.sound, false)
      assert.equal(notices.enabled, true)
      assert.equal(notices.kinds.agents, false)
      assert.equal(notices.kinds.mentions, true)

      // A change to one kind leaves the others as they were.
      await post(`${running.url}/api/settings/notifications`, { kinds: { drafts: false } })
      const me = (await (await fetch(`${running.url}/api/me`)).json()) as { notices: NoticeSettings }
      assert.equal(me.notices.kinds.agents, false)
      assert.equal(me.notices.kinds.drafts, false)
      assert.equal(me.notices.sound, false)

      const saved = JSON.parse(readFileSync(settingsFile, 'utf8'))
      assert.equal(saved.language, 'en')
      assert.equal(saved.notifications.kinds.drafts, false)
    } finally {
      await running.stop()
    }
  })

  it('hide the count on the icon, and show it again as it is', async () => {
    const { running, badges } = await board()
    try {
      await post(`${running.url}/api/badge`, { unread: 3, waiting: 1 })
      await post(`${running.url}/api/settings/notifications`, { badge: false })
      await post(`${running.url}/api/badge`, { unread: 4, waiting: 1 })
      await post(`${running.url}/api/settings/notifications`, { badge: true })
      assert.deepEqual(badges, [
        { unread: 3, waiting: 1 },
        { unread: 0, waiting: 0 },
        { unread: 0, waiting: 0 },
        { unread: 4, waiting: 1 },
      ])
    } finally {
      await running.stop()
    }
  })
})

describe('a thread in the list', () => {
  it('names who its last message mentions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'board-notices-'))
    temp.push(root)
    const store = new Store(root)
    const thread = await store.createThread({ title: 'Mentions', kind: 'question', author: 'vbarbanneau' })
    await store.addMessage(thread.id, { author: 'vbarbanneau', body: 'Une question pour @rodolphebarbanneau' })
    const [summary] = await store.listThreads()
    assert.deepEqual(summary.lastMentions, ['rodolphebarbanneau'])
    assert.equal(kindOfMessage(summary, 'RodolpheBarbanneau'), 'mentions')
    assert.equal(kindOfMessage(summary, 'vbarbanneau'), 'messages')
  })
})
