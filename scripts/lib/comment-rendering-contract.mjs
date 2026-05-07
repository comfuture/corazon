export function toSingleLine(value) {
  return String(value).replace(/\s+/g, ' ').trim()
}

export function inlineCode(value) {
  const normalized = toSingleLine(value)
  if (normalized === '') {
    return '``'
  }

  const runs = normalized.match(/`+/g) || []
  const maxRun = runs.reduce((max, run) => Math.max(max, run.length), 0)
  const fence = '`'.repeat(maxRun + 1)
  const needsPadding = normalized.startsWith('`') || normalized.endsWith('`')
  const padded = needsPadding ? ` ${normalized} ` : normalized
  return `${fence}${padded}${fence}`
}

export function escapeMarkdownLinkDestination(url) {
  return encodeURI(toSingleLine(url)).replace(/\)/g, '%29')
}

export function escapeHtmlCommentBody(value) {
  return toSingleLine(value).replace(/-->/g, '-- >')
}
