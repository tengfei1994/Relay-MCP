# Relay Agent Windows Client

This folder contains a small Windows Agent package:

- `RelayAgent.Client.exe`: WinForms UI for Relay URL/token configuration and service control.
- `RelayAgent.Service.exe`: Windows Service that runs on the target server and connects outbound to Relay.

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

Copy both EXEs to the target server. Start `RelayAgent.Client.exe`, enter:

- Relay URL, for example `http://ftd1994.mycloudnas.com:7230`
- Agent ID, for example `VGSM-SERVER`
- Agent token

Then click Save, Install Service, and Start.

## Current Protocol

The service currently uses outbound HTTP only:

```text
POST /api/agents/heartbeat
GET  /api/agents/{agentId}/jobs/next
POST /api/agents/{agentId}/jobs/{jobId}/events
POST /api/agents/{agentId}/jobs/{jobId}/result
```

These endpoints are the intended Relay Agent protocol surface. The current
Relay server still needs matching routes before real remote execution can move
from SSH to the Agent channel.

