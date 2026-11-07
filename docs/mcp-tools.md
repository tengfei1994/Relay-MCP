# MCP 工具分类

[← 返回 README](../README.md)

Relay MCP 通过 `/mcp` endpoint 暴露一组工具。本页只讲分类和选用思路；工具的准确名称、参数 schema 和注解，以运行时 `tools/list` 与 `src/shared/tool-catalog.ts` 为准。

## 分类总览

| 分类 | 解决什么问题 | 典型工具 |
|---|---|---|
| Project | 弄清能访问哪些 Project / Server / environment，以及当前路由和版本 | `list_projects`、`project_server_links_list`、`relay_route_check`、`project_create` |
| Remote execution | 在目标服务器上执行命令与脚本，部署、查日志、重启服务 | `relay_exec_remote`、`relay_exec_remote_powershell`、`relay_exec_remote_script`、`deploy`、`fetch_logs`、`restart_service` |
| Remote files | 读写目标服务器上的文件 | `list_remote_files`、`read_remote_file`、`write_remote_file`、`patch_remote_file`、`download_remote_file` |
| Workspace | 管理 Relay 侧 Project 工作区，并在工作区与目标服务器之间传文件 | `list_workspace_files`、`read_local_file`、`write_local_file`、`create_workspace_upload`、`upload_workspace_file`、`sync_workspace` |
| Jobs | 跟踪长时间运行的异步任务 | `job_status`、`job_wait`、`job_list`、`job_cancel` |
| Playwright | 通过 Agent 在 Windows 上运行正式 Playwright 测试 | `playwright_suite_upload`、`playwright_run_suite`、`playwright_run_status`、`playwright_artifact_download` |
| Knowledge | 检索已发布产品资料和已确认 Memory，提交待审经验 | `knowledge_search`、`knowledge_get`、`memory_search`、`knowledge_confirmed_memory_get`、`memory_capture` |
| SampleManager | SampleManager LIMS 的诊断、SQL、构建、部署与回滚 | `samplemanager_diagnose`、`samplemanager_sql_query`、`samplemanager_build_deploy_assembly`、`samplemanager_restore_backup` |

## 各分类说明

### Project

先弄清能访问什么。`list_projects` 列出当前 MCP Token 可访问的 Project；`project_server_links_list` 返回准确的 environment key、Server ID/名称、远程路径和 LIMS 实例绑定，调用其他工具前先用它，不要猜 UI 显示名。`relay_route_check` 只读确认请求进入 Relay 并解析可选目标；`relay_mcp_info` 与 `relay_core_tools` 返回路由、版本和首选工具；`project_create` 创建 Project workspace。

### Remote execution

在目标服务器上执行 shell、encoded PowerShell 或上传脚本，首选 `relay_exec_remote`、`relay_exec_remote_powershell`、`relay_exec_remote_script`。`deploy` 部署远端 Git checkout 并记录 commit、输出与回滚状态；`fetch_logs` 按时间窗口或 deployment run 读日志；`restart_service` 支持 Windows Service、systemd、PM2 和 Docker。`relay_unicode_check` 只读检查中文在 SQL Server、PowerShell、Agent 到 MCP 之间的往返编码。耗时命令设置 `async: true`，配合 Jobs 使用。

### Remote files

读、写、列目录和应用 unified diff 补丁。`download_remote_file` 把远端二进制流式下载到本地，SSH 模式走 SFTP staging，Agent 模式走 `artifact-upload` job，并校验字节数与 SHA-256。

### Workspace

Workspace 指 Relay 侧的 Project 工作区，不是 AI 助手本机路径；先用 `workspace_info` 确认根目录。工具覆盖读写、移动、删除、元数据与 SHA-256。大文件用 `create_workspace_upload` 创建短期上传 session；`upload_workspace_file` 经临时路径上传到远端并校验 SHA-256，相同文件跳过、原子替换目标；`sync_workspace` 通过 SFTP 同步目录；`cleanup_workspace_staging` 清理旧的 `.relay-staging` 内容。

### Jobs

异步命令返回 `jobId` 后，用 `job_status` 查状态、结果和近期日志，`job_wait` 有界等待终态（到期返回最新快照，不会制造新的执行超时），`job_list` 列出近期 job，`job_cancel` 请求取消运行中的 SSH job。同步调用超时时先查 job，避免重复执行有副作用的操作。

### Playwright

