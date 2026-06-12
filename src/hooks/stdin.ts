/** Read all of stdin and parse it as JSON (the hook payload). */
export async function readHookInput<T>(): Promise<T> {
  const text = await new Response(Bun.stdin.stream()).text();
  if (!text.trim()) return {} as T;
  return JSON.parse(text) as T;
}

/** Common fields across Claude Code hook payloads. */
export interface ClaudeHookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
}
