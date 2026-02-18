const THEME_PREFERENCES = ['light', 'dark', 'system'] as const
const FONT_SIZES = ['sm', 'md', 'lg'] as const

type ThemePreference = (typeof THEME_PREFERENCES)[number]
type FontSize = (typeof FONT_SIZES)[number]

const STORAGE_KEYS = {
  themePreference: 'codex-settings-theme-preference',
  fontSize: 'codex-settings-font-size',
  enableNotifications: 'codex-settings-enable-notifications'
} as const

const isThemePreference = (value: unknown): value is ThemePreference =>
  typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value)

const isFontSize = (value: unknown): value is FontSize =>
  typeof value === 'string' && (FONT_SIZES as readonly string[]).includes(value)

const applyFontSize = (value: FontSize) => {
  if (!import.meta.client) {
    return
  }
  document.documentElement.dataset.codexFontSize = value
}

export const useSettings = () => {
  const colorMode = useColorMode()
  const themePreference = useState<ThemePreference>('codex-settings-theme-preference', () => 'system')
  const fontSize = useState<FontSize>('codex-settings-font-size', () => 'md')
  const enableNotifications = useState<boolean>('codex-settings-enable-notifications', () => false)
  const loaded = useState<boolean>('codex-settings-loaded', () => false)

  if (import.meta.client && !loaded.value) {
    const storedTheme = window.localStorage.getItem(STORAGE_KEYS.themePreference)
    if (isThemePreference(storedTheme)) {
      themePreference.value = storedTheme
    }

    const storedFontSize = window.localStorage.getItem(STORAGE_KEYS.fontSize)
    if (isFontSize(storedFontSize)) {
      fontSize.value = storedFontSize
    }

    const storedEnableNotifications = window.localStorage.getItem(STORAGE_KEYS.enableNotifications)
    if (storedEnableNotifications === 'true') {
      enableNotifications.value = true
    }
    if (storedEnableNotifications === 'false') {
      enableNotifications.value = false
    }

    loaded.value = true
  }

  watch(themePreference, (value) => {
    colorMode.preference = value
    if (!import.meta.client) {
      return
    }
    window.localStorage.setItem(STORAGE_KEYS.themePreference, value)
  }, { immediate: true })

  watch(fontSize, (value) => {
    applyFontSize(value)
    if (!import.meta.client) {
      return
    }
    window.localStorage.setItem(STORAGE_KEYS.fontSize, value)
  }, { immediate: true })

  watch(enableNotifications, (value) => {
    if (!import.meta.client) {
      return
    }
    window.localStorage.setItem(STORAGE_KEYS.enableNotifications, value ? 'true' : 'false')
  })

  const setThemePreference = (value: ThemePreference) => {
    themePreference.value = value
  }

  const setFontSize = (value: FontSize) => {
    fontSize.value = value
  }

  const setEnableNotifications = async (value: boolean) => {
    if (!import.meta.client) {
      enableNotifications.value = value
      return value
    }

    if (!value) {
      enableNotifications.value = false
      return false
    }

    if (typeof Notification === 'undefined') {
      enableNotifications.value = false
      return false
    }

    if (Notification.permission === 'granted') {
      enableNotifications.value = true
      return true
    }

    if (Notification.permission === 'denied') {
      enableNotifications.value = false
      return false
    }

    const permission = await Notification.requestPermission()
    const granted = permission === 'granted'
    enableNotifications.value = granted
    return granted
  }

  return {
    themePreference,
    fontSize,
    enableNotifications,
    themePreferences: THEME_PREFERENCES,
    fontSizes: FONT_SIZES,
    setThemePreference,
    setFontSize,
    setEnableNotifications
  }
}
