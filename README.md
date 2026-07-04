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

- **MCP Tools**: `exec_remote`, `deploy`, `fetch_logs`, `restart_service`, `read/write_remote_file`, `list_remote_files`, `read/write_local_file`, `list_projects`
- **Token-saving tools**: compact command/log output, async job tracking, project memory (`context_record_fact`, `context_search`)
- **MCP token profiles**: create per-agent tokens from the Web UI and bind a default project/server/environment
- **SampleManager tools**: `samplemanager_restart_instance`, `samplemanager_clear_form_cache`, `samplemanager_recent_errors`, `samplemanager_sql_query`
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

Use the Web UI **Tokens** page to create tokens for local agents. A token can
optionally carry a default project and server environment. When a token has a
default project, MCP tools can omit the `project` argument. When no default
project exists, RelayMCP returns an actionable error telling the local agent to
ask the user whether to create a new project or choose an existing one.

Generated tokens are shown once. RelayMCP stores only token metadata and the
token id so profiles can be revoked without storing the full secret.

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

- **MCP 工具**：`exec_remote`（执行命令）、`deploy`（部署）、`fetch_logs`（获取日志）、`restart_service`（重启服务）、远程/本地文件读写、项目列表查询
- **节省 token 工具**：输出压缩、异步 job、项目事实记忆（`context_record_fact`、`context_search`）
- **MCP token profile**：在 Web UI 手动生成 agent token，并绑定默认 project/server/environment
- **SampleManager 工具**：实例重启、FormsBin 缓存清理、近期错误检索、SQL 查询
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

在 Web UI 的 **Tokens** 页面生成本地 agent 使用的 token。生成时可以选择默认
project 和 server environment。带默认 project 的 token 调用 MCP tool 时可以省略
`project` 参数；如果 token 没有默认 project，RelayMCP 会返回明确提示，让本地
agent 询问用户是新建 project 还是选择历史 project。

token 明文只显示一次。数据库只保存 token 元数据和 token id，用于列表展示和撤销。

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
