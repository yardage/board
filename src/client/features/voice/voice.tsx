import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { personOf } from '../../lib/people.tsx'
import { toSection } from '../settings/settings-sections.ts'
import { call } from '../../lib/api.ts'
import { Blocks, Loading, percent } from '../../components/ui.tsx'
import { clock, RATE, Segmenter, toPcm16 } from './voice-segments.ts'
import { t, dateLocale, localize } from '../../../shared/i18n/i18n.ts'
import { Row } from '../settings/settings-parts.tsx'

/**
 * Listening to a person's own microphone, and reading what it heard before anyone else can.
 * The microphone only opens on a click, here, and it closes with the listening. See `server/voice.ts`.
 * Written after speak (MIT, Rodolphe Barbanneau), its capture and its handling of microphones.
 */

type EngineVariant = 'cuda12' | 'cuda11' | 'cpu'
interface VoiceStatus {
  supported: boolean
  gpu: string | null
  recommended: { engine: EngineVariant; model: string }
  engines: { id: EngineVariant; label: string; size: number; installed: boolean }[]
  models: { id: string; label: string; note: string; size: number; installed: boolean; inSpeak: boolean }[]
  ready: boolean
  chosen: { engine: EngineVariant | null; model: string | null }
  installing: { label: string; received: number; total: number } | null
  installError: string | null
  running: boolean
}
interface Segment {
  seq: number
  at: number
  text: string
  lost?: boolean
}
interface Draft {
  id: string
  threadId: string
  startedAt: string
  stoppedAt: string | null
  segments: Segment[]
  text: string
}
interface VoiceData {
  status: VoiceStatus
  listening: { id: string; threadId: string; page: string } | null
  drafts: Draft[]
}

const MIC_KEY = 'voice-microphone'
const SILENT_PEAK = 0.0005
/** Longer than a pause, since noise suppression can make one perfectly silent. */
const NO_SIGNAL_AFTER_MS = 5000
const PAGE_KEY = 'voice-page'
const STATUS_POLL_MS = 700
const SAVE_AFTER_MS = 500

/** One per tab, and it survives a reload: it tells a page that came back from another page. */
function pageId(): string {
  let id = sessionStorage.getItem(PAGE_KEY)
  if (!id) {
    id = crypto.randomUUID()
    sessionStorage.setItem(PAGE_KEY, id)
  }
  return id
}

const sizeOf = (bytes: number) => (bytes >= 1e9 ? t('{0} Go', { 0: (bytes / 1e9).toFixed(1).replace('.', ',') }) : t('{0} Mo', { 0: Math.round(bytes / 1e6) }))

/** Why the microphone didn't open, in words for the person. */
function micProblem(error: unknown): string {
  const name = (error as DOMException)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return t('Windows ou l\'app refuse le micro : dans les paramètres de confidentialité de Windows, autorisez les applications de bureau à l\'utiliser.')
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return t('Aucun micro trouvé : branchez-en un, puis réessayez.')
  if (name === 'NotReadableError') return t('Le micro ne répond pas : une autre application le bloque peut-être.')
  return t('L\'écoute n\'a pas pu démarrer.')
}

class Capture {
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private segmenter: Segmenter | null = null
  private paused = false
  private windowFed = 0
  private peak = 0
  device = ''

