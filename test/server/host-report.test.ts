import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { parseReading } from '../../src/server/infra/probes.ts'

/**
 * The reporter a machine runs (host/report.sh) writes what the board reads (parseReading): this runs it on a
 * made-up /proc, with Git's bash on Windows, and reads what it wrote with the board's own parser. Its install,
 * under systemd, is tested by host/test.sh, in a container.
 */
const bash = process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : '/bin/bash'
const script = resolve('host/report.sh')
const slashed = (path: string) => path.replace(/\\/g, '/')
const TOKEN = `github_pat_${'a1'.repeat(20)}`

let base: string
let proc: string
before(() => {
  base = mkdtempSync(join(tmpdir(), 'board-host-'))
  proc = join(base, 'proc')
  mkdirSync(join(proc, 'pressure'), { recursive: true })
  writeFileSync(join(proc, 'meminfo'), 'MemTotal:        7932000 kB\nMemFree:          200000 kB\nMemAvailable:    4400000 kB\n')
  writeFileSync(join(proc, 'stat'), 'cpu  100 0 50 800 10 0 5 0 0 0\ncpu0 25 0 12 200 2 0 1 0 0 0\ncpu1 25 0 12 200 2 0 1 0 0 0\ncpu2 25 0 13 200 3 0 2 0 0 0\ncpu3 25 0 13 200 3 0 1 0 0 0\nintr 1\n')
  writeFileSync(join(proc, 'uptime'), '86400.55 300000.00\n')
  writeFileSync(join(proc, 'loadavg'), '3.20 2.10 1.50 2/300 4000\n')
  writeFileSync(join(proc, 'vmstat'), 'nr_free_pages 1\noom_kill 2\n')
  writeFileSync(join(proc, 'pressure', 'memory'), 'some avg10=0.00 avg60=1.25 avg300=0.50 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n')
})
after(() => rmSync(base, { recursive: true, force: true }))

function report(state: string, env: Record<string, string> = {}) {
  mkdirSync(state, { recursive: true })
  return spawnSync(bash, [slashed(script)], {
    encoding: 'utf8',
    env: { ...process.env, STATE_DIRECTORY: slashed(state), REPORT_PROC: slashed(proc), REPORT_SAMPLES: '1', REPORT_INTERVAL: '0', ...env },
  })
}

describe('a machine’s reporter', { skip: !existsSync(bash) && 'no bash here' }, () => {
  it('writes a reading the board reads, numbers only', () => {
    const state = join(base, 'one')
    const run = report(state, { REPORT_DRY: '1' })
    assert.equal(run.status, 0, run.stderr)
    const text = readFileSync(join(state, 'reading.json'), 'utf8')
    const parsed = parseReading(text, Date.now())
    assert.ok(!('problem' in parsed), JSON.stringify(parsed))
    const { reading } = parsed as Exclude<typeof parsed, { problem: string }>
    assert.equal(reading.cpus, 4)
    assert.equal(reading.memoryTotal, 7746)
    assert.equal(reading.memoryAvailable, 4297)
    assert.ok(reading.memoryLowest <= reading.memoryAvailable)
    assert.equal(reading.uptime, 86401)
    assert.equal(reading.load1, 3.2)
    assert.equal(reading.oomKills, 2)
    assert.equal(reading.pressure, 1.25)
    assert.equal(reading.points.length, 1)
    assert.ok(reading.diskTotal > 0 && reading.diskFree <= reading.diskTotal)
  })

  it('keeps 6 hours, and drops a line cut short', () => {
    const state = join(base, 'history')
    mkdirSync(state, { recursive: true })
    const old = Array.from({ length: 400 }, (_, at) => `[${1_700_000_000 + 60 * at},2000,10,40000,0]`)
    writeFileSync(join(state, 'points'), `${old.join('\n')}\n[1700099999,20\n`)
    assert.equal(report(state, { REPORT_DRY: '1' }).status, 0)
    const parsed = parseReading(readFileSync(join(state, 'reading.json'), 'utf8'), Date.now())
    assert.ok(!('problem' in parsed))
    assert.equal((parsed as { reading: { points: unknown[] } }).reading.points.length, 360)
  })

  it('writes it to the environment’s variable, with the token only GitHub sees', async () => {
    const seen: { method: string; url: string; auth: string; body: string }[] = []
    let answers = [404, 201, 204]
    const server = createServer(async (req: IncomingMessage, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: String(req.headers.authorization ?? ''), body })
      res.writeHead(answers.shift() ?? 500).end()
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
    const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const credentials = join(base, 'credentials')
    mkdirSync(credentials, { recursive: true })
    writeFileSync(join(credentials, 'token'), `${TOKEN}\n`)
    const env = { BOARD_ENV: 'acme/agora', BOARD_HOST: 'ci-1', CREDENTIALS_DIRECTORY: slashed(credentials), REPORT_API: api }
    const state = join(base, 'sent')
    try {
      // spawnSync would hold this process, and the stand-in with it: the runs go one after the other, asynchronously.
      const run = (extra: Record<string, string> = {}) =>
        new Promise<number>((done) => {
          const child = spawn(bash, [slashed(script)], {
            env: { ...process.env, STATE_DIRECTORY: slashed(state), REPORT_PROC: slashed(proc), REPORT_SAMPLES: '1', REPORT_INTERVAL: '0', ...env, ...extra },
            stdio: 'ignore',
          })
          child.on('close', (code) => done(code ?? 1))
        })
      mkdirSync(state, { recursive: true })
      assert.equal(await run(), 0, 'made the first time')
      assert.equal(await run(), 0, 'changed after')
      assert.deepEqual(seen.map((request) => `${request.method} ${request.url}`), [
        'PATCH /repos/acme/agora/actions/variables/BOARD_HOST_CI_1',
        'POST /repos/acme/agora/actions/variables',
        'PATCH /repos/acme/agora/actions/variables/BOARD_HOST_CI_1',
      ])
      assert.ok(seen.every((request) => request.auth === `Bearer ${TOKEN}`))
      const sent = JSON.parse(seen[1].body) as { name: string; value: string }
      assert.equal(sent.name, 'BOARD_HOST_CI_1')
      assert.ok(!('problem' in parseReading(sent.value, Date.now())), 'the variable holds a reading the board reads')
      assert.match(readFileSync(join(state, 'sent'), 'utf8'), /^\d+ 204\n$/)

      answers = [401]
      assert.notEqual(await run(), 0, 'a refused token fails the run')
      const before = seen.length
      assert.notEqual(await run({ REPORT_API: 'https://example.invalid' }), 0)
      assert.notEqual(await run({ BOARD_HOST: 'CI 1' }), 0)
      writeFileSync(join(credentials, 'token'), 'ghp_classic0123456789012345678901234567\n')
      assert.notEqual(await run(), 0, 'a classic token is refused')
      assert.equal(seen.length, before, 'none of these sent anything')
    } finally {
      server.close()
    }
  })
})
