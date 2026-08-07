using System;
using System.Collections.Generic;
using System.IO;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

namespace RelayAgent.Shared
{
    public sealed class AgentConfig
    {
        public const string ServiceName = "RelayMcpAgent";
        private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("RelayMcpAgent.Config.v2");

        public string RelayUrl { get; set; } = "";
        public string AgentId { get; set; } = Environment.MachineName;
        public string Token { get; set; } = "";
        public int PollSeconds { get; set; } = 10;
        public bool AuditEnabled { get; set; } = true;
        public bool AuditLogPayloads { get; set; } = true;
        public int AuditRetentionDays { get; set; } = 14;

        public static string ConfigDirectory
        {
            get
            {
                var overridePath = Environment.GetEnvironmentVariable("RELAY_AGENT_CONFIG_DIR");
                if (!string.IsNullOrWhiteSpace(overridePath))
                {
                    return Path.GetFullPath(overridePath);
                }

                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                    "RelayMcpAgent");
            }
        }

        public static string ConfigPath
        {
            get { return Path.Combine(ConfigDirectory, "agent.env"); }
        }

        public static string AgentLogPath
        {
            get { return Path.Combine(ConfigDirectory, "agent.log"); }
        }

        public static string LastHeartbeatPath
        {
            get { return Path.Combine(ConfigDirectory, "last-heartbeat.txt"); }
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
                if (key.Equals("RELAY_URL_PROTECTED", StringComparison.OrdinalIgnoreCase))
                {
                    config.RelayUrl = Unprotect(value).TrimEnd('/');
                }
                else if (key.Equals("RELAY_URL", StringComparison.OrdinalIgnoreCase) &&
                         string.IsNullOrWhiteSpace(config.RelayUrl))
                {
                    config.RelayUrl = value.TrimEnd('/');
                }
                else if (key.Equals("AGENT_ID", StringComparison.OrdinalIgnoreCase))
                {
                    config.AgentId = value;
                }
                else if (key.Equals("AGENT_TOKEN_PROTECTED", StringComparison.OrdinalIgnoreCase))
                {
                    config.Token = Unprotect(value);
                }
                else if (key.Equals("AGENT_TOKEN", StringComparison.OrdinalIgnoreCase) &&
                         string.IsNullOrWhiteSpace(config.Token))
                {
                    config.Token = value;
                }
                else if (key.Equals("POLL_SECONDS", StringComparison.OrdinalIgnoreCase))
                {
                    config.PollSeconds = ParseInt(value, 10, 2, 120);
                }
                else if (key.Equals("AUDIT_ENABLED", StringComparison.OrdinalIgnoreCase))
                {
                    config.AuditEnabled = ParseBool(value, true);
                }
                else if (key.Equals("AUDIT_LOG_PAYLOADS", StringComparison.OrdinalIgnoreCase))
                {
                    config.AuditLogPayloads = ParseBool(value, true);
                }
                else if (key.Equals("AUDIT_RETENTION_DAYS", StringComparison.OrdinalIgnoreCase))
                {
                    config.AuditRetentionDays = ParseInt(value, 14, 1, 365);
                }
            }