  async start(deviceId: string, send: (samples: Float32Array, at: number) => void, onLevel: (level: number) => void, onNoSignal: (silent: boolean) => void, onLost: () => void): Promise<void> {
    const audio: MediaTrackConstraints = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio })
    } catch (error) {
      // A microphone chosen earlier can be gone: the default one is what the person would expect.
      if (!deviceId || (error as DOMException).name !== 'OverconstrainedError') throw error
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: undefined } })
    }
    this.device = this.stream.getAudioTracks()[0]?.label ?? ''
    // A headset that runs out of battery, or a cable: nothing else would say so.
    for (const track of this.stream.getAudioTracks()) track.onended = onLost
    this.segmenter = new Segmenter(({ samples, at }) => send(samples, at))
    // The browser converts to this rate, the one the engine works at.
    this.context = new AudioContext({ sampleRate: RATE })
    await this.context.resume()
    await this.context.audioWorklet.addModule('/voice-capture.js')
    const source = this.context.createMediaStreamSource(this.stream)
    this.node = new AudioWorkletNode(this.context, 'voice-capture')
    this.node.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
      if (this.paused) return
      let sum = 0
      for (const sample of data) {
        sum += sample * sample
        this.peak = Math.max(this.peak, Math.abs(sample))
      }
      onLevel(Math.min(1, Math.sqrt(sum / data.length) * 8))
      this.windowFed += data.length
      if ((this.windowFed * 1000) / RATE > NO_SIGNAL_AFTER_MS) {
        onNoSignal(this.peak < SILENT_PEAK)
        this.windowFed = 0
        this.peak = 0
      }
      this.segmenter?.feed(data)
    }
    // The graph only runs if it reaches the output: silently here.
    const mute = this.context.createGain()
    mute.gain.value = 0
    source.connect(this.node)
    this.node.connect(mute).connect(this.context.destination)
  }

  pause(paused: boolean): void {
    this.paused = paused
    this.windowFed = 0
    this.peak = 0
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !paused
    if (paused) this.segmenter?.breakHere()
  }

  /** The microphone closes at once, whatever else is still being transcribed. */
  stop(): void {
    this.segmenter?.flush()
    this.segmenter = null
    if (this.node) this.node.port.onmessage = null
    for (const track of this.stream?.getTracks() ?? []) {
      track.onended = null
      track.stop()
    }
    void this.context?.close().catch(() => undefined)
    this.stream = null
    this.context = null
    this.node = null
  }
}

type Phase = 'idle' | 'starting' | 'listening' | 'paused' | 'finishing'
interface VoiceContextValue {
  phase: Phase
  threadId: string | null
  elapsed: number
  level: number
  noSignal: boolean
  device: string
  pending: number
  lost: number
  segments: Segment[]
  error: string | null
  data: VoiceData | null
  reload: () => Promise<VoiceData | null>
  /** What the person is typing, so that coming back to the thread shows it, whatever was read from the app meanwhile. */
  noteDraft: (id: string, text: string) => void
  /** That text is safely on the disk. */
  draftSaved: (id: string, text: string) => void
  /** A problem that has no place on the screen the person is on. */
  notice: string | null
  clearNotice: () => void
  clearError: () => void
  start: (threadId: string, deviceId: string) => Promise<void>
  pause: (paused: boolean) => void
  stop: () => void
}

const VoiceContext = createContext<VoiceContextValue | null>(null)

export const useVoice = () => {
  const value = useContext(VoiceContext)
  if (!value) throw new Error('useVoice outside VoiceProvider')
  return value
}

/**
 * At the root of the app: going to another screen doesn't stop a listening, and every screen says
 * that it is on. `tick` is whatever tells that the app has changed; `stopSignal` that the window is closing.
 */
