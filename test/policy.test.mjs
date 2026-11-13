import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COMMAND_NAME,
  DEFAULT_THRESHOLD_TOKENS,
  MAX_THRESHOLD_TOKENS,
  MIN_THRESHOLD_TOKENS,
  USAGE,
  clampThreshold,
  formatExact,
  formatTokens,
  parseCommand,
  parseThreshold,
  renderStatus,
  resolveConfig,
  resolveStateFile,
  serializeState,
} from '../policy.js'

test('bounds match the requested 100k-1M range with a 500k default', () => {
  assert.equal(DEFAULT_THRESHOLD_TOKENS, 500_000)
  assert.equal(MIN_THRESHOLD_TOKENS, 100_000)
  assert.equal(MAX_THRESHOLD_TOKENS, 1_000_000)
  assert.equal(COMMAND_NAME, 'auto-compact')
})

test('clampThreshold reports which bound it used', () => {
  assert.deepEqual(clampThreshold(500_000), { tokens: 500_000, clamped: undefined })
  assert.deepEqual(clampThreshold(1), { tokens: 100_000, clamped: 'min' })
  assert.deepEqual(clampThreshold(5_000_000), { tokens: 1_000_000, clamped: 'max' })
  assert.deepEqual(clampThreshold(100_000), { tokens: 100_000, clamped: undefined })
  assert.deepEqual(clampThreshold(1_000_000), { tokens: 1_000_000, clamped: undefined })
})

test('parseThreshold accepts plain counts and k/m suffixes', () => {
  assert.deepEqual(parseThreshold('500000'), { tokens: 500_000, clamped: undefined })
  assert.deepEqual(parseThreshold('500k'), { tokens: 500_000, clamped: undefined })
  assert.deepEqual(parseThreshold('500K'), { tokens: 500_000, clamped: undefined })
  assert.deepEqual(parseThreshold('300,000'), { tokens: 300_000, clamped: undefined })
  assert.deepEqual(parseThreshold(' 250_000 '), { tokens: 250_000, clamped: undefined })
  assert.deepEqual(parseThreshold('1M'), { tokens: 1_000_000, clamped: undefined })
  assert.deepEqual(parseThreshold('0.5m'), { tokens: 500_000, clamped: undefined })
  assert.deepEqual(parseThreshold('0.1m'), { tokens: 100_000, clamped: undefined })
})

test('parseThreshold clamps out-of-range requests', () => {
  assert.deepEqual(parseThreshold('50k'), { tokens: 100_000, clamped: 'min' })
  assert.deepEqual(parseThreshold('2m'), { tokens: 1_000_000, clamped: 'max' })
})

test('parseThreshold rejects non-levels', () => {
  for (const input of ['', 'abc', 'on', '-5', '0', '1.2.3k', '1g', 'k', 'NaN', 'Infinity']) {
    assert.equal(parseThreshold(input), undefined, input)
  }
})

test('parseCommand owns the full grammar', () => {
  assert.deepEqual(parseCommand(''), { kind: 'status' })
  assert.deepEqual(parseCommand('status'), { kind: 'status' })
  assert.deepEqual(parseCommand(' show '), { kind: 'status' })
  assert.deepEqual(parseCommand('on'), { kind: 'enable' })
  assert.deepEqual(parseCommand('ENABLE'), { kind: 'enable' })
  assert.deepEqual(parseCommand('off'), { kind: 'disable' })
  assert.deepEqual(parseCommand('disable'), { kind: 'disable' })
  assert.deepEqual(parseCommand('reset'), { kind: 'reset' })
  assert.deepEqual(parseCommand('default'), { kind: 'reset' })
  assert.deepEqual(parseCommand('300k'), { kind: 'set', tokens: 300_000, clamped: undefined })
  assert.deepEqual(parseCommand('10k'), { kind: 'set', tokens: 100_000, clamped: 'min' })
  assert.equal(parseCommand('what?').kind, 'invalid')
})

