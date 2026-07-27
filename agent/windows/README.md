# Relay Agent Windows Client

This folder contains a small Windows Agent package:

- `RelayAgent.Client.exe`: one-file WinForms UI and Windows Service host.

The client writes configuration to:

```text
%ProgramData%\RelayMcpAgent\agent.env
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

The installed service runs the same executable with:

```text
RelayAgent.Client.exe --service
```

For foreground diagnostics, run:

```powershell
.\RelayAgent.Client.exe --console
```

The UI also includes a Check Update button. It downloads the latest
`RelayAgent.Client.exe` from the GitHub release page, stops the service,
replaces the executable, restarts the service, and reopens the UI.

## Current Protocol

The service currently uses outbound HTTP only:

```text
POST /api/agents/heartbeat
GET  /api/agents/{agentId}/jobs/next
POST /api/agents/{agentId}/jobs/{jobId}/events
POST /api/agents/{agentId}/jobs/{jobId}/result
```

These endpoints are the Relay Agent protocol surface. The agent can execute
queued `cmd.exe` commands and Encoded PowerShell jobs, then returns stdout,
stderr, and exit code to the Relay server.
