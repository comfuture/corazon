#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const DEFAULT_SECTIONS = ['Facts', 'Preferences', 'Decisions', 'Tasks']
const DEFAULT_THRESHOLD = 0.72
const DEFAULT_LIMIT = 5

const toJson = payload => JSON.stringify(payload, null, 2)

const normalizeText = value =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const toTokenSet = (value) => {
  const normalized = normalizeText(value)
  if (!normalized) {
    return new Set()
  }
  return new Set(normalized.split(' ').filter(Boolean))
}

const jaccard = (left, right) => {
  const leftTokens = toTokenSet(left)
  const rightTokens = toTokenSet(right)
  const union = new Set([...leftTokens, ...rightTokens])
  if (union.size === 0) {
    return 0
  }
  let intersection = 0
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1
    }
  }
  return intersection / union.size
}

const scoreSimilarity = (left, right) => {
  const normalizedLeft = normalizeText(left)
  const normalizedRight = normalizeText(right)
  if (!normalizedLeft || !normalizedRight) {
    return 0
  }
  if (normalizedLeft === normalizedRight) {
    return 1
  }
  return jaccard(normalizedLeft, normalizedRight)
}

const parseDocument = (raw) => {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n')
  const sections = []
  let current = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const headingMatch = line.match(/^##\s+(.+?)\s*$/)
    if (headingMatch) {
      if (current) {
        current.endIndex = index
      }
      current = {
        name: headingMatch[1].trim(),
        startIndex: index,
        endIndex: lines.length,
        items: []
      }
      sections.push(current)
      continue
    }

    if (!current) {
      continue
    }

    const itemMatch = line.match(/^([-*])\s+(.*)$/)
    if (!itemMatch) {
      continue
    }

    const text = (itemMatch[2] ?? '').trim()
    if (!text) {
      continue
    }

    current.items.push({
      lineIndex: index,
      marker: itemMatch[1],
      text
    })
  }

  if (current) {
    current.endIndex = lines.length
  }

  return { lines, sections }
}

const appendSection = (lines, sectionName) => {
  const next = [...lines]
  if (next.length > 0 && next[next.length - 1].trim() !== '') {
    next.push('')
  }
  next.push(`## ${sectionName}`)
  return next
}

const buildDefaultMemoryContent = () => `${DEFAULT_SECTIONS.map(section => `## ${section}`).join('\n\n')}\n`

const atomicWrite = (filePath, content) => {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmpPath, content, 'utf8')
  renameSync(tmpPath, filePath)
}

const ensureMemoryFile = (filePath) => {
  const resolvedPath = resolve(filePath)

  if (!existsSync(resolvedPath)) {
    atomicWrite(resolvedPath, buildDefaultMemoryContent())
    return {
      memoryFile: resolvedPath,
      created: true,
      addedSections: [...DEFAULT_SECTIONS]
    }
  }

  const raw = readFileSync(resolvedPath, 'utf8')
  const parsed = parseDocument(raw)
  const existing = new Set(parsed.sections.map(section => section.name))

  let lines = parsed.lines
  const addedSections = []
  for (const section of DEFAULT_SECTIONS) {
    if (!existing.has(section)) {
      lines = appendSection(lines, section)
      addedSections.push(section)
      existing.add(section)
    }
  }

  if (addedSections.length > 0) {
    const content = `${lines.join('\n').replace(/\s+$/g, '')}\n`
    atomicWrite(resolvedPath, content)
  }

  return {
    memoryFile: resolvedPath,
    created: false,
    addedSections
  }
}

const getSectionByName = (sections, name) => {
  const target = name.trim()
  return sections.find(section => section.name === target) ?? null
}

const searchMemory = (filePath, query, limit) => {
  const ensured = ensureMemoryFile(filePath)
  const raw = readFileSync(ensured.memoryFile, 'utf8')
  const parsed = parseDocument(raw)

  const normalizedQuery = normalizeText(query)
  if (!normalizedQuery) {
    return {
      ...ensured,
      query,
      results: []
    }
  }

  const scored = []
  for (const section of parsed.sections) {
    for (const item of section.items) {
      const score = scoreSimilarity(normalizedQuery, item.text)
      if (score <= 0) {
        continue
      }
      scored.push({
        section: section.name,
        text: item.text,
        score,
        line: item.lineIndex + 1
      })
    }
  }

  scored.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score
    }
    if (left.section !== right.section) {
      return left.section.localeCompare(right.section)
    }
    return left.line - right.line
  })

  return {
    ...ensured,
    query,
    results: scored.slice(0, limit)
  }
}

