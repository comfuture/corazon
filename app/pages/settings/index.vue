<script setup lang="ts">
definePageMeta({
  layout: 'settings'
})

await navigateTo('/settings/general')
</script>

<template>
  <div class="p-4 text-sm text-muted-foreground">
    Redirecting to General settings...
  </div>
</template>
