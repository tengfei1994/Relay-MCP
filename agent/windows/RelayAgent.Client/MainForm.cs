using RelayAgent.Shared;
using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Windows.Forms;

namespace RelayAgent.Client
{
    public sealed class MainForm : Form
    {
        private readonly TextBox _relayUrl = new TextBox();
        private readonly TextBox _agentId = new TextBox();
        private readonly TextBox _token = new TextBox();
        private readonly NumericUpDown _pollSeconds = new NumericUpDown();
        private readonly Label _status = new Label();

        public MainForm()
        {
            Text = "Relay MCP Agent Client";
            Width = 620;
            Height = 360;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;

            BuildLayout();
            LoadConfig();
            RefreshStatus();
        }

        private void BuildLayout()
        {
            AddLabel("Relay URL", 20, 24);
            _relayUrl.SetBounds(150, 20, 420, 24);
            Controls.Add(_relayUrl);

            AddLabel("Agent ID", 20, 64);
            _agentId.SetBounds(150, 60, 420, 24);
            Controls.Add(_agentId);

            AddLabel("Agent Token", 20, 104);
            _token.SetBounds(150, 100, 420, 24);
            _token.UseSystemPasswordChar = true;
            Controls.Add(_token);

            AddLabel("Poll Seconds", 20, 144);
            _pollSeconds.SetBounds(150, 140, 100, 24);
            _pollSeconds.Minimum = 2;
            _pollSeconds.Maximum = 120;
            _pollSeconds.Value = 10;
            Controls.Add(_pollSeconds);

            AddButton("Save Config", 20, 190, SaveConfig);
            AddButton("Test Relay", 140, 190, TestRelay);
            AddButton("Install Service", 260, 190, InstallService);
            AddButton("Uninstall", 410, 190, UninstallService);
            AddButton("Start", 20, 235, StartService);
            AddButton("Stop", 140, 235, StopService);
            AddButton("Refresh", 260, 235, (s, e) => RefreshStatus());

            _status.SetBounds(20, 285, 550, 30);
            _status.AutoEllipsis = true;
            Controls.Add(_status);
        }

        private void AddLabel(string text, int x, int y)
        {
            var label = new Label();
            label.Text = text;
            label.SetBounds(x, y, 120, 24);
            Controls.Add(label);
        }

        private void AddButton(string text, int x, int y, EventHandler handler)
        {
            var button = new Button();
            button.Text = text;
            button.SetBounds(x, y, 110, 30);
            button.Click += handler;
            Controls.Add(button);
        }

        private void LoadConfig()
        {
            var config = AgentConfig.Load();
            _relayUrl.Text = config.RelayUrl;
            _agentId.Text = config.AgentId;
            _token.Text = config.Token;
            _pollSeconds.Value = Math.Max(_pollSeconds.Minimum, Math.Min(_pollSeconds.Maximum, config.PollSeconds));
        }

        private AgentConfig ReadConfigFromForm()
        {
            return new AgentConfig
            {
                RelayUrl = _relayUrl.Text.Trim(),
                AgentId = _agentId.Text.Trim(),
                Token = _token.Text.Trim(),
                PollSeconds = Decimal.ToInt32(_pollSeconds.Value)
            };
        }

        private void SaveConfig(object sender, EventArgs e)
        {
            try
            {
                var config = ReadConfigFromForm();
                config.Validate();
                config.Save();
                MessageBox.Show("Saved to " + AgentConfig.ConfigPath, Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private async void TestRelay(object sender, EventArgs e)
        {
            try
            {
                var config = ReadConfigFromForm();
                config.Validate();
                using (var client = new HttpClient())
                {
                    client.Timeout = TimeSpan.FromSeconds(15);
                    client.DefaultRequestHeaders.Add("Authorization", "Bearer " + config.Token);
                    var response = await client.GetAsync(config.RelayUrl.TrimEnd('/') + "/api/health");
                    MessageBox.Show((int)response.StatusCode + " " + response.ReasonPhrase, Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void InstallService(object sender, EventArgs e)
        {
            var serviceExe = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "RelayAgent.Service.exe");
            if (!File.Exists(serviceExe))
            {
                MessageBox.Show("RelayAgent.Service.exe must be in the same folder as this client.", Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            RunSc("create " + AgentConfig.ServiceName + " binPath= \"" + serviceExe + "\" start= auto DisplayName= \"Relay MCP Agent\"");
            RunSc("description " + AgentConfig.ServiceName + " Outbound Relay MCP agent for server-side command execution.");
            RefreshStatus();
        }

        private void UninstallService(object sender, EventArgs e)
        {
            RunSc("stop " + AgentConfig.ServiceName);
            RunSc("delete " + AgentConfig.ServiceName);
            RefreshStatus();
        }

        private void StartService(object sender, EventArgs e)
        {
            RunSc("start " + AgentConfig.ServiceName);
            RefreshStatus();
        }

        private void StopService(object sender, EventArgs e)
        {
            RunSc("stop " + AgentConfig.ServiceName);
            RefreshStatus();
        }

        private void RefreshStatus()
        {
            _status.Text = "Config: " + AgentConfig.ConfigPath + " | Service: " + QueryService();
        }

        private string QueryService()
        {
            var result = RunProcess("sc.exe", "query " + AgentConfig.ServiceName);
            if (result.ExitCode != 0)
            {
                return "not installed";
            }
            if (result.Output.IndexOf("RUNNING", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "running";
            }
            if (result.Output.IndexOf("STOPPED", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "stopped";
            }
            return "installed";
        }

        private void RunSc(string args)
        {
            var result = RunProcess("sc.exe", args);
            if (result.ExitCode != 0 && result.Output.IndexOf("FAILED 1060", StringComparison.OrdinalIgnoreCase) < 0)
            {
                MessageBox.Show(result.Output, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private ProcessResult RunProcess(string fileName, string args)
        {
            var info = new ProcessStartInfo(fileName, args);
            info.UseShellExecute = false;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.CreateNoWindow = true;
            using (var process = Process.Start(info))
            {
                var output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
                process.WaitForExit();
                return new ProcessResult(process.ExitCode, output);
            }
        }

        private sealed class ProcessResult
        {
            public ProcessResult(int exitCode, string output)
            {
                ExitCode = exitCode;
                Output = output;
            }

            public int ExitCode { get; private set; }
            public string Output { get; private set; }
        }
    }
}