export function VoiceProvider({ children, stopSignal }: { children: ReactNode; stopSignal: number }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [threadId, setThreadId] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [noSignal, setNoSignal] = useState(false)
  const [device, setDevice] = useState('')
  const [pending, setPending] = useState(0)
  const [lost, setLost] = useState(0)
  const [segments, setSegments] = useState<Segment[]>([])
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<VoiceData | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const edits = useRef(new Map<string, string>())
  const capture = useRef<Capture | null>(null)
  const session = useRef<string | null>(null)
  /** One passage at a time: a slow computer would otherwise take every connection the page has. */
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const seq = useRef(0)
  const startedAt = useRef(0)
  /** How long after the listening's start, on the app's side, the microphone began to run. */
  const openedAfter = useRef(0)
  const pausedFor = useRef(0)
  const pausedAt = useRef(0)
  /** "Stop" came while the microphone was still opening. */
  const stopWanted = useRef(false)
  const stopRef = useRef<() => void>(() => undefined)

  const reload = useCallback(async () => {
    const found = await call<VoiceData>('voice').catch(() => null)
    if (found) setData({ ...found, drafts: found.drafts.map((draft) => (edits.current.has(draft.id) ? { ...draft, text: edits.current.get(draft.id) as string } : draft)) })
    return found
  }, [])

  const clearNotice = useCallback(() => setNotice(null), [])
  const clearError = useCallback(() => setError(null), [])
  const draftSaved = useCallback((id: string, text: string) => {
    if (edits.current.get(id) === text) edits.current.delete(id)
  }, [])
  const noteDraft = useCallback((id: string, text: string) => {
    edits.current.set(id, text)
    setData((current) => current && { ...current, drafts: current.drafts.map((draft) => (draft.id === id ? { ...draft, text } : draft)) })
  }, [])

  /** The app ended this listening without the page: another page, or a restart of the server. */
  const abandon = useCallback(
    (id: string) => {
      if (session.current !== id) return
      capture.current?.stop()
      capture.current = null
      session.current = null
      setPhase('idle')
      setThreadId(null)
      setLevel(0)
      setNotice(t('Cette écoute s’est terminée ailleurs : le micro est fermé.'))
      void reload()
    },
    [reload],
  )

  const send = useCallback((samples: Float32Array, at: number) => {
    const id = session.current
    if (!id) return
    const number = seq.current++
    // From the start of the listening, as a clock on the wall would: this is what orders two people's words.
    const when = Math.round(at + pausedFor.current + openedAfter.current)
    setPending((count) => count + 1)
    queue.current = queue.current
      .then(() =>
        session.current !== id
          ? null
          : fetch(`/api/voice/sessions/${id}/audio?seq=${number}&at=${when}`, {
              method: 'POST',
              headers: { 'content-type': 'application/octet-stream', 'x-board': '1' },
              body: toPcm16(samples),
            }),
      )
      .then(async (response) => {
        if (!response) return
        if (response.status === 409) return abandon(id)
        const answer = await response.json()
        if (!response.ok) throw new Error(answer.error)
        if (answer.segment) setSegments((current) => [...current, answer.segment as Segment].sort((a, b) => a.seq - b.seq))
        // The window closed while the message saying so was lost.
        if (answer.stop) stopRef.current()
      })
      .catch((failure) => {
        setLost((count) => count + 1)
        // A page reads "Failed to fetch" for what the app can't be reached: no use to the person.
        setError(failure instanceof TypeError ? t('L’app n’a pas répondu.') : (failure as Error).message || t('Un passage n’a pas pu être transcrit.'))
        setSegments((current) => [...current, { seq: number, at: when, text: '', lost: true }].sort((a, b) => a.seq - b.seq))
      })
      .finally(() => setPending((count) => count - 1))
  }, [abandon])

  const stop = useCallback(() => {
    const id = session.current
    if (!capture.current) {
      stopWanted.current = true
      return
    }
    if (!id) return
    setPhase('finishing')
    capture.current.stop()
    capture.current = null
    setLevel(0)
    // The rest is text being made from what was already heard: the microphone is closed.
    void queue.current
      .then(() => call(`voice/sessions/${id}/stop`, {}))
      .catch((failure) => setError((failure as Error).message))
      .then(() => reload())
      .finally(() => {
        // Unless the app ended it meanwhile, and another listening has started since.
        if (session.current !== id) return
        session.current = null
        setPhase('idle')
        setThreadId(null)
      })
  }, [reload])
  stopRef.current = stop

  const start = useCallback(
    async (thread: string, deviceId: string) => {
      if (capture.current) return
      stopWanted.current = false
      setNotice(null)
      setPhase('starting')
      setError(null)
      setNoSignal(false)
      setSegments([])
      setPending(0)
      setLost(0)
      seq.current = 0
      pausedFor.current = 0
      let id: string | null = null
      const opened = new Capture()
      try {
        const made = await call<{ id: string; startedAt: string }>('voice/sessions', { threadId: thread, page: pageId() })
        id = made.id
        session.current = made.id
        await opened.start(deviceId, send, setLevel, setNoSignal, () => {
          setNotice(t('Le micro s’est coupé : l’écoute est arrêtée.'))
          stopRef.current()
        })
        if (stopWanted.current) {
          opened.stop()
          session.current = null
          setPhase('idle')
          await call(`voice/sessions/${made.id}/discard`, {}).catch(() => undefined)
          void reload()
          return
        }
        openedAfter.current = Math.max(0, Date.now() - Date.parse(made.startedAt))
        capture.current = opened
        setDevice(opened.device)
        setThreadId(thread)
        startedAt.current = Date.now()
        setElapsed(0)
        setPhase('listening')
        void reload()
      } catch (failure) {
        opened.stop()
        session.current = null
        setPhase('idle')
        const fromServer = id === null
        setError(fromServer ? (failure as Error).message : micProblem(failure))
        if (id) await call(`voice/sessions/${id}/discard`, {}).catch(() => undefined)
        void reload()
      }
    },
    [send, reload],
  )

  const pause = useCallback((paused: boolean) => {
    capture.current?.pause(paused)
    setNoSignal(false)
    if (paused) pausedAt.current = Date.now()
    else pausedFor.current += Date.now() - pausedAt.current
    setPhase(paused ? 'paused' : 'listening')
    setLevel(0)
  }, [])

  useEffect(() => {
    void reload().then((found) => {
      // This page came back without its microphone: what was open is over, and the app has to know. Another page's is left alone.
      if (found?.listening && !capture.current && found.listening.page === pageId()) void call(`voice/sessions/${found.listening.id}/stop`, {}).then(reload)
    })
  }, [reload])

  useEffect(() => {
    if (phase !== 'listening') return
    const timer = setInterval(() => setElapsed(Date.now() - startedAt.current - pausedFor.current), 500)
    return () => clearInterval(timer)
  }, [phase])

  // The window is closing to the tray, where nothing would show that it still listens.
  useEffect(() => {
    if (stopSignal) stop()
  }, [stopSignal, stop])

  // Reloading or leaving the page closes the microphone by itself, and that is all it can do then.
  // Unmounting too: an error on any screen blanks the window, where nothing would show that it listens.
  useEffect(() => {
    const leave = () => capture.current?.stop()
    addEventListener('pagehide', leave)
    return () => {
      removeEventListener('pagehide', leave)
      leave()
      // Nothing is left on the screen to say it has ended: the app and the taskbar have to know.
      if (session.current) void fetch(`/api/voice/sessions/${session.current}/stop`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: '{}', keepalive: true }).catch(() => undefined)
    }
  }, [])

  const value = useMemo(
    () => ({ phase, threadId, elapsed, level, noSignal, device, pending, lost, segments, error, data, notice, reload, noteDraft, draftSaved, clearNotice, clearError, start, pause, stop }),
    [phase, threadId, elapsed, level, noSignal, device, pending, lost, segments, error, data, notice, reload, noteDraft, draftSaved, clearNotice, clearError, start, pause, stop],
  )
  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>
}

