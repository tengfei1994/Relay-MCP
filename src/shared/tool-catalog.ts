export const TOOL_CATEGORIES = [
  "project",
  "remote-execution",
  "remote-files",
  "workspace",
  "jobs",
  "context",
  "samplemanager",
] as const;

export type ToolCategory = typeof TOOL_CATEGORIES[number];

export interface ToolCatalogEntry {
  name: string;
  category: ToolCategory;
  description: string;
}

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  { name: "list_projects", category: "project", description: "List projects allowed by the current MCP token." },
  { name: "project_create", category: "project", description: "Create a project workspace and optionally link a remote server." },
  { name: "exec_remote", category: "remote-execution", description: "Execute a shell command with timeout and optional async tracking." },
  { name: "exec_remote_powershell", category: "remote-execution", description: "Execute inline encoded PowerShell with timeout and optional async tracking." },
  { name: "exec_remote_script", category: "remote-execution", description: "Upload, execute, and optionally clean up a remote PowerShell script." },
  { name: "deploy", category: "remote-execution", description: "Update a remote Git checkout and restart PM2 or Docker workloads." },
  { name: "fetch_logs", category: "remote-execution", description: "Fetch recent Windows, file, systemd, PM2, or Docker logs." },
  { name: "restart_service", category: "remote-execution", description: "Restart Windows services, systemd units, PM2 processes, or Docker containers." },
  { name: "read_remote_file", category: "remote-files", description: "Read a text file from a linked remote server." },
  { name: "write_remote_file", category: "remote-files", description: "Write UTF-8 text to a linked remote server through SFTP." },
  { name: "list_remote_files", category: "remote-files", description: "List files and directories on a linked remote server." },
  { name: "patch_remote_file", category: "remote-files", description: "Apply a unified diff to a remote text file." },
  { name: "read_local_file", category: "workspace", description: "Read UTF-8 text from the Relay project workspace." },
  { name: "write_local_file", category: "workspace", description: "Write or append UTF-8 text in the Relay project workspace." },
  { name: "write_local_binary", category: "workspace", description: "Write a small Base64-encoded binary into the Relay workspace." },
  { name: "list_workspace_files", category: "workspace", description: "List workspace entries with optional bounded recursion." },
  { name: "workspace_file_stat", category: "workspace", description: "Inspect workspace file metadata and optionally calculate SHA-256." },
  { name: "move_workspace_file", category: "workspace", description: "Move or rename a workspace file or directory." },
  { name: "delete_workspace_file", category: "workspace", description: "Delete a workspace file or explicitly approved directory tree." },
  { name: "create_workspace_upload", category: "workspace", description: "Create a short-lived streaming upload session for a large local binary." },
  { name: "cleanup_workspace_staging", category: "workspace", description: "Preview or remove old .relay-staging entries." },
  { name: "sync_workspace", category: "workspace", description: "Synchronize the project workspace to a linked remote directory through SFTP." },
  { name: "upload_workspace_file", category: "workspace", description: "Upload one Relay workspace file to a linked remote server." },
  { name: "job_status", category: "jobs", description: "Read status, result, error, and recent logs for an async job." },
  { name: "job_list", category: "jobs", description: "List recent async jobs owned by the current user." },
  { name: "job_cancel", category: "jobs", description: "Request cancellation and close the active SSH command for a running job." },
  { name: "context_record_fact", category: "context", description: "Record a durable project fact for future MCP sessions." },
  { name: "context_search", category: "context", description: "Search durable project facts." },
  { name: "samplemanager_restart_instance", category: "samplemanager", description: "Restart core services for a SampleManager instance." },
  { name: "samplemanager_clear_form_cache", category: "samplemanager", description: "Remove compiled FormsBin entries for one form." },
  { name: "samplemanager_recent_errors", category: "samplemanager", description: "Search recent SampleManager logs for compact error evidence." },
  { name: "samplemanager_sql_query", category: "samplemanager", description: "Run SQL Server queries with mutation blocking by default." },
  { name: "samplemanager_sql_execute_file", category: "samplemanager", description: "Run a workspace SQL file with mutation blocking by default." },
  { name: "samplemanager_run_command", category: "samplemanager", description: "Run SampleManagerCommand.exe with structured arguments." },
  { name: "samplemanager_create_entity_definition", category: "samplemanager", description: "Run CreateEntityDefinition.exe after structure source changes." },
  { name: "samplemanager_convert_tables", category: "samplemanager", description: "Run convert_table.exe separately for validated table names." },
  { name: "samplemanager_table_loader", category: "samplemanager", description: "Load a remote CSV through the built-in $table_loader VGL report." },
  { name: "samplemanager_run_utility", category: "samplemanager", description: "Run an allowlisted version-dependent SampleManager utility." },
  { name: "samplemanager_build_dotnet", category: "samplemanager", description: "Build a classic SampleManager .NET solution with MSBuild." },
  { name: "samplemanager_deploy_file", category: "samplemanager", description: "Deploy a staged file into an instance area with timestamped backup." },
  { name: "samplemanager_restore_backup", category: "samplemanager", description: "Restore a specific SampleManager backup file to an explicit target." },
];

export const TOOL_CATALOG_BY_NAME = new Map(TOOL_CATALOG.map((entry) => [entry.name, entry]));
