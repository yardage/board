import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { AboutView, DictationView, ProgramView } from '../../../server/board/routes/about.ts'
import { CallError, call } from '../../lib/api.ts'
import { dateLocale, localize, t } from '../../../shared/i18n/i18n.ts'
import { Blocks, Loading, percent, Spinner, useUpdateProgress } from '../../components/ui.tsx'
import { Row } from './settings-parts.tsx'
import { toSection } from './settings-sections.ts'

/**
 * "About": the app on this computer, its updates, the programs it works with, and its command line. Each
 * program is asked on its own, so a slow one holds up only its row; the page never waits for them.
 */

/** A check can answer at once: long enough for the bar to be seen, and for the screen not to flicker. */
const CHECK_SHOWN_MS = 800

const time = (iso: string) => new Date(iso).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' })
const sizeOf = (bytes: number) => (bytes >= 1e9 ? t('{0} Go', { 0: (bytes / 1e9).toFixed(1).replace('.', ',') }) : t('{0} Mo', { 0: Math.round(bytes / 1e6) }))
const failed = (failure: unknown) => (failure as Error).message

/** A heading over rows, with what acts on all of them at its end. */
function Section({ title, tail, note, children }: { title: string; tail?: ReactNode; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="set-group-block">
      <div className="about-head">
        <h3 className="set-title">{title}</h3>
        {tail && <span className="about-tail">{tail}</span>}
      </div>
      {note && <p className="set-note">{note}</p>}
      {children}
    </section>
  )
}

function AppRows({ data }: { data: AboutView }) {
  const [opened, setOpened] = useState<'idle' | 'busy' | 'gone'>('idle')
  const [error, setError] = useState<string | null>(null)
  const open = async () => {
    setOpened('busy')
    setError(null)
    try {
      await call('app/open-data', {})
      setOpened('idle')
    } catch (failure) {
      // Only the installed app opens a folder: a page that can't, no longer offers it.
      setOpened(failure instanceof CallError && failure.status === 404 ? 'gone' : 'idle')
      if (!(failure instanceof CallError && failure.status === 404)) setError(failed(failure))
    }
  }
  return (
    <Section title={t('Board')}>
      <Row label={t('Version')}>{data.version ? `v${data.version}` : <span className="dim">{t('Lancée depuis le code')}</span>}</Row>
      <Row label={t('Système')}>{data.platform}</Row>
      {data.home && (
        <Row
          label={t('Données')}
          hint={error ? <span className="set-bad">✕ {error}</span> : t('Vos réglages, vos environnements et ce que l’app garde sur cet ordinateur.')}
          actions={
            data.canOpenData &&
            opened !== 'gone' && (
              <button type="button" className="ghost" disabled={opened === 'busy'} onClick={() => void open()}>
                {t('Ouvrir')}
              </button>
            )
          }
        >
          <span className="about-path">{data.home}</span>
        </Row>
      )}
    </Section>
  )
}

