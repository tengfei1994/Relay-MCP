# Remote Ops Platform

> A self-hosted remote operations platform that lets any MCP-compatible LLM agent manage remote servers through a controlled relay server.

**中文说明见下方 / Chinese documentation below ↓**

---

## Architecture

```
LLM Client (Claude, Codex, Cursor, Cline, custom agents)
      │  MCP over HTTP
      ▼
RelayMCP Server (Ubuntu VM)
  ├── Web UI        :3000  — project & server management
  └── MCP Server    :3001  — platform-neutral tools for LLM clients
      │  SSH
      ▼
Production Servers (any SSH-accessible host)
```

## Features

- **MCP Tools**: `exec_remote`, `exec_remote_powershell`, `exec_remote_script`, `deploy`, `fetch_logs`, `restart_service`, `read/write_remote_file`, `list_remote_files`, `read/write_local_file`, `list_projects`, `project_create`
- **Token-saving tools**: compact command/log output, async job tracking, project memory (`context_record_fact`, `context_search`)
- **MCP token profiles**: create per-agent tokens from the Web UI, allow one agent to access multiple projects, and manually scope the servers it may use
- **SampleManager tools**: `samplemanager_restart_instance`, `samplemanager_clear_form_cache`, `samplemanager_recent_errors`, `samplemanager_sql_query`, `samplemanager_sql_execute_file`, `samplemanager_run_command`
- **Server Management**: add servers, auto-generate SSH key pairs, push public keys, test connectivity, edit settings
- **Project Management**: workspace directories per user, link/unlink servers per project per environment
- **User Management**: admin-only user creation, password reset, admin role toggle
- **JWT Auth**: token-based authentication for both Web UI and MCP

## Agent Boundary

RelayMCP is designed to keep the LLM client thin:

| Local LLM Agent | RelayMCP Server |
|-----------------|-----------------|
| Understands user intent and edits source files | Stores server connections, SSH keys, project/environment mapping |
| Calls high-level MCP tools | Executes remote commands and playbooks |
| Reads compact summaries | Compresses logs, SQL output, file listings, and build output |
| Keeps durable source/docs in the user's repo | Owns temp scripts, staging zips, job logs, audit records, and project facts |

This means one-off local `inspect-*.ps1`, `fix-*.ps1`, and `deploy-*.ps1`
scripts should gradually become MCP tools or playbooks. Temporary PowerShell or
Python snippets are generated and cleaned up on the relay/server side instead of
polluting the local agent workspace.

## Token Efficiency

RelayMCP defaults to returning compact output (`MCP_OUTPUT_LIMIT`, default
`12000` characters). Long-running operations can use async jobs:

- `job_list`
- `job_status`

Project facts can be stored in relay-side memory so future LLM calls do not need
the full chat history:

- `context_record_fact`
- `context_search`

## Supported Operation Scenarios

RelayMCP has two capability layers:

1. **First-class MCP tools** for common, repeatable operations.
2. **Remote command playbooks** executed through `exec_remote`, `read/write_remote_file`,
   `upload_workspace_file`, `sync_workspace`, and PowerShell/SSH on the target
   server.

### Built-In MCP Tools

| Scenario | Tools |
|----------|-------|
| Project selection and creation | `list_projects`, `project_create` |
| Remote command execution | `exec_remote`, `exec_remote_powershell`, `exec_remote_script` |
| Deployment and restart | `deploy`, `restart_service` |
| Logs and jobs | `fetch_logs`, `job_list`, `job_status` |
| Remote files | `read_remote_file`, `write_remote_file`, `list_remote_files`, `patch_remote_file` |
| Relay-side project workspace | `read_local_file`, `write_local_file`, `upload_workspace_file`, `sync_workspace` |
| Durable project memory | `context_record_fact`, `context_search` |
| SampleManager helpers | `samplemanager_restart_instance`, `samplemanager_clear_form_cache`, `samplemanager_recent_errors`, `samplemanager_sql_query`, `samplemanager_sql_execute_file`, `samplemanager_run_command` |

