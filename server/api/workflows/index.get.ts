import type { WorkflowListResponse } from '@@/types/workflow'

export default defineEventHandler((event): WorkflowListResponse => {
  setResponseHeader(event, 'cache-control', 'no-store')
  const workflows = loadWorkflowDefinitions()
  const availableSkills = listInstalledSkills().map(skill => skill.name)

  return {
    workflows,
    availableSkills
  }
})
