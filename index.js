/**
 * `/auto-compact` — user-selected context-level compaction that complements the
 * shipped manual `/compact` command.
 *
 * Placement: this is a HOST-plane plugin. In the Web surface the compaction
 * backend and `/compact` live inside each agent preset's isolated `cordis:group`,
 * so a host row cannot inject `compaction`; instead this plugin attaches one
 * agent-scoped command to every live Agent through that Agent's own context and
 * resolves its preset-isolated engine with `ctx.agentPresets.serviceFor(agent,
 * 'compaction')` (the documented accessor for services inside a preset's
 * isolation realm). Host-plane `agent/status` dispatch is unscoped and reaches
 * this plugin for every Agent, which drives the idle trigger.
 *
 * Behavior:
 *  - a human command, per Agent, that shows or changes the trigger level, and
 *  - a watcher that condenses an idle Agent once its measured context reaches
 *    that level, using the same `compaction.compactNow()` seam as `/compact`.
 *
 * The chosen level lives in a small plugin-owned state file under the active
 * profile directory so it survives restarts without restarting this plugin. The
 * row config (`enabled`, `thresholdTokens`) remains the fallback when that file
 * is absent or invalid.
 *
 * Compaction is only attempted when the Agent is idle (the manual compaction
 * contract), so the watcher triggers on the `agent/status` idle transition and
 * defers one event-loop turn to let the driver finish closing the turn. A
 * queued next message that starts a turn first wins; the check then skips and
 * waits for the next idle transition instead of delaying the user's message.
 *
 * @module @local/dsh-auto-compact
 */

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  COMMAND_NAME,
  DEFAULT_THRESHOLD_TOKENS,
  MAX_THRESHOLD_TOKENS,
  MIN_THRESHOLD_TOKENS,
  USAGE,
  formatExact,
  formatTokens,
  parseCommand,
  renderStatus,
  resolveConfig,
  resolveStateFile,
  serializeState,
} from './policy.js'

/** Cordis plugin name used by diagnostics. */
export const name = 'auto-compact'

/**
 * Host services this plugin cannot work without: the live Agent registry, the
 * command registry, and replay-based token measurement. The compaction engine
 * is resolved per Agent because the Web surface isolates it inside presets.
 */
export const inject = ['agents', 'commands', 'tokenMeter']

const LOG_PREFIX = 'auto-compact'

/** Human text for an unknown thrown value. */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve the plugin's state file path. The active profile directory is the
 * natural owner: the saved level belongs to the user's profile, not to a
 * checkout. Without a profile context, fall back to DSH's home directory.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @returns {string} absolute state file path.
 */
function stateFilePath(ctx) {
  const profile = ctx.get('profileContext')
  const base = typeof profile?.dir === 'string' && profile.dir.length > 0
    ? join(profile.dir, '.auto-compact')
    : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'auto-compact')
  return join(base, 'state.json')
}

/**
 * Read the persisted state once at activation. A missing file is normal; any
 * other read or validation failure is logged and the row defaults are used.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {{ enabled: boolean, thresholdTokens: number }} fallback row defaults.
 * @param {string} file absolute state file path.
 * @returns {{ enabled: boolean, thresholdTokens: number, persisted: boolean }} state.
 */
function loadState(ctx, fallback, file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      ctx.logger.warn(`${LOG_PREFIX}: cannot read ${file}: ${errorMessage(error)}; using row defaults`)
    }
    return { ...fallback, persisted: false }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    ctx.logger.warn(`${LOG_PREFIX}: ignoring ${file}: ${errorMessage(error)}; using row defaults`)
    return { ...fallback, persisted: false }
  }
  const resolved = resolveStateFile(parsed, fallback)
  if (resolved.error !== undefined) {
    ctx.logger.warn(`${LOG_PREFIX}: ignoring ${file}: ${resolved.error}; using row defaults`)
    return { ...fallback, persisted: false }
  }
  return { ...resolved.state, persisted: true }
}

/**
 * Live measurement for the status output. The window comes from the durable
 * route's `request/context` record; the level is the same request-and-surface
 * total the compaction backend compares against its own pressure threshold.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {{ session?: unknown }} agent invoking agent.
 * @returns {{ measuredTokens?: number, contextWindow?: number }} snapshot.
 */
function statusSnapshot(ctx, agent) {
  const session = agent?.session
  if (session === undefined || session === null) return {}
  const snapshot = {}
  try {
    const pressure = ctx.tokenMeter.contextPressure(session)
    if (typeof pressure?.contextWindow === 'number') snapshot.contextWindow = pressure.contextWindow
  } catch {
    // The status block stays useful without capacity metadata.
  }
  try {
    const measurement = ctx.tokenMeter.measure(session)
    if (typeof measurement?.totalTokens === 'number') snapshot.measuredTokens = measurement.totalTokens
  } catch {
    // History that cannot be priced yet simply omits the current level.
  }
  return snapshot
}

/**
 * Register `/auto-compact` for every live Agent and watch idle transitions.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx host plugin context.
 * @param {unknown} rawConfig row config (see `resolveConfig`).
 */
