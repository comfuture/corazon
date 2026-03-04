import { watch, type FSWatcher } from 'node:fs'
import { AsyncTask, CronJob, SimpleIntervalJob, ToadScheduler } from 'toad-scheduler'
import { rrulestr } from 'rrule'
import type { WorkflowDefinition, WorkflowTriggerType } from '@@/types/workflow'

type WorkflowScheduledExecutor = (
  definition: WorkflowDefinition,
  triggerType: WorkflowTriggerType,
  triggerValue: string | null
) => Promise<void>

let scheduler: ToadScheduler | null = null
let schedulerInitialized = false
let workflowScheduledExecutor: WorkflowScheduledExecutor = async () => {}
const rruleTimerByJobId = new Map<string, ReturnType<typeof setTimeout>>()
let workflowDefinitionsWatcher: FSWatcher | null = null
let workflowDefinitionsReloadTimer: ReturnType<typeof setTimeout> | null = null
const MAX_TIMEOUT_MS = 2_147_483_647
const WORKFLOW_RELOAD_DEBOUNCE_MS = 200

const createScheduler = () => {
  scheduler = new ToadScheduler()
  return scheduler
}

const getScheduler = () => scheduler ?? createScheduler()

const clearRegisteredRRuleTimers = () => {
  for (const timer of rruleTimerByJobId.values()) {
    clearTimeout(timer)
  }
  rruleTimerByJobId.clear()
}

const clearWorkflowDefinitionsWatcher = () => {
  if (workflowDefinitionsReloadTimer) {
    clearTimeout(workflowDefinitionsReloadTimer)
    workflowDefinitionsReloadTimer = null
  }

  if (workflowDefinitionsWatcher) {
    workflowDefinitionsWatcher.close()
    workflowDefinitionsWatcher = null
  }
}

const scheduleWorkflowReloadFromDefinitionChange = () => {
  if (workflowDefinitionsReloadTimer) {
    clearTimeout(workflowDefinitionsReloadTimer)
  }

  workflowDefinitionsReloadTimer = setTimeout(() => {
    workflowDefinitionsReloadTimer = null

    try {
      reloadWorkflowScheduler()
    } catch (error) {
      console.error(error)
    }
  }, WORKFLOW_RELOAD_DEBOUNCE_MS)
}

const ensureWorkflowDefinitionsWatcher = () => {
  if (workflowDefinitionsWatcher) {
    return
  }

  const directory = ensureWorkflowsDirectory()

  try {
    workflowDefinitionsWatcher = watch(directory, (_eventType, filename) => {
      const resolvedFilename = filename ? String(filename) : ''

      if (resolvedFilename && !resolvedFilename.endsWith('.md')) {
        return
      }

      scheduleWorkflowReloadFromDefinitionChange()
    })
    workflowDefinitionsWatcher.on('error', (error) => {
      console.error(error)
    })
  } catch (error) {
    console.error(error)
  }
}

const toIntervalSchedule = (value: string) => {
  const matched = value.match(/^([1-9][0-9]*)(s|m|h)$/)
  if (!matched) {
    return null
  }

  const amount = Number.parseInt(matched[1] ?? '0', 10)
  const unit = matched[2]

  if (!Number.isFinite(amount) || amount <= 0) {
    return null
  }

  if (unit === 's') {
    return { seconds: amount }
  }
  if (unit === 'm') {
    return { minutes: amount }
  }
  if (unit === 'h') {
    return { hours: amount }
  }

  return null
}

const buildWorkflowJobId = (fileSlug: string, triggerType: WorkflowTriggerType) =>
  `workflow:${fileSlug}:${triggerType}`

const registerCronSchedule = (
  targetScheduler: ToadScheduler,
  definition: WorkflowDefinition,
  cronExpression: string
) => {
  const triggerType: WorkflowTriggerType = 'schedule'
  const task = new AsyncTask(
    buildWorkflowJobId(definition.fileSlug, triggerType),
    async () => {
      await workflowScheduledExecutor(definition, triggerType, cronExpression)
    },
    (error) => {
      console.error(error)
    }
  )

  const job = new CronJob(
    { cronExpression },
    task,
    {
      id: buildWorkflowJobId(definition.fileSlug, triggerType),
      preventOverrun: true
    }
  )
  targetScheduler.addCronJob(job)
}

