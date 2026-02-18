<script setup lang="ts">
definePageMeta({
  layout: 'settings'
})

await navigateTo('/settings/mcp')
</script>

<template>
  <div class="p-4 text-sm text-muted-foreground">
    Redirecting to MCP settings...
  </div>
</template>
