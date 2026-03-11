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

export const log = (
  minimumLevel: AppLogLevel,
  messageLevel: AppLogLevel,
  event: string,
  fields: Record<string, unknown>,
) =>
  Effect.sync(() => {
    if (!shouldLog(minimumLevel, messageLevel)) {
      return
    }

    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: messageLevel,
      event,
      ...fields,
    })

    if (messageLevel === "Fatal" || messageLevel === "Error") {
      console.error(line)
      return
    }

    console.log(line)
  })
