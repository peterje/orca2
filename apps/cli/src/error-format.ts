import { Schema } from "effect"
import { ConfigLoadError } from "./orca-config"

const formatCauseMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)

export const formatErrorMessage = (error: unknown) => {
  if (Schema.isSchemaError(error)) {
    return String(error.issue)
  }

  if (error instanceof ConfigLoadError) {
    return `failed to load config from ${error.path}: ${formatCauseMessage(error.cause)}`
  }

  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}
