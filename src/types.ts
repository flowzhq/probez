/** Lines a file-editing tool changed, folded from the result's structured patch. */
export interface Patch {
  /** Distinct files the patch touched. */
  files: number
  added: number
  removed: number
}

/** One tool invocation made by the agent during a round. */
export interface ToolCall {
  /** Tool name as the agent called it, e.g. "Read", "Bash". */
  name: string | null
  /** The call's id, which is also how its result is matched back to it. */
  id: string | null
  /** Arguments the agent passed. Long strings are truncated; see truncateInput. */
  input: unknown
  /** Size of `input` before truncation, so the true size survives the cut. */
  input_chars: number
  /** Size of the result, in characters. The body itself is not recorded. */
  result_chars: number | null
  /**
   * Whether the harness reported a failure. This is not the same as the command failing: a Bash
   * call whose suite failed 47 tests still comes back false. See `stderr_chars` and `interrupted`.
   */
  is_error: boolean | null
  /** Size of anything the tool wrote to stderr. Null when the tool has no stderr to report. */
  stderr_chars: number | null
  /** Whether the call was cut short rather than running to completion. */
  interrupted: boolean | null
  /** What the call changed, for tools that edit files. Null for everything else. */
  patch: Patch | null
  /** When the call was emitted. */
  emitted_at: string | null
  /** When its result arrived. Null if no result was ever seen. */
  result_at: string | null
  /** Wall time from the call being emitted to its result arriving. */
  ms: number | null
}

/** A moment within a round, in the order the session file recorded it. */
export interface RoundEvent {
  /**
   * `user_message` and `tool_result` are the input that prompted the round, and precede it in the
   * file; the rest are the round's own output.
   */
  type: 'user_message' | 'tool_result' | 'reasoning' | 'text' | 'tool_call'
  ts: string
  /** Size of the event's content. Absent on `tool_call`, whose size is on the ToolCall itself. */
  chars?: number
  /** Present on `tool_call` and `tool_result`, which is how the two are paired across rounds. */
  tool_call_id?: string
}

/** One LLM round: a single assistant message and the input that prompted it. */
export interface Round {
  /** Session id, i.e. the source session file's name. */
  session: string
  /** 0-based position of this round within its session. */
  round: number
  /** 1-based task number; a new user turn starts a new task. */
  task: number
  /** "sub" for subagent work, "main" otherwise. */
  agent: 'main' | 'sub'
  /** Provider message id, unique within the session. */
  id: string
  /** ISO timestamp of the first record belonging to this round. */
  ts: string | null
  /** Wall time spanned by this round's records. */
  ms: number | null
  /**
   * Time from the input that prompted this round to its last output. Unlike `ms`, this covers the
   * wait before the model said anything, which is most of what a round actually costs in wall time.
   */
  gen_ms: number | null
  /** Time spent waiting on the person. Null unless a user message opened the round. */
  wait_ms: number | null
  /** What prompted the round: a person, or the previous round's tool results. */
  first_input: 'user_message' | 'tool_result' | null
  model: string | null
  /** Total input, which is the three fields below summed. */
  in_tokens: number
  /** Input the model had not seen before, charged at full rate. */
  in_uncached: number
  /** Input written into the prompt cache. */
  in_cache_write: number
  /** Input served from the prompt cache, charged at a fraction of the rate. */
  in_cache_read: number
  out_tokens: number
  /** The MCP server this round's work was attributed to, when the harness named one. */
  mcp_server: string | null
  mcp_tool: string | null
  /** The skill this round's work was attributed to, when the harness named one. */
  skill: string | null
  /** User text that prompted this round. Empty when the round was driven by tool results. */
  user_text: string
  /** Assistant prose from this round, with tool calls and reasoning excluded. */
  text: string
  /** Size of the reasoning content. The reasoning itself is not recorded. */
  thinking_chars: number
  tools: ToolCall[]
  /** The round's moments in file order, which is what makes `gen_ms` and `wait_ms` re-derivable. */
  events: RoundEvent[]
}

/** A session file belonging to a project. */
export interface SessionFile {
  id: string
  file: string
  size: number
  mtimeMs: number
}

/** A project the agent has been run in. */
export interface Project {
  /** The agent's own directory name for this project. Opaque: do not decode it. */
  key: string
  /** Absolute directory the agent ran in, read from the session records. */
  path: string | null
  /** Directory holding the session files. */
  dir: string
  sessions: SessionFile[]
  /** Newest session mtime, in ms. */
  lastActivity: number
}
