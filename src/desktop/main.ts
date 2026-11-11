// The installed app: one host for any environment, in its own window, with its data in `~/.board`.
import { execFile, spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, Menu, nativeImage, nativeTheme, shell, Tray } from 'electron'
import type { RunningBoard } from '../server/board/board.ts'
import { type Host, startHost } from '../server/host/host.ts'
import { BADGE_SIZE, badgeBitmap, trayText, withDot } from './badge.ts'
import { windowColours } from '../shared/themes.ts'
import { DEFAULT_TEXT_SIZE, TEXT_ZOOM } from '../shared/text-size.ts'
import { localize, setLanguage, t } from '../shared/i18n/i18n.ts'
import { downloadTo } from '../server/host/download.ts'
import { widenPath } from '../server/host/setup.ts'

const HOME = process.env.BOARD_HOME ?? join(homedir(), '.board')
/**
 * Every window of the app is a process of its own, so that several environments can be open at once. Chromium
 * lets one process use a profile folder: each gets its own, under the home, and leaves it clean when it quits.
 * What a page keeps (what was read, pinned) is by address, and each process has its own port anyway.
 */
const PROFILE = join(HOME, 'windows', `${Date.now().toString(36)}-${process.pid}`)
app.setPath('userData', PROFILE)
app.setPath('sessionData', PROFILE)
/** The environment this window was asked to open, by a menu of another window. */
const askedEnvironment = process.argv.find((arg) => arg.startsWith('--environment='))?.slice('--environment='.length) ?? null
/** The language chosen on this computer, before any environment is open. A first start follows the system's, once the app is ready. */
const savedLanguage = (() => {
  try {
    const saved = JSON.parse(readFileSync(join(HOME, 'settings.json'), 'utf8')).language
    return saved === 'en' || saved === 'fr' ? saved : null
  } catch {
    return null
  }
})()
if (savedLanguage) setLanguage(savedLanguage)
/** The CLI and the agents' bridge to the board's tools, at a path that doesn't change. */
const SCRIPT = join(HOME, 'bin', 'board.mjs')
/** Where the app itself is released: the code repository it was built from (scripts/bundle.mjs), not an environment. */
declare const __APP_REPOSITORY__: string
const APP_REPOSITORY = __APP_REPOSITORY__
const RELEASES = `repos/${APP_REPOSITORY}/releases/latest`
const UPDATE_EVERY_MS = 6 * 60 * 60_000
const UPDATE_CHECK_TIMEOUT_MS = 30_000
const QUIT_WAIT_MS = 5000
const ICON = join(app.getAppPath(), 'build', 'icon.png')
/** The window's colours, as in src/client/styles: the system draws its buttons on them. */
const TITLE_BAR_HEIGHT = 32

let window: BrowserWindow | null = null
let tray: Tray | null = null
let host: Host | null = null
const board = (): RunningBoard | null => host?.board() ?? null
let quitting = false
let newVersion: string | null = null
let checkedAt: string | null = null
let installing = false
/** How far the update's download has gone, from 0 to 1, while there is one. */
let downloaded: number | null = null
/** Why the last check or download failed, until one works: the About part says it. */
let updateError: string | null = null

const run = (command: string, args: string[], cwd?: string, timeout = 0) =>
  new Promise<string>((done, fail) => {
    execFile(command, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26, timeout }, (error, stdout, stderr) =>
      error ? fail(new Error(stderr.trim() || error.message)) : done(stdout.trim()),
    )
  })

/** The CLI and the agents' bridge, at a path that doesn't change. */
async function installScript(): Promise<void> {
  await mkdir(join(HOME, 'bin'), { recursive: true })
  await writeFile(SCRIPT, await readFile(join(app.getAppPath(), 'out', 'board.mjs')))
}

