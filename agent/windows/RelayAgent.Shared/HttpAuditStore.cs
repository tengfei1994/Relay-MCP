using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace RelayAgent.Shared
{
    public sealed class HttpAuditEntry
    {
        public string timestamp { get; set; }
        public string method { get; set; }
        public string endpoint { get; set; }
        public int? statusCode { get; set; }
        public long durationMs { get; set; }
        public string jobId { get; set; }
        public string requestBody { get; set; }
        public string responseBody { get; set; }
        public string error { get; set; }
    }

    public static class HttpAuditStore
    {
        private const int MaxPayloadCharacters = 1048576;
        private static readonly object FileLock = new object();
        private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer
        {
            MaxJsonLength = int.MaxValue,
            RecursionLimit = 64
        };
        private static DateTimeOffset _lastPruneAt = DateTimeOffset.MinValue;

        public static string AuditPath
        {
            get { return Path.Combine(AgentConfig.ConfigDirectory, "http-audit.jsonl"); }
        }

        public static async Task<HttpResponseMessage> SendAsync(
            HttpClient client,
            HttpRequestMessage request,
            AgentConfig config,
            string jobId,
            CancellationToken token)
        {
            string requestBody = null;
            if (request.Content != null && config.AuditEnabled && config.AuditLogPayloads)
            {
                requestBody = await request.Content.ReadAsStringAsync();
            }

            var watch = Stopwatch.StartNew();
            HttpResponseMessage response = null;
            string responseBody = null;
            Exception failure = null;
            try
            {
                response = await client.SendAsync(request, token);
                if (response.Content != null && config.AuditEnabled && config.AuditLogPayloads)
                {
                    try
                    {
                        responseBody = await response.Content.ReadAsStringAsync();
                    }
                    catch
                    {
                        responseBody = "[RESPONSE BODY UNAVAILABLE]";
                    }
                }
                return response;
            }
            catch (Exception ex)
            {
                failure = ex;
                throw;
            }
            finally
            {
                watch.Stop();
                if (config.AuditEnabled)
                {
                    try
                    {
                        Append(new HttpAuditEntry
                        {
                            timestamp = DateTimeOffset.Now.ToString("o"),
                            method = request.Method.Method,
                            endpoint = GetEndpoint(request.RequestUri),
                            statusCode = response == null ? (int?)null : (int)response.StatusCode,
                            durationMs = watch.ElapsedMilliseconds,
                            jobId = jobId ?? "",
                            requestBody = config.AuditLogPayloads ? Redact(requestBody) : "",
                            responseBody = config.AuditLogPayloads ? Redact(responseBody) : "",
                            error = failure == null ? "" : Redact(failure.Message)
                        }, config.AuditRetentionDays);
                    }
                    catch
                    {
                        // Audit storage must never interrupt Agent communication.
                    }
                }
            }
        }

        public static IList<HttpAuditEntry> ReadRecent(
            int maximum,
            string method,
            string statusFilter)
        {
            lock (FileLock)
            {
                if (!File.Exists(AuditPath))
                {
                    return new List<HttpAuditEntry>();
                }

                var entries = new List<HttpAuditEntry>();
                try
                {
                    foreach (var line in File.ReadLines(AuditPath))
                    {
                        if (string.IsNullOrWhiteSpace(line))
                        {
                            continue;
                        }

                        try
                        {
                            entries.Add(Serializer.Deserialize<HttpAuditEntry>(line));
                        }
                        catch
                        {
                            // Keep a malformed historical row from hiding the rest of the audit.
                        }
                    }
                }
                catch
                {
                    return new List<HttpAuditEntry>();
                }

                IEnumerable<HttpAuditEntry> query = entries;
                if (!string.IsNullOrWhiteSpace(method) &&
                    !method.Equals("All", StringComparison.OrdinalIgnoreCase))
                {
                    query = query.Where(entry =>
                        string.Equals(entry.method, method, StringComparison.OrdinalIgnoreCase));
                }

                if (string.Equals(statusFilter, "Success", StringComparison.OrdinalIgnoreCase))
                {
                    query = query.Where(entry =>
                        entry.statusCode.HasValue && entry.statusCode.Value >= 200 && entry.statusCode.Value < 400);
                }
                else if (string.Equals(statusFilter, "Failed", StringComparison.OrdinalIgnoreCase))
                {
                    query = query.Where(entry =>
                        !entry.statusCode.HasValue || entry.statusCode.Value >= 400);
                }

                return query
                    .OrderByDescending(entry => ParseTimestamp(entry.timestamp))
                    .Take(Math.Max(1, maximum))
                    .ToList();
            }
        }

        public static void Clear()
        {
            lock (FileLock)
            {
                if (File.Exists(AuditPath))
                {
                    File.WriteAllText(AuditPath, "", new UTF8Encoding(false));
                }
            }
        }

        public static void Export(string destination)
        {
            lock (FileLock)
            {
                if (!File.Exists(AuditPath))
                {
                    File.WriteAllText(destination, "", new UTF8Encoding(false));
                    return;
                }
                File.Copy(AuditPath, destination, true);
            }
        }

        private static void Append(HttpAuditEntry entry, int retentionDays)
        {
            lock (FileLock)
            {
                Directory.CreateDirectory(AgentConfig.ConfigDirectory);
                if (DateTimeOffset.Now - _lastPruneAt > TimeSpan.FromHours(1))
                {
                    PruneUnsafe(retentionDays);
                    _lastPruneAt = DateTimeOffset.Now;
                }
                File.AppendAllText(
                    AuditPath,
                    Serializer.Serialize(entry) + Environment.NewLine,
                    new UTF8Encoding(false));
            }
        }

        private static void PruneUnsafe(int retentionDays)
        {
            if (!File.Exists(AuditPath))
            {
                return;
            }

            var cutoff = DateTimeOffset.Now.AddDays(-Math.Max(1, retentionDays));
            var retained = new List<string>();
            foreach (var line in File.ReadLines(AuditPath))
            {
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                try
                {
                    var entry = Serializer.Deserialize<HttpAuditEntry>(line);
                    if (ParseTimestamp(entry.timestamp) >= cutoff)
                    {
                        retained.Add(line);
                    }
                }
                catch
                {
                    retained.Add(line);
                }
            }

            File.WriteAllLines(AuditPath, retained, new UTF8Encoding(false));
        }

        private static DateTimeOffset ParseTimestamp(string value)
        {
            DateTimeOffset timestamp;
            return DateTimeOffset.TryParse(value, out timestamp)
                ? timestamp
                : DateTimeOffset.MinValue;
        }

        private static string GetEndpoint(Uri uri)
        {
            if (uri == null)
            {
                return "";
            }
            return uri.PathAndQuery;
        }

        public static string Redact(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return "";
            }

            var sanitized = value;
            try
            {
                var parsed = Serializer.DeserializeObject(value);
                sanitized = Serializer.Serialize(RedactObject(parsed));
            }
            catch
            {
                sanitized = RedactText(sanitized);
            }

            return sanitized.Length <= MaxPayloadCharacters
                ? sanitized
                : sanitized.Substring(0, MaxPayloadCharacters) + "\n[TRUNCATED]";
        }

        private static object RedactObject(object value)
        {
            var dictionary = value as IDictionary<string, object>;
            if (dictionary != null)
            {
                var result = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
                foreach (var pair in dictionary)
                {
                    result[pair.Key] = IsSensitiveKey(pair.Key)
                        ? "[REDACTED]"
                        : RedactObject(pair.Value);
                }
                return result;
            }

            var stringValue = value as string;
            if (stringValue != null)
            {
                return RedactText(stringValue);
            }

            var enumerable = value as IEnumerable;
            if (enumerable != null)
            {
                return enumerable.Cast<object>().Select(RedactObject).ToArray();
            }

            return value;
        }

        private static bool IsSensitiveKey(string key)
        {
            if (string.IsNullOrWhiteSpace(key))
            {
                return false;
            }

            var normalized = key.Replace("_", "").Replace("-", "").ToLowerInvariant();
            return normalized.Contains("authorization") ||
                   normalized.Contains("token") ||
                   normalized.Contains("password") ||
                   normalized.Contains("secret") ||
                   normalized.Contains("apikey") ||
                   normalized.Contains("connectionstring");
        }

        private static string RedactText(string value)
        {
            var sanitized = Regex.Replace(
                value ?? "",
                "(?i)Bearer\\s+[A-Za-z0-9._~+/=-]+",
                "Bearer [REDACTED]");
            sanitized = Regex.Replace(
                sanitized,
                "(?i)(authorization|agent[_-]?token|access[_-]?token|password|secret|api[_-]?key)\\s*[:=]\\s*([^\\s,;]+)",
                "$1=[REDACTED]");
            return sanitized;
        }
    }
}
