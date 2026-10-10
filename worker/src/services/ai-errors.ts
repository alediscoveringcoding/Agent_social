export class AiOutputError extends Error {
  // RESEARCH_EMPTY: the web research step found no source to write from; RESEARCH_NO_STORY:
  // it found sources but no story passed the audit (amendment 07). Neither calls the writer.
  constructor(readonly code: "AI_REFUSED" | "AI_TRUNCATED" | "AI_BAD_OUTPUT" | "RESEARCH_EMPTY" | "RESEARCH_NO_STORY", message: string) {
    super(message);
    this.name = "AiOutputError";
  }
}