function UpdateRows({ data, reload, onChange }: { data: AboutView; reload: () => Promise<void>; onChange: () => void }) {
  const update = data.update
  const [busy, setBusy] = useState<'check' | 'install' | 'restart' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [canRestart, setCanRestart] = useState(data.canRestart)
  /** A download started before this screen opened, which only the app knows about. */
  const [resumed, setResumed] = useState(update.progress !== null)
  const downloading = busy === 'install' || resumed
  const progress = useUpdateProgress(downloading)
  /** The app reports no progress once it has stopped: a download this screen only resumed may have failed, and the app says why. */
  const seen = useRef(false)
  useEffect(() => {
    if (progress !== null) seen.current = true
    else if (resumed && seen.current) {
      seen.current = false
      setResumed(false)
      void reload().catch(() => undefined)
    }
  }, [progress, resumed, reload])
  const act = async (kind: 'check' | 'install', work: () => Promise<unknown>) => {
    setBusy(kind)
    setError(null)
    try {
      await work()
    } catch (failure) {
      setError(failed(failure))
    } finally {
      await reload().catch(() => undefined)
      setBusy(null)
      onChange()
    }
  }
  const check = () => act('check', () => Promise.all([call('update/check', {}), new Promise((done) => setTimeout(done, CHECK_SHOWN_MS))]))
  const [restartError, setRestartError] = useState<string | null>(null)
  const restart = async () => {
    setBusy('restart')
    setRestartError(null)
    try {
      await call('app/restart', {})
    } catch (failure) {
      setBusy(null)
      // A board in a browser has no app to start again: the action goes.
      if (failure instanceof CallError && failure.status === 404) setCanRestart(false)
      else setRestartError(failed(failure))
    }
  }
  const shownError = error ?? update.error
  const idle = busy === null && !downloading

  let status: ReactNode
  if (!update.can) status = <span className="dim">{t('Lancée depuis le code : les mises à jour se font avec lui.')}</span>
  else if (busy === 'check') status = <Loading>{t('Vérification…')}</Loading>
  else if (downloading)
    status = (
      <span className="loading">
        <Blocks ratio={progress ?? 0} />
        <span>{t('Téléchargement de la version {0} · {1}', { 0: update.available, 1: percent(progress ?? 0) })}</span>
      </span>
    )
  else if (shownError) status = <span className="set-bad">✕ {shownError}</span>
  else if (update.available) status = <span className="set-new">{t('La version {0} est disponible.', { 0: update.available })}</span>
  else if (update.checkedAt)
    status = (
      <span>
        <span className="set-ok">{t('✓ À jour')}</span>
        <span className="dim"> {t('· vérifié à {0}', { 0: time(update.checkedAt) })}</span>
      </span>
    )
  else status = <span className="dim">{t('Pas encore vérifié depuis le démarrage.')}</span>

  return (
    <Section
      title={t('Mises à jour')}
      tail={
        update.can && (
          <button type="button" className="ghost" disabled={!idle} onClick={() => void check()}>
            {t('Vérifier maintenant')}
          </button>
        )
      }
    >
      <Row
        label={t('État')}
        hint={update.can ? t('Rien ne s’installe sans votre clic. Installer télécharge la nouvelle version et rouvre l’app dessus.') : undefined}
        actions={
          update.can &&
          update.available &&
          !downloading && (
            <button type="button" className="send" disabled={!idle} onClick={() => void act('install', () => call('update', {}))}>
              {t('Installer')}
            </button>
          )
        }
      >
        {status}
      </Row>
      {canRestart && (
        <Row
          label={t('Redémarrage')}
          hint={restartError && <span className="set-bad">✕ {restartError}</span>}
          actions={
            <button type="button" className="ghost" disabled={!idle} onClick={() => void restart()}>
              {t('Redémarrer')}
            </button>
          }
        >
          {busy === 'restart' ? <Loading>{t('Redémarrage…')}</Loading> : <span className="dim">{t('L’app se ferme et se rouvre aussitôt, sur le même environnement.')}</span>}
        </Row>
      )}
    </Section>
  )
}

/** Each refresh asks every program again, past what the app kept. */
interface Round {
  n: number
  fresh: boolean
}

/** One program's answer, asked when the row appears and again when the person asks. */
function useComponent<T>(id: string, round: Round) {
  const [found, setFound] = useState<{ value: T | null; error: string | null; loading: boolean }>({ value: null, error: null, loading: true })
  const [own, setOwn] = useState(0)
  useEffect(() => {
    let live = true
    setFound((current) => ({ ...current, loading: true, error: null }))
    call<T>(`about/components/${id}${round.fresh || own > 0 ? '?fresh=1' : ''}`).then(
      (value) => live && setFound({ value, error: null, loading: false }),
      (failure) => live && setFound({ value: null, error: failed(failure), loading: false }),
    )
    return () => {
      live = false
    }
  }, [id, round, own])
  return { ...found, again: () => setOwn((current) => current + 1) }
}

const Checking = () => (
  <span className="dim">
    <Spinner /> {t('Vérification…')}
  </span>
)

function ProgramRow({ id, name, hint, required, round }: { id: ProgramView['id']; name: string; hint: string; required: boolean; round: Round }) {
  const { value, error, loading, again } = useComponent<ProgramView>(id, round)
  const [installing, setInstalling] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const install = async () => {
    setInstalling(true)
    setFailure(null)
    try {
      await call('setup/install', { tool: id })
    } catch (problem) {
      setFailure(failed(problem))
    }
    setInstalling(false)
    again()
  }
  const missing = value && !value.installed
  return (
    <Row
      label={name}
      hint={failure ? <span className="set-bad">✕ {failure}</span> : hint}
      actions={
        missing &&
        !installing &&
        (value.install ? (
          <button type="button" className="ghost" onClick={() => void install()}>
            {t('Installer')}
          </button>
        ) : (
          <a className="link" href={value.page} target="_blank" rel="noreferrer">
            {required ? t('Télécharger') : t('Comment l\'installer')}
          </a>
        ))
      }
    >
      {installing ? (
        <span>
          <Spinner /> {t('Installation…')}
        </span>
      ) : loading ? (
        <Checking />
      ) : error ? (
        <span className="set-bad">✕ {error}</span>
      ) : value?.installed ? (
        <span>
          <span className="set-ok">✓ {t('installé')}</span>
          {value.version && <span className="dim"> · {t('version {0}', { 0: value.version })}</span>}
        </span>
      ) : (
        <span className={required ? 'set-bad' : 'dim'}>✕ {t('absent')}</span>
      )}
    </Row>
  )
}