const newer = (candidate: string, current: string) => {
  const parts = (version: string) => version.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const [a, b] = [parts(candidate), parts(current)]
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

/** Throws when GitHub can't say, and what it knew stands: only the settings screen shows why. */
async function checkForUpdate(): Promise<void> {
  let tag: string
  try {
    tag = await run('gh', ['api', RELEASES, '--jq', '.tag_name'], undefined, UPDATE_CHECK_TIMEOUT_MS)
  } catch (error) {
    // A download under way says its own failure.
    if (!installing) updateError = `GitHub n'a pas répondu : ${(error as Error).message}`
    throw error
  }
  const version = tag.replace(/^v/, '')
  newVersion = version && newer(version, app.getVersion()) ? version : null
  checkedAt = new Date().toISOString()
  if (!installing) updateError = null
}

/** Through `gh api`, which writes to its output as it comes: that gives a real percentage, and `gh release download` doesn't. */
async function downloadInstaller(version: string, file: string): Promise<void> {
  const found = await run('gh', ['api', `repos/${APP_REPOSITORY}/releases/tags/v${version}`, '--jq', '.assets[] | select(.name | endswith(".exe")) | [.id, .size] | @tsv'], undefined, UPDATE_CHECK_TIMEOUT_MS)
  const [id, size] = found.split(/\s+/).map(Number)
  if (!id || !size) throw new Error('Installateur introuvable.')
  await downloadTo('gh', ['api', '-H', 'Accept: application/octet-stream', `repos/${APP_REPOSITORY}/releases/assets/${id}`], file, size, (ratio) => {
    downloaded = ratio
  })
}

/** The repository is private, so the installer comes through the person's `gh` login. */
async function installUpdate(): Promise<void> {
  if (!newVersion || installing) return
  installing = true
  downloaded = 0
  updateError = null
  try {
    const dir = join(tmpdir(), 'board-update')
    await mkdir(dir, { recursive: true })
    const installer = join(dir, `Board-Setup-${newVersion}.exe`)
    await downloadInstaller(newVersion, installer)
    // The app quits only once the installer has really started.
    await new Promise<void>((done, fail) => {
      const child = spawn(installer, ['/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true })
      child.once('error', fail)
      child.once('spawn', () => {
        child.unref()
        done()
      })
    })
  } catch (error) {
    installing = false
    downloaded = null
    updateError = (error as Error).message
    await rm(join(tmpdir(), 'board-update', `Board-Setup-${newVersion}.exe`), { force: true }).catch(() => undefined)
    throw error
  }
  quitting = true
  setTimeout(() => app.quit(), 300)
}

/**
 * Quits as the tray's "Quitter" does, Git's work finished first, and starts again as it was opened: the same
 * window, on the environment open now, shown even if Windows had started it hidden. Late enough for the page to hear back.
 */
let restarting = false

function restart(): void {
  // One new app for however many clicks: Electron starts one per call.
  if (restarting) return
  restarting = true
  // On the environment open now, which may not be the one this window was started on.
  const open = host?.board()?.repo
  const args = process.argv.slice(1).filter((arg) => arg !== '--hidden' && !arg.startsWith('--environment='))
  app.relaunch({ args: open ? [...args, `--environment=${open}`] : args })
  quitting = true
  setTimeout(() => app.quit(), 300)
}

/** The data folder, in the system's file manager. */
async function openData(): Promise<void> {
  const problem = await shell.openPath(HOME)
  if (problem) throw new Error(problem)
}

function showWindow(): void {
  openWindow(true)
}

/** Another window: the same program again, told which environment to open, or none to choose one. */
function newWindow(repo: string | null): void {
  const args = [...(app.isPackaged ? [] : [app.getAppPath()]), '--window', ...(repo ? [`--environment=${repo}`] : [])]
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } })
  child.unref()
}

/** Profiles left by windows that are gone. Chromium keeps a lock while a window lives; a folder nobody holds is dropped. */
async function dropOldProfiles(): Promise<void> {
  const dir = join(HOME, 'windows')
  const names = await readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    if (join(dir, name) === PROFILE) continue
    const locked = await stat(join(dir, name, 'lockfile')).then((found) => Date.now() - found.mtimeMs < 24 * 3_600_000, () => false)
    if (!locked) await rm(join(dir, name), { recursive: true, force: true }).catch(() => undefined)
  }
}

