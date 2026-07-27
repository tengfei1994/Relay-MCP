using System;
using System.Collections.Generic;
using System.IO;

namespace RelayAgent.Shared
{
    public sealed class AgentConfig
    {
        public const string ServiceName = "RelayMcpAgent";

        public string RelayUrl { get; set; } = "";
        public string AgentId { get; set; } = Environment.MachineName;
        public string Token { get; set; } = "";
        public int PollSeconds { get; set; } = 10;

        public static string ConfigDirectory
        {
            get
            {
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                    "RelayMcpAgent");
            }
        }

        public static string ConfigPath
        {
            get { return Path.Combine(ConfigDirectory, "agent.env"); }
        }

        public static AgentConfig Load()
        {
            var config = new AgentConfig();
            if (!File.Exists(ConfigPath))
            {
                return config;
            }

            foreach (var line in File.ReadAllLines(ConfigPath))
            {
                if (string.IsNullOrWhiteSpace(line) || line.TrimStart().StartsWith("#"))
                {
                    continue;
                }

                var index = line.IndexOf('=');
                if (index <= 0)
                {
                    continue;
                }

                var key = line.Substring(0, index).Trim();
                var value = line.Substring(index + 1).Trim();
                if (key.Equals("RELAY_URL", StringComparison.OrdinalIgnoreCase))
                {
                    config.RelayUrl = value.TrimEnd('/');
                }
                else if (key.Equals("AGENT_ID", StringComparison.OrdinalIgnoreCase))
                {
                    config.AgentId = value;
                }
                else if (key.Equals("AGENT_TOKEN", StringComparison.OrdinalIgnoreCase))
                {
                    config.Token = value;
                }
                else if (key.Equals("POLL_SECONDS", StringComparison.OrdinalIgnoreCase))
                {
                    int seconds;
                    if (int.TryParse(value, out seconds))
                    {
                        config.PollSeconds = Math.Max(2, Math.Min(seconds, 120));
                    }
                }
            }

            return config;
        }

        public void Save()
        {
            Directory.CreateDirectory(ConfigDirectory);
            var lines = new List<string>
            {
                "RELAY_URL=" + (RelayUrl ?? "").TrimEnd('/'),
                "AGENT_ID=" + (AgentId ?? "").Trim(),
                "AGENT_TOKEN=" + (Token ?? "").Trim(),
                "POLL_SECONDS=" + PollSeconds
            };
            File.WriteAllLines(ConfigPath, lines);
        }

        public void Validate()
        {
            Uri uri;
            if (!Uri.TryCreate(RelayUrl, UriKind.Absolute, out uri))
            {
                throw new InvalidOperationException("Relay URL must be an absolute HTTP or HTTPS URL.");
            }
            if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
            {
                throw new InvalidOperationException("Relay URL must use HTTP or HTTPS.");
            }
            if (string.IsNullOrWhiteSpace(AgentId))
            {
                throw new InvalidOperationException("Agent ID is required.");
            }
            if (string.IsNullOrWhiteSpace(Token))
            {
                throw new InvalidOperationException("Agent token is required.");
            }
        }
    }
}

