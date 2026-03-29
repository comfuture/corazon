export const normalizeImageGenerationFeatureConfig = (original) => {
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  const lines = original.split(/\r?\n/)
  const imageGenerationKeyPattern = /^(?:"image_generation"|'image_generation'|image_generation)\s*=/
  const imageGenerationTruePattern = /^(?:"image_generation"|'image_generation'|image_generation)\s*=\s*true(?:\s+#.*)?$/i
  const featuresHeaderPattern = /^\[features\](?:\s+#.*)?\s*$/i
  const featuresAnyDottedPattern = /^(?:"features"|'features'|features)\s*\./i
  const featuresImageGenerationDottedPattern = /^(?:"features"|'features'|features)\s*\.\s*(?:"image_generation"|'image_generation'|image_generation)\s*=/i
  const featuresImageGenerationDottedTruePattern = /^(?:"features"|'features'|features)\s*\.\s*(?:"image_generation"|'image_generation'|image_generation)\s*=\s*true(?:\s+#.*)?$/i
  const featuresInlinePattern = /^(\s*)(?:"features"|'features'|features)\s*=\s*\{(.*)\}(\s*(?:#.*)?)$/i
  const inlineImageGenerationPattern = /((?:"image_generation"|'image_generation'|image_generation)\s*=\s*)[^,}]+/i
  const inlineImageGenerationTruePattern = /(?:"image_generation"|'image_generation'|image_generation)\s*=\s*true(?:\s*(?:,|$))/i
  let inFeatures = false
  let inRootTable = true
  let sawFeatures = false
  let imageGenerationSet = false
  let sawRootDottedFeatures = false
  let changed = false
  const nextLines = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (/^\[.*\]/.test(trimmed)) {
      if (inRootTable && sawRootDottedFeatures && !imageGenerationSet) {
        // Insert root-level dotted key before entering the next explicit table.
        nextLines.push('features.image_generation = true')
        imageGenerationSet = true
        changed = true
      }
      if (inFeatures && !imageGenerationSet) {
        nextLines.push('image_generation = true')
        imageGenerationSet = true
        changed = true
      }
      inFeatures = featuresHeaderPattern.test(trimmed)
      sawFeatures = sawFeatures || inFeatures
      inRootTable = false
      nextLines.push(line)
      continue
    }

    if (inRootTable && featuresImageGenerationDottedPattern.test(trimmed)) {
      sawFeatures = true
      sawRootDottedFeatures = true
      imageGenerationSet = true
      if (!featuresImageGenerationDottedTruePattern.test(trimmed)) {
        const match = line.match(/^(\s*).*(\s*(?:#.*)?)$/)
        const indent = match?.[1] ?? ''
        const trailing = match?.[2] ?? ''
        nextLines.push(`${indent}features.image_generation = true${trailing}`)
        changed = true
      } else {
        nextLines.push(line)
      }
      continue
    }

    if (inRootTable && featuresAnyDottedPattern.test(trimmed)) {
      sawFeatures = true
      sawRootDottedFeatures = true
      nextLines.push(line)
      continue
    }

    if (!inFeatures) {
      const inlineMatch = line.match(featuresInlinePattern)
      if (inlineMatch) {
        const [, indent, body, suffix] = inlineMatch
        sawFeatures = true
        if (inlineImageGenerationPattern.test(body)) {
          imageGenerationSet = true
          if (inlineImageGenerationTruePattern.test(body)) {
            nextLines.push(line)
          } else {
            const trailingWhitespace = body.match(/\s*$/)?.[0] ?? ''
            const bodyWithoutTrailing = body.slice(0, body.length - trailingWhitespace.length)
            const nextBodyCore = bodyWithoutTrailing.replace(inlineImageGenerationPattern, '$1true')
            const nextBody = `${nextBodyCore}${trailingWhitespace}`
            nextLines.push(`${indent}features = {${nextBody}}${suffix}`)
            changed = true
          }
        } else {
          const trailingWhitespace = body.match(/\s*$/)?.[0] ?? ''
          const bodyWithoutTrailing = body.slice(0, body.length - trailingWhitespace.length)
          const bodyTrimmedEnd = bodyWithoutTrailing.trimEnd()
          const separator = bodyTrimmedEnd.length === 0 ? '' : (bodyTrimmedEnd.endsWith(',') ? ' ' : ', ')
          const nextBody = `${bodyWithoutTrailing}${separator}image_generation = true${trailingWhitespace}`
          nextLines.push(`${indent}features = {${nextBody}}${suffix}`)
          imageGenerationSet = true
          changed = true
        }
        continue
      }
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
  } else if (!imageGenerationSet && sawRootDottedFeatures) {
    nextLines.push('features.image_generation = true')
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
