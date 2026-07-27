using RelayAgent.Shared;
using System;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.ServiceProcess;

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
                    Console.WriteLine(DateTimeOffset.Now.ToString("o") + " " + ex.Message);
                }

                var delay = Math.Max(2, config.PollSeconds);
                await Task.Delay(TimeSpan.FromSeconds(delay), token).ContinueWith(_ => { });
            }
        }

        private static HttpClient CreateClient(AgentConfig config)
        {
            var client = new HttpClient();
            client.Timeout = TimeSpan.FromSeconds(60);
            client.DefaultRequestHeaders.Add("Authorization", "Bearer " + config.Token);
            client.DefaultRequestHeaders.Add("X-Relay-Agent-Id", config.AgentId);
            return client;
        }

        private static async Task PostHeartbeatAsync(HttpClient client, AgentConfig config, CancellationToken token)
        {
            var json = "{\"agentId\":\"" + Escape(config.AgentId) + "\",\"machine\":\"" + Escape(Environment.MachineName) + "\",\"ts\":\"" + DateTimeOffset.UtcNow.ToString("o") + "\"}";
            using (var content = new StringContent(json, Encoding.UTF8, "application/json"))
            {
                await client.PostAsync(config.RelayUrl + "/api/agents/heartbeat", content, token);
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
                if (!string.IsNullOrWhiteSpace(body) && body.IndexOf("\"jobId\"", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    await PostResultAsync(client, config, body, token);
                }
            }
        }

        private static async Task PostResultAsync(HttpClient client, AgentConfig config, string jobBody, CancellationToken token)
        {
            var json = "{\"agentId\":\"" + Escape(config.AgentId) + "\",\"status\":\"received\",\"message\":\"Agent execution is not enabled in this MVP build.\"}";
            var jobId = "unknown";
            var url = config.RelayUrl + "/api/agents/" + Uri.EscapeDataString(config.AgentId) + "/jobs/" + Uri.EscapeDataString(jobId) + "/result";
            using (var content = new StringContent(json, Encoding.UTF8, "application/json"))
            {
                await client.PostAsync(url, content, token);
            }
        }

        private static string Escape(string value)
        {
            return (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
        }
    }
}