/** In the title row of every screen, while the microphone is open. */
export function ListeningBar() {
  // The title row also stands alone while the app starts, and nothing can be listening then.
  const voice = useContext(VoiceContext)
  if (!voice) return null
  const { phase, elapsed, threadId, stop, pause, data, notice, clearNotice, noSignal } = voice
  if (phase === 'idle' && notice) {
    return (
      <span className="voice-waiting" role="alert">
        ✕ {notice}{' '}
        <button type="button" className="link" onClick={clearNotice}>
          {t('OK')}
        </button>
      </span>
    )
  }
  if (phase === 'idle') {
    // A text nobody has read yet can be in another thread, after a restart for instance.
    const waiting = data?.drafts.filter((draft) => draft.stoppedAt) ?? []
    if (!waiting.length) return null
    return (
      <a className="voice-waiting" href={`#t/${encodeURIComponent(waiting[0].threadId)}`}>
        {waiting.length > 1 ? t('{0} textes à relire', { 0: waiting.length }) : t('1 texte à relire')}
      </a>
    )
  }
  if (phase !== 'listening' && phase !== 'paused') return null
  return (
    <div className={`listening-bar ${phase}`} role="status">
      <span className="listening-dot" aria-hidden />
      <a href={threadId ? `#t/${encodeURIComponent(threadId)}` : '#'}>{phase === 'paused' ? t('En pause') : t('À l’écoute')}</a>
      <span>{clock(elapsed)}</span>
      {noSignal && phase === 'listening' && <span className="voice-silent">{t('✕ aucun son')}</span>}
      <button type="button" className="link" onClick={() => pause(phase === 'listening')}>
        {phase === 'listening' ? t('Pause') : t('Reprendre')}
      </button>
      <button type="button" className="link" onClick={stop}>
        {t('Arrêter')}
      </button>
    </div>
  )
}

/** The button in the composer. Opening the panel opens nothing else. */
export function VoiceTool({ threadId, open, onToggle, disabled }: { threadId: string; open: boolean; onToggle: () => void; disabled?: boolean }) {
  const { phase, threadId: listeningIn } = useVoice()
  const here = (phase === 'listening' || phase === 'paused') && listeningIn === threadId
  return (
    <button type="button" className={`tool ${open || here ? 'on' : ''}`} disabled={disabled} title={t('Dire à voix haute ce que vous voulez écrire ici')} onClick={onToggle}>
      {t('Parler')}
    </button>
  )
}

