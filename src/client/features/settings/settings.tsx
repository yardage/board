import { type JSX, type MouseEvent, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { AiSettings } from './ai-settings.tsx'
import { AboutSettings } from './about-settings.tsx'
import { call } from '../../lib/api.ts'
import { type AgentPolicy, AgentSettings } from './agent-settings.tsx'
import { EnvironmentPart } from './environment-settings.tsx'
import type { EnvironmentView } from './environment-config.ts'
import { type EnvironmentEditor, LeaveQuestion, SaveBar, useEnvironmentDraft } from './environment-draft.tsx'
import { ReadOnlyNote } from './environment-fields.tsx'
import { RepositoriesPart } from './repositories-settings.tsx'
import { ProjectsPart } from './projects-settings.tsx'
import { DocumentsPart } from './documents-settings.tsx'
import { MachinesPart } from './machines-settings.tsx'
import { ReportsPart } from './reports-settings.tsx'
import { adoptLanguage, t } from '../../../shared/i18n/i18n.ts'
import { NoticeSettingsPart } from './notice-settings.tsx'
import type { NoticeSettings } from '../../../shared/notices.ts'
import { Choices, Row, Saved } from './settings-parts.tsx'
import { SettingsClosing } from './settings-dialog.tsx'
import { type EnvironmentSection, isEnvironmentSection, SETTINGS_GROUPS, type SettingsSection, toSection } from './settings-sections.ts'
import { TEXT_SIZES, type TextSize } from '../../../shared/text-size.ts'
import { applyTheme, coloursOf, type Theme, type ThemeColours, themeProblem } from '../../../shared/themes.ts'
import { Loading } from '../../components/ui.tsx'
import { VoiceSettings } from '../voice/voice.tsx'

type Language = 'fr' | 'en'

interface Settings {
  version: string | null
  canUpdate: boolean
  update: string | null
  checkedAt: string | null
  language: Language
  theme: Theme
  themeColours: ThemeColours | null
  /** The program in use and how it stands; no status while it isn't known yet. */
  ai: { provider: string; status: { installed: boolean; loggedIn: boolean | null } | null }
  policy: AgentPolicy
  notices: NoticeSettings
  environment: EnvironmentView
}

const SECTION_NAMES: Record<SettingsSection, string> = {
  general: t('Général'),
  notifications: t('Notifications'),
  ai: t('IA'),
  agent: t('Mon agent'),
  voice: t('Dictée'),
  about: t('À propos'),
  environment: t('Environnement'),
  repositories: t('Dépôts'),
  projects: t('Projets et validations'),
  documents: t('Documents'),
  machines: t('Machines'),
  reports: t('Rapports et conventions'),
}
const ENVIRONMENT_NAMES: Record<EnvironmentSection, string> = {
  environment: SECTION_NAMES.environment,
  repositories: SECTION_NAMES.repositories,
  projects: SECTION_NAMES.projects,
  documents: SECTION_NAMES.documents,
  machines: SECTION_NAMES.machines,
  reports: SECTION_NAMES.reports,
}
const HERE = t('Sur cet ordinateur')
const EVERYONE = t('Pour tous les membres')
/** Where each part's choices live, said once at the top of the part. */
const SCOPE_WORDS: Record<SettingsSection, string> = {
  general: HERE,
  notifications: HERE,
  ai: t('Sur cet ordinateur, pour tous vos environnements'),
  agent: t('Dans cet environnement · les autres membres voient votre choix'),
  voice: HERE,
  about: HERE,
  environment: EVERYONE,
  repositories: EVERYONE,
  projects: EVERYONE,
  documents: EVERYONE,
  machines: EVERYONE,
  reports: EVERYONE,
}
const GROUP_NAMES = { computer: HERE, everyone: EVERYONE }
const SIZE_NAMES: Record<TextSize, string> = { small: t('Petit'), medium: t('Moyen'), large: t('Grand'), larger: t('Très grand') }
const COLOUR_SAVE_MS = 500

/** Three colours, seen at once on the whole app; saved when the person stops moving, and only if they can make a theme. */
function CustomColours({ saved }: { saved: ThemeColours }) {
  const [draft, setDraft] = useState(saved)
  const [failure, setFailure] = useState<string | null>(null)
  const problem = themeProblem(draft)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const change = (key: keyof ThemeColours, value: string) => {
    const next = { ...draft, [key]: value }
    setDraft(next)
    clearTimeout(timer.current)
    if (themeProblem(next)) return
    applyTheme('custom', next)
    timer.current = setTimeout(() => {
      call('settings/theme', { theme: 'custom', colours: next }).then(() => setFailure(null), (error) => setFailure((error as Error).message))
    }, COLOUR_SAVE_MS)
  }
  return (
    <Row label={t('Couleurs')} hint={problem ?? failure ?? t('Le fond, le texte et la couleur d’accent. Le reste en découle.')}>
      <span className="set-colours">
        {(
          [
            ['bg', t('Fond')],
            ['text', t('Texte')],
            ['accent', t('Accent')],
          ] as const
        ).map(([key, name]) => (
          <label key={key}>
            <input type="color" value={draft[key]} onChange={(event) => change(key, event.target.value)} />
            {name}
          </label>
        ))}
      </span>
    </Row>
  )
}

/** A row whose choice is saved as soon as it is made, with a word on what happened beside it. */
function useSave<T>(work: (value: T) => Promise<unknown>) {
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const save = async (value: T) => {
    setState('saving')
    setError(null)
    try {
      await work(value)
      setState('saved')
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setState('idle'), 1500)
    } catch (failure) {
      setState('idle')
      setError((failure as Error).message)
    }
  }
  return { save, state, error, busy: state === 'saving' }
}

