import assert from 'node:assert/strict'
import { parseWorkflowSource, serializeWorkflowSource } from '../server/utils/workflow-definitions.ts'
import type { WorkflowFrontmatter } from '../types/workflow.ts'

const baseFrontmatter = (language: WorkflowFrontmatter['language']): WorkflowFrontmatter => ({
  name: 'Daily Summary',
  description: 'Summarize the latest activity.',
  language,
  on: { 'workflow-dispatch': true },
  skills: []
})

const run = () => {
  const markdownSource = serializeWorkflowSource(
    {
      ...baseFrontmatter('markdown'),
      on: {
        'schedule': '13 * * * *',
        'workflow-dispatch': true
      }
    },
    '  Every day run this task.  \n\n   Send a concise report.  '
  )

  const markdown = parseWorkflowSource({
    fileSlug: 'daily-summary',
    filePath: '/tmp/daily-summary.md',
    source: markdownSource,
    updatedAt: Date.now()
  })

  assert.equal(markdown.isValid, true)
  assert.equal(markdown.frontmatter.language, 'markdown')
  assert.equal(markdown.frontmatter.on.schedule, '13 * * * *')
  assert.equal(markdown.instruction.includes('<goal>'), true)
  assert.equal(markdown.instruction.includes('Send a concise report.'), true)

  const pythonSource = serializeWorkflowSource(
    baseFrontmatter('python'),
    'for item in [1, 2]:\n    print(item)\n'
  )

  const python = parseWorkflowSource({
    fileSlug: 'python-dispatch',
    filePath: '/tmp/python-dispatch.md',
    source: pythonSource,
    updatedAt: Date.now()
  })

  assert.equal(python.isValid, true)
  assert.equal(python.frontmatter.language, 'python')
  assert.equal(python.frontmatter.on['workflow-dispatch'], true)
  assert.equal(python.frontmatter.on.schedule, undefined)
  assert.equal(python.frontmatter.on.interval, undefined)
  assert.equal(python.frontmatter.on.rrule, undefined)
  assert.equal(
    python.instruction,
    'for item in [1, 2]:\n    print(item)',
    'script workflows should preserve code body except leading/trailing whitespace trim'
  )

  assert.throws(
    () => serializeWorkflowSource(
      {
        ...baseFrontmatter('python'),
        on: {
          'schedule': '*/5 * * * *',
          'workflow-dispatch': false
        }
      },
      'print("hi")'
    ),
    /Time triggers \("schedule", "interval", "rrule"\) currently support only markdown workflows\./,
    'non-markdown workflows with time triggers must fail validation'
  )

  const invalidLanguage = parseWorkflowSource({
    fileSlug: 'invalid-language',
    filePath: '/tmp/invalid-language.md',
    source: [
      '---',
      'name: Invalid Language',
      'description: should fail',
      'language: javascript',
      'on:',
      '  workflow-dispatch: true',
      'skills: []',
      '---',
      'do work'
    ].join('\n'),
    updatedAt: Date.now()
  })

  assert.equal(invalidLanguage.isValid, false)
  assert.match(invalidLanguage.parseError ?? '', /Frontmatter must include name, description, language, on, skills\./)

  const typescriptSource = serializeWorkflowSource(
    baseFrontmatter('typescript'),
    'console.log("ok")'
  )
  const typescript = parseWorkflowSource({
    fileSlug: 'typescript-dispatch',
    filePath: '/tmp/typescript-dispatch.md',
    source: typescriptSource,
    updatedAt: Date.now()
  })

  assert.equal(typescript.isValid, true)
  assert.equal(typescript.frontmatter.language, 'typescript')
  assert.equal(typescript.frontmatter.on['workflow-dispatch'], true)
  assert.equal(typescript.frontmatter.on.schedule, undefined)
  assert.equal(typescript.frontmatter.on.interval, undefined)
  assert.equal(typescript.frontmatter.on.rrule, undefined)

  console.log('workflow language regression smoke checks passed')
}

run()