### PowerShell / SSH Operations

For Windows SampleManager servers, RelayMCP can run remote PowerShell via SSH.
Use `exec_remote_powershell` for inline scripts and `exec_remote_script` for
longer scripts. Both avoid shell quoting issues with PowerShell variables such
as `$svc`; `exec_remote_script` writes a temporary `.ps1`, runs it, and removes
it automatically on success.
Common playbook operations include:

- create/remove remote staging folders
- upload generated files by SFTP instead of embedding large file content in chat
- copy staged files into SampleManager instance folders
- back up target files before replacement
- clear form caches such as `FormsBin\<FORM_NAME>.binform*`
- restart services, IIS app pools, or SampleManager-related processes when required
- collect recent logs and compact them before returning to the LLM client

Large generated files should normally be written to the relay-side project
workspace first, then uploaded with `upload_workspace_file` or `sync_workspace`.
This avoids one-off local `.ps1`/`.py` scripts and reduces token usage.

### SampleManager Command Scenarios

The following SampleManager operations are supported as remote command playbooks.
They can later be promoted into dedicated MCP tools when they become frequent.

| Scenario | Command Pattern |
|----------|-----------------|
| Run VGL report | Prefer `samplemanager_run_command` with `task="VGL"` and structured `args`, or run `SampleManagerCommand.exe -instance <INSTANCE> -username <USER> -task VGL -report '<REPORT_NAME>' -prompts "(...)"` |
| Load table-loader CSV | Prefer `samplemanager_run_command` with args such as `["-report","$table_loader","-prompts","(C:\path\file.csv,overwrite_table)"]` |
| Apply structure changes | `CreateEntityDefinition.exe -instance <INSTANCE>` followed by `convert_table.exe -mode convert -tables <TABLE_NAME> -noconfirm -instance <INSTANCE>` |
| Deploy form XML / form task code | Copy form artifacts, deploy task assemblies if needed, clear targeted `FormsBin` cache |
| Deploy Report Designer layouts | Upload `.repx`, validate layout loading, run report smoke test |
| Deploy custom .NET task assemblies | Build with `MSBuild.exe` or `dotnet build`, copy DLL/PDB/config to the target convention, restart affected task hosts |
| RESOURCE icons | Copy icon files under the instance `Resource\Icon` convention and refresh/reopen clients |
| SampleManager SQL checks | `samplemanager_sql_query` for compact read-only checks by default, or `samplemanager_sql_execute_file` for SQL stored in the relay project workspace; use `maxRows` and `includeResultSets` to control output size; mutation requires explicit opt-in |

Important rules:

- Run SampleManager command-line utilities from the instance `Exe` folder so DLLs
  and logical paths resolve correctly.
- Quote `'$table_loader'` with single quotes in PowerShell; double quotes may
  expand `$table_loader` as a variable.
- Table-loader CSV belongs to the `$table_loader` VGL report. Do not send it to
  `EntityImportTask`, which expects XML entity import content.
- Structure changes should use SampleManager structure tooling, not direct SQL
  schema edits.
- Deployment output should include commands run, files copied, caches cleared,
  restart impact, and smoke-test results.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js · Fastify · SQLite (Drizzle ORM) |
| MCP Server | @modelcontextprotocol/sdk · Express · HTTP/SSE |
| Frontend | React · Vite · Tailwind CSS |
| Process Manager | PM2 |
| SSH | node-ssh · openssh-client |

## Deployment

### Requirements

- Ubuntu 22.04+ server (RelayMCP)
- Node.js 20 LTS
- PM2 (`npm install -g pm2`)

### Steps

