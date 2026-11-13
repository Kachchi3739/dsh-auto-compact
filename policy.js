/**
 * Pure policy for the `/auto-compact` command plugin.
 *
 * This module deliberately has no imports: a profile-linked bundle cannot
 * resolve the Harness installation's own packages, so token parsing, bounds,
 * config validation, and status rendering live here as plain JavaScript and are
 * covered by `test/policy.test.mjs`.
 *
 * @module @local/dsh-command-auto-compact/policy
 */

/** Command name without the leading slash. */
export const COMMAND_NAME = 'auto-compact'

/** Trigger level used when neither the row config nor a previous command set one. */
export const DEFAULT_THRESHOLD_TOKENS = 500_000

/** Lowest accepted trigger level. */
export const MIN_THRESHOLD_TOKENS = 100_000

/** Highest accepted trigger level. */
export const MAX_THRESHOLD_TOKENS = 1_000_000

/** Command grammar shown by every failure path and by the status output. */
export const USAGE = 'Usage: /auto-compact [<tokens>|on|off|status|reset]'

const UNIT_MULTIPLIERS = {
  '': 1,
  k: 1_000,
  m: 1_000_000,
}

const CONTROL_WORDS = new Map([
  ['status', 'status'],
  ['show', 'status'],
  ['on', 'enable'],
  ['enable', 'enable'],
  ['off', 'disable'],
  ['disable', 'disable'],
  ['reset', 'reset'],
  ['default', 'reset'],
])

/**
 * Clamp a token count into the supported range.
 * @param {number} tokens candidate threshold.
 * @returns {{ tokens: number, clamped: 'min' | 'max' | undefined }} the
 *   in-range value and which limit it was clamped to, if any.
 */
export function clampThreshold(tokens) {
  if (tokens < MIN_THRESHOLD_TOKENS) return { tokens: MIN_THRESHOLD_TOKENS, clamped: 'min' }
  if (tokens > MAX_THRESHOLD_TOKENS) return { tokens: MAX_THRESHOLD_TOKENS, clamped: 'max' }
  return { tokens, clamped: undefined }
}

/**
 * Validate the plugin row config. Defaults apply when a field is absent.
 *
 * A hand-edited profile config is validated strictly so a bad value fails
 * activation loudly instead of silently changing when compaction happens; the
 * slash command is the forgiving path and clamps out-of-range requests.
 *
 * @param {unknown} rawConfig config the Loader passed to `apply`.
 * @returns {{ enabled: boolean, thresholdTokens: number }} resolved state.
 * @throws {Error} when a present field has the wrong type or is out of range.
 */
export function resolveConfig(rawConfig) {
  const config = rawConfig ?? {}
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('auto-compact: config must be an object')
  }
  let enabled = true
  if (config.enabled !== undefined) {
    if (typeof config.enabled !== 'boolean') {
      throw new Error('auto-compact: config.enabled must be a boolean')
    }
    enabled = config.enabled
  }
  let thresholdTokens = DEFAULT_THRESHOLD_TOKENS
  if (config.thresholdTokens !== undefined) {
    const value = config.thresholdTokens
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new Error('auto-compact: config.thresholdTokens must be an integer token count')
    }
    if (value < MIN_THRESHOLD_TOKENS || value > MAX_THRESHOLD_TOKENS) {
      throw new Error(
        `auto-compact: config.thresholdTokens must be between ${MIN_THRESHOLD_TOKENS} and ${MAX_THRESHOLD_TOKENS} (got ${value})`,
      )
    }
    thresholdTokens = value
  }
  return { enabled, thresholdTokens }
}

/**
 * Parse a user-entered token level: `500000`, `500k`, `1M`, `0.5m`, with
 * optional comma, underscore, or space separators. The result is clamped into
 * the supported range; callers report the clamp through the returned fields.
 *
 * @param {string} text raw argument from the command line.
 * @returns {{ tokens: number, clamped: 'min' | 'max' | undefined } | undefined}
 *   the parsed level, or undefined when the text is not a token level.
 */
export function parseThreshold(text) {
  const compact = text.trim().replace(/[,\s_]/gu, '')
  const match = /^([0-9]+(?:\.[0-9]+)?)([kKmM]?)$/u.exec(compact)
  if (match === null) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return undefined
  const multiplier = UNIT_MULTIPLIERS[match[2].toLowerCase()]
  const tokens = Math.round(value * multiplier)
  if (!Number.isFinite(tokens) || tokens <= 0) return undefined
  return clampThreshold(tokens)
}

/**
 * Parse the entire raw input owned by `/auto-compact`.
 * @param {string} rawInput everything after the command name.
 * @returns {{ kind: 'status' | 'enable' | 'disable' | 'reset' } |
 *   { kind: 'set', tokens: number, clamped: 'min' | 'max' | undefined } |
 *   { kind: 'invalid', text: string }} the parsed command.
 */
