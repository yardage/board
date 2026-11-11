import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'

const STALL_MS = 60_000

/**
 * What a command writes to its output, into a file, with a real percentage. Done only once the command
 * and the file have both closed, and only if the file has the announced size: an update that came in
 * part must never be started.
 */
export function downloadTo(command: string, args: string[], file: string, size: number, onProgress: (ratio: number) => void, stallMs = STALL_MS): Promise<void> {
  return new Promise<void>((done, fail) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const out = createWriteStream(file)
    let received = 0
    let errors = ''
    let closed = 0
    let settled = false
    let stall: NodeJS.Timeout
    const settle = (failure?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(stall)
      if (!failure) return done()
      child.kill()
      out.destroy()
      fail(failure)
    }
    const watch = () => {
      clearTimeout(stall)
      stall = setTimeout(() => settle(new Error('Le téléchargement ne progresse plus.')), stallMs)
    }
    watch()
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      received += chunk.length
      onProgress(received / size)
      watch()
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      errors = (errors + chunk).slice(-500)
    })
    child.stdout.pipe(out)
    child.once('error', settle)
    out.once('error', settle)
    const closeOne = () => {
      closed += 1
      if (closed === 2) settle(received === size ? undefined : new Error(errors.trim() || `Téléchargement incomplet : ${received} octets sur ${size}.`))
    }
    child.once('close', closeOne)
    out.once('close', closeOne)
  })
}
