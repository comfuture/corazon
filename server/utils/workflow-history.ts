import { existsSync, readFileSync } from 'node:fs'
import type { WorkflowRunHistoryMessage } from '@@/types/workflow'

type SessionLine = {
  timestamp?: string
  type?: string
  payload?: Record<string, unknown>
}

const parseLine = (line: string): SessionLine | null => {
  if (!line.trim()) {
    return null
  }

  try {
    return JSON.parse(line) as SessionLine
  } catch {
    return null
  }
}

export const loadWorkflowRunMessagesFromSessionFile = (sessionFilePath: string) => {
  if (!existsSync(sessionFilePath)) {
    return null
  }

  const content = readFileSync(sessionFilePath, 'utf8')
  const lines = content.split('\n')
  const messages: WorkflowRunHistoryMessage[] = []

  for (const line of lines) {
    const parsed = parseLine(line)
    if (!parsed) {
      continue
    }

    if (parsed.type !== 'event_msg' || !parsed.payload) {
      continue
    }

    const eventType = parsed.payload.type
    if (eventType === 'user_message') {
      const message = typeof parsed.payload.message === 'string' ? parsed.payload.message.trim() : ''
      if (!message) {
        continue
      }
      messages.push({
        role: 'user',
        text: message,
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : null
      })
      continue
    }

    if (eventType === 'agent_message') {
      const message = typeof parsed.payload.message === 'string' ? parsed.payload.message.trim() : ''
      if (!message) {
        continue
      }
      messages.push({
        role: 'assistant',
        text: message,
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : null
      })
    }
  }

  return messages
}

