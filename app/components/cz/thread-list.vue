<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const props = withDefaults(
  defineProps<{
    collapsed?: boolean
    scrollContainer?: HTMLElement | null
  }>(),
  {
    collapsed: false,
    scrollContainer: null
  }
)

const {
  threads,
  loaded,
  hasMore,
  isRefreshing,
  isLoadingMore,
  refreshThreads,
  loadMoreThreads
} = useCodexThreads()
const rootRef = ref<HTMLElement | null>(null)

const SCROLL_LOAD_THRESHOLD_PX = 180
let resizeObserver: ResizeObserver | null = null
let detachScrollListener: (() => void) | null = null

const maybeLoadMore = async () => {
  const container = props.scrollContainer
  if (!container || !loaded.value || !hasMore.value || isRefreshing.value || isLoadingMore.value) {
    return
  }

  const distanceToBottom = container.scrollHeight - (container.scrollTop + container.clientHeight)
  if (distanceToBottom <= SCROLL_LOAD_THRESHOLD_PX) {
    await loadMoreThreads()
  }
}

const detachScrollAwareness = () => {
  detachScrollListener?.()
  detachScrollListener = null
  resizeObserver?.disconnect()
  resizeObserver = null
}

const attachScrollAwareness = () => {
  detachScrollAwareness()

  const container = props.scrollContainer
  if (!container) {
    return
  }

  const onScroll = () => {
    void maybeLoadMore()
  }

  container.addEventListener('scroll', onScroll, { passive: true })
  detachScrollListener = () => {
    container.removeEventListener('scroll', onScroll)
  }

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      void maybeLoadMore()
    })
    resizeObserver.observe(container)
    if (rootRef.value) {
      resizeObserver.observe(rootRef.value)
    }
  }
}

onMounted(() => {
  const initialize = async () => {
    if (!loaded.value) {
      await refreshThreads()
    }
    await nextTick()
    attachScrollAwareness()
    await maybeLoadMore()
  }

  void initialize()
})

onBeforeUnmount(() => {
  detachScrollAwareness()
})

watch(
  () => threads.value.length,
  () => {
    void nextTick(() => maybeLoadMore())
  }
)

watch(
  () => props.collapsed,
  () => {
    void nextTick(() => {
      attachScrollAwareness()
      void maybeLoadMore()
    })
  }
)

watch(
  () => props.scrollContainer,
  () => {
    void nextTick(() => {
      attachScrollAwareness()
      void maybeLoadMore()
    })
  }
)

const menuItems = computed<NavigationMenuItem[]>(() =>
  threads.value.map(thread => ({
    label: thread.title ?? thread.id,
    icon: props.collapsed ? undefined : 'i-lucide-message-circle',
    to: `/chat/${thread.id}`
  }))
)
</script>

<template>
  <div
    ref="rootRef"
    class="min-h-0"
  >
    <UNavigationMenu
      :items="menuItems"
      orientation="vertical"
    />
    <div
      v-if="isLoadingMore"
      class="px-2 py-2 text-xs text-muted-foreground"
    >
      Loading more chats...
    </div>
  </div>
</template>
