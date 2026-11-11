/**
 * Cuts what a microphone hears into passages to transcribe, at the pauses between sentences, so that
 * text arrives as people talk and silence costs nothing. It holds samples only until a passage is
 * handed over, or dropped for having no speech in it. No DOM here: its tests run without a browser.
 */

export const RATE = 16_000
const FRAME = 320 // 20 ms
const SILENCE_ENDS_MS = 700
/** A speaker who never pauses still gets text regularly. */
const LONGEST_MS = 20_000
/** Keeps the start of a word that began under the threshold. */
const LEAD_MS = 300
/** A "oui" is about this long. Below it, a click or a chair: the engine's own detection judges the rest. */
const SHORTEST_SPEECH_MS = 150
/** Below this, a quiet room. Noisier rooms raise it through the floor measured. */
const MIN_THRESHOLD = 0.006
const FLOOR_FACTOR = 3
const FIRST_FLOOR = MIN_THRESHOLD / FLOOR_FACTOR

export interface Passage {
  samples: Float32Array
  /** Where it starts, in milliseconds from the first sample fed. */
  at: number
}

export class Segmenter {
  private readonly onPassage: (passage: Passage) => void
  private lead: Float32Array[] = []
  private current: Float32Array[] = []
  private inPassage = false
  private startAt = 0
  private speechFrames = 0
  private silentFrames = 0
  private fed = 0
  private floor = FIRST_FLOOR
  private pending = new Float32Array(FRAME)
  private filled = 0

  constructor(onPassage: (passage: Passage) => void) {
    this.onPassage = onPassage
  }

  feed(samples: Float32Array): void {
    let from = 0
    while (from < samples.length) {
      const take = Math.min(FRAME - this.filled, samples.length - from)
      this.pending.set(samples.subarray(from, from + take), this.filled)
      this.filled += take
      from += take
      if (this.filled === FRAME) {
        this.frame(this.pending)
        this.pending = new Float32Array(FRAME)
        this.filled = 0
      }
    }
  }

  /** What is left, at the end of a listening. */
  flush(): void {
    if (this.filled) {
      this.frame(this.pending.slice(0, this.filled))
      this.filled = 0
    }
    this.end()
  }

  /** Words on either side of a pause in the listening don't join up. */
  breakHere(): void {
    this.end()
    this.lead = []
  }

  private frame(frame: Float32Array): void {
    let sum = 0
    for (const sample of frame) sum += sample * sample
    const level = Math.sqrt(sum / frame.length)
    const threshold = Math.max(MIN_THRESHOLD, this.floor * FLOOR_FACTOR)
    const speech = level > threshold
    // The floor follows quiet quickly and a room's noise slowly. Speech barely moves it: starting on a word, or talking for long, doesn't make the next words count as noise.
    const rise = speech ? 0.0002 : 0.002
    this.floor = level < this.floor ? this.floor * 0.9 + level * 0.1 : this.floor * (1 - rise) + level * rise
    const at = (this.fed * 1000) / RATE
    this.fed += frame.length

    if (!this.inPassage) {
      if (speech) {
        this.inPassage = true
        this.startAt = Math.max(0, at - this.lead.length * ((FRAME * 1000) / RATE))
        this.current = [...this.lead, frame]
        this.lead = []
        this.speechFrames = 1
        this.silentFrames = 0
      } else {
        this.lead.push(frame)
        if (this.lead.length > LEAD_MS / ((FRAME * 1000) / RATE)) this.lead.shift()
      }
      return
    }
    this.current.push(frame)
    if (speech) {
      this.speechFrames += 1
      this.silentFrames = 0
    } else {
      this.silentFrames += 1
    }
    const ms = (frames: number) => (frames * FRAME * 1000) / RATE
    if (ms(this.silentFrames) >= SILENCE_ENDS_MS || ms(this.current.length) >= LONGEST_MS) this.end()
  }

  private end(): void {
    if (!this.inPassage) return
    this.inPassage = false
    const frames = this.current
    this.current = []
    if ((this.speechFrames * FRAME * 1000) / RATE < SHORTEST_SPEECH_MS) return
    const samples = new Float32Array(frames.reduce((size, frame) => size + frame.length, 0))
    let at = 0
    for (const frame of frames) {
      samples.set(frame, at)
      at += frame.length
    }
    this.onPassage({ samples, at: Math.round(this.startAt) })
  }
}

/** Signed 16-bit, as the app takes it. */
export function toPcm16(samples: Float32Array): ArrayBuffer {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]))
    out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  return out.buffer
}

export const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}
