import { AsyncTask, CronJob, SimpleIntervalJob, ToadScheduler } from 'toad-scheduler'
import type { WorkflowDefinition, WorkflowTriggerType } from '@@/types/workflow'

type WorkflowScheduledExecutor = (
  definition: WorkflowDefinition,
  triggerType: WorkflowTriggerType,
  triggerValue: string | null
) => Promise<void>

let scheduler: ToadScheduler | null = null
let schedulerInitialized = false
let workflowScheduledExecutor: WorkflowScheduledExecutor = async () => {}

const createScheduler = () => {
  scheduler = new ToadScheduler()
  return scheduler
}

const getScheduler = () => scheduler ?? createScheduler()

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

const scheduleWorkflowDefinition = (targetScheduler: ToadScheduler, definition: WorkflowDefinition) => {
  if (!definition.isValid) {
    return
  }

  const schedule = definition.frontmatter.on.schedule?.trim()
  const interval = definition.frontmatter.on.interval?.trim()

  if (schedule) {
    registerCronSchedule(targetScheduler, definition, schedule)
  }
  if (interval) {
    registerIntervalSchedule(targetScheduler, definition, interval)
  }
}

export const setWorkflowScheduledExecutor = (executor: WorkflowScheduledExecutor) => {
  workflowScheduledExecutor = executor
}

export const reloadWorkflowScheduler = () => {
  if (scheduler) {
    scheduler.stop()
  }

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
}
