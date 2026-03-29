export const normalizeImageGenerationFeatureConfig = (original) => {
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  const lines = original.split(/\r?\n/)
  const imageGenerationKeyPattern = /^(?:"image_generation"|'image_generation'|image_generation)\s*=/
  const imageGenerationTruePattern = /^(?:"image_generation"|'image_generation'|image_generation)\s*=\s*true(?:\s+#.*)?$/i
  let inFeatures = false
  let sawFeatures = false
  let imageGenerationSet = false
  let changed = false
  const nextLines = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (/^\[.*\]/.test(trimmed)) {
      if (inFeatures && !imageGenerationSet) {
        nextLines.push('image_generation = true')
        imageGenerationSet = true
        changed = true
      }
      inFeatures = /^\[features\](?:\s+#.*)?\s*$/i.test(trimmed)
      sawFeatures = sawFeatures || inFeatures
      nextLines.push(line)
      continue
    }

    if (!inFeatures) {
      nextLines.push(line)
      continue
    }

    if (trimmed.startsWith('#')) {
      nextLines.push(line)
      continue
    }

    if (imageGenerationKeyPattern.test(trimmed)) {
      if (!imageGenerationTruePattern.test(trimmed)) {
        changed = true
      }
      nextLines.push('image_generation = true')
      imageGenerationSet = true
      continue
    }

    nextLines.push(line)
  }

  if (inFeatures && !imageGenerationSet) {
    nextLines.push('image_generation = true')
    imageGenerationSet = true
    changed = true
  }

  if (!sawFeatures) {
    const lastLine = nextLines.at(-1)
    if (typeof lastLine === 'string' && lastLine.trim() !== '') {
      nextLines.push('')
    }
    nextLines.push('[features]')
    nextLines.push('image_generation = true')
    changed = true
  }

  if (!changed) {
    return { changed: false, output: original }
  }

  const next = nextLines.join(newline)
  const output = next.endsWith(newline) ? next : `${next}${newline}`
  if (output === original) {
    return { changed: false, output }
  }

  return { changed: true, output }
}