export function parseCommand(rawInput) {
  const input = rawInput.trim()
  if (input.length === 0) return { kind: 'status' }
  const control = CONTROL_WORDS.get(input.toLowerCase())
  if (control !== undefined) return { kind: control }
  const threshold = parseThreshold(input)
  if (threshold !== undefined) {
    return { kind: 'set', tokens: threshold.tokens, clamped: threshold.clamped }
  }
  return { kind: 'invalid', text: input }
}

/**
 * Compact token label used by logs and status output: exact multiples of a
 * million or a thousand stay short, everything else keeps its exact digits.
 * @param {number} tokens token count.
 * @returns {string} `500k`, `1M`, or the exact count as typed.
 */
export function formatTokens(tokens) {
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`
  if (tokens % 1_000 === 0) return `${tokens / 1_000}k`
  return String(tokens)
}

/**
 * Group an exact token count for human display.
 * @param {number} tokens token count.
 * @returns {string} comma-grouped count.
 */
export function formatExact(tokens) {
  return tokens.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

/**
 * Render the shared status block.
 * @param {{ enabled: boolean, thresholdTokens: number }} state resolved state.
 * @param {{ measuredTokens?: number, contextWindow?: number }} [snapshot]
 *   live measurements for the invoking session, when available.
 * @returns {string} multi-line human-only status text.
 */
export function renderStatus(state, snapshot = {}) {
  const lines = [
    `Auto-compact: ${state.enabled ? 'on' : 'off'}`,
    `Threshold: ${formatTokens(state.thresholdTokens)} tokens (${formatExact(state.thresholdTokens)})`,
  ]
  if (typeof snapshot.measuredTokens === 'number') {
    const percent = state.thresholdTokens === 0
      ? 0
      : Math.round((snapshot.measuredTokens / state.thresholdTokens) * 100)
    const window = typeof snapshot.contextWindow === 'number'
      ? ` — ${formatExact(snapshot.contextWindow)} token window`
      : ''
    lines.push(`Current context: ${formatExact(snapshot.measuredTokens)} tokens (${percent}% of threshold)${window}`)
  }
  if (typeof snapshot.contextWindow === 'number') {
    if (state.thresholdTokens >= snapshot.contextWindow) {
      lines.push('Note: the threshold is at or above this model\'s context window, so built-in pressure compaction acts first.')
    } else if (snapshot.contextWindow * 0.8 < state.thresholdTokens) {
      lines.push('Note: built-in pressure compaction may trigger near 80% of the window before this threshold.')
    }
  }
  lines.push(
    'When: after a turn closes, if measured context reaches the threshold.',
  )
  if (!state.enabled) {
    lines.push('Automatic compaction is off; use /auto-compact on to re-enable it, or /compact for a one-off compaction.')
  }
  lines.push('', USAGE, `Range: ${formatTokens(MIN_THRESHOLD_TOKENS)} to ${formatTokens(MAX_THRESHOLD_TOKENS)} tokens.`)
  return lines.join('\n')
}

/**
 * Build the persisted state document for the plugin's own state file. The file
 * is plugin-owned data (the preset-mounted row cannot be addressed by the
 * profile config editor), so it carries its own version.
 * @param {{ enabled: boolean, thresholdTokens: number }} state live state.
 * @returns {string} JSON document text.
 */
export function serializeState(state) {
  return `${JSON.stringify({ version: 1, enabled: state.enabled, thresholdTokens: state.thresholdTokens }, null, 2)}\n`
}

/**
 * Validate a state document read from the plugin's own state file.
 *
 * Unlike the row config, a bad state file never fails activation: automatic
 * compaction keeps working with the row defaults and the command reports the
 * ignored file. This keeps a hand-edited or truncated state file from taking
 * the command surface down.
 *
 * @param {unknown} raw parsed JSON value.
 * @param {{ enabled: boolean, thresholdTokens: number }} fallback row defaults.
 * @returns {{ state: { enabled: boolean, thresholdTokens: number }, error?: undefined } |
 *   { state: undefined, error: string }} resolved state or a diagnostic.
 */
export function resolveStateFile(raw, fallback) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { state: undefined, error: 'state file must contain a JSON object' }
  }
  if (raw.version !== undefined && raw.version !== 1) {
    return { state: undefined, error: `unsupported state version ${JSON.stringify(raw.version)}` }
  }
  let enabled = fallback.enabled
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') return { state: undefined, error: 'enabled must be a boolean' }
    enabled = raw.enabled
  }
  let thresholdTokens = fallback.thresholdTokens
  if (raw.thresholdTokens !== undefined) {
    if (typeof raw.thresholdTokens !== 'number' || !Number.isInteger(raw.thresholdTokens)) {
      return { state: undefined, error: 'thresholdTokens must be an integer' }
    }
    if (raw.thresholdTokens < MIN_THRESHOLD_TOKENS || raw.thresholdTokens > MAX_THRESHOLD_TOKENS) {
      return {
        state: undefined,
        error: `thresholdTokens must be between ${MIN_THRESHOLD_TOKENS} and ${MAX_THRESHOLD_TOKENS}`,
      }
    }
    thresholdTokens = raw.thresholdTokens
  }
  return { state: { enabled, thresholdTokens } }
}
