# Relay Agent Windows Client

This folder contains a small Windows Agent package:

- `RelayAgent.Client.exe`: one-file WPF UI and Windows Service host.

The client writes configuration to:

```text
%ProgramData%\RelayMcpAgent\agent.env
```

Service diagnostics are appended to:

```text
%ProgramData%\RelayMcpAgent\agent.log
```

## Build

Run from this folder on a Windows machine with Visual Studio Build Tools:

```powershell
.\build.ps1
```

The output is written to:

```text
agent\windows\out
```

Copy `RelayAgent.Client.exe` to the target server. Start it normally to open the UI, enter:

- Relay URL, for example `http://ftd1994.mycloudnas.com:7230`
- Agent ID, for example `VGSM-SERVER`
- Agent token

Then click Save, Install Service, and Start.
If the service already exists, Install Service updates its executable path
instead of trying to create a duplicate service.

## Client Pages

The v0.4 client uses a left-navigation operations workspace:

- Overview: connection, service, database, and audit readiness.
- Connection: encrypted Relay URL and Agent token configuration.
- Service Control: install, update, start, stop, restart, and uninstall.
- Database Access: discover local SQL Server databases, test the service
  identity, and grant or revoke read, read/write, or DDL permissions.
- Request Audit: filter, inspect, export, and clear audited Relay HTTP calls.
- Playwright: detect and install Node/Playwright/Chromium dependencies, manage
  SampleManager Web Client test suites, queue background test runs, and inspect
  artifacts.
- Updates & Logs: update the single-file client and inspect `agent.log`.

## Playwright

The Playwright page stores its service-owned runtime under:

```text
%ProgramData%\RelayMcpAgent\playwright
```

The UI creates local installation and test jobs. The Windows Service processes
those jobs independently, so installation and tests continue after the Client
window closes. Node.js LTS must be installed first; the Agent installs
`@playwright/test` and Chromium into the service-owned runtime and browser
cache.

## Secure Configuration

Relay URL and Agent token values are encrypted with Windows DPAPI using
`LocalMachine` scope. After save, the UI displays masked values instead of
plaintext. The configuration directory and file are restricted to:

- `NT AUTHORITY\SYSTEM`
- Local Administrators
- The Windows user that saved the configuration

Existing plaintext `RELAY_URL` and `AGENT_TOKEN` entries remain readable for
backward compatibility. The next successful save migrates them to:

```text
RELAY_URL_PROTECTED=<DPAPI ciphertext>
AGENT_TOKEN_PROTECTED=<DPAPI ciphertext>
```

Because the ciphertext is machine-bound, copying `agent.env` to another
computer does not transfer usable secrets. Use Replace in the Connection page
to configure that computer.

## Request Audit

The Agent records audited Relay HTTP calls in:

```text
%ProgramData%\RelayMcpAgent\http-audit.jsonl
```

Each entry includes timestamp, method, endpoint, status, duration, job ID,
request body, response body, and error details. Authorization headers, tokens,
passwords, secrets, API keys, and connection strings are redacted before
storage. Payload logging can be disabled independently, and retention is
configurable from 1 to 365 days.

The job polling response contains the dispatched command or PowerShell script,
while the result POST contains stdout, stderr, and exit status. This gives the
Request Audit page an end-to-end record without storing Agent credentials.

## Database Access

Database permission actions run under the interactive Windows identity that
opened the Client. That identity must already have authority to create SQL
Server logins and database users. The Client never stores SQL administrator
credentials.

The helper detects local default and named SQL Server instances, ranks
databases that contain common SampleManager tables, and manages permissions for
the installed Relay Agent Windows Service identity.

Permission levels are:

- Read: server login, database user, `db_datareader`, and `VIEW DEFINITION`.
- Read/write: Read plus `db_datawriter`.
- DDL: Read/write plus `db_ddladmin`.

Grant operations are idempotent and verify the resulting permission state.
Revoke removes the database-level user and roles but retains the server login
in case another database uses it.

The installed service runs the same executable with:

```text
RelayAgent.Client.exe --service
```

For foreground diagnostics, run:

```powershell
.\RelayAgent.Client.exe --console
```

The UI also includes a Check Update button. It compares the current release
with GitHub and downloads the latest
`RelayAgent.Client.exe` from the GitHub release page, stops the service,
replaces both the running UI executable and the executable path registered for
the Windows Service, restarts the service, and reopens the UI.

## Current Protocol

The service currently uses outbound HTTP only:

```text
POST /api/agents/heartbeat
GET  /api/agents/{agentId}/jobs/next
POST /api/agents/{agentId}/jobs/{jobId}/events
POST /api/agents/{agentId}/jobs/{jobId}/result
```

These endpoints are the Relay Agent protocol surface. The agent can execute
queued `cmd.exe` commands and PowerShell jobs, then returns stdout, stderr, and
exit code to the Relay server. Payloads are written to short-lived `.cmd` or
`.ps1` files under `%ProgramData%\RelayMcpAgent\jobs`; PowerShell runs with
`powershell.exe -File`. This avoids the Windows command-line length limit.
