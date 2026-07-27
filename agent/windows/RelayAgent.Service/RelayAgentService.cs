using RelayAgent.Shared;
using System;
using System.Diagnostics;
using System.Net.Http;
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
                var config = AgentConfig.Load();
                try
                {
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

                var delay = Math.Max(2, config.PollSeconds);
                await Task.Delay(TimeSpan.FromSeconds(delay), token).ContinueWith(_ => { });
            }
        }

        private static HttpClient CreateClient(AgentConfig config)
        {
            var client = new HttpClient();
            client.Timeout = TimeSpan.FromMinutes(5);
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
            {
                using (var response = await client.PostAsync(config.RelayUrl + "/api/agents/heartbeat", content, token))
                {
                    await EnsureSuccessAsync(response, "heartbeat");
                }
            }
        }

        private static async Task PollOnceAsync(HttpClient client, AgentConfig config, CancellationToken token)
        {
            var url = config.RelayUrl + "/api/agents/" + Uri.EscapeDataString(config.AgentId) + "/jobs/next";
            using (var response = await client.GetAsync(url, token))
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
                        AgentResult result;
                        try
                        {
                            await PostEventAsync(client, config, job.jobId, "started", token);
                            result = await ExecuteJobAsync(job, token);
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

                        try
                        {
                            await PostResultAsync(client, config, job.jobId, result, token);
                            Log("Posted result for job " + job.jobId + " status=" + result.status + " exitCode=" + result.exitCode);
                        }
                        catch (Exception ex)
                        {
                            Log("Failed to post result for job " + job.jobId + ": " + ex);
                        }
                    }
                }
            }
        }

        private static async Task<AgentResult> ExecuteJobAsync(AgentJob job, CancellationToken token)
        {
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

            var info = new ProcessStartInfo();
            if (isPowerShell)
            {
                var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(command));
                info.FileName = "powershell.exe";
                info.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + encoded;
            }
            else
            {
                info.FileName = "cmd.exe";
                info.Arguments = "/d /s /c " + command;
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

        private static async Task PostEventAsync(HttpClient client, AgentConfig config, string jobId, string message, CancellationToken token)
        {
            var serializer = new JavaScriptSerializer();
            var json = serializer.Serialize(new { level = "info", message = message });
            var url = config.RelayUrl + "/api/agents/" + Uri.EscapeDataString(config.AgentId) + "/jobs/" + Uri.EscapeDataString(jobId) + "/events";
            using (var content = new StringContent(json, Encoding.UTF8, "application/json"))
            {
                using (var response = await client.PostAsync(url, content, token))
                {
                    await EnsureSuccessAsync(response, "job event");
                }
            }
        }

        private static async Task PostResultAsync(HttpClient client, AgentConfig config, string jobId, AgentResult result, CancellationToken token)
        {
            var serializer = new JavaScriptSerializer();
            var json = serializer.Serialize(result);
            var url = config.RelayUrl + "/api/agents/" + Uri.EscapeDataString(config.AgentId) + "/jobs/" + Uri.EscapeDataString(jobId) + "/result";
            using (var content = new StringContent(json, Encoding.UTF8, "application/json"))
            {
                using (var response = await client.PostAsync(url, content, token))
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
                    System.IO.Path.Combine(AgentConfig.ConfigDirectory, "agent.log"),
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
            public string command { get; set; }
            public string script { get; set; }
        }

        public sealed class AgentResult
        {
            public string status { get; set; }
            public string message { get; set; }
            public int exitCode { get; set; }
            public string stdout { get; set; }
            public string stderr { get; set; }
        }
    }
}
