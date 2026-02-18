<script setup lang="ts">
import type { AgentHomeInfo, SkillInstallResponse, SkillListResponse, SkillSummary } from '@@/types/settings'

definePageMeta({
  layout: 'settings'
})

const toast = useToast()
const source = ref('')
const installing = ref(false)
const deletingSkillName = ref<string | null>(null)
const isDeleteModalOpen = ref(false)
const pendingDeleteSkill = ref<SkillSummary | null>(null)
const deleteError = ref<string | null>(null)

const { data: agentHome } = await useFetch<AgentHomeInfo>('/api/settings/agent-home')
const { data, pending, refresh } = await useFetch<SkillListResponse>('/api/settings/skill')

const skills = computed<SkillSummary[]>(() => data.value?.skills ?? [])

const refreshSkills = async () => {
  await refresh()
}

const installSkill = async () => {
  const sourceValue = source.value.trim()
  if (!sourceValue) {
    toast.add({
      title: 'Source required',
      description: 'Provide a Git URL or local path.',
      color: 'warning'
    })
    return
  }

  try {
    installing.value = true
    const response = await $fetch<SkillInstallResponse>('/api/settings/skill/install', {
      method: 'POST',
      body: {
        source: sourceValue
      }
    })
    await refresh()
    source.value = ''
    toast.add({
      title: 'Installed',
      description: `Installed ${response.installed.length} skill(s).`,
      color: 'success'
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to install skills.'
    toast.add({
      title: 'Install failed',
      description: message,
      color: 'error'
    })
  } finally {
    installing.value = false
  }
}

const requestRemoveSkill = (skill: SkillSummary) => {
  if (skill.isSystem) {
    return
  }
  pendingDeleteSkill.value = skill
  deleteError.value = null
  isDeleteModalOpen.value = true
}

const closeDeleteSkillModal = () => {
  if (deletingSkillName.value) {
    return
  }
  isDeleteModalOpen.value = false
  pendingDeleteSkill.value = null
  deleteError.value = null
}

const confirmRemoveSkill = async () => {
  const skill = pendingDeleteSkill.value
  if (!skill || skill.isSystem) {
    return
  }

  try {
    deletingSkillName.value = skill.name
    deleteError.value = null
    await $fetch(`/api/settings/skill/${encodeURIComponent(skill.name)}`, {
      method: 'DELETE'
    })
    await refresh()
    isDeleteModalOpen.value = false
    pendingDeleteSkill.value = null
    toast.add({
      title: 'Deleted',
      description: `${skill.name} was removed.`,
      color: 'success'
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete skill.'
    deleteError.value = message
    toast.add({
      title: 'Delete failed',
      description: message,
      color: 'error'
    })
  } finally {
    deletingSkillName.value = null
  }
}
</script>

<template>
  <UDashboardPanel id="settings-skill-panel">
    <template #header>
      <UDashboardNavbar title="Skill">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UContainer class="py-6 sm:py-8">
        <div class="mx-auto flex w-full max-w-4xl flex-col gap-4">
          <UAlert
            color="neutral"
            variant="soft"
            icon="i-lucide-folder-git-2"
            title="Skill directory"
            :description="agentHome?.skillsPath ?? 'Loading...'"
          />

          <UCard :ui="{ body: 'space-y-4' }">
            <h2 class="text-base font-semibold">
              Install skill
            </h2>

            <div class="flex flex-col gap-2 sm:flex-row">
              <UInput
                v-model="source"
                class="flex-1"
                placeholder="Git URL or local path"
              />
              <UButton
                label="Install"
                icon="i-lucide-download"
                :loading="installing"
                @click="installSkill"
              />
            </div>
          </UCard>

          <UCard :ui="{ body: 'space-y-3' }">
            <div class="flex items-center justify-between">
              <h2 class="text-base font-semibold">
                Installed skills
              </h2>
              <UButton
                label="Refresh"
                icon="i-lucide-refresh-cw"
                color="neutral"
                variant="outline"
                :loading="pending"
                @click="refreshSkills"
              />
            </div>

            <div
              v-if="skills.length === 0"
              class="rounded-md border border-dashed border-default p-6 text-center text-sm text-muted-foreground"
            >
              No skills installed.
            </div>

            <div
              v-for="skill in skills"
              :key="skill.name"
              class="flex items-center justify-between rounded-md border border-default p-3"
            >
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <p class="truncate font-medium">
                    {{ skill.name }}
                  </p>
                  <UBadge
                    v-if="skill.isSystem"
                    label="System"
                    color="neutral"
                    variant="soft"
                    size="xs"
                  />
                  <UBadge
                    v-if="!skill.hasSkillFile"
                    label="Missing SKILL.md"
                    color="warning"
                    variant="soft"
                    size="xs"
                  />
                </div>
                <p class="truncate text-xs text-muted-foreground">
                  {{ skill.path }}
                </p>
              </div>

              <UButton
                label="Delete"
                icon="i-lucide-trash-2"
                color="error"
                variant="ghost"
                :disabled="skill.isSystem"
                :loading="deletingSkillName === skill.name"
                @click="requestRemoveSkill(skill)"
              />
            </div>
          </UCard>
        </div>
      </UContainer>

      <UModal
        v-model:open="isDeleteModalOpen"
        title="Delete skill?"
        :description="pendingDeleteSkill ? `This permanently removes ${pendingDeleteSkill.name}.` : 'This permanently removes the selected skill.'"
        :ui="{ footer: 'justify-end' }"
      >
        <template #body>
          <p class="text-sm text-muted-foreground">
            This action cannot be undone.
          </p>
          <UAlert
            v-if="deleteError"
            color="error"
            variant="soft"
            :title="deleteError"
            class="mt-4"
          />
        </template>
        <template #footer>
          <div class="flex gap-2">
            <UButton
              label="Cancel"
              color="neutral"
              variant="outline"
              :disabled="Boolean(deletingSkillName)"
              @click="closeDeleteSkillModal"
            />
            <UButton
              label="Delete"
              color="error"
              :loading="Boolean(deletingSkillName)"
              @click="confirmRemoveSkill"
            />
          </div>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
