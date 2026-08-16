import type { Round, ToolCall } from '../src/types.js'

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