/** The dictation's engine and model: what is here, or what the Dictation part would download. */
function DictationRows({ round }: { round: Round }) {
  const { value, error, loading } = useComponent<DictationView>('voice', round)
  const go = (
    <a className="link" href={toSection('voice')}>
      {t('Dictée')}
    </a>
  )
  if (loading || error || !value) {
    const waiting = error ? <span className="set-bad">✕ {error}</span> : <Checking />
    return (
      <>
        <Row label={t('Moteur de dictée')} actions={go}>
          {waiting}
        </Row>
        <Row label={t('Modèle de dictée')} actions={go}>
          {waiting}
        </Row>
      </>
    )
  }
  if (!value.supported)
    return (
      <Row label={t('Dictée')}>
        <span className="dim">{t('La transcription nécessite Windows sur un processeur x64.')}</span>
      </Row>
    )
  const part = (piece: DictationView['engine']) =>
    value.installing ? (
      <span>
        <Spinner /> {t('Installation…')}
      </span>
    ) : piece.installed ? (
      <span className="set-ok">✓ {localize(piece.label ?? '')}</span>
    ) : (
      <span className="dim">
        {t('Pas installé')}
        {piece.size > 0 && ` · ${t('{0} à télécharger', { 0: sizeOf(piece.size) })}`}
      </span>
    )
  /** What the Dictation part would pick on this computer, said only while nothing is installed. */
  const suggested = (piece: DictationView['engine']) => (!piece.installed && !value.installing && piece.label ? t('Conseillé ici : {0}.', { 0: localize(piece.label) }) : undefined)
  return (
    <>
      <Row label={t('Moteur de dictée')} hint={suggested(value.engine)} actions={go}>
        {part(value.engine)}
      </Row>
      <Row label={t('Modèle de dictée')} hint={suggested(value.model)} actions={go}>
        {part(value.model)}
      </Row>
    </>
  )
}

function ComponentRows() {
  const [round, setRound] = useState<Round>({ n: 0, fresh: false })
  return (
    <Section
      title={t('Composants')}
      tail={
        <button type="button" className="ghost" onClick={() => setRound((current) => ({ n: current.n + 1, fresh: true }))}>
          {t('Actualiser')}
        </button>
      }
    >
      <ProgramRow id="git" name="Git" required round={round} hint={t('Garde la copie de l’environnement sur cet ordinateur.')} />
      <ProgramRow id="gh" name="GitHub CLI" required round={round} hint={t('Votre connexion à GitHub : l’app lit et écrit avec elle.')} />
      <ProgramRow id="claude" name="Claude Code" required={false} round={round} hint={t('Fait répondre votre agent, sur votre compte. Un des deux suffit.')} />
      <ProgramRow id="codex" name="Codex" required={false} round={round} hint={t('Fait répondre votre agent, sur votre compte. Un des deux suffit.')} />
      <DictationRows round={round} />
    </Section>
  )
}

function CommandRows({ cli }: { cli: string }) {
  const thread = t('<fil>')
  const commands: [string, string, string][] = [
    ['threads', `${cli} threads`, t('Les fils : leur numéro, leur état, leurs messages et leur titre.')],
    ['read', `${cli} read ${thread}`, t('Un fil et tous ses messages.')],
    ['new', `${cli} new "${t('Titre')}" --file message.md`, t('Ouvre un fil, avec le message de ce fichier.')],
    ['post', `${cli} post ${thread} --file message.md`, t('Répond dans un fil, avec le message de ce fichier.')],
  ]
  return (
    <Section title={t('Ligne de commande')} note={t('Pour un script, ou une session de Claude Code ou de Codex. Elle travaille sur l’environnement ouvert en dernier, et écrit sous votre login GitHub.')}>
      {commands.map(([name, line, what]) => (
        <Row key={name} label={name} hint={what}>
          <code className="about-command">{line}</code>
        </Row>
      ))}
    </Section>
  )
}

export function AboutSettings({ onChange }: { onChange: () => void }) {
  const [data, setData] = useState<AboutView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => call<AboutView>('about').then(setData), [])
  useEffect(() => {
    load().catch((failure) => setError(failed(failure)))
  }, [load])
  if (!data) return error ? <div className="inline-error">{error}</div> : <Loading>{t('Lecture des réglages…')}</Loading>
  return (
    <div className="about">
      <AppRows data={data} />
      <UpdateRows data={data} reload={load} onChange={onChange} />
      <ComponentRows />
      <CommandRows cli={data.cli} />
    </div>
  )
}
