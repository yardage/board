/**
 * The usual shapes of a secret. What the board writes stays for good, in the environment's history
 * or on GitHub, and the questions asked there are often about settings.
 */
const SECRET = /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s@]+@|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsk-[A-Za-z0-9-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|\bBearer\s+[A-Za-z0-9._~+/-]{16,}|\b[\w-]*(?:secret|token|password|passwd|api[_-]?key|signing[_-]?key|private[_-]?key|access[_-]?key)[\w-]*\s*=\s*\S{4,}|\b(?:password|passwd)\s*:\s*\S{4,}|\btskey-[A-Za-z0-9-]{10,}/i

export const looksSecret = (text: string) => SECRET.test(text)

/** Files that are read as text before they go: the usual places a secret hides. */
export const READ_AS_TEXT = /\.(txt|md|json|ya?ml|toml|ini|cfg|conf|log|csv|xml|html?|js|ts|py|sh|env|properties|sql)$/i
