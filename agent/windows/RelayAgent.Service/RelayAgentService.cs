using RelayAgent.Shared;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.ServiceProcess;
using System.Web.Script.Serialization;

namespace RelayAgent.Service
{
    public sealed class RelayAgentService : ServiceBase
    {
        private CancellationTokenSource _cts;
        private Task _worker;
        private static readonly object PlaywrightWorkerLock = new object();
        private static Task _playwrightWorker;

        public RelayAgentService()
        {
            ServiceName = AgentConfig.ServiceName;
            CanStop = true;
            CanPauseAndContinue = false;
            AutoLog = true;
        }

        protected override void OnStart(string[] args)
        {
            _cts = new CancellationTokenSource();
            _worker = Task.Run(() => RunAsync(_cts.Token));
        }

        protected override void OnStop()
        {
            if (_cts != null)
            {
                _cts.Cancel();
            }
            if (_worker != null)
            {
                _worker.Wait(TimeSpan.FromSeconds(10));
            }
        }

        public void RunConsole()
        {
            Console.WriteLine("Relay Agent running in console mode. Press Ctrl+C to exit.");
            _cts = new CancellationTokenSource();
            Console.CancelKeyPress += (sender, args) =>
            {
                args.Cancel = true;
                _cts.Cancel();
            };
            RunAsync(_cts.Token).GetAwaiter().GetResult();
        }

        private static async Task RunAsync(CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                EnsurePlaywrightWorker(token);
                AgentConfig config = null;
                try
                {
                    config = AgentConfig.Load();
                    config.Validate();
                    using (var client = CreateClient(config))
                    {
                        await PostHeartbeatAsync(client, config, token);
                        await PollOnceAsync(client, config, token);
                    }
                }
                catch (Exception ex)
                {
                    Log("Polling error: " + ex);
                }

                var delay = Math.Max(2, config == null ? 10 : config.PollSeconds);
                await Task.Delay(TimeSpan.FromSeconds(delay), token).ContinueWith(_ => { });
            }
        }

        private static void EnsurePlaywrightWorker(CancellationToken token)
        {
            lock (PlaywrightWorkerLock)
            {
                if (_playwrightWorker != null && !_playwrightWorker.IsCompleted)
                {
                    return;
                }
                _playwrightWorker = Task.Run(() =>
                {
                    try
                    {
                        PlaywrightManager.ProcessNextTask(token);
                    }
                    catch (Exception ex)
                    {
                        Log("Playwright worker error: " + ex);
                    }
                }, token);
            }
        }

        private static HttpClient CreateClient(AgentConfig config)
        {
            var client = new HttpClient();
            client.Timeout = TimeSpan.FromMinutes(30);
            client.DefaultRequestHeaders.Add("Authorization", "Bearer " + config.Token);
            client.DefaultRequestHeaders.Add("X-Relay-Agent-Id", config.AgentId);
            return client;
        }

        private static async Task PostHeartbeatAsync(HttpClient client, AgentConfig config, CancellationToken token)
        {
            var serializer = new JavaScriptSerializer();
            var json = serializer.Serialize(new
            {
                agentId = config.AgentId,
                machine = Environment.MachineName,
                ts = DateTimeOffset.UtcNow.ToString("o")
            });
            using (var content = new StringContent(json, Encoding.UTF8, "application/json"))
            using (var request = new HttpRequestMessage(
                HttpMethod.Post,
                config.RelayUrl + "/api/agents/heartbeat"))
            {
                request.Content = content;
                using (var response = await HttpAuditStore.SendAsync(
                    client,
                    request,
                    config,
                    "",
                    token))
                {
                    await EnsureSuccessAsync(response, "heartbeat");
                    RecordHeartbeat();
                }
            }
        }

        private static void RecordHeartbeat()
        {
            try
            {
                Directory.CreateDirectory(AgentConfig.ConfigDirectory);
                File.WriteAllText(
                    AgentConfig.LastHeartbeatPath,
                    DateTimeOffset.UtcNow.ToString("o"),
                    new UTF8Encoding(false));
            }
            catch { }
        }