```bash
# 1. Clone the repo on RelayMCP
git clone https://github.com/tengfei1994/Relay-MCP.git ~/Relay-MCP
cd ~/Relay-MCP

# 2. Install dependencies
npm install
cd frontend && npm install && npm run build && cd ..

# 3. Configure environment
cp .env.example .env
# Edit .env: set JWT_SECRET, WORKSPACE_ROOT, SSH_KEYS_DIR

# 4. Build backend
npx tsc

# 5. Start with PM2
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

### Environment Variables (`.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Web server port |
| `MCP_PORT` | `3001` | MCP server port |
| `MCP_OUTPUT_LIMIT` | `12000` | Maximum characters returned by compact tool output |
| `JWT_SECRET` | *(required)* | Secret for signing JWT tokens |
| `WORKSPACE_ROOT` | `/workspace` | Root directory for project workspaces |
| `RELAY_STATE_ROOT` | `/workspace/.relay-mcp` | Job, audit, and project-memory storage |
| `SSH_KEYS_DIR` | `/workspace/.ssh-keys` | Directory for generated SSH key pairs |
| `DB_PATH` | `./data/app.db` | SQLite database file path |

## Connecting MCP Clients

### Claude Desktop (Cowork)

Requires Node.js on the client machine. Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "remote-ops": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://YOUR_SERVER:3001/mcp?token=YOUR_JWT_TOKEN",
        "--allow-http"
      ]
    }
  }
}
```

### Claude Code CLI

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "remote-ops": {
      "url": "http://YOUR_SERVER:3001/mcp?token=YOUR_JWT_TOKEN"
    }
  }
}
```

### Other MCP Clients

Any client that supports HTTP MCP can connect to:

```text
http://YOUR_SERVER:3001/mcp
Authorization: Bearer YOUR_JWT_TOKEN
```

Clients that only support local stdio MCP can use `mcp-remote` as a bridge.

## MCP Token Profiles

Use the Web UI **Tokens** page to create tokens for local agents. A token is an
agent profile, not a single-project credential. The intended boundary is:

| Scope | Behavior |
|-------|----------|
| Project access | Allow all current/future projects, or manually select multiple projects |
| Project creation | Optional capability; when enabled, the agent can call `project_create` |
| Server access | Always manually selected; remote execution can only use allowed servers |
| Default project/server | Optional convenience defaults only |

When a token has a default project, MCP tools can omit the `project` argument.
When there is no default project but the token has access to exactly one project,
RelayMCP uses that project automatically. When multiple projects are available,
RelayMCP returns a structured prompt request so the local agent can ask the user
whether to use an existing project or create a new one.

Server access is stricter by design. Even if a token can create projects freely,
it cannot use arbitrary remote servers. The token must include the target server
in its **Allowed Servers** list. `project_create` may create the relay-side
workspace without a server, or may link to an allowed server and create the
remote directory when `serverId` and `remotePath` are provided.

Generated tokens are shown once. RelayMCP stores only token metadata and the
token id so profiles can be revoked without storing the full secret.

### Codex Example

Add the MCP server to `C:\Users\<you>\.codex\config.toml`:

```toml
[mcp_servers.relay_mcp]
url = "http://YOUR_SERVER:3001/mcp"
bearer_token_env_var = "RELAY_MCP_TOKEN"
startup_timeout_sec = 20
tool_timeout_sec = 120
enabled = true
default_tools_approval_mode = "prompt"
```

Then set the token in the user environment and fully restart Codex so the
process can read the new environment variable:

```powershell
[Environment]::SetEnvironmentVariable("RELAY_MCP_TOKEN", "YOUR_TOKEN", "User")
```

Get your JWT token:
```bash
curl -s -X POST http://YOUR_SERVER:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"your-user","password":"your-password"}' | python3 -m json.tool
```

## Windows SSH Notes

For Windows servers (Administrator account), the authorized keys file location is:

```
C:\ProgramData\ssh\administrators_authorized_keys
```

Required permissions (others will cause key auth to fail):
```powershell
icacls "C:\ProgramData\ssh\administrators_authorized_keys" /inheritance:r
icacls "C:\ProgramData\ssh\administrators_authorized_keys" /grant "NT AUTHORITY\SYSTEM:(F)"
icacls "C:\ProgramData\ssh\administrators_authorized_keys" /grant "BUILTIN\Administrators:(F)"
Restart-Service sshd
```