通过专用 Agent 协议运行正式测试，典型顺序：`playwright_runtime_status` 确认 Node.js、Playwright、Chromium 就绪 → `playwright_suite_upload` 上传测试与 suite 元数据 → `playwright_run_suite` 排队运行 → `playwright_run_status` 读运行记录 → `playwright_artifact_list` / `playwright_artifact_download` 取回 artifact。

### Knowledge

- `knowledge_search` / `knowledge_get` 检索和读取获授权的产品与解决方案文档和 Chunk，不依赖 Project。
- `memory_search` / `knowledge_confirmed_memory_get` 检索和读取管理员确认的项目或通用 Memory。
- `memory_capture` 接收本地 Agent 筛选整理的候选或查询审核状态。它不会自动发布；只有管理员确认后才进入正式搜索。

产品知识和通用 Memory 由用户级开关控制，项目 Memory 由用户和令牌的 Project 范围控制。Wiki、历史 Candidate、Work Session、Evidence、导入和运维继续通过网页及受控后台处理，不再暴露旧 Knowledge MCP 工具或 Resource。旧 `context_*` 工具已移除。完整权限矩阵、提交参数和迁移步骤见 [knowledge-access.md](knowledge-access.md)。

### SampleManager

所有工具都作用于绑定到 Project link 的 LIMS Instance，分为几组：

- **能力与就绪**：`samplemanager_capabilities`、`samplemanager_instance_preflight`、`samplemanager_recent_errors`。
- **只读诊断与校验**：`samplemanager_diagnose`、`samplemanager_impact_analysis`、`samplemanager_vgl_inspect_entrypoint`、`samplemanager_validate_form_task_contract`、`samplemanager_entity_inspect`、`samplemanager_lab_method_lint`、`samplemanager_plate_plan_validate`、`samplemanager_enh_inspect`、`samplemanager_enh_validate_configuration`、`samplemanager_workflow_export` / `_validate` / `_compare`、`samplemanager_inspect_assembly_type`、`samplemanager_inspect_deployment_runtime`。
- **数据库**：只读 `samplemanager_table_schema`、`samplemanager_entity_schema`、`samplemanager_sql_query`、`samplemanager_read_query_artifact`；变更类 `samplemanager_sql_execute_file`、`samplemanager_sql_mutation`、`samplemanager_apply_change_set`、`samplemanager_table_loader`、`samplemanager_convert_tables`、`samplemanager_create_entity_definition`。
- **构建与部署**：`samplemanager_discover_build_tools`、`samplemanager_build_dotnet`、`samplemanager_build_deploy_assembly`、`samplemanager_create_deployment_manifest`、`samplemanager_deployment_start` / `_status` / `_finish`、`samplemanager_deploy_file`、`samplemanager_deploy_table_loader_package`、`samplemanager_restart_instance`、`samplemanager_clear_form_cache`、`samplemanager_restore_backup`。
- **命令与工具**：`samplemanager_run_command`、`samplemanager_run_utility`（仅限 allowlist）。

SQL 默认只读；mutation 必须显式调用，并支持 dry run、备份和 before/after 证据。一个 `deploymentId` 可以把构建、哈希、备份、SQL、日志、重启和回滚状态串成一次部署记录。

## 推荐使用路径

1. **看清目标**：`list_projects` → `project_server_links_list`，拿到准确的 environment 与 Server。
2. **只读核对**：`fetch_logs`、`relay_exec_remote*` 的只读命令，或 `samplemanager_*` 的只读检查类工具。
3. **变更**：先 dry run 或预检（`samplemanager_instance_preflight`、`preflightOnly`），再显式调用变更类工具；多阶段操作用 `deploymentId` 关联。
4. **长任务**：设置 `async: true`，用 `job_wait` / `job_status` 跟踪，不要重复提交。
5. **沉淀**：本地 Agent 判断经验是否值得复用，使用 `memory_capture` 提交整理后的候选；管理员确认后才能被 `memory_search` 检索。

## 命名约定与扩展

- `relay_` 前缀是首选命名空间；`exec_remote`、`exec_remote_powershell`、`exec_remote_script` 是兼容旧调用的 legacy 别名。`relay_core_tools` 返回稳定的首选工具和别名。
- 新增工具必须放入 `src/mcp/tools/` 下相应的域 registrar，并在 `src/shared/tool-catalog.ts` 登记分类与描述。
- 工具名称、参数、注解和别名由 `tests/fixtures/mcp-tools-baseline.json` 冻结；有意变更并评审后，用 `npm run generate:mcp-baseline` 重新生成。