function GeneralPart({ data, textSize, onChange }: { data: Settings; textSize: TextSize | null; onChange: () => void }) {
  const language = useSave(async (code: Language) => {
    await call('settings/language', { language: code })
    onChange()
    // Every text on the page, in constants too, is read when it loads.
    if (adoptLanguage(code)) location.reload()
  })
  const theme = useSave(async (code: Theme) => {
    // A custom theme starts as a copy of the one on screen: a person tunes it rather than starts from nothing.
    const colours = code === 'custom' ? (data.themeColours ?? coloursOf(data.theme, null)) : data.themeColours
    await call('settings/theme', { theme: code, ...(code === 'custom' ? { colours } : {}) })
    applyTheme(code, colours)
    onChange()
  })
  const size = useSave(async (code: TextSize) => {
    await call('settings/text-size', { size: code })
    onChange()
  })
  return (
    <>
      <Row label={t('Langue')} actions={<Saved state={language.state} error={language.error} />} hint={t('L’interface, les rapports et ce que votre agent écrit.')}>
        <Choices<Language>
          value={data.language}
          disabled={language.busy}
          label={t('Langue')}
          onPick={(code) => void language.save(code)}
          options={[
            ['en', 'English'],
            ['fr', 'Français'],
          ]}
        />
      </Row>
      <Row label={t('Thème')} actions={<Saved state={theme.state} error={theme.error} />}>
        <Choices<Theme>
          value={data.theme}
          disabled={theme.busy}
          label={t('Thème')}
          onPick={(code) => void theme.save(code)}
          options={[
            ['default', t('Défaut')],
            ['vercel', 'Vercel'],
            ['omarchy', 'Omarchy'],
            ['custom', t('Personnalisé')],
          ]}
        />
      </Row>
      {data.theme === 'custom' && <CustomColours key="colours" saved={data.themeColours ?? coloursOf('custom', null)} />}
      {textSize && (
        <Row label={t('Taille du texte')} actions={<Saved state={size.state} error={size.error} />} hint={t('Ctrl + et Ctrl - la changent aussi, et Ctrl 0 revient à Grand.')}>
          <Choices<TextSize> value={textSize} disabled={size.busy} label={t('Taille du texte')} onPick={(code) => void size.save(code)} options={TEXT_SIZES.map((code) => [code, SIZE_NAMES[code]] as [TextSize, string])} />
        </Row>
      )}
    </>
  )
}

const ENVIRONMENT_PARTS: Record<EnvironmentSection, (props: { editor: EnvironmentEditor }) => JSX.Element> = {
  environment: EnvironmentPart,
  repositories: RepositoriesPart,
  projects: ProjectsPart,
  documents: DocumentsPart,
  machines: MachinesPart,
  reports: ReportsPart,
}

/** What the nav says beside a part, seen from any other: what needs the person, or what they changed. */
type Hint = { text: string; tone: 'warn' | 'changed' | 'plain' }