---

# 远端运维平台

> 一个自托管的远端运维平台，通过 MCP (Model Context Protocol) 让任意兼容 MCP 的 LLM 智能体经由受控中继管理远端服务器。

## 架构说明

```
LLM 客户端（Claude、Codex、Cursor、Cline、自定义 Agent）
      │  MCP over HTTP
      ▼
RelayMCP 服务器（Ubuntu VM）
  ├── Web UI        :3000  — 项目与服务器管理界面
  └── MCP Server    :3001  — 提供平台无关的 MCP 工具
      │  SSH
      ▼
生产服务器（任意可 SSH 访问的主机）
```

## 功能特性

- **MCP 工具**：`exec_remote`（执行命令）、`exec_remote_powershell`、`exec_remote_script`、`deploy`（部署）、`fetch_logs`（获取日志）、`restart_service`（重启服务）、远程/本地文件读写、项目列表查询、`project_create`（创建项目）
- **节省 token 工具**：输出压缩、异步 job、项目事实记忆（`context_record_fact`、`context_search`）
- **MCP token profile**：在 Web UI 手动生成 agent token，一个 agent 可访问多个 project，但可用 server 必须手动授权
- **SampleManager 工具**：实例重启、FormsBin 缓存清理、近期错误检索、SQL 查询、SQL 文件执行、SampleManagerCommand 封装
- **服务器管理**：添加服务器、自动生成 SSH 密钥对、一键推送公钥、连通性测试、编辑服务器信息
- **项目管理**：按用户隔离的工作区目录、支持多环境的项目-服务器关联管理
- **用户管理**：仅管理员可创建用户、重置密码、管理员权限授予/撤销
- **JWT 认证**：Web UI 和 MCP 均使用 Token 认证

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Node.js · Fastify · SQLite（Drizzle ORM） |
| MCP 服务 | @modelcontextprotocol/sdk · Express · HTTP/SSE |
| 前端 | React · Vite · Tailwind CSS |
| 进程管理 | PM2 |
| SSH | node-ssh · openssh-client |

## 当前支持的操作场景

RelayMCP 的能力分两层：

1. **已封装 MCP tool**：适合高频、可重复、需要节省 token 的操作。
2. **远程命令 playbook**：通过 `exec_remote`、远程 PowerShell/SSH、SFTP 文件传输来执行，
   适合 SampleManager 部署、编译、加载、清缓存等场景。

### 已封装 MCP Tool

| 场景 | 工具 |
|------|------|
| Project 选择与创建 | `list_projects`, `project_create` |
| 远程命令执行 | `exec_remote`, `exec_remote_powershell`, `exec_remote_script` |
| 部署和重启 | `deploy`, `restart_service` |
| 日志和异步任务 | `fetch_logs`, `job_list`, `job_status` |
| 远程文件 | `read_remote_file`, `write_remote_file`, `list_remote_files`, `patch_remote_file` |
| Relay 侧 project workspace | `read_local_file`, `write_local_file`, `upload_workspace_file`, `sync_workspace` |
| 项目长期记忆 | `context_record_fact`, `context_search` |
| SampleManager 辅助工具 | `samplemanager_restart_instance`, `samplemanager_clear_form_cache`, `samplemanager_recent_errors`, `samplemanager_sql_query`, `samplemanager_sql_execute_file`, `samplemanager_run_command` |

### PowerShell / SSH 能力

对于 Windows SampleManager 服务器，RelayMCP 可以通过 SSH 执行远程 PowerShell。
内联脚本优先使用 `exec_remote_powershell`，长脚本优先使用
`exec_remote_script`。这两个工具会避免 PowerShell `$变量` 被外层 shell
提前展开；`exec_remote_script` 会写入临时 `.ps1`、执行，并在成功后自动清理。
典型操作包括：

