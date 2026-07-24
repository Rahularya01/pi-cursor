/**
 * Strips inline thinking tags out of Cursor's text stream.
 *
 * Some models wrap reasoning in `<think>`/`<thinking>`/... tags inside the
 * ordinary text channel. Pi has a separate thinking channel, so the tags have to
 * come out of the visible text without waiting for the full response — the
 * filter is incremental and holds back only a partial tag's worth of characters
 * at a chunk boundary.
 */

const THINKING_TAG_NAMES = ["think", "thinking", "reasoning", "thought", "think_intent"];

const MAX_THINKING_TAG_LEN = 16;

// Hoisted to module scope so it is compiled once rather than rebuilt on every
// streamed chunk. `lastIndex` is reset at the start of each process() call.
const THINKING_TAG_RE = new RegExp(`<(/?)(?:${THINKING_TAG_NAMES.join("|")})\\s*>`, "gi");

export function createThinkingTagFilter() {
  let buffer = "";
  let inThinking = false;
  return {
    process(text: string) {
      const input = buffer + text;
      buffer = "";
      let content = "";
      let reasoning = "";
      let lastIdx = 0;
      const re = THINKING_TAG_RE;
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(input)) !== null) {
        const before = input.slice(lastIdx, match.index);
        if (inThinking) reasoning += before;
        else content += before;
        inThinking = match[1] !== "/";
        lastIdx = re.lastIndex;
      }
      const rest = input.slice(lastIdx);
      const ltPos = rest.lastIndexOf("<");
      if (
        ltPos >= 0 &&
        rest.length - ltPos < MAX_THINKING_TAG_LEN &&
        /^<\/?[a-z_]*$/i.test(rest.slice(ltPos))
      ) {
        buffer = rest.slice(ltPos);
        const before = rest.slice(0, ltPos);
        if (inThinking) reasoning += before;
        else content += before;
      } else {
        if (inThinking) reasoning += rest;
        else content += rest;
      }
      return { content, reasoning };
    },
    flush() {
      const b = buffer;
      buffer = "";
      if (!b) return { content: "", reasoning: "" };
      return inThinking ? { content: "", reasoning: b } : { content: b, reasoning: "" };
    },
  };
}
