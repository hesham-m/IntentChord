/**
 * Project membership is authoritative Task-revision state in PostgreSQL.
 * It is never a global browser preference and never grants Workspace authority.
 */
export const taskProjectContextPersistence = "POSTGRESQL_TASK_REVISION_ONLY" as const;
export const globalProjectAutoSelection = "FORBIDDEN" as const;