function MicrophoneChoice({ value, onChange, disabled }: { value: string; onChange: (id: string) => void; disabled: boolean }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  useEffect(() => {
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((found) => setDevices(found.filter((device) => device.kind === 'audioinput' && device.deviceId !== 'default' && device.deviceId !== 'communications' && device.label)))
      .catch(() => undefined)
  }, [])
  // No names means nothing to choose from: the default one is used.
  if (!devices.length) return null
  return (
    <label className="voice-mic">
      {t('Micro')}
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t('Celui par défaut de Windows')}</option>
        {devices.map((device) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/** What a person reads and corrects before it can go anywhere. */
function Review({ draft, onDone }: { draft: Draft; onDone: () => void }) {
  const { noteDraft, draftSaved } = useVoice()
  const [text, setText] = useState(draft.text)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [discarding, setDiscarding] = useState(false)
  const lastSaved = useRef(draft.text)
  const latest = useRef(draft.text)
  const finished = useRef(false)
  const save = useCallback(
    (value: string) =>
      call(`voice/sessions/${draft.id}/text`, { text: value })
        .then(() => {
          lastSaved.current = value
          draftSaved(draft.id, value)
          setSaveError(null)
        })
        .catch((failure) => setSaveError((failure as Error).message)),
    [draft.id, draftSaved],
  )
  useEffect(() => {
    if (text === lastSaved.current) return
    const timer = setTimeout(() => void save(text), SAVE_AFTER_MS)
    return () => clearTimeout(timer)
  }, [text, save])
  // Leaving the thread right after typing doesn't lose it.
  useEffect(
    () => () => {
      if (!finished.current && latest.current !== lastSaved.current) void save(latest.current)
    },
    [save],
  )
  const act = async (route: string, body: unknown) => {
    setBusy(true)
    setError(null)
    finished.current = true
    try {
      await call(`voice/sessions/${draft.id}/${route}`, body)
      draftSaved(draft.id, latest.current)
      onDone()
    } catch (failure) {
      finished.current = false
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="voice-review">
      <p className="voice-note">{t('Relisez avant d’envoyer : personne ne l’a encore vu, et il restera dans le fil. Pas de secret ni de donnée personnelle. Gardez les repères comme [01:20].')}</p>
      <textarea aria-label={t('Texte transcrit')} value={text} rows={Math.min(14, Math.max(4, Math.ceil(text.length / 90)))} disabled={busy}
        onChange={(event) => {
          setText(event.target.value)
          latest.current = event.target.value
          noteDraft(draft.id, event.target.value)
        }}
      />
      {saveError && <p className="set-bad voice-note">{t('✕ Vos corrections ne sont pas enregistrées : {0}', { 0: saveError })}</p>}
      {error && <p className="set-bad voice-note">✕ {error}</p>}
      <div className="voice-actions">
        <button type="button" className="send" disabled={busy || !text.trim()} onClick={() => void act('publish', { text })}>
          {t('Publier dans le fil')}
        </button>
        {discarding ? (
          <>
            <span className="voice-note">{t('Ce texte sera perdu.')}</span>
            <button type="button" className="ghost" disabled={busy} onClick={() => void act('discard', {})}>
              {t('Jeter')}
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setDiscarding(false)}>
              {t('Garder')}
            </button>
          </>
        ) : (
          <button type="button" className="ghost" disabled={busy} onClick={() => setDiscarding(true)}>
            {t('Jeter')}
          </button>
        )}
      </div>
    </div>
  )
}

/** In a thread: asks first, then shows what it hears, then what to read. */
export function VoicePanel({ threadId, open, closed, onPublished }: { threadId: string; open: boolean; closed: boolean; onPublished: () => void }) {
  const { phase, threadId: listeningIn, level, noSignal, device, pending, lost, segments, error, data, reload, clearError, start, pause, stop, elapsed } = useVoice()
  const [mic, setMic] = useState(() => localStorage.getItem(MIC_KEY) ?? '')
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    void reload()
  }, [reload])
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' })
  }, [segments.length])
  const chooseMic = (id: string) => {
    setMic(id)
    localStorage.setItem(MIC_KEY, id)
  }
  const here = (phase === 'listening' || phase === 'paused' || phase === 'finishing') && listeningIn === threadId
  const draft = data?.drafts.find((candidate) => candidate.threadId === threadId && candidate.stoppedAt)
  if (here) {
    return (
      <div className="voice-panel">
        <div className="voice-state">
          <span className={`listening-dot ${phase}`} aria-hidden />
          <strong>{phase === 'finishing' ? t('Micro fermé') : phase === 'paused' ? t('En pause') : t('À l’écoute')}</strong>
          <span className="voice-note">{clock(elapsed)}</span>
          {phase === 'listening' && <span className="voice-meter" style={{ '--level': level } as React.CSSProperties} aria-hidden />}
          {device && <span className="voice-note voice-device">{device}</span>}
          <span className="spacer" />
          {phase !== 'finishing' && (
            <>
              <button type="button" className="ghost" onClick={() => pause(phase === 'listening')}>
                {phase === 'listening' ? t('Pause') : t('Reprendre')}
              </button>
              <button type="button" className="send" onClick={stop}>
                {t('Arrêter')}
              </button>
            </>
          )}
        </div>
        {noSignal && phase === 'listening' && <p className="set-bad voice-note">{t('✕ Ce micro n’envoie aucun son depuis quelques secondes : il est peut-être coupé.')}</p>}
        {lost > 0 && <p className="set-bad voice-note">{t('✕ {0} passage', { 0: lost })}{lost > 1 ? 's' : ''}{' '}{t('non transcrit')}{lost > 1 ? 's' : ''}. {error}</p>}
        <div className="voice-lines" aria-live="polite">
          {!segments.length && !pending && <p className="voice-note">{t('Parlez : le texte arrive à chaque pause.')}</p>}
          {segments.map((segment) => (
            <p key={segment.seq} className={segment.lost ? 'set-bad' : ''}>
              <time>{clock(segment.at)}</time> {segment.lost ? t('Passage non transcrit.') : segment.text}
            </p>
          ))}
          {pending > 0 && <Loading>{phase === 'finishing' ? t('Transcription des derniers mots') : t('Transcription')}{pending > 1 ? t(' · {0} passages en attente', { 0: pending }) : '…'}</Loading>}
          <div ref={end} />
        </div>
      </div>
    )
  }
  if (draft) {
    return (
      <div className="voice-panel">
        {error && <p className="set-bad voice-note">✕ {error}</p>}
        <Review
          key={draft.id}
          draft={draft}
          onDone={() => {
            clearError()
            void reload()
            onPublished()
          }}
        />
      </div>
    )
  }
  if (!open) return null
  if (!data) {
    return (
      <div className="voice-panel">
        <Loading>{t('Chargement…')}</Loading>
      </div>
    )
  }
  if (closed) return <div className="voice-panel voice-note">{t('Ce fil est clos : rouvrez-le pour y parler.')}</div>
  if (!data.status.supported) return <div className="voice-panel voice-note">{t('La transcription nécessite Windows sur un processeur x64.')}</div>
  if (!data.status.ready) {
    return (
      <div className="voice-panel voice-note">
        {t('La transcription tourne sur cet ordinateur, et son modèle reste à installer :')}{' '}<a href={toSection('voice')}>{t('voyez Réglages')}</a>.
      </div>
    )
  }
  // Another page's listening, such as a tab in a browser that was closed: it can only be ended from here.
  const otherPage = phase === 'idle' ? data.listening : null
  if (otherPage) {
    return (
      <div className="voice-panel">
        <p className="voice-note">{t('Une autre page de cette app a ouvert une écoute, et son micro n’est peut-être plus ouvert.')}</p>
        <div className="voice-actions">
          <button type="button" className="ghost" onClick={() => void call(`voice/sessions/${otherPage.id}/stop`, {}).then(reload)}>
            {t('Terminer cette écoute')}
          </button>
        </div>
      </div>
    )
  }
  const elsewhere = phase === 'listening' || phase === 'paused' || phase === 'finishing' || phase === 'starting'
  return (
    <div className="voice-panel">
      <p className="voice-note">
        {t('Le micro s’ouvre quand vous cliquez et se ferme à « Arrêter ». Le son ne quitte jamais cet ordinateur, et vous relisez le texte avant que quiconque le voie.')}
      </p>
      <p className="voice-note">{t('Mettez un casque si vous êtes en appel : ce micro entendrait l’autre personne dans vos haut-parleurs, sans son accord.')}</p>
      {error && <p className="set-bad voice-note">✕ {error}</p>}
      {elsewhere && phase !== 'starting' && <p className="voice-note">{phase === 'finishing' ? t('Le micro est fermé : la transcription de l’écoute précédente se termine.') : t('Vous êtes déjà à l’écoute dans un autre fil.')}</p>}
      <div className="voice-actions">
        <button type="button" className="send" disabled={elsewhere} onClick={() => void start(threadId, mic)}>
          {phase === 'starting' ? t('Ouverture du micro…') : t('Démarrer l’écoute')}
        </button>
        <MicrophoneChoice value={mic} onChange={chooseMic} disabled={elsewhere} />
      </div>
    </div>
  )
}