        private static async Task PollOnceAsync(HttpClient client, AgentConfig config, CancellationToken token)
        {
            var url = config.RelayUrl + "/api/agents/" + Uri.EscapeDataString(config.AgentId) + "/jobs/next";
            using (var request = new HttpRequestMessage(HttpMethod.Get, url))
            using (var response = await HttpAuditStore.SendAsync(
                client,
                request,
                config,
                "",
                token))
            {
                if (!response.IsSuccessStatusCode)
                {
                    return;
                }

                var body = await response.Content.ReadAsStringAsync();
                if (!string.IsNullOrWhiteSpace(body))
                {
                    var serializer = new JavaScriptSerializer();
                    var job = serializer.Deserialize<AgentJob>(body);
                    if (job != null && !string.IsNullOrWhiteSpace(job.jobId))
                    {
                        Log("Claimed job " + job.jobId + " kind=" + job.kind);
                        StartCommandAudit(config, job);
                        AgentResult result;
                        try
                        {
                            await PostEventAsync(client, config, job.jobId, "started", token);
                            result = await ExecuteJobAsync(client, config, job, token);
                        }
                        catch (Exception ex)
                        {
                            Log("Job " + job.jobId + " failed before result: " + ex);
                            result = new AgentResult
                            {
                                status = "failed",
                                exitCode = 1,
                                stderr = ex.ToString()
                            };
                        }

                        CommandAuditStore.Complete(
                            job.jobId,
                            result.status,
                            result.exitCode,
                            result.stdout,
                            result.stderr,
                            result.message);

                        try
                        {
                            await PostResultAsync(client, config, job.jobId, result, token);
                            CommandAuditStore.MarkResultPosted(job.jobId, true, "");
                            Log("Posted result for job " + job.jobId + " status=" + result.status + " exitCode=" + result.exitCode);
                        }
                        catch (Exception ex)
                        {
                            CommandAuditStore.MarkResultPosted(job.jobId, false, ex.ToString());
                            Log("Failed to post result for job " + job.jobId + ": " + ex);
                        }
                    }
                }
            }
        }

        private static void StartCommandAudit(AgentConfig config, AgentJob job)
        {
            var payload = job.payload ?? new AgentPayload();
            var kind = job.kind ?? "unknown";
            string instruction;
            string command;
            string executedCommand;

            if (string.Equals(kind, "powershell", StringComparison.OrdinalIgnoreCase))
            {
                instruction = "Execute PowerShell script";
                command = payload.script ?? "";
                executedCommand = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <Agent jobs script>";
            }
            else if (string.Equals(kind, "exec", StringComparison.OrdinalIgnoreCase))
            {
                instruction = "Execute shell command";
                command = payload.command ?? "";
                executedCommand = "cmd.exe /d /s /c <Agent jobs command>";
            }
            else if (string.Equals(kind, "playwright", StringComparison.OrdinalIgnoreCase))
            {
                instruction = "Run Playwright action: " + (payload.action ?? "unknown");
                command = SerializePlaywrightAuditPayload(payload);
                executedCommand = "RelayAgent PlaywrightManager action=" + (payload.action ?? "unknown");
            }
            else if (string.Equals(kind, "artifact-upload", StringComparison.OrdinalIgnoreCase))
            {
                instruction = "Upload artifact from the Agent host";
                command = "remotePath=" + (payload.remotePath ?? "") + Environment.NewLine +
                          "uploadPath=" + (payload.uploadPath ?? "");
                executedCommand = "HTTP PUT artifact upload from the Agent service";
            }
            else
            {
                instruction = "Execute Agent job";
                command = new JavaScriptSerializer().Serialize(payload);
                executedCommand = "RelayAgent job kind=" + kind;
            }

            CommandAuditStore.Start(
                job.jobId,
                kind,
                instruction,
                command,
                executedCommand,
                job.timeoutMs,
                config.AuditEnabled,
                config.AuditLogPayloads,
                config.AuditRetentionDays);
        }

        private static string SerializePlaywrightAuditPayload(AgentPayload payload)
        {
            return new JavaScriptSerializer().Serialize(new
            {
                action = payload.action,
                suiteId = payload.suiteId,
                runId = payload.runId,
                requestedRunId = payload.requestedRunId,
                artifactPath = payload.artifactPath,
                maximum = payload.maximum
            });
        }

