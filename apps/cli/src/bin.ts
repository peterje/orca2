#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun"
import { Effect } from "effect"
import { program } from "./index"

BunRuntime.runMain(program as Effect.Effect<void, never, never>)