interface SpokenTurn {
  author: string
  at: string
  text: string
}
export interface VoiceState {
  parts: string[]
  ready: boolean
  turns: SpokenTurn[]
}

/**
 * Where a thread stands on a conversation out loud. Publishing is how each member validates their part,
 * and the summary opens once two voices are there.
 */
export function VoiceShared({ threadId, state, me, closed, busy, onAsked }: { threadId: string; state: VoiceState; me: string; closed: boolean; busy: boolean; onAsked: () => void }) {
  const [reading, setReading] = useState(false)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!state.parts.length) return null
  const ask = async () => {
    setAsking(true)
    setError(null)
    try {
      await call(`threads/${encodeURIComponent(threadId)}/voice-summary`, {})
      onAsked()
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setAsking(false)
    }
  }
  return (
    <div className="voice-shared">
      <div className="voice-state">
        {state.ready ? (
          <span>{t('Parties publiées : {0}.', { 0: state.parts.map((login) => personOf(login).name).join(', ') })}</span>
        ) : state.parts.some((login) => login.toLowerCase() === me.toLowerCase()) ? (
          <span>{t('Votre partie est publiée. Le résumé attend une autre voix.')}</span>
        ) : (
          <span>{t('{0} a publié sa partie. Le résumé attend la vôtre : « Parler », relisez, publiez.', { 0: personOf(state.parts[0]).name })}</span>
        )}
        <span className="spacer" />
        <button type="button" className="link" aria-expanded={reading} onClick={() => setReading(!reading)}>
          {reading ? t('Masquer la conversation') : t('Voir la conversation')}
        </button>
        {state.ready && !closed && (
          <button type="button" className="send" disabled={busy || asking} title={t('Votre agent résume ce que chacun a publié. Cela utilise votre quota.')} onClick={() => void ask()}>
            {t('Résumer la conversation')}
          </button>
        )}
      </div>
      {error && <p className="set-bad voice-note">✕ {error}</p>}
      {reading && (
        <div className="voice-lines voice-turns">
          {state.turns.map((turn, index) => (
            <p key={`${turn.at}-${index}`}>
              <time>{new Date(turn.at).toLocaleTimeString(dateLocale())}</time> <b className={`voice-speaker ${personOf(turn.author).tone}`}>{personOf(turn.author).name}</b> {turn.text}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

/** In the settings: what is installed, and what it would take. Nothing downloads without a click. */
export function VoiceSettings() {
  const [data, setData] = useState<VoiceData | null>(null)
  const [engine, setEngine] = useState<EngineVariant | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const load = useCallback(() => call<VoiceData>('voice').then(setData), [])
  useEffect(() => {
    load().catch((failure) => setError((failure as Error).message))
  }, [load])
  const installing = data?.status.installing
  useEffect(() => {
    if (!installing) return
    const timer = setInterval(() => void load().catch(() => undefined), STATUS_POLL_MS)
    return () => clearInterval(timer)
  }, [installing, load])
  if (!data) return error ? <div className="inline-error">{error}</div> : null
  const { status } = data
  if (!status.supported) {
    return (
      <>
        <p className="folder-intro">{t('La transcription nécessite Windows sur un processeur x64.')}</p>
      </>
    )
  }
  const wantedEngine = engine ?? status.chosen.engine ?? status.recommended.engine
  const wantedModel = model ?? status.chosen.model ?? status.recommended.model
  const engineInfo = status.engines.find((candidate) => candidate.id === wantedEngine)!
  const modelInfo = status.models.find((candidate) => candidate.id === wantedModel)!
  const toFetch = (engineInfo.installed ? 0 : engineInfo.size) + (modelInfo.installed || modelInfo.inSpeak ? 0 : modelInfo.size)
  const complete = engineInfo.installed && modelInfo.installed
  const inUse = status.chosen.engine === wantedEngine && status.chosen.model === wantedModel
  const act = async (route: string, body: unknown) => {
    setError(null)
    try {
      await call(route, body)
      await load()
    } catch (failure) {
      setError((failure as Error).message)
    }
  }
  return (
    <>
      <p className="set-note">{t('La dictée se fait sur cet ordinateur : le son ne part nulle part, et vous relisez le texte avant de l’envoyer. Un téléchargement unique est nécessaire.')}</p>
      <Row label={t('Calcul')} hint={status.gpu ? t('Carte détectée : {0}.', { 0: status.gpu }) : t('Aucune carte NVIDIA détectée : le processeur transcrit, plus lentement.')}>
          <span className="set-choices voice-choices" role="radiogroup" aria-label={t('Calcul')}>
            {status.engines.map((candidate) => (
              <button key={candidate.id} type="button" role="radio" className="radio" aria-checked={wantedEngine === candidate.id} disabled={Boolean(installing)} onClick={() => setEngine(candidate.id)}>
                {wantedEngine === candidate.id ? '(•)' : '( )'} {localize(candidate.label)} · {candidate.installed ? t('installé') : sizeOf(candidate.size)}
              </button>
            ))}
          </span>
      </Row>
      <Row label={t('Précision')} hint={modelInfo.note}>
          <span className="set-choices voice-choices" role="radiogroup" aria-label={t('Précision')}>
            {status.models.map((candidate) => (
              <button key={candidate.id} type="button" role="radio" className="radio" aria-checked={wantedModel === candidate.id} disabled={Boolean(installing)} onClick={() => setModel(candidate.id)}>
                {wantedModel === candidate.id ? '(•)' : '( )'} {candidate.label} · {candidate.installed ? t('installé') : candidate.inSpeak ? t('déjà sur cet ordinateur') : sizeOf(candidate.size)}
              </button>
            ))}
          </span>
      </Row>
      <Row label={t('État')}>
          {installing ? (
            <span className="loading">
              <Blocks ratio={installing.total ? installing.received / installing.total : undefined} />
              <span>
                {localize(installing.label)}
                {installing.total ? t(' · {0} de {1}', { 0: percent(installing.received / installing.total), 1: sizeOf(installing.total) }) : ''}
              </span>
            </span>
          ) : status.ready ? (
            <span className="set-ok">{t('✓ Prêt ·')}{' '}{status.engines.find((candidate) => candidate.id === status.chosen.engine)?.label} · {status.models.find((candidate) => candidate.id === status.chosen.model)?.label}</span>
          ) : (
            <span className="dim">{t('Pas encore installé.')}</span>
          )}
          {!installing && status.installError && <p className="set-bad">✕ {status.installError}</p>}
          {error && <p className="set-bad">✕ {error}</p>}
          {!complete && !installing && <p>{toFetch ? t('À télécharger : {0}.', { 0: sizeOf(toFetch) }) : t('Rien à télécharger.')}</p>}
          <div className="folder-actions">
            {installing && (
              <button type="button" className="ghost" onClick={() => void act('voice/cancel', {})}>
                {t('Annuler')}
              </button>
            )}
            {!installing && !(complete && inUse) && (
              <button type="button" className="send" onClick={() => void act('voice/install', { engine: wantedEngine, model: wantedModel })}>
                {complete ? t('Utiliser ce choix') : t('Installer')}
              </button>
            )}
            {!installing &&
              (status.engines.some((candidate) => candidate.installed) || status.models.some((candidate) => candidate.installed)) &&
              (removing ? (
                <>
                  <button type="button" className="ghost" onClick={() => void act('voice/remove', {}).then(() => setRemoving(false))}>
                    {t('Supprimer le moteur et les modèles')}
                  </button>
                  <button type="button" className="ghost" onClick={() => setRemoving(false)}>
                    {t('Garder')}
                  </button>
                </>
              ) : (
                <button type="button" className="ghost" onClick={() => setRemoving(true)}>
                  {t('Libérer la place')}
                </button>
              ))}
          </div>
      </Row>
    </>
  )
}
