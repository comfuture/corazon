export const useChatSubmitGuard = () => {
  const isComposing = ref(false)
  const suppressNextSubmit = ref(false)

  const onCompositionStart = () => {
    isComposing.value = true
  }

  const onCompositionEnd = () => {
    isComposing.value = false
    suppressNextSubmit.value = false
  }

  const onKeydownEnter = (event: KeyboardEvent) => {
    const isIme = event.isComposing || event.keyCode === 229 || isComposing.value
    if (isIme) {
      suppressNextSubmit.value = true
    }
  }

  const shouldSubmit = (event?: Event) => {
    if (suppressNextSubmit.value) {
      suppressNextSubmit.value = false
      return false
    }

    const keyboardEvent = event as KeyboardEvent | undefined
    if (keyboardEvent?.isComposing || keyboardEvent?.keyCode === 229 || isComposing.value) {
      return false
    }

    return true
  }

  return {
    onCompositionStart,
    onCompositionEnd,
    onKeydownEnter,
    shouldSubmit
  }
}
