/** The parts of the settings, each with its own address, so that a link can point at one. No React here, so tests can read it. */
export const SETTINGS_SECTIONS = ['general', 'notifications', 'ai', 'agent', 'voice', 'about', 'environment', 'repositories', 'projects', 'documents', 'machines', 'reports'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

/** The environment's configuration, in parts that share one draft and one save. */
export const ENVIRONMENT_SECTIONS = ['environment', 'repositories', 'projects', 'documents', 'machines', 'reports'] as const satisfies readonly SettingsSection[]
export type EnvironmentSection = (typeof ENVIRONMENT_SECTIONS)[number]
export const isEnvironmentSection = (section: SettingsSection): section is EnvironmentSection => (ENVIRONMENT_SECTIONS as readonly string[]).includes(section)

/** The parts that are this computer's, then the ones every member shares. */
export const SETTINGS_GROUPS: { title: 'computer' | 'everyone'; sections: SettingsSection[] }[] = [
  { title: 'computer', sections: ['general', 'notifications', 'ai', 'agent', 'voice', 'about'] },
  { title: 'everyone', sections: [...ENVIRONMENT_SECTIONS] },
]

/** Addresses from before, still found in a bookmark or a message. */
const RENAMED: Record<string, SettingsSection> = { claude: 'ai', models: 'ai', app: 'about' }

export const toSection = (section: SettingsSection) => (section === 'general' ? '#settings' : `#settings/${section}`)

/** Null if the address isn't the settings'. A part that no longer exists opens the first one, not the home page. */
export function readSettingsHash(hash: string): SettingsSection | null {
  if (hash === 'settings') return 'general'
  if (!hash.startsWith('settings/')) return null
  const wanted = hash.slice('settings/'.length)
  const named = SETTINGS_SECTIONS.find((section) => section === wanted)
  return named ?? (Object.hasOwn(RENAMED, wanted) ? RENAMED[wanted] : 'general')
}
