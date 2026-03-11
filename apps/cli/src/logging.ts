import { Effect } from "effect"

export const appLogLevels = [
  "Fatal",
  "Error",
  "Warn",
  "Info",
  "Debug",
  "Trace",
] as const

export type AppLogLevel = (typeof appLogLevels)[number]

type LogFields = Record<string, unknown>

const severityOrder: Readonly<Record<AppLogLevel, number>> = {
  Fatal: 0,
  Error: 1,
  Warn: 2,
  Info: 3,
  Debug: 4,
  Trace: 5,
}

const shouldLog = (minimumLevel: AppLogLevel, messageLevel: AppLogLevel) =>
  severityOrder[messageLevel] <= severityOrder[minimumLevel]

export const formatLogLine = (
  messageLevel: AppLogLevel,
  event: string,
  fields: LogFields,
) =>
  JSON.stringify({
    ...fields,
    timestamp: new Date().toISOString(),
    level: messageLevel,
    event,
  })

export const writeLogLine = (
  messageLevel: AppLogLevel,
  event: string,
  fields: LogFields,
) => {
  const line = formatLogLine(messageLevel, event, fields)

  if (messageLevel === "Fatal" || messageLevel === "Error") {
    console.error(line)
    return
  }

  console.log(line)
}

export const log = (
  minimumLevel: AppLogLevel,
  messageLevel: AppLogLevel,
  event: string,
  fields: LogFields,
) =>
  Effect.sync(() => {
    if (!shouldLog(minimumLevel, messageLevel)) {
      return
    }

    writeLogLine(messageLevel, event, fields)
  })