test('resolveConfig applies defaults and validates present fields', () => {
  assert.deepEqual(resolveConfig(undefined), { enabled: true, thresholdTokens: 500_000 })
  assert.deepEqual(resolveConfig({}), { enabled: true, thresholdTokens: 500_000 })
  assert.deepEqual(resolveConfig({ enabled: false }), { enabled: false, thresholdTokens: 500_000 })
  assert.deepEqual(resolveConfig({ thresholdTokens: 250_000 }), { enabled: true, thresholdTokens: 250_000 })
  assert.deepEqual(resolveConfig({ enabled: false, thresholdTokens: 1_000_000 }), {
    enabled: false,
    thresholdTokens: 1_000_000,
  })
  assert.throws(() => resolveConfig({ enabled: 'yes' }), /config\.enabled must be a boolean/u)
  assert.throws(() => resolveConfig({ thresholdTokens: '500k' }), /must be an integer/u)
  assert.throws(() => resolveConfig({ thresholdTokens: 1.5 }), /must be an integer/u)
  assert.throws(() => resolveConfig({ thresholdTokens: 50_000 }), /between 100000 and 1000000/u)
  assert.throws(() => resolveConfig({ thresholdTokens: 2_000_000 }), /between 100000 and 1000000/u)
  assert.throws(() => resolveConfig([]), /must be an object/u)
})

test('formatTokens and formatExact render human levels', () => {
  assert.equal(formatTokens(500_000), '500k')
  assert.equal(formatTokens(1_000_000), '1M')
  assert.equal(formatTokens(300_000), '300k')
  assert.equal(formatTokens(123_456), '123456')
  assert.equal(formatTokens(100_000), '100k')
  assert.equal(formatExact(500_000), '500,000')
  assert.equal(formatExact(1_000_000), '1,000,000')
})

test('renderStatus shows state, live measurement, and usage', () => {
  const text = renderStatus({ enabled: true, thresholdTokens: 500_000 }, {
    measuredTokens: 250_000,
    contextWindow: 1_000_000,
  })
  assert.match(text, /Auto-compact: on/u)
  assert.match(text, /Threshold: 500k tokens \(500,000\)/u)
  assert.match(text, /Current context: 250,000 tokens \(50% of threshold\) — 1,000,000 token window/u)
  assert.match(text, /after a turn closes/u)
  assert.ok(text.includes(USAGE))
  assert.match(text, /Range: 100k to 1M tokens\./u)
})

test('renderStatus warns when the threshold cannot win the race', () => {
  const above = renderStatus({ enabled: true, thresholdTokens: 1_000_000 }, { contextWindow: 1_000_000 })
  assert.match(above, /at or above this model's context window/u)
  const near = renderStatus({ enabled: true, thresholdTokens: 900_000 }, { contextWindow: 1_000_000 })
  assert.match(near, /built-in pressure compaction may trigger near 80%/u)
  const fine = renderStatus({ enabled: false, thresholdTokens: 500_000 }, { contextWindow: 1_000_000 })
  assert.match(fine, /Automatic compaction is off/u)
})

test('renderStatus omits live numbers when measurement is unavailable', () => {
  const text = renderStatus({ enabled: true, thresholdTokens: 500_000 })
  assert.doesNotMatch(text, /Current context:/u)
  assert.match(text, /Auto-compact: on/u)
})

test('serializeState writes a versioned document round-tripping through resolveStateFile', () => {
  const state = { enabled: false, thresholdTokens: 300_000 }
  const text = serializeState(state)
  const parsed = JSON.parse(text)
  assert.equal(parsed.version, 1)
  assert.deepEqual(resolveStateFile(parsed, { enabled: true, thresholdTokens: 500_000 }), { state })
})

test('resolveStateFile falls back field-by-field and rejects bad documents', () => {
  const fallback = { enabled: true, thresholdTokens: 500_000 }
  assert.deepEqual(resolveStateFile({}, fallback), { state: fallback })
  assert.deepEqual(resolveStateFile({ enabled: false }, fallback), {
    state: { enabled: false, thresholdTokens: 500_000 },
  })
  assert.deepEqual(resolveStateFile({ thresholdTokens: 250_000 }, fallback), {
    state: { enabled: true, thresholdTokens: 250_000 },
  })
  assert.match(resolveStateFile(null, fallback).error, /JSON object/u)
  assert.match(resolveStateFile([], fallback).error, /JSON object/u)
  assert.match(resolveStateFile({ version: 2 }, fallback).error, /unsupported state version/u)
  assert.match(resolveStateFile({ enabled: 'on' }, fallback).error, /enabled must be a boolean/u)
  assert.match(resolveStateFile({ thresholdTokens: '300k' }, fallback).error, /must be an integer/u)
  assert.match(resolveStateFile({ thresholdTokens: 50_000 }, fallback).error, /between 100000 and 1000000/u)
  assert.match(resolveStateFile({ thresholdTokens: 2_000_000 }, fallback).error, /between 100000 and 1000000/u)
  assert.equal(resolveStateFile({ version: 1 }, fallback).state.thresholdTokens, 500_000)
})
