import assert from 'node:assert/strict'
import { parseWorkflowSource, serializeWorkflowSource } from '../server/utils/workflow-definitions.ts'
import { executeScriptWorkflowInSandbox } from '../server/utils/workflow-script-sandbox.ts'
import type { WorkflowFrontmatter } from '../types/workflow.ts'

const baseFrontmatter = (language: WorkflowFrontmatter['language']): WorkflowFrontmatter => ({
  name: 'Daily Summary',
  description: 'Summarize the latest activity.',
  language,
  on: { 'workflow-dispatch': true },
  skills: []
})

const run = async () => {
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

  const completedScriptRun = await executeScriptWorkflowInSandbox({
    definition: typescript,
    triggerType: 'workflow-dispatch',
    triggerValue: 'manual'
  })
  assert.equal(completedScriptRun.status, 'completed')

  const pythonExecuted = await executeScriptWorkflowInSandbox({
    definition: python,
    triggerType: 'workflow-dispatch',
    triggerValue: 'manual'
  })
  assert.equal(pythonExecuted.status, 'completed')
  assert.match(pythonExecuted.stdout, /1/)
  assert.match(pythonExecuted.stdout, /2/)

  const previousProvider = process.env.CORAZON_WORKFLOW_SCRIPT_SANDBOX_PROVIDER
  process.env.CORAZON_WORKFLOW_SCRIPT_SANDBOX_PROVIDER = ''
  const pythonWithBlankProvider = await executeScriptWorkflowInSandbox({
    definition: python,
    triggerType: 'workflow-dispatch',
    triggerValue: 'manual'
  })
  if (typeof previousProvider === 'string') {
    process.env.CORAZON_WORKFLOW_SCRIPT_SANDBOX_PROVIDER = previousProvider
  } else {
    delete process.env.CORAZON_WORKFLOW_SCRIPT_SANDBOX_PROVIDER
  }
  assert.equal(
    pythonWithBlankProvider.status,
    'completed',
    'empty sandbox provider env should fall back to local provider'
  )

  const failedScriptSource = serializeWorkflowSource(
    baseFrontmatter('typescript'),
    'console.error("boom"); process.exit(7)'
  )
  const failedScriptWorkflow = parseWorkflowSource({
    fileSlug: 'typescript-failure',
    filePath: '/tmp/typescript-failure.md',
    source: failedScriptSource,
    updatedAt: Date.now()
  })
  const failedScriptRun = await executeScriptWorkflowInSandbox({
    definition: failedScriptWorkflow,
    triggerType: 'workflow-dispatch',
    triggerValue: 'manual'
  })
  assert.equal(failedScriptRun.status, 'failed')
  assert.equal(failedScriptRun.errorCode, 'execution-failed')
  assert.equal(failedScriptRun.exitCode, 7)

  const timeoutSource = serializeWorkflowSource(
    baseFrontmatter('typescript'),
    'await new Promise(resolve => setTimeout(resolve, 120));\nconsole.log("done")'
  )
  const timeoutWorkflow = parseWorkflowSource({
    fileSlug: 'typescript-timeout',
    filePath: '/tmp/typescript-timeout.md',
    source: timeoutSource,
    updatedAt: Date.now()
  })
  const previousTimeout = process.env.CORAZON_WORKFLOW_SCRIPT_TIMEOUT_MS
  process.env.CORAZON_WORKFLOW_SCRIPT_TIMEOUT_MS = '50'
  const timedOutScriptRun = await executeScriptWorkflowInSandbox({
    definition: timeoutWorkflow,
    triggerType: 'workflow-dispatch',
    triggerValue: 'manual'
  })
  if (typeof previousTimeout === 'string') {
    process.env.CORAZON_WORKFLOW_SCRIPT_TIMEOUT_MS = previousTimeout
  } else {
    delete process.env.CORAZON_WORKFLOW_SCRIPT_TIMEOUT_MS
  }
  assert.equal(timedOutScriptRun.status, 'failed')
  assert.equal(timedOutScriptRun.errorCode, 'execution-timeout')

  console.log('workflow language regression smoke checks passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
