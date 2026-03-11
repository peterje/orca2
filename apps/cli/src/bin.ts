#!/usr/bin/env bun

import { Effect } from "effect"
import { platformLayer, program } from "./index"

await Effect.runPromise(Effect.provide(program, platformLayer))
