import type { SkillListResponse } from '@@/types/settings'

export default defineEventHandler((): SkillListResponse => {
  return {
    skills: listInstalledSkills()
  }
})