- 创建/清理远程 staging 目录
- 通过 SFTP 上传文件，避免在对话里传递大文件内容
- 将 staging 文件复制到 SampleManager instance 目录
- 替换前备份目标文件
- 清理指定 form 的 `FormsBin\<FORM_NAME>.binform*` 缓存
- 按需重启服务、IIS app pool 或 SampleManager 相关进程
- 收集近期日志，并压缩后返回给本地 LLM agent

大文件或生成物建议先写入 RelayMCP 的 project workspace，再通过
`upload_workspace_file` 或 `sync_workspace` 上传。这样可以减少本地一次性 `.ps1` /
`.py` 脚本，也能降低 token 消耗。

### SampleManager 命令场景

以下能力目前通过远程命令 playbook 支持，未来高频场景可以继续封装成专用 MCP tool：

| 场景 | 命令模式 |
|------|----------|
| 执行 VGL report | 优先用 `samplemanager_run_command`，传入 `task="VGL"` 和结构化 `args`；也可直接运行 `SampleManagerCommand.exe -instance <INSTANCE> -username <USER> -task VGL -report '<REPORT_NAME>' -prompts "(...)"` |
| 加载 table-loader CSV | 优先用 `samplemanager_run_command`，args 例如 `["-report","$table_loader","-prompts","(C:\path\file.csv,overwrite_table)"]` |
| 应用 structure 变更 | `CreateEntityDefinition.exe -instance <INSTANCE>` 后执行 `convert_table.exe -mode convert -tables <TABLE_NAME> -noconfirm -instance <INSTANCE>` |
| 部署 form XML / form task code | 复制 form 文件，必要时部署 task assembly，并清理对应 `FormsBin` 缓存 |
| 部署 Report Designer layout | 上传 `.repx`，验证 layout 可加载，并运行 report smoke test |
| 部署自定义 .NET task assembly | 使用 `MSBuild.exe` 或 `dotnet build` 编译，复制 DLL/PDB/config 到目标约定目录，并重启受影响 task host |
| RESOURCE icon | 将 icon 文件放到 instance 的 `Resource\Icon` 约定目录，并刷新/重开客户端 |
| SampleManager SQL 检查 | `samplemanager_sql_query` 默认用于只读检查，`samplemanager_sql_execute_file` 用于执行 relay project workspace 中的 SQL 文件；用 `maxRows` 和 `includeResultSets` 控制输出大小；写入操作必须显式开启 mutation |

重要约束：

- SampleManager 命令行工具应在 instance 的 `Exe` 目录下执行，避免 DLL 和 logical path 解析失败。
- PowerShell 中 `'$table_loader'` 要用单引号；双引号可能把 `$table_loader` 当变量展开。
- table-loader CSV 应交给 `$table_loader` VGL report，不要交给 `EntityImportTask`。
- structure 变更应使用 SampleManager structure 工具链，不建议直接 SQL 改 schema。
- 部署结果应说明执行过的命令、复制的文件、清理的缓存、重启影响和 smoke test 结果。

## 部署步骤

### 环境要求

- Ubuntu 22.04+ 服务器（作为 RelayMCP 中继节点）
- Node.js 20 LTS
- PM2（`npm install -g pm2`）

### 部署

