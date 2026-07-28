using RelayAgent.Shared;
using System;
using System.Diagnostics;
using System.IO;
using Microsoft.Win32;
using System.Net.Http;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace RelayAgent.Client
{
    public sealed class AutoUpdater
    {
        private const string LatestReleaseApi = "https://api.github.com/repos/tengfei1994/Relay-MCP/releases/latest";
        public const string CurrentRelease = "v0.4.0";

        public async Task<UpdateInfo> CheckLatestAsync()
        {
            using (var client = new HttpClient())
            {
                client.Timeout = TimeSpan.FromSeconds(30);
                client.DefaultRequestHeaders.UserAgent.ParseAdd("RelayAgent.Client");
                var json = await client.GetStringAsync(LatestReleaseApi);
                var tag = MatchJsonString(json, "tag_name");
                var downloadUrl = FindClientDownloadUrl(json);
                if (string.IsNullOrWhiteSpace(downloadUrl))
                {
                    throw new InvalidOperationException("Latest GitHub release does not contain RelayAgent.Client.exe.");
                }

                return new UpdateInfo(tag, downloadUrl, string.Equals(NormalizeTag(tag), NormalizeTag(CurrentRelease), StringComparison.OrdinalIgnoreCase));
            }
        }

        public async Task StageAndRestartAsync(UpdateInfo update)
        {
            var currentExe = Process.GetCurrentProcess().MainModule.FileName;
            var serviceExe = GetServiceExecutablePath();
            if (string.IsNullOrWhiteSpace(serviceExe))
            {
                serviceExe = currentExe;
            }
            var stageDir = Path.Combine(Path.GetTempPath(), "RelayMcpAgentUpdate");
            Directory.CreateDirectory(stageDir);
            var stagedExe = Path.Combine(stageDir, "RelayAgent.Client.exe");

            using (var client = new HttpClient())
            {
                client.Timeout = TimeSpan.FromMinutes(5);
                client.DefaultRequestHeaders.UserAgent.ParseAdd("RelayAgent.Client");
                var bytes = await client.GetByteArrayAsync(update.DownloadUrl);
                File.WriteAllBytes(stagedExe, bytes);
            }

            var script = Path.Combine(stageDir, "apply-update.cmd");
            var copyCurrent = string.Equals(currentExe, serviceExe, StringComparison.OrdinalIgnoreCase)
                ? ""
                : "copy /Y \"" + stagedExe + "\" \"" + currentExe + "\" >nul\r\n";
            File.WriteAllText(script,
                "@echo off\r\n" +
                "net stop " + AgentConfig.ServiceName + " >nul 2>&1\r\n" +
                "timeout /t 2 /nobreak >nul\r\n" +
                "copy /Y \"" + stagedExe + "\" \"" + serviceExe + "\" >nul\r\n" +
                copyCurrent +
                "net start " + AgentConfig.ServiceName + " >nul 2>&1\r\n" +
                "start \"\" \"" + currentExe + "\"\r\n" +
                "del \"%~f0\"\r\n");

            var info = new ProcessStartInfo("cmd.exe", "/c \"" + script + "\"");
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            Process.Start(info);
        }

        private static string GetServiceExecutablePath()
        {
            using (var key = Registry.LocalMachine.OpenSubKey(
                @"SYSTEM\CurrentControlSet\Services\" + AgentConfig.ServiceName))
            {
                var imagePath = key == null ? null : key.GetValue("ImagePath") as string;
                if (string.IsNullOrWhiteSpace(imagePath))
                {
                    return "";
                }
                var expanded = Environment.ExpandEnvironmentVariables(imagePath.Trim());
                if (expanded.StartsWith("\"", StringComparison.Ordinal))
                {
                    var closingQuote = expanded.IndexOf('"', 1);
                    return closingQuote > 1 ? expanded.Substring(1, closingQuote - 1) : "";
                }
                var serviceArgument = expanded.IndexOf(" --service", StringComparison.OrdinalIgnoreCase);
                return (serviceArgument > 0 ? expanded.Substring(0, serviceArgument) : expanded).Trim();
            }
        }

        private static string MatchJsonString(string json, string property)
        {
            var match = Regex.Match(json, "\"" + Regex.Escape(property) + "\"\\s*:\\s*\"(?<value>(?:\\\\.|[^\"])*)\"");
            return match.Success ? Regex.Unescape(match.Groups["value"].Value) : "";
        }

        private static string FindClientDownloadUrl(string json)
        {
            foreach (Match match in Regex.Matches(json, "\"browser_download_url\"\\s*:\\s*\"(?<value>(?:\\\\.|[^\"])*)\""))
            {
                var value = Regex.Unescape(match.Groups["value"].Value);
                if (value.EndsWith("/RelayAgent.Client.exe", StringComparison.OrdinalIgnoreCase))
                {
                    return value;
                }
            }
            return "";
        }

        private static string NormalizeTag(string tag)
        {
            return (tag ?? "").Trim().TrimStart('v', 'V');
        }
    }

    public sealed class UpdateInfo
    {
        public UpdateInfo(string tagName, string downloadUrl, bool isCurrent)
        {
            TagName = tagName;
            DownloadUrl = downloadUrl;
            IsCurrent = isCurrent;
        }

        public string TagName { get; private set; }

        public string DownloadUrl { get; private set; }

        public bool IsCurrent { get; private set; }
    }
}
