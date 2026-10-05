export class AiOutputError extends Error {
  constructor(readonly code: "AI_REFUSED" | "AI_TRUNCATED" | "AI_BAD_OUTPUT", message: string) {
    super(message);
    this.name = "AiOutputError";
  }
}
