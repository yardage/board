import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { parsePoll, pollOpen, setAliases, Store } from '../../src/server/environment/store.ts'
import { kindOfMessage } from '../../src/shared/notices.ts'
import { startTestBoard, testConfig } from '../support/helpers.ts'

/** Polls: a question in a thread, votes as files, a list of them all, and an end decided by a date, the author or an admin. */

const temp: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-polls-'))
  temp.push(dir)
  return dir
}
beforeEach(() => setAliases(testConfig().aliases))
afterEach(() => {
  setAliases({})
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const POLL = { question: 'Which day?', options: ['Monday', 'Tuesday'], multiple: false }

describe('a poll', () => {
  it('keeps its end date only when it is one', () => {
    assert.deepEqual(parsePoll({ ...POLL, closesAt: '2030-01-02T10:00:00.000Z' }), { ...POLL, closesAt: '2030-01-02T10:00:00.000Z' })
    assert.deepEqual(parsePoll({ ...POLL, closesAt: '2030-01-02T10:00Z' }), { ...POLL, closesAt: '2030-01-02T10:00:00.000Z' })
    assert.deepEqual(parsePoll({ ...POLL, closesAt: 'tomorrow' }), POLL, 'a word is no date')
    assert.deepEqual(parsePoll({ ...POLL, closesAt: 42 }), POLL)
    assert.equal(parsePoll({ ...POLL, options: ['One'] }), null)
    assert.equal(parsePoll({ ...POLL, options: Array.from({ length: 13 }, (_, i) => `o${i}`) }), null)
  })

  it('is open until its thread closes, its author closes it, or its date comes', () => {
    const now = Date.parse('2030-01-01T00:00:00Z')
    assert.ok(pollOpen({ threadStatus: 'open', poll: POLL, closed: null }, now))
    assert.ok(!pollOpen({ threadStatus: 'closed', poll: POLL, closed: null }, now))
    assert.ok(!pollOpen({ threadStatus: 'open', poll: POLL, closed: { at: '2029-12-31T00:00:00Z', by: 'vbarbanneau' } }, now))
    assert.ok(pollOpen({ threadStatus: 'open', poll: { ...POLL, closesAt: '2030-01-02T00:00:00Z' }, closed: null }, now))
    assert.ok(!pollOpen({ threadStatus: 'open', poll: { ...POLL, closesAt: '2029-12-31T00:00:00Z' }, closed: null }, now))
  })

  it('is listed with its votes and its state, and the latest word on closing wins', async () => {
    const store = new Store(tempDir())
    const thread = await store.createThread({ title: 'Day', kind: 'question', author: 'vbarbanneau' })
    const { message } = await store.addMessage(thread.id, { author: 'vbarbanneau', body: '', poll: POLL })
    await store.addMessage(thread.id, { author: 'rodolphebarbanneau', body: 'No poll here' })
    await store.addVote(thread.id, message.id, [1], 'rodolphebarbanneau')
    assert.deepEqual(await store.pollStates(thread.id), new Map())
    await store.setPollClosed(thread.id, message.id, true, 'vbarbanneau')
    await new Promise((done) => setTimeout(done, 3))
    await store.setPollClosed(thread.id, message.id, false, 'vbarbanneau')
    await new Promise((done) => setTimeout(done, 3))
    await store.setPollClosed(thread.id, message.id, true, 'rodolphebarbanneau')
    const [poll] = await store.listPolls()
    assert.equal(poll.messageId, message.id)
    assert.equal(poll.threadTitle, 'Day')
    assert.deepEqual(poll.votes.map((vote) => [vote.author, vote.choices]), [['rodolphebarbanneau', [1]]])
    assert.equal(poll.closed?.by, 'rodolphebarbanneau')
    assert.ok(!pollOpen(poll))
    // A file written by hand as an agent, or without a verdict, says nothing.
    writeFileSync(join(store.root, thread.id, 'polls', `${Date.now() + 10}-agent-victor-abcd.json`), JSON.stringify({ poll: message.id, closed: false, author: 'agent-victor' }))
    writeFileSync(join(store.root, thread.id, 'polls', `${Date.now() + 11}-vbarbanneau-abce.json`), JSON.stringify({ poll: message.id, closed: 'no', author: 'vbarbanneau' }))
    assert.equal((await store.pollStates(thread.id)).get(message.id)?.closed, true)
    const [summary] = await store.listThreads()
    assert.equal(summary.lastPoll, false, 'the last message has no poll')
    assert.equal(kindOfMessage({ lastAgent: null, lastPoll: true }, 'vbarbanneau'), 'polls')
    assert.equal(kindOfMessage({ lastAgent: null, lastPoll: true, lastMentions: ['vbarbanneau'] }, 'vbarbanneau'), 'mentions')
  })
})

describe('the poll routes', () => {
  const post = (url: string, body: unknown = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify(body) })
  async function board(person: 'victor' | 'rodolphe') {
    const root = tempDir()
    execFileSync('git', ['init', '-q', root])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'test'])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid'])
    writeFileSync(join(root, '.gitignore'), '.cache\nclient\n')
    execFileSync('git', ['-C', root, 'add', '.gitignore'])
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'start'])
    mkdirSync(join(root, 'client'))
    writeFileSync(join(root, 'client', 'index.html'), 'page')
    return { running: await startTestBoard({ root, client: join(root, 'client'), port: 4784, person }), root }
  }

  it('creates a poll on its own, votes, refuses a closed one, and lists them all', async () => {
    const { running } = await board('victor')
    try {
      const soon = new Date(Date.now() + 3_600_000).toISOString()
      const made = await post(`${running.url}/api/threads`, { body: '', poll: { ...POLL, closesAt: soon } })
      assert.equal(made.status, 201)
      const { id, firstMessage, kind } = (await made.json()) as { id: string; firstMessage: string; kind: string }
      assert.equal(kind, 'question')
      assert.match(firstMessage, /-vbarbanneau-/)

      const past = await post(`${running.url}/api/threads`, { body: '', poll: { ...POLL, closesAt: '2020-01-01T00:00:00Z' } })
      assert.equal(past.status, 400)
      const farAway = await post(`${running.url}/api/threads`, { body: '', poll: { ...POLL, closesAt: '2099-01-01T00:00:00Z' } })
      assert.equal(farAway.status, 400)
      const broken = await post(`${running.url}/api/threads`, { body: '', poll: { ...POLL, closesAt: 'soon' } })
      assert.equal(broken.status, 400)

      const voted = await post(`${running.url}/api/threads/${id}/votes`, { poll: firstMessage, choices: [0] })
      assert.equal(voted.status, 200)
      let list = (await (await fetch(`${running.url}/api/polls`)).json()) as { polls: { messageId: string; open: boolean; votes: unknown[]; poll: { closesAt?: string }; closed: unknown }[] }
      assert.equal(list.polls.length, 1)
      assert.equal(list.polls[0].messageId, firstMessage)
      assert.equal(list.polls[0].open, true)
      assert.equal(list.polls[0].poll.closesAt, soon)
      assert.equal(list.polls[0].votes.length, 1)

      const view = (await (await fetch(`${running.url}/api/threads/${id}`)).json()) as { pollStates: Record<string, unknown> }
      assert.deepEqual(view.pollStates, {})

      const closed = await post(`${running.url}/api/threads/${id}/polls/${firstMessage}/close`, { closed: true })
      assert.equal(closed.status, 200)
      const refused = await post(`${running.url}/api/threads/${id}/votes`, { poll: firstMessage, choices: [1] })
      assert.equal(refused.status, 409)
      list = (await (await fetch(`${running.url}/api/polls`)).json()) as typeof list
      assert.equal(list.polls[0].open, false)
      assert.ok(list.polls[0].closed)
      const after = (await (await fetch(`${running.url}/api/threads/${id}`)).json()) as { pollStates: Record<string, { by: string }> }
      assert.equal(after.pollStates[firstMessage]?.by, 'vbarbanneau')

      const reopened = await post(`${running.url}/api/threads/${id}/polls/${firstMessage}/close`, { closed: false })
      assert.equal(reopened.status, 200)
      assert.equal((await post(`${running.url}/api/threads/${id}/votes`, { poll: firstMessage, choices: [1] })).status, 200)
    } finally {
      await running.stop()
    }
  })

  it('lets only the author or an admin close a poll', async () => {
    const { running: asVictor, root } = await board('victor')
    let id = ''
    let messageId = ''
    try {
      const made = (await (await post(`${asVictor.url}/api/threads`, { body: '', poll: POLL })).json()) as { id: string; firstMessage: string }
      id = made.id
      messageId = made.firstMessage
      // Rodolphe is an admin here: he can close Victor's poll. Victor, not an admin, could not close Rodolphe's.
      const rodolphe = await startTestBoard({ root: root, client: join(root, 'client'), port: 4785, person: 'rodolphe' })
      try {
        assert.equal((await post(`${rodolphe.url}/api/threads/${id}/polls/${messageId}/close`, { closed: true })).status, 200)
        const his = (await (await post(`${rodolphe.url}/api/threads`, { body: '', poll: POLL })).json()) as { id: string; firstMessage: string }
        const refused = await post(`${asVictor.url}/api/threads/${his.id}/polls/${his.firstMessage}/close`, { closed: true })
        assert.equal(refused.status, 403)
      } finally {
        await rodolphe.stop()
      }
    } finally {
      await asVictor.stop()
    }
  })
})
