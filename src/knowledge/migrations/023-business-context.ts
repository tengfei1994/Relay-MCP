/** Persist the business explanation alongside technical Candidate/Case fields. */
export const BUSINESS_CONTEXT_MIGRATION = {
  version: "023-business-context",
  sql: `
ALTER TABLE knowledge_candidate_cards ADD COLUMN business_context_json TEXT;
ALTER TABLE knowledge_cases ADD COLUMN business_context_json TEXT;
`,
};
