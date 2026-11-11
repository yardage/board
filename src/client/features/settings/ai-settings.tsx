import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { type AiView, ChoiceTable, GeneralChoice } from './ai-choice.tsx'
import { AI_USES, type AiChoices, defaultChoices, type Provider, PROVIDER_NAMES, PROVIDERS } from '../../../shared/ai-uses.ts'
import { call } from '../../lib/api.ts'
import { t } from '../../../shared/i18n/i18n.ts'
import { Spinner } from '../../components/ui.tsx'
import { Row } from './settings-parts.tsx'

/** How a program stands on this computer: two runs of it, asked apart from the page. */
interface Status {
  installed: boolean
  version: string | null
  loggedIn: boolean | null
  method: string | null
  plan: string | null
}

interface Setup {
  /** Null: its usual folder. */
  home: string | null
  /** Null: found in its usual places. */
  path: string | null
}

interface Program extends Setup {
  models: string[]
  efforts: string[]
}

/** `GET /api/ai`: what is set, offered and chosen. Nothing in it runs a program, so the page is there at once. */
interface AiPage {
  provider: Provider
  programs: Record<Provider, Program>
  choices: Record<Provider, AiChoices>
}

const INSTALL_PAGE: Record<Provider, string> = { claude: 'https://docs.claude.com/en/docs/claude-code/setup', codex: 'https://developers.openai.com/codex' }
const USUAL_HOME: Record<Provider, string> = { claude: '~/.claude', codex: '~/.codex' }
const OTHER_HOME: Record<Provider, string> = { claude: '~/.claude_work', codex: '~/.codex_work' }
/** Whose account each uses, and what it may read: the board's folders only, for both. */
const PROGRAMS: Record<Provider, { tag: string; reads: string }> = {
  claude: { tag: t('votre compte Claude'), reads: t('Ne lit que les dossiers du board, et ne lance aucune commande.') },
  codex: { tag: t('votre compte ChatGPT'), reads: t('Ne lit que les dossiers du board, et ne lance aucune commande.') },
}

/** After an install page or a login opens, how often and how long the page looks again. */
const WATCH_EVERY_MS = 3000
const WATCH_FOR_MS = 5 * 60_000

const ready = (status: Status | null) => Boolean(status?.installed && status.loggedIn)

/**
 * A program's state, asked on its own so the page never waits for it, after speak's `useAgentStatus`. Installing
 * and signing in happen outside the board: for a few minutes after `watch()`, it looks again every few seconds
 * while the window shows, and when it gets the focus back, until the program is there and signed in. A state
 * that follows something done here (another program, folder or location, a refresh, a login) is told with
 * `onNews`, for the rest of the settings.
 *
 * The question names the folder and location the page shows, and the answer the ones it is of: an answer of
 * others, given before a change or after another window's, is left, and `onStale` reads the page again. `read`
 * counts the page's readings, and each one asks again.
 */