export function SettingsScreen({ section, textSize, admin, me, onChange }: { section: SettingsSection; textSize: TextSize | null; admin: boolean; me: string; onChange: () => void }) {
  const [data, setData] = useState<Settings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => call<Settings>('settings').then(setData), [])
  useEffect(() => {
    load().catch((failure) => setError((failure as Error).message))
  }, [load])
  const changed = useCallback(async () => {
    await load().catch(() => undefined)
    onChange()
  }, [load, onChange])
  const env = useEnvironmentDraft(data?.environment ?? null, () => void changed())

  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scroller.current?.scrollTo(0, 0)
  }, [section])

  // Unsaved changes are asked about before they go: by closing the settings, or by leaving the environment's parts.
  const [asking, setAsking] = useState<{ go: string } | { close: true } | null>(null)
  const closing = useContext(SettingsClosing)
  useEffect(() => {
    closing.guard.current = () => {
      if (asking) {
        setAsking(null)
        return false
      }
      if (!env.dirty) return true
      setAsking({ close: true })
      return false
    }
    return () => {
      closing.guard.current = null
    }
  })
  const onNav = (event: MouseEvent, target: SettingsSection) => {
    if (!env.dirty || !isEnvironmentSection(section) || isEnvironmentSection(target)) return
    event.preventDefault()
    setAsking({ go: toSection(target) })
  }
  const leave = () => {
    const was = asking
    setAsking(null)
    if (!was) return
    if ('close' in was) closing.close()
    else location.hash = was.go
  }

  const hint: Partial<Record<SettingsSection, Hint>> = {}
  if (data?.canUpdate && data.update) hint.about = { text: t('Mise à jour'), tone: 'changed' }
  const ai = data?.ai.status
  if (ai && !ai.installed) hint.ai = { text: t('✕ Absent'), tone: 'warn' }
  else if (ai && ai.loggedIn === false) hint.ai = { text: t('Non connecté'), tone: 'warn' }
  if (data?.environment.warning) hint.environment = { text: t('Configuration refusée'), tone: 'warn' }
  else if (admin) hint.environment = { text: t('admin'), tone: 'plain' }
  for (const part of env.changed) hint[part] = { text: t('modifié'), tone: 'changed' }
  if (env.dirty) for (const part of env.broken) hint[part] = { text: t('à corriger'), tone: 'warn' }

  const environmentPart = isEnvironmentSection(section) ? section : null
  const Part = environmentPart ? ENVIRONMENT_PARTS[environmentPart] : null

  return (
    <section className="now settings">
      <nav className="set-nav" aria-label={t('Réglages')}>
        <h2>{t('Réglages')}</h2>
        {SETTINGS_GROUPS.map((group) => (
          <div key={group.title} className="set-nav-group">
            <small className="set-nav-title">{GROUP_NAMES[group.title]}</small>
            {group.sections.map((one) => (
              <a key={one} href={toSection(one)} onClick={(event) => onNav(event, one)} aria-current={section === one ? 'page' : undefined} className={`now-link ${section === one ? 'active' : ''} ${hint[one]?.tone ?? ''}`}>
                <strong>{SECTION_NAMES[one]}</strong>
                {hint[one] && <small>{hint[one].text}</small>}
              </a>
            ))}
          </div>
        ))}
      </nav>
      <div className="set-pane">
        <header className="chat-head">
          <div>
            <span className="kind">{SCOPE_WORDS[section]}</span>
            <h1>{SECTION_NAMES[section]}</h1>
          </div>
        </header>
        <div className="now-scroll set-scroll" ref={scroller}>
          <div className="set-body">
            {!data && !error && <Loading>{t('Lecture des réglages…')}</Loading>}
            {!data && error && <div className="inline-error">{error}</div>}
            {data && (
              <>
                <div hidden={section !== 'general'}>
                  <GeneralPart data={data} textSize={textSize} onChange={() => void changed()} />
                </div>
                <div hidden={section !== 'notifications'}>
                  <NoticeSettingsPart initial={data.notices} inApp={textSize !== null} onSaved={onChange} />
                </div>
                {section === 'ai' && <AiSettings onChange={() => void changed()} />}
                <div hidden={section !== 'agent'}>
                  <AgentSettings policy={data.policy} me={me} onSaved={() => void changed()} />
                </div>
                <div hidden={section !== 'voice'}>
                  <VoiceSettings />
                </div>
                {section === 'about' && <AboutSettings onChange={() => void changed()} />}
                {Part && env.editor && (
                  <>
                    {!env.editor.view.admin && <ReadOnlyNote />}
                    <Part editor={env.editor} />
                  </>
                )}
              </>
            )}
          </div>
        </div>
        {environmentPart && env.editor?.view.admin && <SaveBar env={env} names={ENVIRONMENT_NAMES} />}
      </div>
      {asking && <LeaveQuestion env={env} names={ENVIRONMENT_NAMES} closing={'close' in asking} onStay={() => setAsking(null)} onLeave={leave} />}
    </section>
  )
}