const insertLineAt = (lines, index, line) => [
  ...lines.slice(0, index),
  line,
  ...lines.slice(index)
]

const ensureSectionSpacingAfterInsert = (lines, insertedIndex) => {
  const nextLine = lines[insertedIndex + 1]
  if (typeof nextLine !== 'string') {
    return lines
  }
  if (!/^##\s+/.test(nextLine)) {
    return lines
  }
  return insertLineAt(lines, insertedIndex + 1, '')
}

const clampThreshold = (value) => {
  if (!Number.isFinite(value)) {
    return DEFAULT_THRESHOLD
  }
  return Math.max(0, Math.min(1, value))
}

const clampLimit = (value) => {
  if (!Number.isFinite(value)) {
    return DEFAULT_LIMIT
  }
  const rounded = Math.floor(value)
  if (rounded < 1) {
    return 1
  }
  return Math.min(rounded, 100)
}

const upsertMemory = (filePath, sectionName, text, threshold) => {
  const ensured = ensureMemoryFile(filePath)
  const targetSectionName = sectionName.trim()
  const targetText = text.trim()
  if (!targetSectionName) {
    throw new Error('section is required')
  }
  if (!targetText) {
    throw new Error('text is required')
  }

  let raw = readFileSync(ensured.memoryFile, 'utf8')
  let parsed = parseDocument(raw)
  let lines = parsed.lines
  let sectionCreated = false

  let section = getSectionByName(parsed.sections, targetSectionName)
  if (!section) {
    lines = appendSection(lines, targetSectionName)
    sectionCreated = true
    raw = `${lines.join('\n').replace(/\s+$/g, '')}\n`
    parsed = parseDocument(raw)
    section = getSectionByName(parsed.sections, targetSectionName)
  }

  if (!section) {
    throw new Error(`unable to resolve section: ${targetSectionName}`)
  }

  let best = null
  for (const item of section.items) {
    const score = scoreSimilarity(targetText, item.text)
    if (!best || score > best.score) {
      best = {
        ...item,
        score
      }
    }
  }

  let action = 'created'
  let updatedLine = null
  if (best && best.score >= threshold) {
    lines[best.lineIndex] = `- ${targetText}`
    action = 'updated'
    updatedLine = best.lineIndex + 1
  } else {
    const insertIndex = section.endIndex
    lines = insertLineAt(lines, insertIndex, `- ${targetText}`)
    lines = ensureSectionSpacingAfterInsert(lines, insertIndex)
    updatedLine = insertIndex + 1
  }

  const content = `${lines.join('\n').replace(/\s+$/g, '')}\n`
  atomicWrite(ensured.memoryFile, content)

  return {
    ...ensured,
    section: targetSectionName,
    text: targetText,
    threshold,
    sectionCreated,
    action,
    line: updatedLine,
    matched: best
      ? {
          text: best.text,
          score: best.score,
          line: best.lineIndex + 1
        }
      : null
  }
}

const parseArgs = (argv) => {
  const [command, ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (!arg.startsWith('--')) {
      continue
    }
    const key = arg.slice(2)
    const value = rest[index + 1]
    if (!value || value.startsWith('--')) {
      options[key] = 'true'
      continue
    }
    options[key] = value
    index += 1
  }
  return { command, options }
}

const requireOption = (options, key) => {
  const value = options[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`missing --${key}`)
  }
  return value
}

const run = () => {
  const { command, options } = parseArgs(process.argv.slice(2))

  if (!command) {
    throw new Error('missing command (ensure|search|upsert)')
  }

  const memoryFile = requireOption(options, 'memory-file')

  if (command === 'ensure') {
    return ensureMemoryFile(memoryFile)
  }

  if (command === 'search') {
    const query = requireOption(options, 'query')
    const limit = clampLimit(Number(options.limit ?? DEFAULT_LIMIT))
    return searchMemory(memoryFile, query, limit)
  }

  if (command === 'upsert') {
    const section = requireOption(options, 'section')
    const text = requireOption(options, 'text')
    const threshold = clampThreshold(Number(options.threshold ?? DEFAULT_THRESHOLD))
    return upsertMemory(memoryFile, section, text, threshold)
  }

  throw new Error(`unknown command: ${command}`)
}

try {
  const payload = run()
  process.stdout.write(`${toJson({ ok: true, ...payload })}\n`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stdout.write(`${toJson({ ok: false, error: message })}\n`)
  process.exitCode = 1
}