function useProgramStatus(provider: Provider, { home, path }: Setup, read: number, onNews: () => void, announce: boolean, onStale: () => void) {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [watchUntil, setWatchUntil] = useState(0)
  /** Only the latest look's answer counts. */
  const latest = useRef(0)
  const inFlight = useRef(0)
  const tell = useRef(announce)
  const first = useRef(true)
  const news = useRef(onNews)
  news.current = onNews
  const stale = useRef(onStale)
  stale.current = onStale

  const check = useCallback(
    async (fresh: boolean, tick = false) => {
      if (tick && inFlight.current) return
      const look = ++latest.current
      inFlight.current++
      setChecking(true)
      try {
        const query = new URLSearchParams({ provider, home: home ?? '', path: path ?? '' })
        if (fresh) query.set('fresh', '1')
        const found = await call<Status & Setup>(`ai/status?${query}`)
        if (look !== latest.current) return
        if (found.home !== home || found.path !== path) {
          stale.current()
          return
        }
        setStatus(found)
        setError(null)
        if (tell.current) {
          tell.current = false
          news.current()
        }
      } catch (failure) {
        // The last state stays, if there is one: the next look may get another.
        if (look === latest.current) setError((failure as Error).message)
      } finally {
        if (--inFlight.current === 0) setChecking(false)
      }
    },
    [provider, home, path],
  )

  useEffect(() => {
    if (!first.current) tell.current = true
    first.current = false
    setStatus(null)
    setError(null)
    void check(false)
  }, [check, read])

  const watching = watchUntil > 0 && !ready(status)
  useEffect(() => {
    if (!watching) return
    const tick = () => {
      if (Date.now() > watchUntil) setWatchUntil(0)
      else if (!document.hidden) void check(true, true)
    }
    const timer = setInterval(tick, WATCH_EVERY_MS)
    addEventListener('focus', tick)
    return () => {
      clearInterval(timer)
      removeEventListener('focus', tick)
    }
  }, [watching, watchUntil, check])

  // What was awaited arrived: the rest of the settings hear of it.
  useEffect(() => {
    if (watchUntil > 0 && ready(status)) {
      setWatchUntil(0)
      news.current()
    }
  }, [status, watchUntil])

  const refresh = () => {
    tell.current = true
    void check(true)
  }
  return { status, error, checking, watching, refresh, watch: () => setWatchUntil(Date.now() + WATCH_FOR_MS) }
}

/** A heading between parts of the page, with what can be done there. */
function Part({ title, action, note, children }: { title: string; action?: ReactNode; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="set-group-block">
      <div className="ai-part-head">
        <h3 className="set-title">{title}</h3>
        {action}
      </div>
      {note && <p className="set-note">{note}</p>}
      {children}
    </section>
  )
}

/** A path, saved when the person leaves the field or presses Enter; Escape takes it back. */
function PathField({ value, placeholder, label, onCommit }: { value: string | null; placeholder: string; label: string; onCommit: (next: string) => Promise<void> }) {
  const [text, setText] = useState(value ?? '')
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => setText(value ?? ''), [value])
  useEffect(() => () => clearTimeout(timer.current), [])
  const commit = () => {
    if (text.trim() === (value ?? '')) {
      setError(null)
      return
    }
    clearTimeout(timer.current)
    setState('saving')
    setError(null)
    onCommit(text.trim()).then(
      () => {
        setState('saved')
        timer.current = setTimeout(() => setState('idle'), 1600)
      },
      (failure: Error) => {
        setState('idle')
        setError(failure.message)
      },
    )
  }
  const key = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') event.currentTarget.blur()
    if (event.key === 'Escape') {
      setText(value ?? '')
      setError(null)
    }
  }
  return (
    <>
      <span className="set-box long ai-path">
        <input className={`set-input ${error ? 'wrong' : ''}`} value={text} placeholder={placeholder} aria-label={label} spellCheck={false} autoComplete="off" onChange={(event) => setText(event.target.value)} onBlur={commit} onKeyDown={key} aria-invalid={error ? true : undefined} />
        {state === 'saving' && <span className="dim">…</span>}
        {state === 'saved' && <span className="set-ok" role="status" aria-label={t('Enregistré')}>✓</span>}
      </span>
      {error && <span className="set-problem">✕ {error}</span>}
    </>
  )
}

/** The account in a few words, without the address or the organisation. */
const signedWords = (status: Status) => [status.plan && t('abonnement {0}', { 0: status.plan }), status.method && t('compte {0}', { 0: status.method })].filter(Boolean).join(' · ')

