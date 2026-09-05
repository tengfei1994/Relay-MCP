export const EVENT_PROJECT_IDENTITY_MIGRATION = {
  version: "003-event-project-identity",
  sql: "ALTER TABLE relay_domain_events ADD COLUMN project_name_snapshot TEXT;",
};