function openWindow(visible: boolean): void {
  if (window) {
    if (!visible) return
    window.show()
    window.focus()
    return
  }
  if (!host) return
  const own = new URL(host.url).origin
  const frame = windowColours(board()?.theme() ?? 'default', board()?.themeColours() ?? null)
  window = new BrowserWindow({
    show: visible,
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'Board',
    icon: ICON,
    autoHideMenuBar: true,
    backgroundColor: frame.background,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: frame.background, symbolColor: frame.symbols, height: TITLE_BAR_HEIGHT },
    // Not throttled when hidden: notifications must still arrive.
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true, backgroundThrottling: false, zoomFactor: TEXT_ZOOM[board()?.textSize() ?? DEFAULT_TEXT_SIZE] },
  })
  const contents = window.webContents
  // The window only ever shows the board. Every other address opens in the person's browser.
  const openOutside = (url: string) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
  }
  contents.setWindowOpenHandler(({ url }) => {
    openOutside(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (new URL(url).origin === own) return
    event.preventDefault()
    openOutside(url)
  })
  contents.session.setPermissionRequestHandler((_contents, permission, allow, details) => {
    if (permission === 'media') {
      // The microphone only, and only for the board's own page: never a camera, a report or a file.
      const media = details as Electron.MediaAccessPermissionRequest
      const own_page = details.isMainFrame && new URL(details.requestingUrl).origin === own
      allow(own_page && media.mediaTypes?.length === 1 && media.mediaTypes[0] === 'audio')
      return
    }
    allow(permission === 'notifications' || permission === 'clipboard-sanitized-write')
  })
  contents.on('context-menu', (_event, params) => {
    const items: Electron.MenuItemConstructorOptions[] = [
      ...params.dictionarySuggestions.map((word) => ({ label: word, click: () => contents.replaceMisspelling(word) })),
      ...(params.dictionarySuggestions.length ? [{ type: 'separator' as const }] : []),
      ...(params.isEditable ? [{ label: t('Couper'), role: 'cut' as const }] : []),
      { label: t('Copier'), role: 'copy' as const },
      ...(params.isEditable ? [{ label: t('Coller'), role: 'paste' as const }] : []),
    ]
    Menu.buildFromTemplate(items).popup()
  })
  // Closing the first window keeps the board running in the tray, so this person's agent can still answer.
  // A window opened from another one is only a window: closing it ends it.
  window.on('close', (event) => {
    if (quitting) return
    if (process.argv.includes('--window')) {
      quitting = true
      app.quit()
      return
    }
    event.preventDefault()
    // In the tray, nothing would show that the microphone is open.
    board()?.stopListening()
    window?.hide()
  })
  window.on('closed', () => {
    window = null
  })
  void window.loadURL(host.url)
}

let listeningNow = false
let counts = { unread: 0, waiting: 0 }

/** What needs someone, on the taskbar and the tray. An open microphone comes first: it's the one that can't wait. */
function showCounts(next = counts): void {
  counts = next
  const total = counts.unread + counts.waiting
  tray?.setToolTip(trayText(counts.unread, counts.waiting, listeningNow))
  if (tray) {
    const icon = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 })
    tray.setImage(total > 0 && !icon.isEmpty() ? nativeImage.createFromBitmap(withDot(icon.toBitmap(), 16), { width: 16, height: 16 }) : icon)
  }
  if (listeningNow) return
  const bitmap = badgeBitmap(total)
  window?.setOverlayIcon(bitmap && nativeImage.createFromBitmap(bitmap, { width: BADGE_SIZE, height: BADGE_SIZE }), bitmap ? trayText(counts.unread, counts.waiting, false) : '')
}

/** A red dot on the taskbar, and the tray says so too: the window can be behind others, or minimised. */
function showListening(listening: boolean): void {
  listeningNow = listening
  tray?.setToolTip(trayText(counts.unread, counts.waiting, listening))
  if (!listening) {
    showCounts()
    return
  }
  const size = 16
  const dot = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((x - 7.5) ** 2 + (y - 7.5) ** 2 > 49) continue
      // BGRA.
      dot.set([0x40, 0x40, 0xe0, 0xff], (y * size + x) * 4)
    }
  }
  window?.setOverlayIcon(nativeImage.createFromBitmap(dot, { width: size, height: size }), t('À l’écoute'))
}

