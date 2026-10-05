// Builds the one allowed repair prompt when a draft batch fails validation (PRD F2).
export function buildRepairPrompt(drafts: any[]): string {
  const errorsSection = drafts
    .filter((d: any) => d.validation_errors.length > 0)
    .map((d: any) => {
      const errs = d.validation_errors
        .filter((e: any) => e.rule !== "contains_figures")
        .map((e: any) => `- ${e.rule}: ${e.message}`)
        .join("\n");
      return `Draft "${d.client_ref}":\n${errs}`;
    })
    .join("\n\n");

  return `The following drafts have validation errors. Fix them and return the corrected drafts in the same JSON format.\n\nErrors:\n${errorsSection}\n\nOriginal drafts:\n${JSON.stringify(drafts, null, 2)}`;
}