/** The chosen program: whether it is there, signed in, and the account folder and location it is given. */
function ProgramPart({ provider, program, read, switched, onSet, onChange, onStale }: { provider: Provider; program: Program; read: number; switched: boolean; onSet: (change: { home?: string; path?: string }) => Promise<void>; onChange: () => void; onStale: () => void }) {
  const name = PROVIDER_NAMES[provider]
  const agent = useProgramStatus(provider, program, read, onChange, switched, onStale)
  const { status } = agent
  const [loginError, setLoginError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  /** A login was opened on this folder and location, and the page waits for it. */
  const [opened, setOpened] = useState(false)
  useEffect(() => setOpened(false), [program.home, program.path])
  const signIn = async () => {
    setLoginError(null)
    setOpening(true)
    try {
      await call('ai/login', { provider })
      setOpened(true)
      agent.watch()
    } catch (failure) {
      setLoginError((failure as Error).message)
    } finally {
      setOpening(false)
    }
  }
  const unknown = !status && (agent.error ? <span className="set-bad">✕ {t('État illisible : {0}', { 0: agent.error })}</span> : <span className="dim"><Spinner /> {t('vérification…')}</span>)

  return (
    <Part
      title={name}
      action={
        <button type="button" className="link ai-refresh" disabled={agent.checking} onClick={agent.refresh}>
          {agent.checking ? t('vérification…') : t('vérifier')}
        </button>
      }
    >
      <Row
        label={t('Programme')}
        hint={status && !status.installed ? t('Sa propre page dit comment l’installer : le board le trouve dès qu’il est là.') : undefined}
        actions={
          status && !status.installed && (
            <a className="link" href={INSTALL_PAGE[provider]} target="_blank" rel="noreferrer" data-outside onClick={agent.watch}>
              {t('page d’installation ↗')}
            </a>
          )
        }
      >
        {unknown ||
          (status?.installed ? (
            <span>
              <span className="set-ok">{t('✓ Installé')}</span>
              {status.version && <span className="dim"> · {t('version {0}', { 0: status.version })}</span>}
            </span>
          ) : (
            <span>
              <span className="set-bad">{t('✕ Absent')}</span>
              {agent.watching && <span className="dim"> · {t('le board regarde à nouveau toutes les quelques secondes')}</span>}
            </span>
          ))}
      </Row>
      {(!status || status.installed) && (
        <Row
          label={t('Connexion')}
          hint={t('Ouvre la connexion de {0} lui-même : le board ne voit jamais vos identifiants.', { 0: name })}
          actions={
            status &&
            status.loggedIn !== true && (
              // A window closed by mistake is opened again: clicking is never held for the whole wait.
              <button type="button" className="ghost" disabled={opening} onClick={() => void signIn()}>
                {opened && agent.watching ? t('Réessayer') : t('Se connecter')}
              </button>
            )
          }
        >
          {!status ? (
            <span className="dim">…</span>
          ) : status.loggedIn === true ? (
            <span>
              <span className="set-ok">{t('✓ Connecté')}</span>
              {signedWords(status) && <span className="dim"> · {signedWords(status)}</span>}
            </span>
          ) : status.loggedIn === false ? (
            <span>
              <span className="set-bad">{t('✕ Non connecté')}</span>
              {agent.watching && (
                <span className="dim">
                  {' '}
                  · <Spinner /> {t('terminez la connexion dans la fenêtre qui s’est ouverte')}
                </span>
              )}
            </span>
          ) : (
            <span className="dim">{t('connexion non vérifiée')}</span>
          )}
          {loginError && <p className="set-bad">✕ {loginError}</p>}
        </Row>
      )}
      <Row label={t('Dossier du compte')} hint={t('Les réglages et la connexion de {0}. Un autre dossier, comme {1}, utilise un autre compte.', { 0: name, 1: OTHER_HOME[provider] })}>
        <PathField value={program.home} placeholder={t('{0} · le dossier habituel', { 0: USUAL_HOME[provider] })} label={t('Dossier du compte')} onCommit={(home) => onSet({ home })} />
      </Row>
      <Row label={t('Emplacement du programme')} hint={t('Le programme {0} lui-même. Vide, il est cherché à ses emplacements habituels.', { 0: name })}>
        <PathField value={program.path} placeholder={t('trouvé automatiquement')} label={t('Emplacement du programme')} onCommit={(path) => onSet({ path })} />
      </Row>
    </Part>
  )
}

/**
 * The program that answers for the member on this computer, Claude Code or Codex, how it stands, the account
 * folder and location it is given, and the model and effort of each use. All of it is this computer's, for every
 * environment opened here. `view` is what the settings once gave; the page asks for its own.
 */
export function AiSettings({ onChange }: { onChange: () => void; view?: unknown }) {
  const [page, setPage] = useState<AiPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** The program was switched here: its state, when it comes, is news for the rest of the settings. */
  const [switched, setSwitched] = useState(false)
  /** How many times the page was read again, after an answer of another folder or location than it showed. */
  const [read, setRead] = useState(0)

  useEffect(() => {
    let alive = true
    call<AiPage>('ai').then(
      (found) => alive && setPage(found),
      (failure: Error) => alive && setError(failure.message),
    )
    return () => {
      alive = false
    }
  }, [])
  // Another window may have chosen since: what this computer has now, then its state asked again.
  const reload = useCallback(() => {
    call<AiPage>('ai').then(
      (found) => {
        setPage((current) => ({ ...current, ...found }))
        setRead((count) => count + 1)
      },
      (failure: Error) => setError(failure.message),
    )
  }, [])

  if (!page) return error ? <p className="set-note"><span className="set-bad">✕ {error}</span></p> : null
  const provider = page.provider
  const program = page.programs[provider]

  const choose = async (next: Provider) => {
    if (next === provider || busy) return
    setBusy(true)
    setError(null)
    try {
      const view = await call<Omit<AiPage, 'choices'>>('ai/provider', { provider: next })
      setPage((current) => (current ? { ...current, ...view } : current))
      setSwitched(true)
      onChange()
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const set = async (change: { home?: string; path?: string }) => {
    const view = await call<Omit<AiPage, 'choices'>>('ai/program', { provider, ...change })
    setPage((current) => (current ? { ...current, ...view } : current))
  }
  const saved = (ai: AiView) => setPage((current) => (current ? { ...current, choices: { ...current.choices, [ai.provider]: ai.choices } } : current))
  const base = defaultChoices(provider)
  const offered = { models: program.models, efforts: program.efforts, choices: page.choices[provider] }

  return (
    <>
      <Part title={t('Programme')} note={t('Le programme qui fait répondre votre agent, et qui traduit, titre et synthétise, avec votre propre compte.')}>
        <div className="ai-programs" role="radiogroup" aria-label={t('Programme')}>
          {PROVIDERS.map((one) => (
            <button key={one} type="button" role="radio" aria-checked={provider === one} className="ai-program" disabled={busy} onClick={() => void choose(one)}>
              <span className="ai-program-name">
                <span className="ai-radio" aria-hidden>
                  {provider === one ? '(•)' : '( )'}
                </span>{' '}
                {PROVIDER_NAMES[one]}
              </span>
              <span className="ai-program-tag">{PROGRAMS[one].tag}</span>
              <span className="ai-program-reads">
                {PROGRAMS[one].reads}
              </span>
            </button>
          ))}
        </div>
        {error && (
          <p className="set-note">
            <span className="set-bad">✕ {error}</span>
          </p>
        )}
      </Part>

      <ProgramPart key={provider} provider={provider} program={program} read={read} switched={switched} onSet={set} onChange={onChange} onStale={reload} />

      <Part title={t('Modèle et effort')} note={t('Plus haut, plus coûteux sur votre forfait. Un fil peut avoir les siens, sous sa zone de texte.')}>
        <ChoiceTable label={t('Modèle et effort par usage')}>
          {AI_USES.map((use) => (
            <GeneralChoice key={`${provider}-${use}`} use={use} view={offered} base={base[use]} disabled={busy} onSaved={saved} />
          ))}
        </ChoiceTable>
      </Part>
    </>
  )
}
