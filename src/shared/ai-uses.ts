/**
 * Which program answers for a member, and with which model and effort for each use. Each person chooses for their
 * own program and plan: this stays on their computer, never in the shared history. Only what is listed or checked
 * here reaches a command line.
 */

export const PROVIDERS = ['claude', 'codex'] as const
export type Provider = (typeof PROVIDERS)[number]
/** The programs' own names: they are the choice itself, so a screen may say them. */
export const PROVIDER_NAMES: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex' }
export const isProvider = (value: unknown): value is Provider => (PROVIDERS as readonly unknown[]).includes(value)

/** The models a person can pick, by program. Codex's list grows with what its own catalogue names (`server/ai.ts`). */
export const MODELS: Record<Provider, readonly string[]> = {
  claude: ['haiku', 'sonnet', 'opus', 'fable'],
  codex: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
}
export const EFFORTS: Record<Provider, readonly string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh'],
}
/** A model's name as a person reads it. */
export function modelName(model: string): string {
  const known: Record<string, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' }
  if (known[model]) return known[model]
  return model.replace(/^gpt-/, 'GPT-').replace(/-([a-z])/g, (_, letter: string) => ` ${letter.toUpperCase()}`)
}
/** A model id as Codex's catalogue writes one: letters, digits, dots and dashes, nothing a command line could read otherwise. */
export const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,39}$/

export const AI_USES = ['reply', 'synthesis', 'summary', 'translation', 'title'] as const
/** What runs inside a thread. A translation is kept by the hash of its text, and a title comes before the thread. */
export const THREAD_USES = ['reply', 'synthesis', 'summary'] as const
/** Their default could be the person's largest model, for a task that doesn't need it: they always name one. */
const NAMES_ITS_MODEL: readonly AiUse[] = ['translation', 'title']

export type AiUse = (typeof AI_USES)[number]
export type ThreadUse = (typeof THREAD_USES)[number]

/** Empty means not chosen: the program's own default in the settings, and the settings' choice under a thread. */
export interface AiChoice {
  model: string
  effort: string
}
export type AiChoices = Record<AiUse, AiChoice>
export type ThreadChoices = Partial<Record<ThreadUse, AiChoice>>

export const NOT_CHOSEN: AiChoice = { model: '', effort: '' }
/** The smallest model of each program, for the uses that always name one. */
const SMALL: Record<Provider, string> = { claude: 'haiku', codex: 'gpt-6-luna' }
export const defaultChoices = (provider: Provider): AiChoices => ({
  reply: NOT_CHOSEN,
  synthesis: NOT_CHOSEN,
  summary: NOT_CHOSEN,
  translation: { model: SMALL[provider], effort: '' },
  title: { model: SMALL[provider], effort: '' },
})

export const isAiUse = (value: unknown): value is AiUse => (AI_USES as readonly unknown[]).includes(value)
export const isThreadUse = (value: unknown): value is ThreadUse => (THREAD_USES as readonly unknown[]).includes(value)
export const canBeLeftToProgram = (use: AiUse) => !NAMES_ITS_MODEL.includes(use)

/** A model the program knows: its list, and for Codex what its catalogue adds (`known`). */
export const isModel = (provider: Provider, value: unknown, known: readonly string[] = []): value is string =>
  value === '' || (typeof value === 'string' && (MODELS[provider].includes(value) || (provider === 'codex' && MODEL_ID.test(value) && known.includes(value))))
const isEffort = (provider: Provider, value: unknown): value is string => value === '' || (typeof value === 'string' && EFFORTS[provider].includes(value))

/** Null for anything else than a known model and effort of this program. */
export function parseChoice(raw: unknown, provider: Provider = 'claude', known: readonly string[] = []): AiChoice | null {
  const { model, effort } = (raw ?? {}) as { model?: unknown; effort?: unknown }
  return isModel(provider, model, known) && isEffort(provider, effort) ? { model, effort } : null
}

/** The settings' choices for a program. Whatever a damaged file holds, each use has a valid one. */
export function parseChoices(raw: unknown, provider: Provider = 'claude', known: readonly string[] = []): AiChoices {
  const saved = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const choices = defaultChoices(provider)
  for (const use of AI_USES) {
    const choice = parseChoice(saved[use], provider, known)
    if (choice && (choice.model || canBeLeftToProgram(use))) choices[use] = choice
  }
  return choices
}

/** Every program's choices, from the file. An older file named Claude Code's only, without saying so. */
export function parseAllChoices(raw: unknown, known: Partial<Record<Provider, readonly string[]>> = {}): Record<Provider, AiChoices> {
  const saved = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const flat = AI_USES.some((use) => use in saved)
  return {
    claude: parseChoices(flat ? saved : saved.claude, 'claude', known.claude),
    codex: parseChoices(flat ? undefined : saved.codex, 'codex', known.codex),
  }
}

/** A model or an effort any program could know: a thread keeps its choices whichever program runs, and `forProvider` picks. */
const ANY_PROVIDERS: readonly Provider[] = PROVIDERS
const couldBeModel = (value: unknown) => value === '' || (typeof value === 'string' && (ANY_PROVIDERS.some((provider) => MODELS[provider].includes(value)) || MODEL_ID.test(value)))
const couldBeEffort = (value: unknown) => value === '' || (typeof value === 'string' && ANY_PROVIDERS.some((provider) => EFFORTS[provider].includes(value)))

/** A thread's choices, with only what differs from the settings, as written: the program that runs checks them. */
export function parseThreadChoices(raw: unknown): ThreadChoices {
  const saved = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const choices: ThreadChoices = {}
  for (const use of THREAD_USES) {
    const { model, effort } = (saved[use] ?? {}) as { model?: unknown; effort?: unknown }
    if (!couldBeModel(model) || !couldBeEffort(effort)) continue
    if (model || effort) choices[use] = { model: model as string, effort: effort as string }
  }
  return choices
}

/** A thread's choices as this program can take them: a model or an effort it doesn't know counts as not chosen. */
export function forProvider(choices: ThreadChoices | undefined, provider: Provider, known: readonly string[] = []): ThreadChoices | undefined {
  if (!choices) return undefined
  const kept: ThreadChoices = {}
  for (const use of THREAD_USES) {
    const choice = choices[use]
    if (!choice) continue
    const model = isModel(provider, choice.model, known) ? choice.model : ''
    const effort = EFFORTS[provider].includes(choice.effort) ? choice.effort : ''
    if (model || effort) kept[use] = { model, effort }
  }
  return kept
}

/** Field by field: a thread can raise the effort and keep the model of the settings. */
export function choiceFor(general: AiChoices, thread: ThreadChoices | undefined, use: AiUse): AiChoice {
  const own = isThreadUse(use) ? thread?.[use] : undefined
  return { model: own?.model || general[use].model, effort: own?.effort || general[use].effort }
}