function refreshTrayMenu(): void {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: t('Ouvrir le board'), click: showWindow },
      {
        label: t('Lancer au démarrage de Windows'),
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] })
        },
      },
      { type: 'separator' },
      {
        label: t('Quitter'),
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
}

async function start(): Promise<void> {
  // A first start follows the system's language; the settings then say.
  if (!savedLanguage) setLanguage(app.getLocale().toLowerCase().startsWith('fr') ? 'fr' : 'en')
  Menu.setApplicationMenu(null)
  nativeTheme.themeSource = 'dark'
  app.setAppUserModelId('app.board.desktop')

  // Programs installed while the app was closed aren't on the PATH it inherited.
  widenPath()
  const followTheme = (theme: Parameters<typeof windowColours>[0], custom: Parameters<typeof windowColours>[1]) => {
    const colours = windowColours(theme, custom)
    window?.setBackgroundColor(colours.background)
    window?.setTitleBarOverlay({ color: colours.background, symbolColor: colours.symbols, height: TITLE_BAR_HEIGHT })
  }
  try {
    await installScript()
    // What's missing on this computer is said by the first screens, which can fix most of it.
    host = await startHost({
      home: HOME,
      client: join(app.getAppPath(), 'dist'),
      version: app.getVersion(),
      openExternal: (url) => void shell.openExternal(url),
      newWindow,
      environment: askedEnvironment,
      onBoard: (opened) => {
        if (!opened) return
        setLanguage(opened.language())
        refreshTrayMenu()
        followTheme(opened.theme(), opened.themeColours())
        window?.webContents.setZoomFactor(TEXT_ZOOM[opened.textSize()])
      },
      board: {
        // Electron's own binary runs the bridge as Node: the person needs no Node.js for their agent's tools.
        tools: { command: [process.execPath, SCRIPT, 'mcp'], env: { ELECTRON_RUN_AS_NODE: '1' } },
        onListening: showListening,
        onBadge: showCounts,
        onLanguage: (language) => {
          setLanguage(language)
          refreshTrayMenu()
        },
        onTheme: followTheme,
        onTextSize: (zoom) => window?.webContents.setZoomFactor(zoom),
        updates: { available: () => newVersion, check: checkForUpdate, checkedAt: () => checkedAt, install: installUpdate, progress: () => downloaded, error: () => updateError },
        restart,
        openData,
        focus: showWindow,
        // Timers keep running in a hidden window (`backgroundThrottling`), and the page can't tell.
        onScreen: () => Boolean(window?.isVisible() && !window.isMinimized()),
      },
    })
  } catch (error) {
    dialog.showErrorBox(t('Board ne peut pas démarrer'), localize((error as Error).message))
    quitting = true
    app.quit()
    return
  }

  // One tray icon is enough: the first window's. Another window is a window, and quits with itself.
  if (!process.argv.includes('--window')) {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }))
    tray.setToolTip('Board')
    tray.on('click', showWindow)
    refreshTrayMenu()
  }
  void dropOldProfiles()

  // Started with Windows, it stays out of the way, and its page is still what tells the tray and notifications.
  openWindow(!process.argv.includes('--hidden'))
  void checkForUpdate().catch(() => undefined)
  setInterval(() => void checkForUpdate().catch(() => undefined), UPDATE_EVERY_MS)
}

// The window being closed isn't a reason to quit: see the tray.
app.on('window-all-closed', () => undefined)
app.on('before-quit', (event) => {
  quitting = true
  const running = host
  if (!running) return
  // Once: wait for Git to finish, within reason, then leave for good.
  host = null
  event.preventDefault()
  void Promise.race([running.stop(), new Promise((done) => setTimeout(done, QUIT_WAIT_MS))]).finally(() => app.exit(0))
})
void app.whenReady().then(start)