        private static async Task<AgentResult> ExecuteJobAsync(
            HttpClient client,
            AgentConfig config,
            AgentJob job,
            CancellationToken token)
        {
            if (string.Equals(job.kind, "artifact-upload", StringComparison.OrdinalIgnoreCase))
            {
                return await UploadArtifactAsync(client, config, job, token);
            }

            if (string.Equals(job.kind, "playwright", StringComparison.OrdinalIgnoreCase))
            {
                return await ExecutePlaywrightJobAsync(client, config, job, token);
            }

            var isPowerShell = string.Equals(job.kind, "powershell", StringComparison.OrdinalIgnoreCase);
            if (job.payload == null)
            {
                throw new InvalidOperationException("Agent job payload was null.");
            }
            var command = isPowerShell ? job.payload.script : job.payload.command;
            if (string.IsNullOrWhiteSpace(command))
            {
                return new AgentResult
                {
                    status = "failed",
                    exitCode = 2,
                    stderr = "Agent job payload did not contain a command or script."
                };
            }

            string scriptPath = null;
            try
            {
                var info = new ProcessStartInfo();
                var jobsDirectory = Path.Combine(AgentConfig.ConfigDirectory, "jobs");
                Directory.CreateDirectory(jobsDirectory);
                if (isPowerShell)
                {
                    scriptPath = Path.Combine(jobsDirectory, "relay-" + Guid.NewGuid().ToString("N") + ".ps1");
                    File.WriteAllText(scriptPath, command, new UTF8Encoding(true));
                    info.FileName = "powershell.exe";
                    info.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + scriptPath + "\"";
                }
                else
                {
                    scriptPath = Path.Combine(jobsDirectory, "relay-" + Guid.NewGuid().ToString("N") + ".cmd");
                    File.WriteAllText(scriptPath, command, Encoding.Default);
                    info.FileName = "cmd.exe";
                    info.Arguments = "/d /s /c \"\"" + scriptPath + "\"\"";
                }
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.RedirectStandardOutput = true;
                info.RedirectStandardError = true;

                using (var process = new Process())
                {
                    process.StartInfo = info;
                    process.Start();
                    var stdoutTask = process.StandardOutput.ReadToEndAsync();
                    var stderrTask = process.StandardError.ReadToEndAsync();
                    var timeoutMs = Math.Max(1000, job.timeoutMs);
                    var exitTask = Task.Run(() => process.WaitForExit(), token);
                    var finished = await Task.WhenAny(exitTask, Task.Delay(timeoutMs, token));
                    if (finished != exitTask)
                    {
                        try { process.Kill(); } catch { }
                        return new AgentResult
                        {
                            status = "failed",
                            exitCode = 124,
                            stderr = "Agent command timed out after " + timeoutMs + "ms."
                        };
                    }

                    await Task.WhenAll(stdoutTask, stderrTask);
                    return new AgentResult
                    {
                        status = process.ExitCode == 0 ? "completed" : "failed",
                        exitCode = process.ExitCode,
                        stdout = stdoutTask.Result,
                        stderr = stderrTask.Result
                    };
                }
            }
            finally
            {
                if (!string.IsNullOrWhiteSpace(scriptPath))
                {
                    try { File.Delete(scriptPath); } catch { }
                }
            }
        }

        private static async Task<AgentResult> ExecutePlaywrightJobAsync(
            HttpClient client,
            AgentConfig config,
            AgentJob job,
            CancellationToken token)
        {
            if (job.payload == null || string.IsNullOrWhiteSpace(job.payload.action))
            {
                return new AgentResult
                {
                    status = "failed",
                    exitCode = 2,
                    message = "Playwright job payload must contain an action."
                };
            }

            var action = job.payload.action.Trim().ToLowerInvariant();
            var serializer = new JavaScriptSerializer
            {
                MaxJsonLength = int.MaxValue,
                RecursionLimit = 64
            };

            await PostEventAsync(client, config, job.jobId, "playwright_action=" + action, token);
            switch (action)
            {
                case "runtime_status":
                    return JsonResult(serializer.Serialize(PlaywrightManager.DetectRuntime()));

                case "suite_list":
                    return JsonResult(serializer.Serialize(PlaywrightManager.ReadSuites()));

                case "suite_upload":
                    var suite = PlaywrightManager.SaveUploadedSuite(
                        job.payload.suiteJson,
                        job.payload.testFileBase64,
                        job.payload.expectedSha256);
                    return JsonResult(serializer.Serialize(new
                    {
                        suite,
                        testFileSha256 = job.payload.expectedSha256
                    }));

                case "run_suite":
                    var dispatch = PlaywrightManager.QueueRunDetailed(
                        job.payload.suiteId,
                        job.payload.requestedRunId);
                    return JsonResult(serializer.Serialize(dispatch));

                case "run_status":
                    var run = PlaywrightManager.ReadRun(job.payload.runId);
                    if (run == null)
                    {
                        return new AgentResult
                        {
                            status = "failed",
                            exitCode = 404,
                            message = "Playwright run was not found: " + job.payload.runId
                        };
                    }
                    return JsonResult(serializer.Serialize(run));

                case "artifact_list":
                    return JsonResult(serializer.Serialize(
                        PlaywrightManager.ReadArtifactMetadata(job.payload.maximum <= 0 ? 250 : job.payload.maximum)));

                case "artifact_download":
                    var artifactPath = PlaywrightManager.ResolveArtifactPath(job.payload.artifactPath);
                    var uploadJob = new AgentJob
                    {
                        jobId = job.jobId,
                        kind = "artifact-upload",
                        payload = new AgentPayload
                        {
                            remotePath = artifactPath,
                            uploadPath = job.payload.uploadPath,
                            uploadToken = job.payload.uploadToken
                        },
                        timeoutMs = job.timeoutMs
                    };
                    return await UploadArtifactAsync(client, config, uploadJob, token);

                default:
                    return new AgentResult
                    {
                        status = "failed",
                        exitCode = 2,
                        message = "Unsupported Playwright action: " + action
                    };
            }
        }

