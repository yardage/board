import { useCallback, useEffect, useState } from 'react'
import { call } from '../../lib/api.ts'
import { t } from '../../../shared/i18n/i18n.ts'
import { Loading, Spinner } from '../../components/ui.tsx'

/**
 * What comes before an environment: the programs the app relies on, the person's GitHub login, their
 * Claude Code, then the environment itself. Each step says what is missing and fixes it with a click
 * where it can, so nobody needs a terminal.
 */

interface Tool {
  installed: boolean
  version: string | null
}

export interface SetupState {
  git: Tool
  gh: Tool
  /** Which program answers for the member, and how each stands. */
  provider: 'claude' | 'codex'
  ai: Record<'claude' | 'codex', { installed: boolean; version: string | null; loggedIn: boolean | null }>
  github: { loggedIn: boolean; login: string | null; scopes: string[]; missing: string[] }
  winget: boolean
  login: { code: string | null; url: string | null; running: boolean; error: string | null }
  installing: string | null
  environment: { current: string | null; opening: string | null; error: string | null; recent: string[] }
  version: string | null
  update: string | null
}

interface Choice {
  repo: string
  private: boolean
  admin: boolean
  description: string
}

const POLL_MS = 2000

function Step({ done, title, children }: { done: boolean; title: string; children?: React.ReactNode }) {
  return (
    <section className={`setup-step ${done ? 'done' : ''}`}>
      <h2>
        <span aria-hidden>{done ? '✓' : '·'}</span> {title}
        {done && <span className="sr-only">{t(' : fait')}</span>}
      </h2>
      {!done && children}
    </section>
  )
}

