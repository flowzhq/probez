import { defaultPricing } from '../src/pricing.js'
import type { Pricing } from '../src/pricing.js'
import type { Round, ToolCall } from '../src/types.js'

/**
 * Rates for the tests.
 *
 * The published table, plus a round number for the model the fixtures use, so an assertion about a
 * cost is arithmetic a reader can check rather than a figure that moved when a price did.
 */
export const PRICING: Pricing = {
  ...defaultPricing(),
  models: {
    ...defaultPricing().models,
    'claude-opus-5': { in: 10, cache_write_5m: 20, cache_write_1h: 40, cache_read: 1, out: 100 },
  },
}

/**
 * Every field of the stored schema at its empty value.
 *
 * The test factories spread these and then name only what the case under test cares about, so
 * adding a field to `types.ts` does not mean editing an unrelated fixture in every test file.
 */
export const TOOL_DEFAULTS: ToolCall = {
  name: null,
  id: null,
  input: {},
  input_chars: 0,
  result_chars: null,
  is_error: null,
  stderr_chars: null,
  interrupted: null,
  patch: null,
  emitted_at: null,
  result_at: null,
  ms: null,
}

export const ROUND_DEFAULTS: Round = {
  session: '',
  round: 0,
  task: 1,
  commit: null,
  agent: 'main',
  id: '',
  ts: null,
  ms: null,
  gen_ms: null,
  wait_ms: null,
  first_input: null,
  model: null,
  in_tokens: 0,
  in_uncached: 0,
  in_cache_write: 0,
  in_cache_write_5m: 0,
  in_cache_write_1h: 0,
  in_cache_read: 0,
  out_tokens: 0,
  mcp_server: null,
  mcp_tool: null,
  skill: null,
  user_text: '',
  text: '',
  thinking_chars: 0,
  tools: [],
  events: [],
}