        private static AgentResult JsonResult(string json)
        {
            return new AgentResult
            {
                status = "completed",
                exitCode = 0,
                stdout = json ?? "{}",
                stderr = ""
            };
        }

        private static async Task<AgentResult> UploadArtifactAsync(
            HttpClient client,
            AgentConfig config,
            AgentJob job,
            CancellationToken token)
        {
            if (job.payload == null ||
                string.IsNullOrWhiteSpace(job.payload.remotePath) ||
                string.IsNullOrWhiteSpace(job.payload.uploadPath) ||
                string.IsNullOrWhiteSpace(job.payload.uploadToken))
            {
                return new AgentResult
                {
                    status = "failed",
                    exitCode = 2,
                    stderr = "Artifact upload job is missing remotePath, uploadPath, or uploadToken."
                };
            }

            var file = new FileInfo(job.payload.remotePath);
            if (!file.Exists)
            {
                return new AgentResult
                {
                    status = "failed",
                    exitCode = 3,
                    stderr = "Artifact source file does not exist: " + job.payload.remotePath
                };
            }

            string sha256;
            using (var input = file.OpenRead())
            using (var hash = SHA256.Create())
            {
                sha256 = BitConverter.ToString(hash.ComputeHash(input))
                    .Replace("-", "")
                    .ToLowerInvariant();
            }

            await PostEventAsync(
                client,
                config,
                job.jobId,
                "artifact_upload_start bytes=" + file.Length + " sha256=" + sha256,
                token);

            var uploadUrl = job.payload.uploadPath.StartsWith("http", StringComparison.OrdinalIgnoreCase)
                ? job.payload.uploadPath
                : config.RelayUrl.TrimEnd('/') + "/" + job.payload.uploadPath.TrimStart('/');
            using (var input = file.OpenRead())
            using (var content = new StreamContent(input, 1024 * 1024))
            using (var request = new HttpRequestMessage(HttpMethod.Put, uploadUrl))
            {
                content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
                content.Headers.ContentLength = file.Length;
                request.Content = content;
                request.Headers.Add("X-Relay-Upload-Token", job.payload.uploadToken);
                using (var response = await client.SendAsync(
                    request,
                    HttpCompletionOption.ResponseHeadersRead,
                    token))
                {
                    var body = await response.Content.ReadAsStringAsync();
                    if (!response.IsSuccessStatusCode)
                    {
                        return new AgentResult
                        {
                            status = "failed",
                            exitCode = (int)response.StatusCode,
                            stderr = "Artifact upload returned " +
                                (int)response.StatusCode + " " +
                                response.ReasonPhrase + ": " + body
                        };
                    }

                    var serializer = new JavaScriptSerializer();
                    var envelope = serializer.Deserialize<ArtifactUploadEnvelope>(body);
                    var uploaded = envelope == null ? null : envelope.upload;
                    if (uploaded == null ||
                        uploaded.bytesWritten != file.Length ||
                        !string.Equals(uploaded.sha256, sha256, StringComparison.OrdinalIgnoreCase))
                    {
                        return new AgentResult
                        {
                            status = "failed",
                            exitCode = 4,
                            stderr = "Artifact verification mismatch: localBytes=" +
                                file.Length + ", relayBytes=" +
                                (uploaded == null ? -1 : uploaded.bytesWritten) +
                                ", localSha256=" + sha256 + ", relaySha256=" +
                                (uploaded == null ? "" : uploaded.sha256)
                        };
                    }

                    return new AgentResult
                    {
                        status = "completed",
                        exitCode = 0,
                        stdout = serializer.Serialize(new
                        {
                            artifact = job.payload.remotePath,
                            bytes = file.Length,
                            sha256 = sha256,
                            relayVerified = true
                        })
                    };
                }
            }
        }