const registerIntervalSchedule = (
  targetScheduler: ToadScheduler,
  definition: WorkflowDefinition,
  intervalExpression: string
) => {
  const schedule = toIntervalSchedule(intervalExpression)
  if (!schedule) {
    return
  }

  const triggerType: WorkflowTriggerType = 'interval'
  const task = new AsyncTask(
    buildWorkflowJobId(definition.fileSlug, triggerType),
    async () => {
      await workflowScheduledExecutor(definition, triggerType, intervalExpression)
    },
    (error) => {
      console.error(error)
    }
  )
  const job = new SimpleIntervalJob(
    schedule,
    task,
    {
      id: buildWorkflowJobId(definition.fileSlug, triggerType),
      preventOverrun: true
    }
  )
  targetScheduler.addSimpleIntervalJob(job)
}

const registerRRuleSchedule = (
  definition: WorkflowDefinition,
  rruleExpression: string
) => {
  const triggerType: WorkflowTriggerType = 'rrule'
  const jobId = buildWorkflowJobId(definition.fileSlug, triggerType)
  const existingTimer = rruleTimerByJobId.get(jobId)
  if (existingTimer) {
    clearTimeout(existingTimer)
    rruleTimerByJobId.delete(jobId)
  }

  let parsedRule: ReturnType<typeof rrulestr>
  try {
    parsedRule = rrulestr(rruleExpression)
  } catch (error) {
    console.error(error)
    return
  }

  const scheduleNext = () => {
    const nextRunAt = parsedRule.after(new Date(), false)
    if (!nextRunAt) {
      rruleTimerByJobId.delete(jobId)
      return
    }

    const delay = Math.max(0, nextRunAt.getTime() - Date.now())
    const effectiveDelay = delay > MAX_TIMEOUT_MS ? MAX_TIMEOUT_MS : delay

    const timer = setTimeout(async () => {
      if (!rruleTimerByJobId.has(jobId)) {
        return
      }

      if (delay <= MAX_TIMEOUT_MS) {
        try {
          await workflowScheduledExecutor(definition, triggerType, rruleExpression)
        } catch (error) {
          console.error(error)
        }
      }

      scheduleNext()
    }, effectiveDelay)

    rruleTimerByJobId.set(jobId, timer)
  }

  scheduleNext()
}

const scheduleWorkflowDefinition = (targetScheduler: ToadScheduler, definition: WorkflowDefinition) => {
  if (!definition.isValid) {
    return
  }

  const schedule = definition.frontmatter.on.schedule?.trim()
  const interval = definition.frontmatter.on.interval?.trim()
  const rrule = definition.frontmatter.on.rrule?.trim()

  if (schedule) {
    registerCronSchedule(targetScheduler, definition, schedule)
  }
  if (interval) {
    registerIntervalSchedule(targetScheduler, definition, interval)
  }
  if (rrule) {
    registerRRuleSchedule(definition, rrule)
  }
}

export const setWorkflowScheduledExecutor = (executor: WorkflowScheduledExecutor) => {
  workflowScheduledExecutor = executor
}

export const reloadWorkflowScheduler = () => {
  ensureWorkflowDefinitionsWatcher()

  if (scheduler) {
    scheduler.stop()
  }
  clearRegisteredRRuleTimers()

  const targetScheduler = createScheduler()
  const definitions = loadWorkflowDefinitions()

  for (const definition of definitions) {
    scheduleWorkflowDefinition(targetScheduler, definition)
  }

  return definitions
}

export const ensureWorkflowSchedulerInitialized = () => {
  if (schedulerInitialized) {
    return
  }

  schedulerInitialized = true
  reloadWorkflowScheduler()
}

export const stopWorkflowScheduler = () => {
  getScheduler().stop()
  clearRegisteredRRuleTimers()
  clearWorkflowDefinitionsWatcher()
}
