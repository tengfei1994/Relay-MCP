# Relay MCP

> Self-hosted remote operations relay for MCP clients, SSH servers, Windows Agents, and Thermo Scientific SampleManager LIMS.

[![Release](https://img.shields.io/badge/release-v0.6.3-2563eb)](https://github.com/tengfei1994/Relay-MCP/releases/tag/v0.6.3)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-64748b)](#license)

Relay MCP 让 Codex、Claude 等 MCP 客户端通过一台自托管 Relay，按受控的项目、服务器和环境范围执行远程运维与 SampleManager 开发任务。目标服务器既可以使用 SSH，也可以运行仅需出站 HTTP 的 Relay Agent。

## v0.6.3

- Agent 通过 `artifact-upload` job 将远程文件流式上传到 Relay，不再把大型二进制塞进 Base64/JSON。
- 下载接口支持 HTTP Range，本地下载器使用 `.part` 文件断点续传。
- 文件传输返回并校验字节数和 SHA-256。
- `/api/health` 返回版本、Git commit 和构建时间，便于确认实际运行版本。
- 提供单文件 WPF Windows Agent Client，包含服务控制、数据库权限、请求审计、日志和更新管理。

Release 与 Windows Agent 下载：
[v0.6.3](https://github.com/tengfei1994/Relay-MCP/releases/tag/v0.6.3)

## 架构

```text
Codex / Claude / Cursor / custom MCP client
                    |
                    | HTTP MCP + MCP Token
                    v
        +-----------------------------+
        | Relay MCP                   |
        | Web API / UI          :3000 |
        | MCP endpoint          :3001 |
        | SQLite + workspace          |
        +-----------------------------+
              |                 ^
         SSH / SFTP             | outbound HTTP polling
              v                 |
       SSH target         Relay Agent on Windows
```

Relay 管理层中的对象彼此独立：

- **Server**：一台物理机或虚拟机，连接方式为 SSH 或 Agent。
- **Project**：Relay 工作区和权限边界，可关联多个 Server。
- **Project Server Link**：Project、Server、environment、remote path 和 LIMS instance 的映射。
- **LIMS Instance**：某台 Server 上独立的 SampleManager 实例，保存版本、路径、数据库、服务和构建配置。
- **MCP Token**：授权 Codex 等 MCP 客户端访问哪些 Project 和 Server。
- **Agent Token**：仅用于一个 Relay Agent 注册、轮询 job 和回传结果，不授予 MCP 客户端权限。

## 核心能力

- 项目、服务器、environment 和 token 范围选择。
- SSH/SFTP 远程执行，或无入站网络权限场景下的 Windows Agent。
- Encoded PowerShell、脚本上传执行、结构化 JSON 输出和异步 job。
- Relay workspace 与远端文件的读取、写入、同步、补丁和流式传输。
- 部署、日志检索、服务重启、执行审计和持久化项目事实。
- SampleManager 多实例扫描、数据库识别、构建工具发现、SQL、utility、程序集部署和回滚。
- 大文件上传、断点下载、大小与 SHA-256 完整性验证。

## 快速部署

要求：Linux Relay 主机、Node.js 20+、npm 和 PM2。

```bash
git clone https://github.com/tengfei1994/Relay-MCP.git ~/Relay-MCP
cd ~/Relay-MCP
npm install
npm --prefix frontend install
cp .env.example .env
npm run build
mkdir -p logs
pm2 start ecosystem.config.cjs
pm2 save
```

至少修改 `.env` 中的 `JWT_SECRET` 和 `RELAY_PUBLIC_URL`。默认 Web 端口是 `3000`，MCP 端口是 `3001`。

健康检查：

```bash
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3001/mcp/health
```

更新已有部署：

```bash
cd ~/Relay-MCP
git pull --ff-only
npm install
npm --prefix frontend install
npm run build
pm2 restart remote-ops-web remote-ops-mcp --update-env
pm2 save
```

## 初始配置

打开 `http://<relay-host>:3000`。第一个注册用户自动成为管理员，然后按以下顺序配置：

1. **Servers**：创建 SSH Server，或创建带 `agentId` 的 Agent Server。
2. **Projects**：独立创建 Project，并按 environment 关联一个或多个 Server。
3. **LIMS Instances**：对 Agent Server 执行只读扫描，审核候选结果后再导入并绑定到 Project link。
4. **MCP Tokens**：为 Codex 等客户端创建 token，配置 Project 范围、Allowed Servers 和可选默认目标。
5. **Agent Tokens**：为每个 Agent 创建独立 token；token 只显示一次。

一个 Project 可以同时关联多台 Server，例如：

| Environment | Server | 用途 |
|---|---|---|
| `analysis` | `A-SERVER` | 只读分析、日志和配置核对 |
| `development` | `B-SERVER` | 编译、部署和测试 |
| `production` | `PROD-SERVER` | 受控生产操作 |

调用工具前可用 `project_server_links_list` 获取准确的 environment key、server ID/name、remote path 和 LIMS instance 绑定，不需要猜 UI 显示名。

## 连接方式

### SSH

适合 Linux、已有 SSH 管理权限、低延迟交互和通用 SFTP 场景。Relay 保存连接信息和私钥，Project link 保存 environment 与 remote path。

### Relay Agent

适合 Windows 服务器无法开放 SSH/WinRM、只能向公网 Relay 发起 HTTP 请求的场景。Agent 主动轮询工作队列，依次执行命令并回传状态、输出或 artifact。

1. 从 Release 下载 `RelayAgent.Client.exe`。
2. 在目标 Windows Server 上以管理员身份运行。
3. 输入 Web API 地址，例如 `https://relay.example.com`，不要填写 `/mcp`。
4. 输入 Server 中配置的 Agent ID 和对应 Agent Token。
5. 保存配置，执行 **Install Service**，然后 **Start**。

Relay URL 和 Agent Token 使用 Windows DPAPI `LocalMachine` 范围加密。安装为服务后，界面程序可以关闭，Windows Service 会继续运行。

Agent 配置、日志和审计文件位于：

```text
%ProgramData%\RelayMcpAgent\
```

## MCP 客户端

MCP endpoint：

```text
http://<relay-host>:3001/mcp
Authorization: Bearer <MCP_TOKEN>
```

### Codex

在 `C:\Users\<you>\.codex\config.toml` 中配置：

```toml
[mcp_servers.relay_mcp]
url = "http://<relay-host>:3001/mcp"
bearer_token_env_var = "RELAY_MCP_TOKEN"
startup_timeout_sec = 20
tool_timeout_sec = 120
enabled = true
default_tools_approval_mode = "prompt"
```

设置用户环境变量后完整重启 Codex：

```powershell
[Environment]::SetEnvironmentVariable("RELAY_MCP_TOKEN", "<MCP_TOKEN>", "User")
```

### 其他客户端

原生支持 HTTP MCP 的客户端直接使用 endpoint 和 Bearer token。只支持 stdio 的客户端可以使用 `mcp-remote`：

```json
{
  "mcpServers": {
    "relay-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://<relay-host>:3001/mcp?token=<MCP_TOKEN>",
        "--allow-http"
      ]
    }
  }
}
```

生产环境应使用 HTTPS，避免在 URL query 中携带 token，并通过反向代理限制 Web 与 MCP 入口。

## 目标选择

远程工具支持 Project 和 environment 选择。一个 Project 有多个 link 时，建议先调用：

```text
project_server_links_list(project="HKJC")
```

然后传入返回的 `environment`，或在支持的工具中使用准确的 server ID/name。Relay 会同时校验：

- Project 是否在当前 MCP Token 的允许范围内。
- Server 是否在 MCP Token 的 **Allowed Servers** 中。
- Project link 是否存在。
- Agent 是否在线，或 SSH 是否可连接。
- SampleManager 操作是否绑定到明确的 LIMS instance。

## 文件传输

大型二进制不经过 MCP JSON。MCP 只负责创建短期 session，并返回 URL、token、字节数和 SHA-256。

### 本地到远端

```text
local file
  -> create_workspace_upload
  -> HTTP streaming upload to Relay workspace
  -> upload_workspace_file
  -> target server
```

创建 session 后可使用：

```bash
npm run relay-upload -- --url <url> --token <token> --file <local-file>
```

### 远端到本地

```text
target server
  -> SSH/SFTP staging or Agent artifact-upload
  -> Relay short-lived download
  -> local .part file
  -> byte count + SHA-256 verification
```

`download_remote_file` 在 SSH 模式使用 SFTP staging，在 Agent 模式派发 `artifact-upload` job。下载器支持 HTTP Range 和 `.part` 断点续传：

```bash
npm run relay-download -- --url <url> --token <token> \
  --file <local-file> --expected-bytes <bytes> --expected-sha256 <sha256>
```

短期 session 过期后需要重新调用 MCP 工具。不要把下载 token 写入源码、日志或长期脚本。

## 异步 Job

长时间命令应设置 `async: true`。工具立即返回 `jobId`，随后使用：

- `job_status`：查看 queued/running/completed/failed、结果、错误和近期日志。
- `job_list`：列出当前用户的近期 job。
- `job_cancel`：请求取消仍在运行的 SSH job。

同步调用超时时，优先查询 job 状态，避免重复执行表转换、DLL 部署、清缓存或服务重启等有副作用的操作。

## SampleManager 多实例

同一 Server 可以管理多个 SampleManager 实例，包括不同版本、数据库、Windows Service 和构建工具链。

**LIMS Instances > Scan** 执行只读发现：

- 实例目录、文件版本和 runtime 类型。
- 实例所属 Windows Service。
- connection string 候选及数据库证据。
- Visual Studio MSBuild、Framework MSBuild 和 .NET SDK。
- 本地 SQL Server 中符合 SampleManager 核心表特征的业务数据库。

扫描会保留 LocalDB、`EntityContext-*` 和 OData 元数据库作为诊断候选，但不会将其优先识别为 LIMS 业务库。候选必须经用户审核并导入，之后才能绑定到 Project link。

绑定后，SampleManager 工具使用该实例的：

- `Exe`、`Server`、`SolutionAssemblies` 等路径。
- 数据库 host/name/auth 配置。
- Windows Service 与进程范围。
- .NET Framework MSBuild 或现代 `dotnet build` profile。

构建工具支持 `preflightOnly`、`msbuildProperties` 和仅限非敏感值的 `environmentVariables`。两类设置的名称只要包含 `TOKEN`、`SECRET`、`PASSWORD`、`PWD`、`PASS`、`KEY`（包括 `APIKEY` / `API_KEY`）、`CREDENTIAL`、`AUTH`、`PAT`、`BEARER`、`COOKIE` 或 connection string 等敏感标记就会被拒绝，必须预先配置到目标服务账号。审计、Job 和 deployment metadata 只记录设置键名，不保存值。绑定实例时会自动注入 `SAMPLEMANAGER_EXE` 及 `<INSTANCE>_EXE`；后者将实例名转为大写 ASCII，非字母数字字符替换为 `_`，若首字符不是字母或 `_` 则前置 `_`，因此始终是有效的 MSBuild 属性名。

SQL 查询默认只读。mutation 要求显式参数，并支持 dry run、备份和 before/after 证据。部署操作可通过 `deploymentId` 关联构建、哈希、备份、SQL、日志、重启和回滚状态。

## MCP 工具目录

下表与 `src/shared/tool-catalog.ts` 保持同步，测试会检查注册工具是否出现在 README 中。

| 分类 | 工具 | 说明 |
|---|---|---|
| Project | `list_projects` | 列出当前 MCP Token 可访问的 Project。 |
| Project | `project_server_links_list` | 列出 Project link、environment、Server 和 LIMS instance 绑定。 |
| Project | `relay_mcp_info` | 返回 Relay MCP 路由、命名空间和版本信息。 |
| Project | `relay_core_tools` | 返回稳定的首选 Relay 工具和兼容旧别名。 |
| Project | `relay_route_check` | 只读确认请求进入 Relay MCP，并解析可选的 Project/Server 目标。 |
| Remote execution | `relay_unicode_check` | 只读检查 SQL Server、PowerShell、Agent 到 MCP 的中文往返编码，并返回字节、码点、哈希和编码证据。 |
| Project | `relay_project_server_links_list` | 使用明确的 Relay 命名空间列出 Project links。 |
| Project | `project_create` | 创建 Project workspace，并可关联允许的 Server。 |
| Remote execution | `exec_remote` | 兼容旧调用；新调用优先使用 `relay_exec_remote`。 |
| Remote execution | `exec_remote_powershell` | 兼容旧调用；新调用优先使用 `relay_exec_remote_powershell`。 |
| Remote execution | `exec_remote_script` | 兼容旧调用；新调用优先使用 `relay_exec_remote_script`。 |
| Remote execution | `relay_exec_remote` | 首选 Relay 命名空间 shell command 工具。 |
| Remote execution | `relay_exec_remote_powershell` | 首选 Relay 命名空间 encoded PowerShell 工具。 |
| Remote execution | `relay_exec_remote_script` | 首选 Relay 命名空间 PowerShell 脚本工具。 |
| Playwright | `playwright_runtime_status` | 读取 Agent 管理的 Node.js、Playwright、Chromium 和缓存状态。 |
| Playwright | `playwright_suite_list` | 列出选定 Agent 保存的 Playwright suite。 |
| Playwright | `playwright_suite_upload` | 上传 Playwright 测试文件和 suite 元数据，并校验 SHA-256。 |
| Playwright | `playwright_run_suite` | 通过专用 Agent 协议排队正式 Playwright 测试。 |
| Playwright | `playwright_run_status` | 读取 Agent 生成的正式 Playwright run 记录。 |
| Playwright | `playwright_artifact_list` | 列出 Agent 上的 Playwright artifact 元数据。 |
| Playwright | `playwright_artifact_download` | 将 Playwright artifact 校验后传回 Relay workspace。 |
| Remote execution | `deploy` | 部署远端 Git checkout，并记录 commit、输出和 rollback 状态。 |
| Remote execution | `fetch_logs` | 按时间窗口或 deployment run 读取日志。 |
| Remote execution | `restart_service` | 重启 Windows Service、systemd、PM2 或 Docker workload。 |
| Remote files | `read_remote_file` | 读取远端文本文件。 |
| Remote files | `download_remote_file` | 将远端二进制流式下载到本地 workspace。 |
| Remote files | `write_remote_file` | 通过 SFTP 写入远端 UTF-8 文本。 |
| Remote files | `list_remote_files` | 列出远端目录。 |
| Remote files | `patch_remote_file` | 对远端文本应用 unified diff。 |
| Workspace | `read_local_file` | 读取 Relay Project workspace 文本。 |
| Workspace | `workspace_info` | 显示 Relay workspace 根目录和受限文件清单，避免与 Codex 本地路径混淆。 |
| Workspace | `write_local_file` | 写入或追加 Relay workspace 文本。 |
| Workspace | `write_local_binary` | 将小型 Base64 二进制写入 Relay workspace。 |
| Workspace | `list_workspace_files` | 有界递归列出 workspace 内容。 |
| Workspace | `workspace_file_stat` | 查看文件元数据并可计算 SHA-256。 |
| Workspace | `move_workspace_file` | 移动或重命名 workspace 文件。 |
| Workspace | `delete_workspace_file` | 删除文件或显式批准的目录树。 |
| Workspace | `create_workspace_upload` | 创建大型本地文件的短期流式上传 session。 |
| Workspace | `cleanup_workspace_staging` | 预览或清理旧 `.relay-staging` 内容。 |
| Workspace | `sync_workspace` | 通过 SFTP 同步 workspace 到远端目录。 |
| Workspace | `upload_workspace_file` | 上传单个 workspace 文件到远端。 |
| Jobs | `job_status` | 查询异步 job 的状态、结果、错误和日志。 |
| Jobs | `job_wait` | 有界等待 job 终态或阶段变化；等待到期时返回最新快照而不是制造新的执行超时。 |
| Jobs | `job_list` | 列出当前用户的近期 job。 |
| Jobs | `job_cancel` | 请求取消运行中的 SSH job。 |
| Context | `context_record_fact` | 保存持久化 Project fact。 |
| Context | `context_search` | 搜索持久化 Project fact。 |
| SampleManager | `samplemanager_capabilities` | 解析实例使用的版本化 Capability Pack，并列出已就绪、规划中和不可用的语义检查能力。 |
| SampleManager | `samplemanager_inspect_assembly_type` | 对单一程序集类型执行受限反射，返回扁平化属性、方法、事件、依赖、版本和 SHA-256 证据。 |
| SampleManager | `samplemanager_validate_form_task_contract` | 只读核对 FORM/TASK/MASTER_MENU、目标 Form XML/控件、FormsBin cache 与可选程序集类型契约。 |
| SampleManager | `samplemanager_create_deployment_manifest` | 在 Relay workspace 生成含明确目标与源文件 SHA-256 的只读部署 manifest，不执行构建或部署。 |
| SampleManager | `samplemanager_restart_instance` | 重启指定实例的核心服务。 |
| SampleManager | `samplemanager_deployment_start` | 创建用于关联多阶段操作的 `deploymentId`。 |
| SampleManager | `samplemanager_clear_form_cache` | 清理一个 form 的 FormsBin cache。 |
| SampleManager | `samplemanager_recent_errors` | 按时间范围检索紧凑错误证据。 |
| SampleManager | `samplemanager_table_schema` | 查询列、键、identity、默认值和物理映射。 |
| SampleManager | `samplemanager_sql_query` | 执行参数化只读 SQL，并返回详细 SQL Server 错误。 |
| SampleManager | `samplemanager_sql_execute_file` | 执行 workspace 中的参数化 SQL 文件。 |
| SampleManager | `samplemanager_sql_mutation` | 执行支持 dry run、备份和 before/after 的 mutation。 |
| SampleManager | `samplemanager_apply_change_set` | 在一个事务中执行多项 SQL 变更，支持幂等键、失败回滚、验证和 Deployment 恢复状态。 |
| SampleManager | `samplemanager_run_command` | 以结构化参数运行 `SampleManagerCommand.exe`。 |
| SampleManager | `samplemanager_create_entity_definition` | 运行 `CreateEntityDefinition.exe`。 |
| SampleManager | `samplemanager_convert_tables` | 对已验证表名分别运行 `convert_table.exe`。 |
| SampleManager | `samplemanager_table_loader` | 通过内置 `$table_loader` VGL report 导入远端 CSV。 |
| SampleManager | `samplemanager_deploy_table_loader_package` | 按 deploymentId 完成 staging、SHA-256 校验、顺序加载和验证。 |
| SampleManager | `samplemanager_run_utility` | 运行与版本匹配的 allowlisted utility。 |
| SampleManager | `samplemanager_discover_build_tools` | 按优先级发现 VS2022、VS2019、Framework 和 PATH 中的 MSBuild。 |
| SampleManager | `samplemanager_build_dotnet` | 使用 MSBuild 构建经典 SampleManager .NET solution。 |
| SampleManager | `samplemanager_build_deploy_assembly` | 构建、哈希、备份、部署、重启并支持程序集回滚。 |
| SampleManager | `samplemanager_deployment_status` | 查看 deployment 阶段、artifact、hash、backup 和 rollback 状态。 |
| SampleManager | `samplemanager_deployment_finish` | 将手动编排的 deployment 标记为成功或失败。 |
| SampleManager | `samplemanager_deploy_file` | 将 staged file 备份后部署到实例目录。 |
| SampleManager | `samplemanager_restore_backup` | 将指定 backup 恢复到显式 target。 |

## 环境变量

| 变量 | 默认值 | 用途 |
|---|---|---|
| `PORT` | `3000` | Web API/UI 端口。 |
| `MCP_PORT` | `3001` | MCP HTTP endpoint 端口。 |
| `JWT_SECRET` | 必填 | Web JWT 与 token 签名密钥。 |
| `MCP_SECRET` | 可选 | MCP 相关独立 secret。 |
| `MCP_OUTPUT_LIMIT` | `12000` | 工具紧凑输出字符上限。 |
| `DB_PATH` | `./data/app.db` | SQLite 数据库路径。 |
| `WORKSPACE_ROOT` | `/workspace` | Project workspace 根目录。 |
| `RELAY_STATE_ROOT` | `/workspace/.relay-mcp` | job、audit、staging 和 context 状态目录。 |
| `SSH_KEYS_DIR` | `/workspace/.ssh-keys` | Relay SSH key 目录。 |
| `RELAY_PUBLIC_URL` | `http://localhost:<PORT>` | 上传/下载 session 返回的公网 Web API base URL。 |
| `RELAY_UPLOAD_TTL_MS` | `900000` | 上传 session 有效期。 |
| `RELAY_UPLOAD_MAX_BYTES` | `4294967296` | 流式上传最大字节数。 |
| `RELAY_ARTIFACT_MAX_BYTES` | `4294967296` | Agent artifact 最大字节数。 |
| `RELAY_DOWNLOAD_TTL_MS` | `900000` | 下载 session 有效期。 |
| `RELAY_VERSION` | `0.6.3` | `/api/health` 返回的版本。 |
| `RELAY_BUILD_COMMIT` | `development` | 部署 commit fingerprint。 |
| `RELAY_BUILD_TIME` | `unknown` | 构建时间 fingerprint。 |

端口转发场景中，`RELAY_PUBLIC_URL` 必须填写客户端实际可访问的 Web 地址。例如公网 `7230` 转发到内网 `3000` 时：

```dotenv
RELAY_PUBLIC_URL=http://relay.example.com:7230
```

MCP 客户端则连接公网 MCP 端口，例如 `http://relay.example.com:7231/mcp`。

## 开发与验证

```bash
npm install
npm --prefix frontend install
npm test
npm run build
```

常用开发命令：

```bash
npm run dev:server
npm run dev:mcp
```

技术栈：Node.js、TypeScript、Fastify、Express、MCP SDK、SQLite/Drizzle、React、Vite、Tailwind CSS、PM2、node-ssh，以及 Windows WPF/.NET Agent。

## 安全边界

- MCP Token 与 Agent Token 分离，均可在后台撤销。
- MCP Token 的 Project 范围与 Allowed Servers 分别校验。
- Agent 只主动访问 Relay，不需要开放入站 SSH 或 WinRM。
- Agent Client 使用 DPAPI 加密 Relay URL 和 Agent Token。
- 请求审计会脱敏 Authorization、token、password、secret、API key 和 connection string。
- 大型文件使用短期 session；URL/token 过期后不可继续访问。
- SQL 默认只读；mutation、目录树删除、部署和回滚需要显式调用。
- 生产环境应使用 HTTPS、强 `JWT_SECRET`、最小权限账号和受限网络入口。

## License

[MIT](LICENSE)