        private static async Task PostEventAsync(HttpClient client, AgentConfig config, string jobId, string message, CancellationToken token)
        {
            var serializer = new JavaScriptSerializer();
            var json = serializer.Serialize(new { level = "info", message = message });
            var url = config.RelayUrl + "/api/agents/" + Uri.EscapeDataString(config.AgentId) + "/jobs/" + Uri.EscapeDataString(jobId) + "/events";
            using (var content = new StringContent(json, Encoding.UTF8, "application/json"))
            using (var request = new HttpRequestMessage(HttpMethod.Post, url))
            {
                request.Content = content;
                using (var response = await HttpAuditStore.SendAsync(
                    client,
                    request,
                    config,
                    jobId,
                    token))
                {
                    await EnsureSuccessAsync(response, "job event");
                }
            }
        }

        private static async Task PostResultAsync(HttpClient client, AgentConfig config, string jobId, AgentResult result, CancellationToken token)
        {
            var serializer = new JavaScriptSerializer();
            var payload = new Dictionary<string, object>
            {
                { "status", result.status },
                { "exitCode", result.exitCode }
            };
            if (!string.IsNullOrEmpty(result.message)) payload["message"] = result.message;
            if (result.stdout != null) payload["stdout"] = result.stdout;
            if (result.stderr != null) payload["stderr"] = result.stderr;
            var json = serializer.Serialize(payload);
            var url = config.RelayUrl + "/api/agents/" + Uri.EscapeDataString(config.AgentId) + "/jobs/" + Uri.EscapeDataString(jobId) + "/result";
            using (var content = new StringContent(json, Encoding.UTF8, "application/json"))
            using (var request = new HttpRequestMessage(HttpMethod.Post, url))
            {
                request.Content = content;
                using (var response = await HttpAuditStore.SendAsync(
                    client,
                    request,
                    config,
                    jobId,
                    token))
                {
                    await EnsureSuccessAsync(response, "job result");
                }
            }
        }

        private static async Task EnsureSuccessAsync(HttpResponseMessage response, string operation)
        {
            if (response.IsSuccessStatusCode)
            {
                return;
            }
            var body = await response.Content.ReadAsStringAsync();
            throw new HttpRequestException(operation + " returned " + (int)response.StatusCode + " " + response.ReasonPhrase + ": " + body);
        }

        private static void Log(string message)
        {
            try
            {
                System.IO.Directory.CreateDirectory(AgentConfig.ConfigDirectory);
                System.IO.File.AppendAllText(
                    AgentConfig.AgentLogPath,
                    DateTimeOffset.Now.ToString("o") + " " + message + Environment.NewLine);
            }
            catch { }
        }

        public sealed class AgentJob
        {
            public string jobId { get; set; }
            public string kind { get; set; }
            public AgentPayload payload { get; set; }
            public int timeoutMs { get; set; }
        }

        public sealed class AgentPayload
        {
            public string action { get; set; }
            public string command { get; set; }
            public string script { get; set; }
            public string remotePath { get; set; }
            public string uploadPath { get; set; }
            public string uploadToken { get; set; }
            public string suiteId { get; set; }
            public string suiteJson { get; set; }
            public string testFileBase64 { get; set; }
            public string expectedSha256 { get; set; }
            public string requestedRunId { get; set; }
            public string runId { get; set; }
            public int maximum { get; set; }
            public string artifactPath { get; set; }
        }

        public sealed class AgentResult
        {
            public string status { get; set; }
            public string message { get; set; }
            public int exitCode { get; set; }
            public string stdout { get; set; }
            public string stderr { get; set; }
        }

        public sealed class ArtifactUploadEnvelope
        {
            public ArtifactUploadResult upload { get; set; }
        }

        public sealed class ArtifactUploadResult
        {
            public long bytesWritten { get; set; }
            public string sha256 { get; set; }
        }
    }
}