function Programs({ state, reload }: { state: SetupState; reload: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const install = async (tool: string) => {
    setError(null)
    try {
      await call('setup/install', { tool })
    } catch (failure) {
      setError((failure as Error).message)
    }
    reload()
  }
  const row = (key: 'git' | 'gh', name: string, link: string) => (
    <li>
      <strong>{name}</strong>{' '}
      {state[key].installed ? (
        <span className="ok">{t('installé ({0})', { 0: state[key].version ?? '?' })}</span>
      ) : state.installing === key ? (
        <span>
          <Spinner /> {t('Installation…')}
        </span>
      ) : (
        <>
          <span className="missing">{t('manquant')}</span>{' '}
          {state.winget ? (
            <button type="button" className="ghost" disabled={state.installing !== null} onClick={() => void install(key)}>
              {t('Installer')}
            </button>
          ) : (
            <a href={link} target="_blank" rel="noreferrer">
              {t('Télécharger')}
            </a>
          )}
        </>
      )}
    </li>
  )
  return (
    <>
      <ul className="setup-list">
        {row('git', 'Git', 'https://git-scm.com/downloads')}
        {row('gh', 'GitHub CLI', 'https://cli.github.com')}
        {(['claude', 'codex'] as const).map((provider) => (
          <li key={provider}>
            <strong>{PROGRAM_NAMES[provider]}</strong>{' '}
            {state.ai[provider].installed ? (
              <span className="ok">{t('installé ({0})', { 0: state.ai[provider].version ?? '?' })}</span>
            ) : (
              <>
                <span className="dim">{t('absent')}</span>{' '}
                <a href={INSTALL_PAGES[provider]} target="_blank" rel="noreferrer">
                  {t('Comment l\'installer')}
                </a>
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="hint">{t('Un seul des deux suffit : il fait répondre votre agent. Sans lui, vous lisez et écrivez, et votre agent se tait.')}</p>
      <p className="hint">{t('Vous vous connectez avec vos propres comptes : aucun mot de passe n’est enregistré ici.')}</p>
      {error && <p className="inline-error">{error}</p>}
    </>
  )
}

const PROGRAM_NAMES = { claude: 'Claude Code', codex: 'Codex' } as const
const INSTALL_PAGES = { claude: 'https://docs.claude.com/en/docs/claude-code/setup', codex: 'https://developers.openai.com/codex' } as const

/** Which program answers for the member: the one installed, or their pick when both are, then its own sign-in. */
function AgentProgram({ state, reload }: { state: SetupState; reload: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const installed = (['claude', 'codex'] as const).filter((provider) => state.ai[provider].installed)
  const chosen = state.ai[state.provider].installed ? state.provider : installed[0]
  const choose = async (provider: 'claude' | 'codex') => {
    setBusy(true)
    setError(null)
    try {
      await call('setup/ai/login', { provider, choose: true })
      reload()
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (!chosen) return null
  return (
    <>
      <p>{installed.length > 1 ? t('Deux programmes sont installés : choisissez celui qui fait répondre votre agent, avec votre propre compte.') : t('Votre agent tourne sur votre compte {0}. Connectez-vous une fois.', { 0: PROGRAM_NAMES[chosen] })}</p>
      <div className="setup-actions">
        {installed.map((provider) => (
          <button key={provider} type="button" className={provider === chosen && state.ai[provider].loggedIn !== false ? 'ghost' : 'send'} disabled={busy} onClick={() => void choose(provider)}>
            {state.ai[provider].loggedIn !== false ? t('Utiliser {0}', { 0: PROGRAM_NAMES[provider] }) : t('Se connecter à {0}', { 0: PROGRAM_NAMES[provider] })}
          </button>
        ))}
      </div>
      {state.ai[chosen].loggedIn === false && <p className="hint">{t('La connexion s’ouvre dans la fenêtre du programme ou dans votre navigateur. Cet écran suit.')}</p>}
      <p className="hint">{t('Facultatif pour lire et écrire : sans programme connecté, votre agent ne répond pas.')}</p>
      {error && <p className="inline-error">{error}</p>}
    </>
  )
}

function GithubLogin({ state, reload }: { state: SetupState; reload: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const start = async (kind: 'login' | 'refresh') => {
    setError(null)
    try {
      await call(`setup/github/${kind}`, {})
    } catch (failure) {
      setError((failure as Error).message)
    }
    reload()
  }
  if (state.login.running && state.login.code) {
    return (
      <div className="device-code">
        <p>{t('Votre navigateur s\'ouvre sur GitHub. Saisissez-y ce code :')}</p>
        <strong className="code">{state.login.code}</strong>
        <p>
          {state.login.url && (
            <a href={state.login.url} target="_blank" rel="noreferrer">
              {state.login.url}
            </a>
          )}
        </p>
        <p className="hint">
          <Spinner /> {t('En attente de GitHub…')}{' '}
          <button type="button" className="link" onClick={() => void call('setup/github/cancel', {}).then(reload)}>
            {t('Annuler')}
          </button>
        </p>
      </div>
    )
  }
  return (
    <>
      {!state.github.loggedIn ? (
        <button type="button" className="send" disabled={!state.gh.installed} onClick={() => void start('login')}>
          {t('Se connecter à GitHub')}
        </button>
      ) : (
        <>
          <p>{t('Connecté en tant que {0}, mais il manque des droits au jeton : {1}.', { 0: state.github.login ?? '?', 1: state.github.missing.join(', ') })}</p>
          <button type="button" className="send" onClick={() => void start('refresh')}>
            {t('Accorder ces droits')}
          </button>
        </>
      )}
      {(error || state.login.error) && <p className="inline-error">{error ?? state.login.error}</p>}
    </>
  )
}

function Environments({ state, onOpened }: { state: SetupState; onOpened: () => void }) {
  const [found, setFound] = useState<{ environments: Choice[]; owners: { login: string; organization: boolean }[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [owner, setOwner] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    call<{ environments: Choice[]; owners: { login: string; organization: boolean }[] }>('setup/environments')
      .then((data) => {
        setFound(data)
        setOwner((current) => current || data.owners.find((one) => one.organization)?.login || data.owners[0]?.login || '')
      })
      .catch((failure) => setError((failure as Error).message))
  }, [])
  const open = async (repo: string) => {
    setBusy(repo)
    setError(null)
    try {
      await call('setup/environments/open', { repo })
      onOpened()
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const create = async () => {
    setBusy('create')
    setError(null)
    try {
      await call('setup/environments/create', { owner, name: name.trim(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
      onOpened()
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const known = [...new Set([...state.environment.recent, ...(found?.environments.map((one) => one.repo) ?? [])])]
  return (
    <>
      <p>{t('Un environnement est un dépôt GitHub privé qui garde les fils, les sondages et les rapports d\'une équipe, sans aucun code. Choisissez le vôtre, ou créez-en un.')}</p>
      {busy && busy !== 'create' && (
        <p>
          <Loading>{t('Ouverture de {0}… La première fois, le board copie l\'environnement et les dépôts qu\'il suit.', { 0: busy })}</Loading>
        </p>
      )}
      {(error || state.environment.error) && <p className="inline-error">{error ?? state.environment.error}</p>}
      <h3>{t('Vos environnements')}</h3>
      {!found && !error && <Loading>{t('Recherche sur GitHub…')}</Loading>}
      {found && known.length === 0 && <p className="side-empty">{t('Aucun environnement trouvé pour ce compte.')}</p>}
      <ul className="setup-envs">
        {known.map((repo) => {
          const info = found?.environments.find((one) => one.repo.toLowerCase() === repo.toLowerCase())
          return (
            <li key={repo}>
              <button type="button" className="ghost" disabled={busy !== null} onClick={() => void open(repo)}>
                <strong>{repo}</strong>
                {info?.admin && <span className="tag">{t('admin')}</span>}
                {info?.description && <small>{info.description}</small>}
              </button>
            </li>
          )
        })}
      </ul>
      <h3>{t('Ouvrir un autre')}</h3>
      <div className="row">
        <input value={typed} placeholder="org/environnement" onChange={(event) => setTyped(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && typed.includes('/') && void open(typed.trim())} />
        <button type="button" className="ghost" disabled={busy !== null || !/^[\w.-]+\/[\w.-]+$/.test(typed.trim())} onClick={() => void open(typed.trim())}>
          {t('Ouvrir')}
        </button>
      </div>
      <h3>{t('Créer un environnement')}</h3>
      <div className="row">
        <select value={owner} onChange={(event) => setOwner(event.target.value)} disabled={!found}>
          {found?.owners.map((one) => (
            <option key={one.login} value={one.login}>
              {one.login}
            </option>
          ))}
        </select>
        <span>/</span>
        <input value={name} placeholder={t('nom-du-depot')} onChange={(event) => setName(event.target.value)} />
        <button type="button" className="send" disabled={busy !== null || !owner || !/^[A-Za-z0-9._-]{1,100}$/.test(name.trim())} onClick={() => void create()}>
          {busy === 'create' ? t('Création…') : t('Créer')}
        </button>
      </div>
      <p className="hint">{t('Le dépôt est privé. Vous en êtes administrateur : vous y invitez les membres sur GitHub, et vous seul changez sa configuration.')}</p>
    </>
  )
}

function UpdateNotice({ version }: { version: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const install = async () => {
    setBusy(true)
    setError(null)
    try {
      await call('setup/update', {})
    } catch (failure) {
      setError((failure as Error).message)
      setBusy(false)
    }
  }
  return (
    <p className="hint">
      {t('La version {0} est disponible.', { 0: version })}{' '}
      <button type="button" className="ghost" disabled={busy} onClick={() => void install()}>
        {busy ? t('Installation…') : t('Installer')}
      </button>
      {error && <span className="inline-error"> {error}</span>}
    </p>
  )
}

export function SetupScreen({ onOpened }: { onOpened: () => void }) {
  const [state, setState] = useState<SetupState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    call<SetupState>('setup')
      .then((found) => {
        setState(found)
        setError(null)
        if (found.environment.current) onOpened()
      })
      .catch((failure) => setError((failure as Error).message))
  }, [onOpened])
  useEffect(() => {
    // The next question waits for the last answer: a slow check never piles up requests.
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const next = () => {
      call<SetupState>('setup')
        .then((found) => {
          if (stopped) return
          setState(found)
          setError(null)
          if (found.environment.current) onOpened()
        })
        .catch((failure) => !stopped && setError((failure as Error).message))
        .finally(() => {
          if (!stopped) timer = setTimeout(next, POLL_MS)
        })
    }
    next()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [onOpened])
  if (!state)
    return (
      <div className="setup">
        {error ? <p className="inline-error">{error}</p> : <Loading>{t('Vérification de cet ordinateur…')}</Loading>}
      </div>
    )
  const programs = state.git.installed && state.gh.installed
  const github = state.github.loggedIn && !state.github.missing.length
  const anyProgram = state.ai.claude.installed || state.ai.codex.installed
  const agentReady = state.ai[state.provider].installed && state.ai[state.provider].loggedIn !== false
  return (
    <div className="setup">
      <h1>{t('Bienvenue')}</h1>
      {state.update && <UpdateNotice version={state.update} />}
      <Step done={programs && anyProgram} title={t('Les programmes')}>
        <Programs state={state} reload={reload} />
      </Step>
      <Step done={github} title={t('Votre compte GitHub')}>
        {programs ? <GithubLogin state={state} reload={reload} /> : <p className="hint">{t('Il faut d\'abord Git et GitHub CLI.')}</p>}
      </Step>
      {anyProgram && (
        <Step done={agentReady} title={t('Votre agent')}>
          <AgentProgram state={state} reload={reload} />
        </Step>
      )}
      {programs && github && (
        <Step done={false} title={t('Votre environnement')}>
          {state.environment.opening ? (
            <Loading>{t('Ouverture de {0}…', { 0: state.environment.opening })}</Loading>
          ) : (
            <Environments state={state} onOpened={onOpened} />
          )}
        </Step>
      )}
      {state.github.loggedIn && <p className="hint">{t('Connecté à GitHub en tant que {0}.', { 0: state.github.login ?? '?' })}</p>}
    </div>
  )
}
