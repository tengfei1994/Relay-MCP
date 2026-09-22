## Relay Agent v0.7.6

### Authentication compatibility fix
- The Agent strips one leading `Bearer ` prefix from stored tokens before constructing the Authorization header.
- This prevents `Bearer Bearer eyJ...` when a copied token includes the scheme prefix.
- Both the Service and Client were rebuilt from the v0.7.6 sources.

### Installation
Replace the installed `RelayAgent.Service.exe` and `RelayAgent.Client.exe`, then restart `RelayMcpAgent`.
The stored token may be either the raw JWT (`eyJ...`) or a single `Bearer eyJ...` prefix.