export function apply(ctx, rawConfig) {
  const rowDefaults = resolveConfig(rawConfig)
  const stateFile = stateFilePath(ctx)
  const loaded = loadState(ctx, rowDefaults, stateFile)
  const state = { enabled: loaded.enabled, thresholdTokens: loaded.thresholdTokens }
  let disposed = false
  /** Agents that already own this plugin's command registration. */
  const attached = new Map()
  /** One in-flight automatic compaction per Session id. */
  const active = new Map()
  /** Sessions whose idle transition already has one deferred check queued. */
  const queued = new Map()
  /** Serializes state-file writes so two commands cannot interleave. */
  let writeChain = Promise.resolve()

  ctx.logger.info(
    `${LOG_PREFIX}: ${state.enabled ? 'enabled' : 'disabled'} at ${formatTokens(state.thresholdTokens)} context tokens (${loaded.persisted ? stateFile : 'row defaults'})`,
  )

  /**
   * Resolve the compaction engine an Agent's own composition provides. Preset
   * compositions isolate it under the preset realm, which ordinary context
   * lookup cannot see; `agentPresets.serviceFor` is the supported accessor.
   * A non-preset composition (CLI/TUI) keeps the engine on the host plane.
   *
   * @param {object} agent live Agent.
   * @returns {{ compactNow: Function } | undefined} the engine when available.
   */
  const engineFor = (agent) => {
    const presets = ctx.get('agentPresets')
    if (presets !== undefined) {
      try {
        const engine = presets.serviceFor(agent, 'compaction')
        if (engine !== undefined) return engine
      } catch {
        // An Agent outside any preset composition falls through to the host plane.
      }
    }
    return ctx.get('compaction')
  }

  /**
   * Read the canonical context level for one Agent.
   * @param {{ session?: unknown }} agent live Agent.
   * @returns {number | undefined} measured request-and-surface tokens.
   */
  const measureAgent = (agent) => {
    const session = agent?.session
    if (session === undefined || session === null) return undefined
    return ctx.tokenMeter.measure(session).totalTokens
  }

  /**
   * Persist the current state atomically through the write chain.
   * @returns {Promise<void>} after this write reached its rename.
   */
  const saveState = () => {
    const next = writeChain.then(async () => {
      await mkdir(dirname(stateFile), { recursive: true })
      const temporary = `${stateFile}.tmp`
      await writeFile(temporary, serializeState(state), 'utf8')
      await rename(temporary, stateFile)
    })
    writeChain = next.catch(() => undefined)
    return next
  }

  /**
   * Condense one idle Agent when its context level has reached the threshold.
   * Failures stay host-log diagnostics: automatic behavior must not raise UI
   * errors, and the Session log already records failed compaction attempts.
   *
   * @param {{ id: string, session?: unknown, status?: string }} agent idle Agent.
   * @returns {Promise<void>} after this attempt settled.
   */
  const checkpoint = async (agent) => {
    if (disposed || !state.enabled || !attached.has(agent?.id)) return
    if (agent.session === undefined || agent.session === null) return
    if (active.has(agent.id)) return
    // A turn may have started between the status event and this deferred check.
    if (typeof agent.status === 'string' && agent.status !== 'idle') return
    const engine = engineFor(agent)
    if (engine === undefined) return
    let tokens
    try {
      tokens = measureAgent(agent)
    } catch (error) {
      ctx.logger.warn(`${LOG_PREFIX}: context measurement failed: ${errorMessage(error)}`)
      return
    }
    if (typeof tokens !== 'number' || tokens < state.thresholdTokens) return
    const controller = new AbortController()
    active.set(agent.id, controller)
    try {
      const result = await engine.compactNow(agent, controller.signal)
      if (result === null) {
        ctx.logger.info(
          `${LOG_PREFIX}: context at ${formatExact(tokens)} tokens but no compactable range; keeping history`,
        )
      } else {
        ctx.logger.info(
          `${LOG_PREFIX}: compacted ${result.shadowedSeqs.length} history items (~${formatExact(result.shadowedTokenCount)} tokens) at ${formatExact(tokens)} context tokens`,
        )
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
        if (code === 'busy') {
          ctx.logger.debug(`${LOG_PREFIX}: compaction skipped because the session is busy`)
        } else {
          ctx.logger.warn(`${LOG_PREFIX}: automatic compaction failed: ${errorMessage(error)}`)
        }
      }
    } finally {
      if (active.get(agent.id) === controller) active.delete(agent.id)
    }
  }

  /**
   * Queue one idle check, keeping at most one queued check per Session. The
   * deferral lets the driver finish its idle transition (and lets a queued next
   * message start its turn) before this plugin reserves maintenance.
   * @param {{ id: string } | undefined} agent Agent whose status became idle.
   */
  const schedule = (agent) => {
    if (agent === undefined || agent === null || typeof agent.id !== 'string') return
    if (queued.has(agent.id)) return
    const timer = setTimeout(() => {
      queued.delete(agent.id)
      if (!disposed) void checkpoint(agent)
    }, 0)
    queued.set(agent.id, timer)
  }

  /**
   * Execute one slash command through the command registry.
   * @param {import('@deepseek-ai/dsh-commands').CommandInvocation} invocation
   *   settled command invocation.
   * @returns {Promise<import('@deepseek-ai/dsh-commands').CommandResult>} human-only result.
   */
  const executeCommand = async (invocation) => {
    const command = parseCommand(invocation.rawInput)
    if (command.kind === 'invalid') return { kind: 'error', text: USAGE }
    if (invocation.attachments !== undefined && invocation.attachments.length > 0) {
      return { kind: 'error', text: `Attachments are not accepted. ${USAGE}` }
    }
    if (command.kind === 'status') {
      return { kind: 'success', text: renderStatus(state, statusSnapshot(ctx, invocation.agent)) }
    }

    const next = { ...state }
    switch (command.kind) {
      case 'enable':
        next.enabled = true
        break
      case 'disable':
        next.enabled = false
        break
      case 'reset':
        next.enabled = true
        next.thresholdTokens = DEFAULT_THRESHOLD_TOKENS
        break
      case 'set':
        next.enabled = true
        next.thresholdTokens = command.tokens
        break
      default:
        return { kind: 'error', text: USAGE }
    }
    const clampNote = command.kind === 'set' && command.clamped !== undefined
      ? `\nNote: the threshold was clamped to the ${command.clamped === 'min' ? `minimum ${formatTokens(MIN_THRESHOLD_TOKENS)}` : `maximum ${formatTokens(MAX_THRESHOLD_TOKENS)}`} limit.`
      : ''
    const changed = next.enabled !== state.enabled || next.thresholdTokens !== state.thresholdTokens
    // Apply first so the new level is live even if the state file cannot be written.
    state.enabled = next.enabled
    state.thresholdTokens = next.thresholdTokens
    const text = `${renderStatus(state, statusSnapshot(ctx, invocation.agent))}${clampNote}`
    if (!changed) return { kind: 'success', text }

    let saveError
    try {
      await saveState()
    } catch (error) {
      saveError = error
      ctx.logger.warn(`${LOG_PREFIX}: could not save the new level: ${errorMessage(error)}`)
    }
    const saveNote = saveError === undefined
      ? `\nSaved to ${stateFile}.`
      : `\nApplied for this process only; saving the state file failed: ${errorMessage(saveError)}.`
    return { kind: 'success', text: `${text}${saveNote}` }
  }

  /**
   * Attach the agent-scoped command to one live Agent. The registration is made
   * through the Agent's own context, so it is visible to that Agent only and is
   * removed with it; the plugin also keeps the returned disposer so unloading
   * removes it first. `ctx.get()` is used because the Agent context does not
   * inject the host command service for us (and its traceable value keeps the
   * registration scoped to that Agent).
   * @param {object} agent live Agent.
   */
  const attach = (agent) => {
    if (disposed || agent === undefined || agent === null) return
    const id = agent.id
    if (typeof id !== 'string' || attached.has(id)) return
    const agentCtx = agent.ctx
    if (agentCtx === undefined || typeof agentCtx.get !== 'function') return
    const commands = agentCtx.get('commands')
    if (commands === undefined) return
    const entry = { agent, dispose: undefined }
    attached.set(id, entry)
    try {
      const unregister = commands.register({
        name: COMMAND_NAME,
        description: 'Automatically compact a conversation at a chosen context level',
        input: { hint: '[<tokens>|on|off|status|reset]' },
        handler: executeCommand,
      })
      entry.dispose = unregister
    } catch (error) {
      attached.delete(id)
      ctx.logger.warn(`${LOG_PREFIX}: could not attach the command to ${id}: ${errorMessage(error)}`)
    }
  }

  /**
   * Detach one Agent's command registration.
   * @param {string} id Session id.
   */
  const detach = (id) => {
    const entry = attached.get(id)
    if (entry === undefined) return
    attached.delete(id)
    if (entry.dispose !== undefined) {
      try {
        void entry.dispose()
      } catch {
        // An already-disposed Agent context needs no cleanup.
      }
    }
    const timer = queued.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      queued.delete(id)
    }
    const controller = active.get(id)
    if (controller !== undefined) controller.abort()
  }

  const stops = [
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle' && state.enabled && attached.has(agent?.id)) schedule(agent)
    }),
    ctx.on('agent/created', ({ agent }) => {
      attach(agent)
    }),
    ctx.on('agent/disposed', ({ agent }) => {
      detach(agent?.id)
    }),
  ]

  ctx.effect(() => {
    for (const agent of ctx.agents.list()) attach(agent)
    return () => {
      disposed = true
      for (const entry of attached.values()) {
        if (entry.dispose !== undefined) {
          try {
            void entry.dispose()
          } catch {
            // An already-disposed Agent context needs no cleanup.
          }
        }
      }
      attached.clear()
      for (const controller of active.values()) controller.abort()
      active.clear()
      for (const timer of queued.values()) clearTimeout(timer)
      queued.clear()
      for (const stop of stops) stop()
    }
  })
}
