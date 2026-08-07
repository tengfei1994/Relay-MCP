using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace RelayAgent.Shared
{
    public sealed class CommandAuditEntry
    {
        public string jobId { get; set; }
        public string kind { get; set; }
        public string instruction { get; set; }
        public string command { get; set; }
        public string executedCommand { get; set; }
        public string status { get; set; }
        public int? exitCode { get; set; }
        public int timeoutMs { get; set; }
        public string startedAt { get; set; }
        public string finishedAt { get; set; }
        public long durationMs { get; set; }
        public string stdout { get; set; }
        public string stderr { get; set; }
        public string message { get; set; }
        public bool? resultPosted { get; set; }
        public string resultPostError { get; set; }
    }

    public sealed class CommandAuditSummary
    {
        public string jobId { get; set; }
        public string kind { get; set; }
        public string instruction { get; set; }
        public string status { get; set; }
        public int? exitCode { get; set; }
        public int timeoutMs { get; set; }
        public string startedAt { get; set; }
        public string finishedAt { get; set; }
        public long durationMs { get; set; }
        public bool? resultPosted { get; set; }
    }

    public static class CommandAuditStore
    {
        private const int MaximumTextCharacters = 262144;
        private static readonly object FileLock = new object();
        private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer
        {
            MaxJsonLength = int.MaxValue,
            RecursionLimit = 64
        };
        private static DateTimeOffset _lastPruneAt = DateTimeOffset.MinValue;

        public static string AuditDirectory
        {
            get { return Path.Combine(AgentConfig.ConfigDirectory, "command-audit"); }
        }

        public static void Start(
            string jobId,
            string kind,
            string instruction,
            string command,
            string executedCommand,
            int timeoutMs,
            bool enabled,
            bool capturePayloads,
            int retentionDays)
        {
            if (!enabled || string.IsNullOrWhiteSpace(jobId)) return;
            try
            {
                EnsureDirectory();
                Prune(retentionDays);
                Write(new CommandAuditEntry
                {
                    jobId = jobId,
                    kind = kind ?? "unknown",
                    instruction = capturePayloads ? Redact(instruction) : "Command capture disabled",
                    command = capturePayloads ? Redact(command) : "Command capture disabled",
                    executedCommand = capturePayloads ? Redact(executedCommand) : "Command capture disabled",
                    status = "running",
                    timeoutMs = Math.Max(0, timeoutMs),
                    startedAt = DateTimeOffset.UtcNow.ToString("o"),
                    stdout = "",
                    stderr = "",
                    message = ""
                });
            }
            catch
            {
                // Audit must never stop command execution.
            }
        }

        public static void Complete(
            string jobId,
            string status,
            int exitCode,
            string stdout,
            string stderr,
            string message)
        {
            Update(jobId, entry =>
            {
                var finished = DateTimeOffset.UtcNow;
                entry.status = status ?? "failed";
                entry.exitCode = exitCode;
                entry.stdout = Redact(stdout);
                entry.stderr = Redact(stderr);
                entry.message = Redact(message);
                entry.finishedAt = finished.ToString("o");
                entry.durationMs = Duration(entry.startedAt, finished);
            });
        }

        public static void MarkResultPosted(string jobId, bool posted, string error)
        {
            Update(jobId, entry =>
            {
                entry.resultPosted = posted;
                entry.resultPostError = posted ? "" : Redact(error);
            });
        }

        public static IList<CommandAuditSummary> ReadRecent(int maximum, string kindFilter, string statusFilter)
        {
            lock (FileLock)
            {
                if (!Directory.Exists(AuditDirectory)) return new List<CommandAuditSummary>();
                EnsureLegacyIndexes(Math.Min(Math.Max(1, maximum), 20));

                var entries = new List<CommandAuditSummary>();
                var files = new DirectoryInfo(AuditDirectory)
                    .EnumerateFiles("*.index", SearchOption.TopDirectoryOnly)
                    .OrderByDescending(file => file.LastWriteTimeUtc);
                foreach (var file in files)
                {
                    var entry = ReadSummary(file.FullName);
                    if (entry == null || !Matches(entry, kindFilter, statusFilter)) continue;
                    entries.Add(entry);
                    if (entries.Count >= Math.Max(1, Math.Min(maximum, 200))) break;
                }
                return entries;
            }
        }

        private static void EnsureLegacyIndexes(int maximum)
        {
            var migrated = false;
            foreach (var detail in new DirectoryInfo(AuditDirectory)
                .EnumerateFiles("*.json", SearchOption.TopDirectoryOnly)
                .OrderByDescending(file => file.LastWriteTimeUtc)
                .Where(file => !File.Exists(Path.ChangeExtension(file.FullName, ".index")))
                .Take(maximum))
            {
                var entry = Read(detail.FullName);
                if (entry == null) continue;
                WriteSummary(entry);
                var index = Path.ChangeExtension(detail.FullName, ".index");
                try { File.SetLastWriteTimeUtc(index, detail.LastWriteTimeUtc); } catch { }
                migrated = true;
            }
            if (migrated)
            {
                GC.Collect(2, GCCollectionMode.Optimized, false);
            }
        }

        public static CommandAuditEntry ReadDetail(string jobId)
        {
            if (string.IsNullOrWhiteSpace(jobId)) return null;
            lock (FileLock)
            {
                return Read(Path.Combine(AuditDirectory, SafeFileName(jobId) + ".json"));
            }
        }

        public static void Clear()
        {
            lock (FileLock)
            {
                if (!Directory.Exists(AuditDirectory)) return;
                foreach (var file in Directory.EnumerateFiles(AuditDirectory, "*.json"))
                {
                    try { File.Delete(file); } catch { }
                }
                foreach (var file in Directory.EnumerateFiles(AuditDirectory, "*.index"))
                {
                    try { File.Delete(file); } catch { }
                }
            }
        }

        public static void Export(string destination)
        {
            var summaries = ReadRecent(200, "All", "All");
            using (var writer = new StreamWriter(destination, false, new UTF8Encoding(false)))
            {
                foreach (var summary in summaries)
                {
                    var detail = ReadDetail(summary.jobId);
                    if (detail != null) writer.WriteLine(Serializer.Serialize(detail));
                }
            }
        }

        public static string DisplayKind(string kind)
        {
            if (string.Equals(kind, "powershell", StringComparison.OrdinalIgnoreCase)) return "PowerShell";
            if (string.Equals(kind, "exec", StringComparison.OrdinalIgnoreCase)) return "Shell";
            if (string.Equals(kind, "artifact-upload", StringComparison.OrdinalIgnoreCase)) return "Artifact";
            if (string.Equals(kind, "playwright", StringComparison.OrdinalIgnoreCase)) return "Playwright";
            return string.IsNullOrWhiteSpace(kind) ? "Unknown" : kind;
        }

        private static bool Matches(CommandAuditSummary entry, string kindFilter, string statusFilter)
        {
            if (!string.IsNullOrWhiteSpace(kindFilter) && !kindFilter.Equals("All", StringComparison.OrdinalIgnoreCase) &&
                !DisplayKind(entry.kind).Equals(kindFilter, StringComparison.OrdinalIgnoreCase)) return false;
            if (!string.IsNullOrWhiteSpace(statusFilter) && !statusFilter.Equals("All", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(entry.status, statusFilter, StringComparison.OrdinalIgnoreCase)) return false;
            return true;
        }

        private static void Update(string jobId, Action<CommandAuditEntry> update)
        {
            if (string.IsNullOrWhiteSpace(jobId)) return;
            try
            {
                lock (FileLock)
                {
                    var path = Path.Combine(AuditDirectory, SafeFileName(jobId) + ".json");
                    var entry = Read(path);
                    if (entry == null) return;
                    update(entry);
                    Write(entry);
                }
            }
            catch
            {
                // Audit must never stop command execution.
            }
        }

        private static void Write(CommandAuditEntry entry)
        {
            EnsureDirectory();
            var path = Path.Combine(AuditDirectory, SafeFileName(entry.jobId) + ".json");
            WriteAtomic(path, Serializer.Serialize(entry));
            WriteSummary(entry);
        }

        private static void WriteSummary(CommandAuditEntry entry)
        {
            var path = Path.Combine(AuditDirectory, SafeFileName(entry.jobId) + ".index");
            WriteAtomic(path, Serializer.Serialize(new CommandAuditSummary
            {
                jobId = entry.jobId,
                kind = entry.kind,
                instruction = Compact(entry.instruction, 240),
                status = entry.status,
                exitCode = entry.exitCode,
                timeoutMs = entry.timeoutMs,
                startedAt = entry.startedAt,
                finishedAt = entry.finishedAt,
                durationMs = entry.durationMs,
                resultPosted = entry.resultPosted
            }));
        }

        private static void WriteAtomic(string path, string content)
        {
            var temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
            File.WriteAllText(temporary, content, new UTF8Encoding(false));
            try
            {
                if (File.Exists(path)) File.Replace(temporary, path, null);
                else File.Move(temporary, path);
            }
            finally
            {
                try { if (File.Exists(temporary)) File.Delete(temporary); } catch { }
            }
        }

        private static CommandAuditSummary ReadSummary(string path)
        {
            try
            {
                if (!File.Exists(path)) return null;
                using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                using (var reader = new StreamReader(stream, Encoding.UTF8, true))
                {
                    return Serializer.Deserialize<CommandAuditSummary>(reader.ReadToEnd());
                }
            }
            catch
            {
                return null;
            }
        }

        private static CommandAuditEntry Read(string path)
        {
            try
            {
                if (!File.Exists(path)) return null;
                using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                using (var reader = new StreamReader(stream, Encoding.UTF8, true))
                {
                    return Serializer.Deserialize<CommandAuditEntry>(reader.ReadToEnd());
                }
            }
            catch
            {
                return null;
            }
        }

        private static void EnsureDirectory()
        {
            Directory.CreateDirectory(AuditDirectory);
        }

        private static void Prune(int retentionDays)
        {
            if (DateTimeOffset.UtcNow - _lastPruneAt < TimeSpan.FromHours(1)) return;
            _lastPruneAt = DateTimeOffset.UtcNow;
            var cutoff = DateTime.UtcNow.AddDays(-Math.Max(1, retentionDays));
            foreach (var file in new DirectoryInfo(AuditDirectory).EnumerateFiles("*.json"))
            {
                try
                {
                    if (file.LastWriteTimeUtc >= cutoff) continue;
                    var index = Path.ChangeExtension(file.FullName, ".index");
                    file.Delete();
                    if (File.Exists(index)) File.Delete(index);
                }
                catch { }
            }
        }

        private static long Duration(string startedAt, DateTimeOffset finished)
        {
            DateTimeOffset started;
            return DateTimeOffset.TryParse(startedAt, out started)
                ? Math.Max(0, (long)(finished - started).TotalMilliseconds)
                : 0;
        }

        private static string SafeFileName(string value)
        {
            return Regex.Replace(value ?? "job", "[^A-Za-z0-9._-]", "_");
        }

        private static string Compact(string value, int maximum)
        {
            if (string.IsNullOrWhiteSpace(value)) return "";
            var compact = Regex.Replace(value.Trim(), "\\s+", " ");
            return compact.Length <= maximum
                ? compact
                : compact.Substring(0, maximum) + "...";
        }

        public static string Redact(string value)
        {
            if (string.IsNullOrEmpty(value)) return "";
            var sanitized = Regex.Replace(value, "(?i)Bearer\\s+[A-Za-z0-9._~+/=-]+", "Bearer [REDACTED]");
            sanitized = Regex.Replace(
                sanitized,
                "(?i)(authorization|agent[_-]?token|access[_-]?token|password|secret|api[_-]?key|connectionstring)\\s*[:=]\\s*(['\"]?)[^\\s,;'\"]+\\2",
                "$1=[REDACTED]");
            if (sanitized.Length <= MaximumTextCharacters) return sanitized;
            return sanitized.Substring(0, MaximumTextCharacters) + "\n[TRUNCATED]";
        }
    }
}
