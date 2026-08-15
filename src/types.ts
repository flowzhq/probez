/** One tool invocation made by the agent during a round. */
export interface ToolCall {
  /** Tool name as the agent called it, e.g. "Read", "Bash". */
  name: string | null
  /** Arguments the agent passed. Long strings are truncated; see truncateInput. */
  input: unknown
  /** Size of the result, in characters. The body itself is not recorded. */
  result_chars: number | null
  /** Whether the tool reported a failure. Null if no result was ever seen. */
  is_error: boolean | null
  /** Wall time from the call being emitted to its result arriving. */
  ms: number | null
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
  model: string | null
  in_tokens: number
  out_tokens: number
  /** User text that prompted this round. Empty when the round was driven by tool results. */
  user_text: string
  /** Assistant prose from this round, with tool calls and reasoning excluded. */
  text: string
  /** Size of the reasoning content. The reasoning itself is not recorded. */
  thinking_chars: number
  tools: ToolCall[]
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