            return config;
        }

        public void Save()
        {
            Validate();
            Directory.CreateDirectory(ConfigDirectory);
            SecureDirectory(ConfigDirectory);

            var lines = new List<string>
            {
                "CONFIG_VERSION=2",
                "RELAY_URL_PROTECTED=" + Protect((RelayUrl ?? "").TrimEnd('/')),
                "AGENT_ID=" + (AgentId ?? "").Trim(),
                "AGENT_TOKEN_PROTECTED=" + Protect((Token ?? "").Trim()),
                "POLL_SECONDS=" + Math.Max(2, Math.Min(PollSeconds, 120)),
                "AUDIT_ENABLED=" + AuditEnabled.ToString().ToLowerInvariant(),
                "AUDIT_LOG_PAYLOADS=" + AuditLogPayloads.ToString().ToLowerInvariant(),
                "AUDIT_RETENTION_DAYS=" + Math.Max(1, Math.Min(AuditRetentionDays, 365))
            };

            var tempPath = ConfigPath + ".tmp";
            File.WriteAllLines(tempPath, lines, new UTF8Encoding(false));
            SecureFile(tempPath);

            if (File.Exists(ConfigPath))
            {
                try
                {
                    File.Replace(tempPath, ConfigPath, null);
                }
                catch
                {
                    File.Copy(tempPath, ConfigPath, true);
                    File.Delete(tempPath);
                }
            }
            else
            {
                File.Move(tempPath, ConfigPath);
            }

            SecureFile(ConfigPath);
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

        public static string MaskRelayUrl(string relayUrl)
        {
            Uri uri;
            if (!Uri.TryCreate(relayUrl, UriKind.Absolute, out uri))
            {
                return "Not configured";
            }

            return uri.Scheme + "://************";
        }

        public static string MaskToken(string token)
        {
            if (string.IsNullOrWhiteSpace(token))
            {
                return "Not configured";
            }

            var suffix = token.Length <= 4 ? token : token.Substring(token.Length - 4);
            return new string('*', 12) + suffix;
        }

        private static string Protect(string value)
        {
            var bytes = Encoding.UTF8.GetBytes(value ?? "");
            var protectedBytes = ProtectedData.Protect(bytes, Entropy, DataProtectionScope.LocalMachine);
            return Convert.ToBase64String(protectedBytes);
        }

        private static string Unprotect(string value)
        {
            try
            {
                var protectedBytes = Convert.FromBase64String(value);
                var bytes = ProtectedData.Unprotect(protectedBytes, Entropy, DataProtectionScope.LocalMachine);
                return Encoding.UTF8.GetString(bytes);
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException(
                    "Relay Agent configuration could not be decrypted on this machine.", ex);
            }
        }

        private static int ParseInt(string value, int fallback, int minimum, int maximum)
        {
            int parsed;
            return int.TryParse(value, out parsed)
                ? Math.Max(minimum, Math.Min(parsed, maximum))
                : fallback;
        }

        private static bool ParseBool(string value, bool fallback)
        {
            bool parsed;
            return bool.TryParse(value, out parsed) ? parsed : fallback;
        }

        private static void SecureDirectory(string path)
        {
            try
            {
                var security = new DirectorySecurity();
                security.SetAccessRuleProtection(true, false);
                security.AddAccessRule(new FileSystemAccessRule(
                    new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                    FileSystemRights.FullControl,
                    InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                    PropagationFlags.None,
                    AccessControlType.Allow));
                security.AddAccessRule(new FileSystemAccessRule(
                    new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
                    FileSystemRights.FullControl,
                    InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                    PropagationFlags.None,
                    AccessControlType.Allow));
                security.AddAccessRule(new FileSystemAccessRule(
                    WindowsIdentity.GetCurrent().User,
                    FileSystemRights.FullControl,
                    InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                    PropagationFlags.None,
                    AccessControlType.Allow));
                Directory.SetAccessControl(path, security);
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException(
                    "Unable to secure the Relay Agent configuration directory. Run the client as administrator.", ex);
            }
        }

        private static void SecureFile(string path)
        {
            try
            {
                var security = new FileSecurity();
                security.SetAccessRuleProtection(true, false);
                security.AddAccessRule(new FileSystemAccessRule(
                    new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                    FileSystemRights.FullControl,
                    AccessControlType.Allow));
                security.AddAccessRule(new FileSystemAccessRule(
                    new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
                    FileSystemRights.FullControl,
                    AccessControlType.Allow));
                security.AddAccessRule(new FileSystemAccessRule(
                    WindowsIdentity.GetCurrent().User,
                    FileSystemRights.FullControl,
                    AccessControlType.Allow));
                File.SetAccessControl(path, security);
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException(
                    "Unable to secure the Relay Agent configuration file. Run the client as administrator.", ex);
            }
        }
    }
}
