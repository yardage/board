import { type ReactNode, type RefObject, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { Me, TreeNode, Upload } from '../../lib/types.ts'
import { PaperclipIcon, sizeOf } from './bubble.tsx'
import { t } from '../../../shared/i18n/i18n.ts'
import { MentionTextarea, type MentionTextareaHandle } from '../../components/mention-input.tsx'
import { type Poll, PollForm } from './thread-parts.tsx'
import { TreeContext } from '../knowledge/tree.tsx'

const MAX_BYTES = 10 * 1024 * 1024

const toUpload = (file: File) =>
  new Promise<Upload>((done, fail) => {
    const reader = new FileReader()
    reader.onerror = () => fail(new Error(t('Lecture impossible : {0}', { 0: file.name })))
    reader.onload = () => done({ name: file.name, type: file.type, data: String(reader.result).split(',')[1] ?? '' })
    reader.readAsDataURL(file)
  })

const flatten = (nodes: TreeNode[], parents: string[] = []): { label: string; path: string }[] =>
  nodes.flatMap((node) =>
    node.children
      ? flatten(node.children, [...parents, node.name])
      : [{ label: [...parents, node.name.replace(/\.md$/, '')].join(' / '), path: node.path }],
  )

function DocPicker({ onPick, onClose }: { onPick: (label: string, path: string) => void; onClose: () => void }) {
  const tree = useContext(TreeContext)
  const [query, setQuery] = useState('')
  const all = useMemo(() => flatten(tree), [tree])
  const found = all.filter((doc) => doc.label.toLowerCase().includes(query.toLowerCase())).slice(0, 40)
  return (
    <div className="doc-picker">
      <input
        autoFocus
        value={query}
        placeholder={t('Chercher un document, un rapport, une décision…')}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
          if (event.key === 'Enter' && found[0]) {
            event.preventDefault()
            onPick(found[0].label, found[0].path)
          }
        }}
      />
      <ul>
        {found.map((doc) => (
          <li key={doc.path}>
            <button type="button" onClick={() => onPick(doc.label, doc.path)}>
              {doc.label}
            </button>
          </li>
        ))}
        {found.length === 0 && <li className="side-empty">{t('Aucun document.')}</li>}
      </ul>
    </div>
  )
}

export function Composer({
  me,
  onSend,
  disabled,
  placeholder,
  autoFocus,
  dropZone,
  tools,
  below,
}: {
  me: Me
  onSend: (body: string, attachments: Upload[], poll: Poll | null) => Promise<void>
  disabled?: boolean
  placeholder: string
  autoFocus?: boolean
  dropZone?: RefObject<HTMLElement | null>
  tools?: ReactNode
  below?: ReactNode
}) {
  const [text, setText] = useState('')
  const [polling, setPolling] = useState(false)
  const [poll, setPoll] = useState<Poll | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const [picking, setPicking] = useState(false)
  const [over, setOver] = useState(false)
  const area = useRef<MentionTextareaHandle>(null)
  const chooser = useRef<HTMLInputElement>(null)

  const addFiles = useCallback((added: File[]) => {
    if (added.length) setFiles((current) => [...current, ...added])
  }, [])

  useEffect(() => {
    const zone = dropZone?.current
    if (!zone || disabled) return
    const enter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      setOver(true)
    }
    const leave = (event: DragEvent) => {
      if (!event.relatedTarget || !zone.contains(event.relatedTarget as Node)) setOver(false)
    }
    const drop = (event: DragEvent) => {
      event.preventDefault()
      setOver(false)
      addFiles([...(event.dataTransfer?.files ?? [])])
    }
    zone.addEventListener('dragover', enter)
    zone.addEventListener('dragleave', leave)
    zone.addEventListener('drop', drop)
    return () => {
      zone.removeEventListener('dragover', enter)
      zone.removeEventListener('dragleave', leave)
      zone.removeEventListener('drop', drop)
    }
  }, [dropZone, disabled, addFiles])

  useEffect(() => {
    const el = area.current?.element
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`
  }, [text])

  const ready = Boolean(text.trim() || files.length || (polling && poll))
  async function send() {
    if (!ready || busy || (polling && !poll)) return
    if (files.reduce((sum, file) => sum + file.size, 0) > MAX_BYTES) {
      setError(t('Pas plus de 10 Mo de fichiers par message.'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const uploads = await Promise.all(files.map(toUpload))
      await onSend(text.trim(), uploads, polling ? poll : null)
      setText('')
      setFiles([])
      setPoll(null)
      setPolling(false)
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`composer ${over ? 'dropping' : ''}`}>
      {error && <div className="inline-error">{error}</div>}
      {files.length > 0 && (
        <ul className="pending-files">
          {files.map((file, index) => (
            <li key={`${file.name}-${index}`}>
              <PaperclipIcon />
              <span>{file.name}</span>
              <small>{sizeOf(file.size)}</small>
              <button type="button" aria-label={t('Retirer {0}', { 0: file.name })} onClick={() => setFiles(files.filter((_, at) => at !== index))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {polling && (
        <PollForm
          onReady={setPoll}
          onCancel={() => {
            setPolling(false)
            setPoll(null)
          }}
        />
      )}
      {picking && (
        <DocPicker
          onClose={() => setPicking(false)}
          onPick={(label, path) => {
            setText((current) => `${current}${current && !current.endsWith('\n') ? ' ' : ''}[${label}](doc:${path}) `)
            setPicking(false)
            area.current?.focus()
          }}
        />
      )}
      <MentionTextarea ref={area} me={me.login} value={text} onChange={setText} rows={2} autoFocus={autoFocus} disabled={disabled} placeholder={placeholder} onPaste={(event) => addFiles([...event.clipboardData.files])} onSubmitKey={() => void send()} />
      <div className="composer-row">
        <input
          ref={chooser}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            addFiles([...(event.target.files ?? [])])
            event.target.value = ''
          }}
        />
        <button type="button" className="tool" disabled={disabled} title={t('Joindre un fichier (ou glissez-le ici, ou collez une image)')} onClick={() => chooser.current?.click()}>
          <PaperclipIcon />{' '}{t('Joindre')}
        </button>
        <button type="button" className={`tool ${picking ? 'on' : ''}`} disabled={disabled} title={t('Citer un document de la connaissance')} onClick={() => setPicking(!picking)}>
          {t('Citer un document')}
        </button>
        <button type="button" className={`tool ${polling ? 'on' : ''}`} disabled={disabled} title={t('Poser une question à choix aux membres')} onClick={() => setPolling(!polling)}>
          {t('Sondage')}
        </button>
        {tools}
        <span className="spacer" />
        <span className="hint">{t('Ctrl + Entrée')}</span>
        <button type="button" className="send" disabled={busy || disabled || !ready || (polling && !poll)} onClick={() => void send()}>
          {busy ? t('Envoi…') : t('Envoyer')}
        </button>
      </div>
      {below}
    </div>
  )
}
