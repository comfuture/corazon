<script setup lang="ts">
type DiffRowKind = 'meta' | 'hunk' | 'context' | 'add' | 'delete' | 'note'

type DiffRow = {
  id: string
  kind: DiffRowKind
  text: string
  prefix: string
  oldLineNumber: number | null
  newLineNumber: number | null
}

const props = defineProps<{
  diff: string
}>()

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

const rows = computed<DiffRow[]>(() => {
  const source = props.diff.replace(/\r\n/g, '\n').trim()
  if (!source) {
    return []
  }

  const parsedRows: DiffRow[] = []
  const lines = source.split('\n')
  let oldLineNumber: number | null = null
  let newLineNumber: number | null = null

  lines.forEach((line, index) => {
    const rowId = `diff-row-${index}`

    if (line.startsWith('@@')) {
      const matched = line.match(HUNK_HEADER_PATTERN)
      oldLineNumber = matched ? Number.parseInt(matched[1] ?? '0', 10) : null
      newLineNumber = matched ? Number.parseInt(matched[2] ?? '0', 10) : null
      parsedRows.push({
        id: rowId,
        kind: 'hunk',
        text: line,
        prefix: '@@',
        oldLineNumber: null,
        newLineNumber: null
      })
      return
    }

    if (
      line.startsWith('diff --git')
      || line.startsWith('index ')
      || line.startsWith('--- ')
      || line.startsWith('+++ ')
    ) {
      parsedRows.push({
        id: rowId,
        kind: 'meta',
        text: line,
        prefix: line.slice(0, Math.min(4, line.length)),
        oldLineNumber: null,
        newLineNumber: null
      })
      return
    }

    if (line.startsWith('\\')) {
      parsedRows.push({
        id: rowId,
        kind: 'note',
        text: line,
        prefix: '\\',
        oldLineNumber: null,
        newLineNumber: null
      })
      return
    }

    if (line.startsWith('+')) {
      parsedRows.push({
        id: rowId,
        kind: 'add',
        text: line.slice(1),
        prefix: '+',
        oldLineNumber: null,
        newLineNumber
      })
      newLineNumber = newLineNumber == null ? null : newLineNumber + 1
      return
    }

    if (line.startsWith('-')) {
      parsedRows.push({
        id: rowId,
        kind: 'delete',
        text: line.slice(1),
        prefix: '-',
        oldLineNumber,
        newLineNumber: null
      })
      oldLineNumber = oldLineNumber == null ? null : oldLineNumber + 1
      return
    }

    parsedRows.push({
      id: rowId,
      kind: 'context',
      text: line.startsWith(' ') ? line.slice(1) : line,
      prefix: ' ',
      oldLineNumber,
      newLineNumber
    })
    oldLineNumber = oldLineNumber == null ? null : oldLineNumber + 1
    newLineNumber = newLineNumber == null ? null : newLineNumber + 1
  })

  return parsedRows
})

const lineNumberText = (value: number | null) => value == null ? '' : String(value)

const rowClass = (kind: DiffRowKind) => {
  switch (kind) {
    case 'meta':
      return 'bg-muted/20 text-muted-foreground'
    case 'hunk':
      return 'bg-sky-500/10 text-sky-700 dark:text-sky-200'
    case 'add':
      return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
    case 'delete':
      return 'bg-rose-500/10 text-rose-700 dark:text-rose-200'
    case 'note':
      return 'bg-muted/10 text-muted-foreground italic'
    default:
      return 'text-default'
  }
}

const gutterClass = (kind: DiffRowKind) => {
  switch (kind) {
    case 'add':
      return 'text-emerald-700 dark:text-emerald-300'
    case 'delete':
      return 'text-rose-700 dark:text-rose-300'
    case 'hunk':
      return 'text-sky-700 dark:text-sky-300'
    case 'meta':
    case 'note':
      return 'text-muted-foreground'
    default:
      return 'text-muted'
  }
}
</script>

<template>
  <div class="overflow-x-auto rounded-md border border-muted/40 bg-muted/10">
    <table class="min-w-full border-collapse font-mono text-[11px] leading-5">
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.id"
          :class="rowClass(row.kind)"
        >
          <td
            class="w-12 select-none border-r border-white/5 px-2 text-right align-top"
            :class="gutterClass(row.kind)"
          >
            {{ lineNumberText(row.oldLineNumber) }}
          </td>
          <td
            class="w-12 select-none border-r border-white/5 px-2 text-right align-top"
            :class="gutterClass(row.kind)"
          >
            {{ lineNumberText(row.newLineNumber) }}
          </td>
          <td
            class="w-6 select-none border-r border-white/5 px-2 text-center align-top"
            :class="gutterClass(row.kind)"
          >
            {{ row.prefix }}
          </td>
          <td class="px-3 py-0.5 whitespace-pre">
            {{ row.text }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
