# Relay Agent Windows Client

This folder contains a small Windows Agent package:

- `RelayAgent.Client.exe`: one-file WPF UI and Windows Service host.

Minimizing the client sends it to the Windows notification area. Click or
double-click the tray icon to restore it, or use the tray menu to exit the UI.
The installed Windows Service continues independently when the UI exits.

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

For repeatable UI layout QA, build the client and run:

```powershell
.\render-ui-qa.ps1
```

For isolated large-output memory QA, run:

```powershell
.\test-memory-qa.ps1
```

The script renders every main page and Playwright tab at 1240 x 820,
1060 x 680, 980 x 760, and 900 x 700 without requiring interactive window
automation. It also verifies minimize-to-tray and restore behavior.
If the normal output exe is currently running, `build.ps1` writes the new
binary to `RelayAgent.Client.next.exe`.

Copy `RelayAgent.Client.exe` to the target server. Start it normally to open the UI, enter:

- Relay URL, for example `http://ftd1994.mycloudnas.com:7230`
- Agent ID, for example `VGSM-SERVER`
- Agent token

Then click Save, Install Service, and Start.
If the service already exists, Install Service updates its executable path
instead of trying to create a duplicate service.

## Client Pages

The current client uses a left-navigation WPF operations workspace:

- Overview: connection, service, database, and command-audit readiness.
- Connection: encrypted Relay URL and Agent token configuration.
- Service Control: install, update, start, stop, restart, and uninstall.
- Database Access: discover local SQL Server databases, test the service
  identity, and grant or revoke read, read/write, or DDL permissions.
- Command Audit: inspect the instruction, executed command or script, status,
  exit code, stdout, stderr, and Relay result-post state for Agent jobs.
- Playwright: detect and install Node/Playwright/Chromium dependencies, manage
  SampleManager Web Client test suites, queue background test runs, and inspect
  artifacts.
- Updates & Logs: update the single-file client and inspect `agent.log` in a
  searchable, zoomable terminal-style output panel.

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

The Relay MCP can also control this same runtime through a dedicated
`kind=playwright` Agent job. The MCP tools do not invoke PowerShell:

- `playwright_runtime_status` reads runtime readiness.
- `playwright_suite_list` and `playwright_suite_upload` manage suite metadata
  and UTF-8 test files with SHA-256 verification.
- `playwright_run_suite` creates a formal queued run record under `runs`.
- `playwright_run_status` reads that record after the service worker starts or
  completes the test.
- `playwright_artifact_list` and `playwright_artifact_download` list and
  stream bounded test artifacts through Relay with byte/hash verification.

The Client and MCP share the same service-owned files, so a run queued from
either surface appears in the Client's Test Runs page.

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

## Command Audit

The Agent writes one structured record per received job under:

```text
%ProgramData%\RelayMcpAgent\command-audit
```

Each record includes the job ID, kind, instruction, redacted command or script,
the executable path or runtime action, timestamps, status, timeout, exit code,
stdout, stderr, and whether the result was posted back to Relay. Payload
capture can be disabled independently, and retention is configurable from 1
to 365 days.

The Client loads at most the latest 100 lightweight record indexes on a
background thread. Full command, stdout, and stderr payloads are loaded only
after selecting one record, and the Terminal preview is bounded while Export
streams the complete stored records. It no longer scans the Relay HTTP request
log when the page opens.
Successful heartbeat time is maintained in `last-heartbeat.txt`, so the normal
five-second status refresh also avoids reparsing the HTTP audit file.

Playwright run lists use the same summary/detail pattern. The Client does not
preload Playwright runs or Agent logs during startup, expensive runtime checks
are throttled, and the log viewer reads only a bounded tail of `agent.log`.

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

The UI also includes a Check Update button. It shows the active connection,
metadata, download, verification, and restart stages with elapsed time and
byte-level download progress. If the GitHub API is unavailable or rate
limited, the client automatically falls back to the public latest-release
redirect. After download validation it stops the service, replaces both the
running UI executable and the executable path registered for the Windows
Service, restarts the service, and reopens the UI.

## Current Protocol

The service currently uses outbound HTTP only:

```text
POST /api/agents/heartbeat
GET  /api/agents/{agentId}/jobs/next
POST /api/agents/{agentId}/jobs/{jobId}/events
POST /api/agents/{agentId}/jobs/{jobId}/result
```

These endpoints are the Relay Agent protocol surface. The agent can execute
queued `cmd.exe` commands and PowerShell jobs, process dedicated Playwright
actions, and upload binary artifacts. Payloads for shell work are written to
short-lived `.cmd` or `.ps1` files under `%ProgramData%\RelayMcpAgent\jobs`;
PowerShell runs with `powershell.exe -File`. Playwright work uses the
service-owned runtime and queue directly, avoiding command-line quoting and
length limits.
