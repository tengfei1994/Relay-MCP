using RelayAgent.Shared;
using System;
using System.Diagnostics;
using System.IO;
using Microsoft.Win32;
using System.Net.Http;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace RelayAgent.Client
{
    public sealed class AutoUpdater
    {
        private const string LatestReleaseApi = "https://api.github.com/repos/tengfei1994/Relay-MCP/releases/latest";
        private const string LatestReleasePage = "https://github.com/tengfei1994/Relay-MCP/releases/latest";
        private const string ReleaseDownloadBase = "https://github.com/tengfei1994/Relay-MCP/releases/download/";
        private static readonly TimeSpan CheckTimeout = TimeSpan.FromSeconds(30);
        private static readonly TimeSpan DownloadTimeout = TimeSpan.FromMinutes(5);
        public const string CurrentRelease = "v0.7.5";

        public async Task<UpdateInfo> CheckLatestAsync(
            IProgress<UpdateProgress> progress = null,
            CancellationToken cancellationToken = default(CancellationToken))
        {
            Exception apiFailure;
            Report(progress, "Connecting", "Connecting to the GitHub Releases API...", true);

            using (var client = CreateClient(CheckTimeout))
            {
                try
                {
                    using (var response = await client.GetAsync(
                        LatestReleaseApi,
                        HttpCompletionOption.ResponseHeadersRead,
                        cancellationToken))
                    {
                        response.EnsureSuccessStatusCode();
                        Report(progress, "Reading release", "GitHub responded. Reading release metadata...", true);
                        var json = await response.Content.ReadAsStringAsync();
                        var tag = MatchJsonString(json, "tag_name");
                        var downloadUrl = FindClientDownloadUrl(json);
                        if (string.IsNullOrWhiteSpace(tag))
                        {
                            throw new InvalidOperationException("GitHub returned a release without a version tag.");
                        }
                        if (string.IsNullOrWhiteSpace(downloadUrl))
                        {
                            throw new InvalidOperationException("Latest GitHub release does not contain RelayAgent.Client.exe.");
                        }

                        return BuildUpdateInfo(tag, downloadUrl, progress);
                    }
                }
                catch (TaskCanceledException ex)
                {
                    if (cancellationToken.IsCancellationRequested)
                    {
                        throw;
                    }
                    apiFailure = new TimeoutException(
                        "GitHub API timed out after 30 seconds.",
                        ex);
                }
                catch (Exception ex)
                {
                    apiFailure = ex;
                }
            }

            Report(
                progress,
                "Trying fallback",
                "GitHub API is unavailable or rate limited. Trying the public release page...",
                true);
            using (var client = CreateClient(CheckTimeout))
            {
                try
                {
                    using (var response = await client.GetAsync(
                        LatestReleasePage,
                        HttpCompletionOption.ResponseHeadersRead,
                        cancellationToken))
                    {
                        response.EnsureSuccessStatusCode();
                        var finalUri = response.RequestMessage == null
                            ? null
                            : response.RequestMessage.RequestUri;
                        var tag = ExtractReleaseTag(finalUri);
                        if (string.IsNullOrWhiteSpace(tag))
                        {
                            throw new InvalidOperationException(
                                "GitHub release fallback did not resolve to a versioned release page.");
                        }

                        var downloadUrl = ReleaseDownloadBase +
                            Uri.EscapeDataString(tag) +
                            "/RelayAgent.Client.exe";
                        return BuildUpdateInfo(tag, downloadUrl, progress);
                    }
                }
                catch (TaskCanceledException ex)
                {
                    if (cancellationToken.IsCancellationRequested)
                    {
                        throw;
                    }
                    throw new TimeoutException(
                        "GitHub update check timed out. API result: " + FriendlyFailure(apiFailure) +
                        " Fallback release page also timed out after 30 seconds.",
                        ex);
                }
                catch (Exception ex)
                {
                    throw new InvalidOperationException(
                        "Could not check for updates. API result: " + FriendlyFailure(apiFailure) +
                        " Fallback result: " + ex.Message,
                        ex);
                }
            }
        }

        public async Task StageAndRestartAsync(
            UpdateInfo update,
            IProgress<UpdateProgress> progress = null,
            CancellationToken cancellationToken = default(CancellationToken))
        {
            if (update == null)
            {
                throw new ArgumentNullException("update");
            }

            var currentExe = Process.GetCurrentProcess().MainModule.FileName;
            var serviceExe = GetServiceExecutablePath();
            if (string.IsNullOrWhiteSpace(serviceExe))
            {
                serviceExe = currentExe;
            }
            var stageDir = Path.Combine(Path.GetTempPath(), "RelayMcpAgentUpdate");
            Directory.CreateDirectory(stageDir);
            var stagedExe = Path.Combine(stageDir, "RelayAgent.Client.exe");
            var partialExe = stagedExe + ".download";

            try
            {
                Report(progress, "Starting download", "Requesting RelayAgent.Client.exe from GitHub...", true);
                using (var client = CreateClient(DownloadTimeout))
                using (var response = await client.GetAsync(
                    update.DownloadUrl,
                    HttpCompletionOption.ResponseHeadersRead,
                    cancellationToken))
                {
                    response.EnsureSuccessStatusCode();
                    var totalBytes = response.Content.Headers.ContentLength;
                    using (var source = await response.Content.ReadAsStreamAsync())
                    using (var destination = new FileStream(
                        partialExe,
                        FileMode.Create,
                        FileAccess.Write,
                        FileShare.None,
                        81920,
                        true))
                    {
                        var buffer = new byte[81920];
                        long received = 0;
                        var reportTimer = Stopwatch.StartNew();
                        while (true)
                        {
                            var read = await source.ReadAsync(buffer, 0, buffer.Length, cancellationToken);
                            if (read <= 0)
                            {
                                break;
                            }

                            await destination.WriteAsync(buffer, 0, read, cancellationToken);
                            received += read;
                            if (reportTimer.ElapsedMilliseconds >= 150 ||
                                (totalBytes.HasValue && received >= totalBytes.Value))
                            {
                                ReportDownloadProgress(progress, received, totalBytes);
                                reportTimer.Restart();
                            }
                        }
                        await destination.FlushAsync(cancellationToken);
                        ReportDownloadProgress(progress, received, totalBytes);
                    }
                }

                ValidateDownloadedExecutable(partialExe);
                File.Copy(partialExe, stagedExe, true);
                File.Delete(partialExe);
            }
            catch (TaskCanceledException ex)
            {
                TryDelete(partialExe);
                if (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                throw new TimeoutException(
                    "Client download timed out after 5 minutes. The partial download was removed; it is safe to retry.",
                    ex);
            }
            catch (HttpRequestException ex)
            {
                TryDelete(partialExe);
                throw new InvalidOperationException(
                    "Client download failed while connecting to GitHub. The partial download was removed. " + ex.Message,
                    ex);
            }
            catch
            {
                TryDelete(partialExe);
                throw;
            }

            Report(progress, "Preparing update", "Download verified. Preparing service replacement...", false, 100);
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

            Report(progress, "Restarting", "Update is ready. Restarting the Agent service and client...", true);
            var info = new ProcessStartInfo("cmd.exe", "/c \"" + script + "\"");
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            Process.Start(info);
        }

        private static HttpClient CreateClient(TimeSpan timeout)
        {
            var client = new HttpClient();
            client.Timeout = timeout;
            client.DefaultRequestHeaders.UserAgent.ParseAdd("RelayAgent.Client/" + NormalizeTag(CurrentRelease));
            return client;
        }

        private static void ReportDownloadProgress(
            IProgress<UpdateProgress> progress,
            long received,
            long? totalBytes)
        {
            var percentage = totalBytes.HasValue && totalBytes.Value > 0
                ? (int)Math.Min(100, received * 100L / totalBytes.Value)
                : (int?)null;
            Report(
                progress,
                "Downloading",
                totalBytes.HasValue
                    ? FormatBytes(received) + " of " + FormatBytes(totalBytes.Value)
                    : FormatBytes(received) + " downloaded",
                !percentage.HasValue,
                percentage,
                received,
                totalBytes);
        }

        private static void Report(
            IProgress<UpdateProgress> progress,
            string stage,
            string message,
            bool isIndeterminate,
            int? percentage = null,
            long bytesReceived = 0,
            long? totalBytes = null)
        {
            if (progress != null)
            {
                progress.Report(new UpdateProgress(
                    stage,
                    message,
                    isIndeterminate,
                    percentage,
                    bytesReceived,
                    totalBytes));
            }
        }

        private static void ValidateDownloadedExecutable(string path)
        {
            var file = new FileInfo(path);
            if (!file.Exists || file.Length < 64)
            {
                throw new InvalidDataException("Downloaded client file is empty or incomplete.");
            }

            using (var stream = File.OpenRead(path))
            {
                if (stream.ReadByte() != 'M' || stream.ReadByte() != 'Z')
                {
                    throw new InvalidDataException("Downloaded file is not a valid Windows executable.");
                }
            }
        }

        private static void TryDelete(string path)
        {
            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch
            {
                // A stale partial file will be overwritten on the next attempt.
            }
        }

        private static string FormatBytes(long bytes)
        {
            if (bytes >= 1024L * 1024L)
            {
                return (bytes / (1024d * 1024d)).ToString("0.0") + " MB";
            }
            if (bytes >= 1024L)
            {
                return (bytes / 1024d).ToString("0.0") + " KB";
            }
            return bytes + " B";
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

        private static UpdateInfo BuildUpdateInfo(
            string tag,
            string downloadUrl,
            IProgress<UpdateProgress> progress)
        {
            Report(progress, "Release found", "Latest release is " + tag + ".", false, 100);
            var comparison = CompareReleaseTags(CurrentRelease, tag);
            return new UpdateInfo(
                tag,
                downloadUrl,
                comparison >= 0,
                comparison > 0);
        }

        private static string ExtractReleaseTag(Uri uri)
        {
            if (uri == null)
            {
                return "";
            }

            var match = Regex.Match(
                uri.AbsolutePath,
                @"/releases/tag/(?<tag>[^/?#]+)",
                RegexOptions.IgnoreCase);
            return match.Success
                ? Uri.UnescapeDataString(match.Groups["tag"].Value)
                : "";
        }

        private static string FriendlyFailure(Exception failure)
        {
            if (failure == null)
            {
                return "unknown failure.";
            }
            var message = string.IsNullOrWhiteSpace(failure.Message)
                ? failure.GetType().Name
                : failure.Message;
            return message.Trim().TrimEnd('.') + ".";
        }

        private static string NormalizeTag(string tag)
        {
            return (tag ?? "").Trim().TrimStart('v', 'V');
        }

        private static int CompareReleaseTags(string current, string latest)
        {
            Version currentVersion;
            Version latestVersion;
            if (Version.TryParse(NormalizeTag(current), out currentVersion) &&
                Version.TryParse(NormalizeTag(latest), out latestVersion))
            {
                return currentVersion.CompareTo(latestVersion);
            }
            return string.Equals(
                NormalizeTag(current),
                NormalizeTag(latest),
                StringComparison.OrdinalIgnoreCase)
                ? 0
                : -1;
        }
    }

    public sealed class UpdateInfo
    {
        public UpdateInfo(
            string tagName,
            string downloadUrl,
            bool isCurrent,
            bool isNewerThanLatest)
        {
            TagName = tagName;
            DownloadUrl = downloadUrl;
            IsCurrent = isCurrent;
            IsNewerThanLatest = isNewerThanLatest;
        }

        public string TagName { get; private set; }

        public string DownloadUrl { get; private set; }

        public bool IsCurrent { get; private set; }

        public bool IsNewerThanLatest { get; private set; }
    }

    public sealed class UpdateProgress
    {
        public UpdateProgress(
            string stage,
            string message,
            bool isIndeterminate,
            int? percentage,
            long bytesReceived,
            long? totalBytes)
        {
            Stage = stage;
            Message = message;
            IsIndeterminate = isIndeterminate;
            Percentage = percentage;
            BytesReceived = bytesReceived;
            TotalBytes = totalBytes;
        }

        public string Stage { get; private set; }

        public string Message { get; private set; }

        public bool IsIndeterminate { get; private set; }

        public int? Percentage { get; private set; }

        public long BytesReceived { get; private set; }

        public long? TotalBytes { get; private set; }
    }
}