```bash
# 1. 克隆仓库到 RelayMCP 服务器
git clone https://github.com/tengfei1994/Relay-MCP.git ~/Relay-MCP
cd ~/Relay-MCP

# 2. 安装依赖
npm install
cd frontend && npm install && npm run build && cd ..

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env，设置 JWT_SECRET、WORKSPACE_ROOT、SSH_KEYS_DIR

# 4. 编译后端
npx tsc

# 5. 用 PM2 启动
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

### 环境变量说明（`.env`）

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `PORT` | `3000` | Web 服务端口 |
| `MCP_PORT` | `3001` | MCP 服务端口 |
| `MCP_OUTPUT_LIMIT` | `12000` | 工具返回内容的默认压缩上限 |
| `JWT_SECRET` | *必填* | JWT 签名密钥 |
| `WORKSPACE_ROOT` | `/workspace` | 项目工作区根目录 |
| `RELAY_STATE_ROOT` | `/workspace/.relay-mcp` | job、审计、项目记忆存储目录 |
| `SSH_KEYS_DIR` | `/workspace/.ssh-keys` | SSH 密钥对存储目录 |
| `DB_PATH` | `./data/app.db` | SQLite 数据库路径 |

## 连接 MCP 客户端

### Claude Desktop（Cowork）

客户端需安装 Node.js，将以下内容加入 `claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "remote-ops": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://你的服务器:3001/mcp?token=你的JWT令牌",
        "--allow-http"
      ]
    }
  }
}
```

### Claude Code CLI

加入 `~/.claude/settings.json`：

```json
{
  "mcpServers": {
    "remote-ops": {
      "url": "http://你的服务器:3001/mcp?token=你的JWT令牌"
    }
  }
}
```

### 其他 MCP 客户端

任意支持 HTTP MCP 的客户端都可以连接：

```text
http://你的服务器:3001/mcp
Authorization: Bearer 你的JWT令牌
```

如果客户端只支持本地 stdio MCP，可以用 `mcp-remote` 做桥接。

## MCP Token Profile

在 Web UI 的 **Tokens** 页面生成本地 agent 使用的 token。token 是一个 agent
profile，不是单个 project 的凭证。推荐的边界如下：

| 范围 | 行为 |
|------|------|
| Project 访问 | 可以允许所有当前/未来 project，也可以手动多选 project |
| Project 创建 | 可选能力；开启后 agent 可以调用 `project_create` |
| Server 访问 | 必须手动勾选；远程执行只能使用 token 允许的 server |
| 默认 project/server | 只是便捷默认值，不代表权限边界 |

带默认 project 的 token 调用 MCP tool 时可以省略 `project` 参数。如果没有默认
project，但 token 只允许访问一个 project，RelayMCP 会自动使用该 project。如果
token 可访问多个 project，RelayMCP 会返回结构化提示，让本地 agent 询问用户是
选择历史 project 还是新建 project。

Server 访问更严格。即使 token 允许自由创建 project，也不能随意使用任意远程
server。目标 server 必须在 token 的 **Allowed Servers** 中被手动勾选。`project_create`
可以只创建 RelayMCP 本地 workspace；如果同时提供 `serverId` 和 `remotePath`，
则会在被允许的 server 上建立远程目录并关联到 project。

token 明文只显示一次。数据库只保存 token 元数据和 token id，用于列表展示和撤销。

### Codex 示例

在 `C:\Users\<you>\.codex\config.toml` 中加入：

```toml
[mcp_servers.relay_mcp]
url = "http://你的服务器:3001/mcp"
bearer_token_env_var = "RELAY_MCP_TOKEN"
startup_timeout_sec = 20
tool_timeout_sec = 120
enabled = true
default_tools_approval_mode = "prompt"
```

然后把 Web UI 生成的 token 写入用户环境变量，并完整重启 Codex：

```powershell
[Environment]::SetEnvironmentVariable("RELAY_MCP_TOKEN", "你的TOKEN", "User")
```

获取 JWT 令牌：
```bash
curl -s -X POST http://你的服务器:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"用户名","password":"密码"}' | python3 -m json.tool
```

## Windows 服务器 SSH 说明

Windows（Administrator 账号）的授权密钥文件路径为：

```
C:\ProgramData\ssh\administrators_authorized_keys
```

必须设置正确的文件权限（其他权限会导致密钥认证失败）：
```powershell
icacls "C:\ProgramData\ssh\administrators_authorized_keys" /inheritance:r
icacls "C:\ProgramData\ssh\administrators_authorized_keys" /grant "NT AUTHORITY\SYSTEM:(F)"
icacls "C:\ProgramData\ssh\administrators_authorized_keys" /grant "BUILTIN\Administrators:(F)"
Restart-Service sshd
```

## 许可证 / License

MIT
