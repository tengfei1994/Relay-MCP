using Microsoft.Win32;
using RelayAgent.Shared;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;

namespace RelayAgent.Client
{
    public partial class MainWindow : Window
    {
        private readonly DispatcherTimer _refreshTimer;
        private readonly Dictionary<string, FrameworkElement> _pages;
        private readonly Dictionary<string, Button> _navigation;
        private AgentConfig _loadedConfig;
        private string _configurationLoadError;
        private DatabasePermissionState _lastDatabaseState;
        private bool _initialized;
        private string _selectedPlaywrightSuiteId;

        public MainWindow()
        {
            PermissionRows = new ObservableCollection<PermissionRow>();
            AuditRows = new ObservableCollection<AuditRow>();
            PlaywrightSuites = new ObservableCollection<PlaywrightSuite>();
            PlaywrightRuns = new ObservableCollection<PlaywrightRun>();
            PlaywrightArtifacts = new ObservableCollection<FileInfo>();
            PlaywrightWebClients = new ObservableCollection<PlaywrightWebClientCandidate>();

            InitializeComponent();
            DataContext = this;

            _pages = new Dictionary<string, FrameworkElement>(StringComparer.OrdinalIgnoreCase)
            {
                { "OverviewPage", OverviewPage },
                { "ConnectionPage", ConnectionPage },
                { "ServicePage", ServicePage },
                { "DatabasePage", DatabasePage },
                { "AuditPage", AuditPage },
                { "PlaywrightPage", PlaywrightPage },
                { "DiagnosticsPage", DiagnosticsPage }
            };
            _navigation = new Dictionary<string, Button>(StringComparer.OrdinalIgnoreCase)
            {
                { "OverviewPage", OverviewNav },
                { "ConnectionPage", ConnectionNav },
                { "ServicePage", ServiceNav },
                { "DatabasePage", DatabaseNav },
                { "AuditPage", AuditNav },
                { "PlaywrightPage", PlaywrightNav },
                { "DiagnosticsPage", DiagnosticsNav }
            };

            AuditMethodFilter.SelectedIndex = 0;
            AuditStatusFilter.SelectedIndex = 0;
            LogLevelFilter.SelectedIndex = 0;

            _loadedConfig = LoadConfigSafely();
            LoadConfigurationIntoView();
            LoadSqlServers();
            PopulatePermissionGrid(null);
            ShowPage("OverviewPage");

            _initialized = true;
            RefreshAll();

            _refreshTimer = new DispatcherTimer(DispatcherPriority.Background)
            {
                Interval = TimeSpan.FromSeconds(5)
            };
            _refreshTimer.Tick += delegate { RefreshRuntimeStatus(); };
            _refreshTimer.Start();
            Closed += delegate { _refreshTimer.Stop(); };
        }

        public ObservableCollection<PermissionRow> PermissionRows { get; private set; }

        public ObservableCollection<AuditRow> AuditRows { get; private set; }

        public ObservableCollection<PlaywrightSuite> PlaywrightSuites { get; private set; }

        public ObservableCollection<PlaywrightRun> PlaywrightRuns { get; private set; }

        public ObservableCollection<FileInfo> PlaywrightArtifacts { get; private set; }

        public ObservableCollection<PlaywrightWebClientCandidate> PlaywrightWebClients { get; private set; }

        private Brush PrimaryBrush
        {
            get { return (Brush)FindResource("PrimaryBrush"); }
        }

        private Brush PrimarySoftBrush
        {
            get { return (Brush)FindResource("PrimarySoftBrush"); }
        }

        private Brush SuccessBrush
        {
            get { return (Brush)FindResource("SuccessBrush"); }
        }

        private Brush SuccessSoftBrush
        {
            get { return (Brush)FindResource("SuccessSoftBrush"); }
        }

        private Brush WarningBrush
        {
            get { return (Brush)FindResource("WarningBrush"); }
        }

        private Brush WarningSoftBrush
        {
            get { return (Brush)FindResource("WarningSoftBrush"); }
        }

        private Brush DangerBrush
        {
            get { return (Brush)FindResource("DangerBrush"); }
        }

        private Brush DangerSoftBrush
        {
            get { return (Brush)FindResource("DangerSoftBrush"); }
        }

        private Brush MutedBrush
        {
            get { return (Brush)FindResource("MutedBrush"); }
        }

        private void Navigation_Click(object sender, RoutedEventArgs e)
        {
            var button = sender as Button;
            var pageName = button == null ? "" : Convert.ToString(button.Tag);
            ShowPage(pageName);
        }

        private void ShowPage(string pageName)
        {
            FrameworkElement selectedPage;
            if (!_pages.TryGetValue(pageName ?? "", out selectedPage))
            {
                return;
            }

            foreach (var pair in _pages)
            {
                pair.Value.Visibility = ReferenceEquals(pair.Value, selectedPage)
                    ? Visibility.Visible
                    : Visibility.Collapsed;
            }

            foreach (var pair in _navigation)
            {
                var selected = pair.Key.Equals(pageName, StringComparison.OrdinalIgnoreCase);
                pair.Value.Background = selected ? PrimarySoftBrush : Brushes.Transparent;
                pair.Value.BorderBrush = selected ? PrimaryBrush : Brushes.Transparent;
                pair.Value.Foreground = selected ? PrimaryBrush : (Brush)FindResource("TextBrush");
                pair.Value.FontWeight = selected ? FontWeights.SemiBold : FontWeights.Normal;
            }

            if (pageName.Equals("AuditPage", StringComparison.OrdinalIgnoreCase))
            {
                RefreshAudit();
            }
            else if (pageName.Equals("PlaywrightPage", StringComparison.OrdinalIgnoreCase))
            {
                _ = RefreshPlaywrightAsync();
            }
            else if (pageName.Equals("DiagnosticsPage", StringComparison.OrdinalIgnoreCase))
            {
                RefreshAgentLog();
            }
        }

        private void RefreshAll_Click(object sender, RoutedEventArgs e)
        {
            RefreshAll();
            SetFooter("Status refreshed.");
        }

        private void TestRelay_Click(object sender, RoutedEventArgs e)
        {
            TestRelayAsync();
        }

        private void OpenDatabasePage_Click(object sender, RoutedEventArgs e)
        {
            ShowPage("DatabasePage");
            TestDatabaseAccessAsync();
        }

        private void OpenAuditPage_Click(object sender, RoutedEventArgs e)
        {
            ShowPage("AuditPage");
        }

        private void ReplaceRelayUrl_Click(object sender, RoutedEventArgs e)
        {
            RelayUrlBox.Tag = "";
            RelayUrlBox.IsReadOnly = false;
            RelayUrlBox.Text = "";
            RelayUrlBox.Background = Brushes.White;
            RelayUrlBox.Focus();
            SetConnectionNotice(
                "Enter the new Relay URL. The old value remains active until Save securely succeeds.",
                MutedBrush);
        }

        private void ReplaceToken_Click(object sender, RoutedEventArgs e)
        {
            AgentTokenBox.Tag = "";
            AgentTokenBox.IsEnabled = true;
            AgentTokenBox.Password = "";
            AgentTokenBox.Background = Brushes.White;
            AgentTokenBox.Focus();
            SetConnectionNotice(
                "Enter the replacement Agent token. It will not be shown again after save.",
                MutedBrush);
        }

        private void NumericOnly_PreviewTextInput(object sender, TextCompositionEventArgs e)
        {
            e.Handled = Regex.IsMatch(e.Text ?? "", "[^0-9]");
        }

        private void SaveConfiguration_Click(object sender, RoutedEventArgs e)
        {
            SaveConfiguration();
        }

        private void SaveConfiguration()
        {
            try
            {
                var config = ReadConfigurationFromView();
                config.Save();
                _loadedConfig = config;
                _configurationLoadError = "";
                LoadConfigurationIntoView();
                SetConnectionNotice("Saved securely to " + AgentConfig.ConfigPath, SuccessBrush);
                LogClientAction("Configuration saved securely.");
                if (QueryService() == "running")
                {
                    RestartService();
                }
                RefreshAll();
            }
            catch (Exception ex)
            {
                SetConnectionNotice(ex.Message, DangerBrush);
                SetFooter("Configuration save failed.");
            }
        }

        private void LoadConfigurationIntoView()
        {
            RelayUrlBox.Text = AgentConfig.MaskRelayUrl(_loadedConfig.RelayUrl);
            RelayUrlBox.IsReadOnly = true;
            RelayUrlBox.Tag = "protected";
            RelayUrlBox.Background = new SolidColorBrush(Color.FromRgb(248, 249, 251));

            AgentIdBox.Text = _loadedConfig.AgentId;

            AgentTokenBox.Password = AgentConfig.MaskToken(_loadedConfig.Token);
            AgentTokenBox.IsEnabled = false;
            AgentTokenBox.Tag = "protected";
            AgentTokenBox.Background = new SolidColorBrush(Color.FromRgb(248, 249, 251));

            PollSecondsBox.Text = Clamp(_loadedConfig.PollSeconds, 2, 120).ToString();
            AuditEnabledCheck.IsChecked = _loadedConfig.AuditEnabled;
            AuditPayloadsCheck.IsChecked = _loadedConfig.AuditLogPayloads;
            AuditRetentionBox.Text = Clamp(_loadedConfig.AuditRetentionDays, 1, 365).ToString();
            DatabaseIdentityText.Text = DatabaseAccessManager.GetServiceIdentity();

            if (!string.IsNullOrWhiteSpace(_configurationLoadError))
            {
                SetConnectionNotice(
                    _configurationLoadError +
                    " Use Replace to enter new values and save them on this machine.",
                    DangerBrush);
            }
            else
            {
                SetConnectionNotice(
                    "Relay URL and Agent token are encrypted with Windows DPAPI for this machine.",
                    MutedBrush);
            }
        }

        private AgentConfig ReadConfigurationFromView()
        {
            var relayUrl = Equals(RelayUrlBox.Tag, "protected")
                ? _loadedConfig.RelayUrl
                : RelayUrlBox.Text.Trim();
            var token = Equals(AgentTokenBox.Tag, "protected")
                ? _loadedConfig.Token
                : AgentTokenBox.Password.Trim();

            return new AgentConfig
            {
                RelayUrl = relayUrl,
                AgentId = AgentIdBox.Text.Trim(),
                Token = token,
                PollSeconds = ReadInteger(PollSecondsBox.Text, 10, 2, 120),
                AuditEnabled = AuditEnabledCheck.IsChecked == true,
                AuditLogPayloads = AuditPayloadsCheck.IsChecked == true,
                AuditRetentionDays = ReadInteger(AuditRetentionBox.Text, 14, 1, 365)
            };
        }

        private async void TestRelayAsync()
        {
            try
            {
                var config = ReadConfigurationFromView();
                config.Validate();
                SetFooter("Testing Relay connection...");
                using (var client = new HttpClient())
                {
                    client.Timeout = TimeSpan.FromSeconds(15);
                    client.DefaultRequestHeaders.Add("Authorization", "Bearer " + config.Token);
                    client.DefaultRequestHeaders.Add("X-Relay-Agent-Id", config.AgentId);
                    using (var request = new HttpRequestMessage(
                        HttpMethod.Get,
                        config.RelayUrl.TrimEnd('/') + "/api/health"))
                    using (var response = await HttpAuditStore.SendAsync(
                        client,
                        request,
                        config,
                        "",
                        CancellationToken.None))
                    {
                        var message = (int)response.StatusCode + " " + response.ReasonPhrase;
                        SetFooter("Relay test: " + message);
                        SetConnectionNotice(
                            "Relay test returned " + message + ".",
                            response.IsSuccessStatusCode ? SuccessBrush : DangerBrush);
                    }
                }
                RefreshAudit();
                RefreshRuntimeStatus();
            }
            catch (Exception ex)
            {
                SetFooter("Relay test failed.");
                SetConnectionNotice(ex.Message, DangerBrush);
            }
        }

        private void SetConnectionNotice(string message, Brush foreground)
        {
            ConnectionNoticeText.Text = message;
            ConnectionNoticeText.Foreground = foreground;
            ConnectionNoticeBorder.Background = foreground == DangerBrush
                ? DangerSoftBrush
                : foreground == SuccessBrush ? SuccessSoftBrush : new SolidColorBrush(Color.FromRgb(243, 245, 248));
        }

        private void CopyServicePath_Click(object sender, RoutedEventArgs e)
        {
            var path = ServicePathText.Text;
            if (string.IsNullOrWhiteSpace(path) || path == "Not installed")
            {
                SetFooter("No service executable path is available.");
                return;
            }
            Clipboard.SetText(path);
            SetFooter("Service executable path copied.");
        }

        private void InstallService_Click(object sender, RoutedEventArgs e)
        {
            InstallService();
        }

        private void StartService_Click(object sender, RoutedEventArgs e)
        {
            var result = RunSc("start " + AgentConfig.ServiceName);
            if (result.ExitCode == 0)
            {
                SetFooter("Windows Service started.");
            }
            RefreshAll();
        }

        private void StopService_Click(object sender, RoutedEventArgs e)
        {
            var result = RunSc("stop " + AgentConfig.ServiceName);
            if (result.ExitCode == 0)
            {
                SetFooter("Windows Service stopped.");
            }
            RefreshAll();
        }

        private void RestartService_Click(object sender, RoutedEventArgs e)
        {
            RestartService();
        }

        private void UninstallService_Click(object sender, RoutedEventArgs e)
        {
            if (MessageBox.Show(
                    this,
                    "Stop and uninstall the Relay MCP Agent Windows Service?",
                    Title,
                    MessageBoxButton.YesNo,
                    MessageBoxImage.Warning) != MessageBoxResult.Yes)
            {
                return;
            }

            RunSc("stop " + AgentConfig.ServiceName);
            var result = RunSc("delete " + AgentConfig.ServiceName);
            if (result.ExitCode == 0)
            {
                SetFooter("Windows Service uninstalled.");
                LogClientAction("Windows Service uninstalled.");
            }
            RefreshAll();
        }

        private void InstallService()
        {
            var clientExe = Process.GetCurrentProcess().MainModule.FileName;
            if (!File.Exists(clientExe))
            {
                SetFooter("Unable to locate RelayAgent.Client.exe.");
                return;
            }

            var serviceArgs = "binPath= \"\\\"" + clientExe + "\\\" --service\" start= auto";
            var result = QueryService() == "not installed"
                ? RunSc("create " + AgentConfig.ServiceName + " " + serviceArgs +
                    " DisplayName= \"Relay MCP Agent\"")
                : RunSc("config " + AgentConfig.ServiceName + " " + serviceArgs);
            if (result.ExitCode == 0)
            {
                RunSc("description " + AgentConfig.ServiceName +
                    " \"Outbound Relay MCP agent for server-side command execution.\"");
                LogClientAction("Windows Service installed or updated: " + clientExe);
                SetFooter("Windows Service installed or updated.");
            }
            RefreshAll();
        }

        private void RestartService()
        {
            if (QueryService() == "not installed")
            {
                SetFooter("Windows Service is not installed.");
                return;
            }

            RunSc("stop " + AgentConfig.ServiceName);
            var result = RunSc("start " + AgentConfig.ServiceName);
            if (result.ExitCode == 0)
            {
                SetFooter("Windows Service restarted.");
                LogClientAction("Windows Service restarted.");
            }
            RefreshAll();
        }

        private void DetectDatabases_Click(object sender, RoutedEventArgs e)
        {
            DetectDatabasesAsync();
        }

        private void TestDatabaseAccess_Click(object sender, RoutedEventArgs e)
        {
            TestDatabaseAccessAsync();
        }

        private void GrantRead_Click(object sender, RoutedEventArgs e)
        {
            GrantDatabaseAccessAsync(DatabaseAccessLevel.Read);
        }

        private void GrantReadWrite_Click(object sender, RoutedEventArgs e)
        {
            GrantDatabaseAccessAsync(DatabaseAccessLevel.ReadWrite);
        }

        private void GrantDdl_Click(object sender, RoutedEventArgs e)
        {
            GrantDatabaseAccessAsync(DatabaseAccessLevel.Ddl);
        }

        private void RevokeDatabaseAccess_Click(object sender, RoutedEventArgs e)
        {
            RevokeDatabaseAccessAsync();
        }

        private void LoadSqlServers()
        {
            SqlServerBox.Items.Clear();
            foreach (var server in DatabaseAccessManager.DiscoverLocalServers())
            {
                SqlServerBox.Items.Add(server);
            }
            if (SqlServerBox.Items.Count > 0)
            {
                SqlServerBox.SelectedIndex = 0;
            }
            else
            {
                SqlServerBox.Text = "localhost";
            }
        }

        private async void DetectDatabasesAsync()
        {
            var server = SqlServerBox.Text.Trim();
            try
            {
                SetDatabaseResult("Scanning...", PrimaryBrush);
                SetFooter("Detecting accessible SQL Server databases...");
                var databases = await Task.Run(() => DatabaseAccessManager.DiscoverDatabases(server));
                DatabaseBox.Items.Clear();
                foreach (var database in databases)
                {
                    DatabaseBox.Items.Add(database);
                }
                if (DatabaseBox.Items.Count > 0)
                {
                    DatabaseBox.SelectedIndex = 0;
                }
                SetDatabaseResult(databases.Count + " database(s) detected", MutedBrush);
                SetFooter("Database discovery completed.");
                LogClientAction(
                    "Database discovery completed for " + server + ": " +
                    databases.Count + " database(s).");
            }
            catch (Exception ex)
            {
                SetDatabaseResult("Discovery failed", DangerBrush);
                SetFooter(ex.Message);
            }
        }

        private async void TestDatabaseAccessAsync()
        {
            string server;
            string database;
            string identity;
            if (!TryGetDatabaseTarget(out server, out database, out identity))
            {
                return;
            }

            try
            {
                SetDatabaseResult("Checking...", PrimaryBrush);
                _lastDatabaseState = await Task.Run(
                    () => DatabaseAccessManager.Test(server, database, identity));
                PopulatePermissionGrid(_lastDatabaseState);
                SetDatabaseResult(
                    _lastDatabaseState.ReadReady ? "Read access ready" : "Permissions incomplete",
                    _lastDatabaseState.ReadReady ? SuccessBrush : WarningBrush);
                SetFooter("Database access check completed.");
                RefreshRuntimeStatus();
            }
            catch (Exception ex)
            {
                SetDatabaseResult("Access check failed", DangerBrush);
                SetFooter(ex.Message);
            }
        }

        private async void GrantDatabaseAccessAsync(DatabaseAccessLevel level)
        {
            string server;
            string database;
            string identity;
            if (!TryGetDatabaseTarget(out server, out database, out identity))
            {
                return;
            }

            if (MessageBox.Show(
                    this,
                    "Grant " + FormatAccessLevel(level) + " access to " + identity +
                    " on " + server + " / " + database + "?\r\n\r\n" +
                    "The operation is idempotent and will verify the result afterward.",
                    Title,
                    MessageBoxButton.YesNo,
                    level == DatabaseAccessLevel.Read
                        ? MessageBoxImage.Information
                        : MessageBoxImage.Warning) != MessageBoxResult.Yes)
            {
                return;
            }

            try
            {
                SetDatabaseResult("Applying permissions...", PrimaryBrush);
                _lastDatabaseState = await Task.Run(
                    () => DatabaseAccessManager.Grant(server, database, identity, level));
                PopulatePermissionGrid(_lastDatabaseState);
                SetDatabaseResult(FormatAccessLevel(level) + " access granted", SuccessBrush);
                SetFooter("Database permissions applied and verified.");
                LogClientAction(
                    "Granted " + level + " database access to " + identity +
                    " on " + server + " / " + database + ".");
                RefreshRuntimeStatus();
            }
            catch (Exception ex)
            {
                SetDatabaseResult("Grant failed", DangerBrush);
                SetFooter(ex.Message);
            }
        }

        private async void RevokeDatabaseAccessAsync()
        {
            string server;
            string database;
            string identity;
            if (!TryGetDatabaseTarget(out server, out database, out identity))
            {
                return;
            }

            if (MessageBox.Show(
                    this,
                    "Remove the database user and database-level permissions for " +
                    identity + " on " + database + "?\r\n\r\n" +
                    "The server login is retained in case another database uses it.",
                    Title,
                    MessageBoxButton.YesNo,
                    MessageBoxImage.Warning) != MessageBoxResult.Yes)
            {
                return;
            }

            try
            {
                SetDatabaseResult("Revoking...", PrimaryBrush);
                _lastDatabaseState = await Task.Run(
                    () => DatabaseAccessManager.RevokeDatabaseAccess(server, database, identity));
                PopulatePermissionGrid(_lastDatabaseState);
                SetDatabaseResult("Database access revoked", WarningBrush);
                SetFooter("Database access removed.");
                LogClientAction(
                    "Revoked database access for " + identity +
                    " on " + server + " / " + database + ".");
                RefreshRuntimeStatus();
            }
            catch (Exception ex)
            {
                SetDatabaseResult("Revoke failed", DangerBrush);
                SetFooter(ex.Message);
            }
        }

        private bool TryGetDatabaseTarget(
            out string server,
            out string database,
            out string identity)
        {
            server = SqlServerBox.Text.Trim();
            var selected = DatabaseBox.SelectedItem as DatabaseCandidate;
            database = selected == null ? DatabaseBox.Text.Trim() : selected.Name;
            identity = DatabaseAccessManager.GetServiceIdentity();
            DatabaseIdentityText.Text = identity;

            if (string.IsNullOrWhiteSpace(server) || string.IsNullOrWhiteSpace(database))
            {
                SetFooter("Choose a SQL Server and database first.");
                return false;
            }
            return true;
        }

        private void PopulatePermissionGrid(DatabasePermissionState state)
        {
            PermissionRows.Clear();
            AddPermissionRow("Server login", state == null ? null : (bool?)state.LoginExists, true, true, true);
            AddPermissionRow("Database user", state == null ? null : (bool?)state.UserExists, true, true, true);
            AddPermissionRow("db_datareader", state == null ? null : (bool?)state.CanRead, true, false, false);
            AddPermissionRow("VIEW DEFINITION", state == null ? null : (bool?)state.CanViewDefinition, true, false, false);
            AddPermissionRow("db_datawriter", state == null ? null : (bool?)state.CanWrite, false, true, false);
            AddPermissionRow("db_ddladmin", state == null ? null : (bool?)state.CanChangeSchema, false, false, true);
        }

        private void AddPermissionRow(
            string permission,
            bool? current,
            bool read,
            bool write,
            bool ddl)
        {
            PermissionRows.Add(new PermissionRow
            {
                Permission = permission,
                Current = current.HasValue ? (current.Value ? "Granted" : "Missing") : "Not checked",
                Read = read ? "Required" : "No",
                Write = write ? "Required" : "No",
                Ddl = ddl ? "Required" : "No",
                StatusForeground = !current.HasValue
                    ? MutedBrush
                    : current.Value ? SuccessBrush : DangerBrush,
                StatusBackground = !current.HasValue
                    ? WarningSoftBrush
                    : current.Value ? SuccessSoftBrush : DangerSoftBrush
            });
        }

        private void SetDatabaseResult(string message, Brush foreground)
        {
            DatabaseResultText.Text = message;
            DatabaseResultText.Foreground = foreground;
        }

        private void AuditFilter_SelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            if (_initialized)
            {
                RefreshAudit();
            }
        }

        private void ApplyAuditSettings_Click(object sender, RoutedEventArgs e)
        {
            try
            {
                var config = ReadConfigurationFromView();
                config.Save();
                _loadedConfig = config;
                _configurationLoadError = "";
                LoadConfigurationIntoView();
                SetFooter("Audit settings saved securely.");
                LogClientAction("HTTP audit settings updated.");
                if (QueryService() == "running")
                {
                    RestartService();
                }
                RefreshAudit();
            }
            catch (Exception ex)
            {
                SetFooter(ex.Message);
            }
        }

        private void AuditGrid_SelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            ShowSelectedAuditDetail();
        }

        private void RefreshAudit()
        {
            if (!_initialized && AuditMethodFilter.SelectedIndex < 0)
            {
                return;
            }

            var method = GetComboValue(AuditMethodFilter, "All");
            var status = GetComboValue(AuditStatusFilter, "All");
            var entries = HttpAuditStore.ReadRecent(1000, method, status);

            AuditRows.Clear();
            foreach (var entry in entries)
            {
                DateTimeOffset timestamp;
                var displayTime = DateTimeOffset.TryParse(entry.timestamp, out timestamp)
                    ? timestamp.LocalDateTime.ToString("yyyy-MM-dd HH:mm:ss")
                    : entry.timestamp;
                AuditRows.Add(new AuditRow
                {
                    Time = displayTime,
                    Method = entry.method,
                    Endpoint = entry.endpoint,
                    Status = entry.statusCode.HasValue
                        ? entry.statusCode.Value.ToString()
                        : "Failed",
                    Duration = entry.durationMs + " ms",
                    JobId = entry.jobId,
                    Payload = !string.IsNullOrWhiteSpace(entry.requestBody) ||
                              !string.IsNullOrWhiteSpace(entry.responseBody)
                        ? "Yes"
                        : "No",
                    Entry = entry
                });
            }

            AuditEmptyText.Visibility = AuditRows.Count == 0
                ? Visibility.Visible
                : Visibility.Collapsed;
            ShowSelectedAuditDetail();
        }

        private void ShowSelectedAuditDetail()
        {
            var row = AuditGrid.SelectedItem as AuditRow;
            var entry = row == null ? null : row.Entry;
            if (entry == null)
            {
                AuditDetailBox.IsEnabled = false;
                AuditDetailBox.Text = "Select a request to inspect details.";
                return;
            }

            AuditDetailBox.IsEnabled = true;
            var builder = new StringBuilder();
            builder.AppendLine(entry.method + " " + entry.endpoint);
            builder.AppendLine(
                "Status: " +
                (entry.statusCode.HasValue ? entry.statusCode.Value.ToString() : "Failed"));
            builder.AppendLine("Duration: " + entry.durationMs + " ms");
            if (!string.IsNullOrWhiteSpace(entry.jobId))
            {
                builder.AppendLine("Job ID: " + entry.jobId);
            }
            if (!string.IsNullOrWhiteSpace(entry.error))
            {
                builder.AppendLine();
                builder.AppendLine("Error");
                builder.AppendLine(entry.error);
            }
            if (!string.IsNullOrWhiteSpace(entry.requestBody))
            {
                builder.AppendLine();
                builder.AppendLine("Request");
                builder.AppendLine(entry.requestBody);
            }
            if (!string.IsNullOrWhiteSpace(entry.responseBody))
            {
                builder.AppendLine();
                builder.AppendLine("Response");
                builder.AppendLine(entry.responseBody);
            }
            AuditDetailBox.Text = builder.ToString();
        }

        private void ExportAudit_Click(object sender, RoutedEventArgs e)
        {
            try
            {
                var dialog = new SaveFileDialog
                {
                    Title = "Export Relay request audit",
                    Filter = "JSON Lines (*.jsonl)|*.jsonl|All files (*.*)|*.*",
                    FileName = "relay-http-audit-" +
                               DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".jsonl"
                };
                if (dialog.ShowDialog(this) == true)
                {
                    HttpAuditStore.Export(dialog.FileName);
                    SetFooter("Audit exported to " + dialog.FileName);
                }
            }
            catch (Exception ex)
            {
                SetFooter("Audit export failed: " + ex.Message);
            }
        }

        private void ClearAudit_Click(object sender, RoutedEventArgs e)
        {
            if (MessageBox.Show(
                    this,
                    "Clear the local HTTP request audit history?",
                    Title,
                    MessageBoxButton.YesNo,
                    MessageBoxImage.Warning) != MessageBoxResult.Yes)
            {
                return;
            }

            try
            {
                HttpAuditStore.Clear();
                RefreshAudit();
                SetFooter("Request audit cleared.");
            }
            catch (Exception ex)
            {
                SetFooter("Audit clear failed: " + ex.Message);
            }
        }

        private async void CheckUpdate_Click(object sender, RoutedEventArgs e)
        {
            try
            {
                UpdateStatusText.Foreground = PrimaryBrush;
                UpdateStatusText.Text = "Checking GitHub release...";
                var updater = new AutoUpdater();
                var update = await updater.CheckLatestAsync();
                if (update.IsCurrent)
                {
                    UpdateStatusText.Foreground = SuccessBrush;
                    UpdateStatusText.Text = "Up to date: " + update.TagName;
                    return;
                }

                UpdateStatusText.Foreground = WarningBrush;
                UpdateStatusText.Text = "Update available: " + update.TagName;
                if (MessageBox.Show(
                        this,
                        "Latest release is " + update.TagName + ". Install it now?",
                        Title,
                        MessageBoxButton.YesNo,
                        MessageBoxImage.Question) == MessageBoxResult.Yes)
                {
                    await updater.StageAndRestartAsync(update);
                    Application.Current.Shutdown();
                }
            }
            catch (Exception ex)
            {
                UpdateStatusText.Foreground = DangerBrush;
                UpdateStatusText.Text = ex.Message;
            }
        }

        private void OpenDataFolder_Click(object sender, RoutedEventArgs e)
        {
            Directory.CreateDirectory(AgentConfig.ConfigDirectory);
            Process.Start("explorer.exe", "\"" + AgentConfig.ConfigDirectory + "\"");
        }

        private void RefreshLog_Click(object sender, RoutedEventArgs e)
        {
            RefreshAgentLog();
        }

        private void OpenAgentLog_Click(object sender, RoutedEventArgs e)
        {
            if (!File.Exists(AgentConfig.AgentLogPath))
            {
                SetFooter("Agent log does not exist yet.");
                return;
            }
            Process.Start(AgentConfig.AgentLogPath);
        }

        private void LogLevelFilter_SelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            if (_initialized)
            {
                RefreshAgentLog();
            }
        }

        private void ClearAgentLog_Click(object sender, RoutedEventArgs e)
        {
            if (MessageBox.Show(
                    this,
                    "Clear the local Agent log?",
                    Title,
                    MessageBoxButton.YesNo,
                    MessageBoxImage.Warning) != MessageBoxResult.Yes)
            {
                return;
            }

            try
            {
                if (File.Exists(AgentConfig.AgentLogPath))
                {
                    File.WriteAllText(AgentConfig.AgentLogPath, "");
                }
                RefreshAgentLog();
                SetFooter("Agent log cleared.");
            }
            catch (Exception ex)
            {
                SetFooter("Unable to clear Agent log: " + ex.Message);
            }
        }

        private void CopySelectedLog_Click(object sender, RoutedEventArgs e)
        {
            if (string.IsNullOrEmpty(AgentLogBox.SelectedText))
            {
                SetFooter("Select log text to copy.");
                return;
            }

            Clipboard.SetText(AgentLogBox.SelectedText);
            SetFooter("Selected log text copied.");
        }

        private void RefreshAll()
        {
            _loadedConfig = LoadConfigSafely();
            LoadConfigurationIntoView();
            RefreshRuntimeStatus();
            RefreshAudit();
            RefreshAgentLog();
            _ = RefreshPlaywrightAsync();
        }

        private async void RefreshPlaywright_Click(object sender, RoutedEventArgs e)
        {
            await RefreshPlaywrightAsync();
            SetFooter("Playwright runtime refreshed.");
        }

        private async Task RefreshPlaywrightAsync()
        {
            try
            {
                var snapshot = await Task.Run(() => new
                {
                    Runtime = PlaywrightManager.DetectRuntime(),
                    Suites = PlaywrightManager.ReadSuites(),
                    Runs = PlaywrightManager.ReadRuns(100),
                    Artifacts = PlaywrightManager.ReadArtifacts(250),
                    WebClients = PlaywrightManager.DiscoverWebClients()
                });

                PlaywrightSuites.Clear();
                foreach (var item in snapshot.Suites) PlaywrightSuites.Add(item);
                PlaywrightRuns.Clear();
                foreach (var item in snapshot.Runs) PlaywrightRuns.Add(item);
                PlaywrightArtifacts.Clear();
                foreach (var item in snapshot.Artifacts) PlaywrightArtifacts.Add(item);
                var selectedWebClientUrl = (PlaywrightWebClientBox.SelectedItem as PlaywrightWebClientCandidate)?.Url;
                PlaywrightWebClients.Clear();
                foreach (var item in snapshot.WebClients) PlaywrightWebClients.Add(item);
                PlaywrightWebClientBox.ItemsSource = PlaywrightWebClients;
                if (!string.IsNullOrWhiteSpace(selectedWebClientUrl))
                {
                    PlaywrightWebClientBox.SelectedItem = PlaywrightWebClients.FirstOrDefault(item =>
                        string.Equals(item.Url, selectedWebClientUrl, StringComparison.OrdinalIgnoreCase));
                }

                var state = snapshot.Runtime;
                var ready = string.Equals(state.Status, "ready", StringComparison.OrdinalIgnoreCase);
                var installing = string.Equals(state.Status, "installing", StringComparison.OrdinalIgnoreCase);
                SetStatusText(PlaywrightOverviewRuntimeText, ready ? "Ready" : installing ? "Installing" : ToTitle(state.Status), ready);
                PlaywrightOverviewNodeText.Text = string.IsNullOrWhiteSpace(state.NodeVersion) ? "Not installed" : state.NodeVersion + " · " + state.NodePath;
                SetStatusText(PlaywrightOverviewNodeStatusText, string.IsNullOrWhiteSpace(state.NodePath) ? "Missing" : "Installed", !string.IsNullOrWhiteSpace(state.NodePath));
                PlaywrightOverviewPackageText.Text = string.IsNullOrWhiteSpace(state.PlaywrightVersion) ? "Not installed" : state.PlaywrightVersion;
                SetStatusText(PlaywrightOverviewPackageStatusText, string.IsNullOrWhiteSpace(state.PlaywrightVersion) ? "Missing" : "Installed", !string.IsNullOrWhiteSpace(state.PlaywrightVersion));
                PlaywrightOverviewBrowserText.Text = state.BrowserCachePath;
                SetStatusText(PlaywrightOverviewBrowserStatusText, state.ChromiumInstalled ? "Verified" : "Missing", state.ChromiumInstalled);
                var lastRun = snapshot.Runs.FirstOrDefault();
                PlaywrightOverviewLastRunText.Text = lastRun == null ? "No runs yet" : lastRun.SuiteName + " · " + ToTitle(lastRun.Status);
                PlaywrightOverviewArtifactsText.Text = snapshot.Artifacts.Count + " files";

                PlaywrightNodeText.Text = string.IsNullOrWhiteSpace(state.NodePath) ? "Node.js was not found" : state.NodeVersion + " · " + state.NodePath;
                SetStatusText(PlaywrightNodeStatusText, string.IsNullOrWhiteSpace(state.NodePath) ? "Missing" : "Ready", !string.IsNullOrWhiteSpace(state.NodePath));
                PlaywrightNpmText.Text = string.IsNullOrWhiteSpace(state.NpmPath) ? "npm was not found" : state.NpmVersion + " · " + state.NpmPath;
                SetStatusText(PlaywrightNpmStatusText, string.IsNullOrWhiteSpace(state.NpmPath) ? "Missing" : "Ready", !string.IsNullOrWhiteSpace(state.NpmPath));
                PlaywrightPackageText.Text = string.IsNullOrWhiteSpace(state.PlaywrightVersion) ? "Not installed" : state.PlaywrightVersion;
                SetStatusText(PlaywrightPackageStatusText, string.IsNullOrWhiteSpace(state.PlaywrightVersion) ? "Missing" : "Ready", !string.IsNullOrWhiteSpace(state.PlaywrightVersion));
                PlaywrightChromiumText.Text = state.ChromiumInstalled ? "Chromium browser installed" : "Chromium browser is missing";
                SetStatusText(PlaywrightChromiumStatusText, state.ChromiumInstalled ? "Ready" : "Missing", state.ChromiumInstalled);
                PlaywrightCacheText.Text = state.BrowserCachePath;
                PlaywrightCacheText.ToolTip = state.BrowserCachePath;
                PlaywrightInstallMessageText.Text = state.Message ?? "";
                PlaywrightInstallButton.Content = string.IsNullOrWhiteSpace(state.InstallAction) ? "Install dependencies" : state.InstallAction;
                PlaywrightInstallButton.IsEnabled = !ready && !installing;
                PlaywrightInstallTaskText.Text = string.IsNullOrWhiteSpace(state.ActiveTask) ? "No active task" : state.ActiveTask;
                PlaywrightInstallProgress.Value = Clamp(state.Progress, 0, 100);
                PlaywrightInstallProgressText.Text = Clamp(state.Progress, 0, 100) + "%";
                PlaywrightRuntimeLogBox.Text = string.IsNullOrWhiteSpace(state.Log) ? "No Playwright runtime activity yet." : state.Log;
                PlaywrightRuntimeLogBox.ScrollToEnd();
            }
            catch (Exception ex)
            {
                PlaywrightInstallMessageText.Text = ex.Message;
                PlaywrightRuntimeLogBox.Text = ex.ToString();
            }
        }

        private async void QueuePlaywrightInstall_Click(object sender, RoutedEventArgs e)
        {
            try
            {
                var state = await Task.Run(() => PlaywrightManager.DetectRuntime());
                if (string.Equals(state.Status, "ready", StringComparison.OrdinalIgnoreCase))
                {
                    SetFooter("Playwright runtime is already ready.");
                    return;
                }
                var taskId = PlaywrightManager.QueueInstall();
                SetFooter("Playwright installation queued: " + taskId);
                LogClientAction("Playwright installation queued: " + taskId);
                PlaywrightTabs.SelectedIndex = 1;
                _ = RefreshPlaywrightAsync();
            }
            catch (Exception ex)
            {
                SetFooter("Unable to queue Playwright installation: " + ex.Message);
            }
        }

        private void PlaywrightSuiteGrid_SelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            var suite = PlaywrightSuiteGrid.SelectedItem as PlaywrightSuite;
            if (suite == null) return;
            _selectedPlaywrightSuiteId = suite.Id;
            PlaywrightSuiteNameBox.Text = suite.Name;
            PlaywrightSuiteUrlBox.Text = suite.BaseUrl;
            PlaywrightSuiteFileBox.Text = suite.TestFile;
            PlaywrightSuiteTimeoutBox.Text = suite.TimeoutSeconds.ToString();
            PlaywrightSuiteRetriesBox.Text = suite.Retries.ToString();
            PlaywrightSuiteHeadlessCheck.IsChecked = suite.Headless;
            PlaywrightSuiteEnabledCheck.IsChecked = suite.Enabled;
            PlaywrightWebClientBox.SelectedItem = PlaywrightWebClients.FirstOrDefault(item =>
                string.Equals(item.Url, suite.BaseUrl, StringComparison.OrdinalIgnoreCase));
        }

        private void NewPlaywrightSuite_Click(object sender, RoutedEventArgs e)
        {
            _selectedPlaywrightSuiteId = "";
            PlaywrightSuiteGrid.SelectedItem = null;
            var candidate = PlaywrightWebClients.FirstOrDefault();
            PlaywrightSuiteNameBox.Text = candidate == null ? "" : candidate.Name + " smoke test";
            PlaywrightSuiteUrlBox.Text = candidate == null ? "http://localhost/" : candidate.Url;
            PlaywrightWebClientBox.SelectedItem = candidate;
            PlaywrightSuiteFileBox.Text = "samplemanager-smoke.spec.js";
            PlaywrightSuiteTimeoutBox.Text = "120";
            PlaywrightSuiteRetriesBox.Text = "0";
            PlaywrightSuiteHeadlessCheck.IsChecked = true;
            PlaywrightSuiteEnabledCheck.IsChecked = true;
            PlaywrightSuiteNameBox.Focus();
        }

        private void PlaywrightWebClientBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            var candidate = PlaywrightWebClientBox.SelectedItem as PlaywrightWebClientCandidate;
            if (candidate == null) return;
            PlaywrightSuiteUrlBox.Text = candidate.Url;
            if (string.IsNullOrWhiteSpace(PlaywrightSuiteNameBox.Text))
            {
                PlaywrightSuiteNameBox.Text = candidate.Name + " smoke test";
            }
        }

        private async void DiscoverPlaywrightWebClients_Click(object sender, RoutedEventArgs e)
        {
            try
            {
                var candidates = await Task.Run(() => PlaywrightManager.DiscoverWebClients());
                PlaywrightWebClients.Clear();
                foreach (var candidate in candidates) PlaywrightWebClients.Add(candidate);
                PlaywrightWebClientBox.ItemsSource = PlaywrightWebClients;
                if (PlaywrightWebClients.Count > 0)
                {
                    PlaywrightWebClientBox.SelectedIndex = 0;
                    var first = PlaywrightWebClients[0];
                    SetFooter(
                        "Discovered " + PlaywrightWebClients.Count +
                        " Web Client URL(s). " + first.Name + " -> " +
                        first.Url + " from " + first.Evidence + ".");
                }
                else
                {
                    SetFooter("No IIS Web Client bindings were discovered. Enter the URL manually.");
                }
            }
            catch (Exception ex)
            {
                SetFooter("Web Client discovery failed: " + ex.Message);
            }
        }

        private async void SavePlaywrightSuite_Click(object sender, RoutedEventArgs e)
        {
            try
            {
                var suite = new PlaywrightSuite
                {
                    Id = _selectedPlaywrightSuiteId,
                    Name = PlaywrightSuiteNameBox.Text.Trim(),
                    BaseUrl = PlaywrightSuiteUrlBox.Text.Trim(),
                    TestFile = PlaywrightSuiteFileBox.Text.Trim(),
                    TimeoutSeconds = ReadInteger(PlaywrightSuiteTimeoutBox.Text, 120, 10, 3600),
                    Retries = ReadInteger(PlaywrightSuiteRetriesBox.Text, 0, 0, 5),
                    Headless = PlaywrightSuiteHeadlessCheck.IsChecked == true,
                    Enabled = PlaywrightSuiteEnabledCheck.IsChecked == true
                };
                var saved = PlaywrightManager.SaveSuite(suite);
                _selectedPlaywrightSuiteId = saved.Id;
                await RefreshPlaywrightAsync();
                SetFooter("Playwright suite saved.");
            }
            catch (Exception ex)
            {
                SetFooter("Unable to save Playwright suite: " + ex.Message);
            }
        }

        private async void DeletePlaywrightSuite_Click(object sender, RoutedEventArgs e)
        {
            if (string.IsNullOrWhiteSpace(_selectedPlaywrightSuiteId))
            {
                SetFooter("Select a Playwright suite to delete.");
                return;
            }
            if (MessageBox.Show(this, "Delete the selected Playwright suite?", Title, MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes)
            {
                return;
            }
            PlaywrightManager.DeleteSuite(_selectedPlaywrightSuiteId);
            NewPlaywrightSuite_Click(sender, e);
            await RefreshPlaywrightAsync();
            SetFooter("Playwright suite deleted.");
        }

        private async void RunPlaywrightSuite_Click(object sender, RoutedEventArgs e)
        {
            var button = sender as Button;
            var suiteId = button == null ? "" : Convert.ToString(button.Tag);
            try
            {
                var taskId = PlaywrightManager.QueueRun(suiteId);
                SetFooter("Playwright test queued: " + taskId);
                LogClientAction("Playwright test queued: " + taskId);
                PlaywrightTabs.SelectedIndex = 3;
                await RefreshPlaywrightAsync();
            }
            catch (Exception ex)
            {
                SetFooter("Unable to queue Playwright test: " + ex.Message);
            }
        }

        private void PlaywrightRunGrid_SelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            var run = PlaywrightRunGrid.SelectedItem as PlaywrightRun;
            if (run == null)
            {
                PlaywrightRunDetailBox.Text = "Select a run to inspect details.";
                return;
            }
            PlaywrightRunDetailBox.Text =
                "Run ID: " + run.Id + Environment.NewLine +
                "Suite: " + run.SuiteName + Environment.NewLine +
                "Status: " + run.Status + Environment.NewLine +
                "Started: " + run.StartedAt + Environment.NewLine +
                "Finished: " + run.FinishedAt + Environment.NewLine +
                "Duration: " + run.DurationMs + " ms" + Environment.NewLine +
                "Exit code: " + run.ExitCode + Environment.NewLine +
                "Artifacts: " + run.ArtifactDirectory + Environment.NewLine +
                (string.IsNullOrWhiteSpace(run.Error) ? "" : "Error: " + run.Error + Environment.NewLine) +
                Environment.NewLine + (run.Output ?? "");
        }

        private void OpenPlaywrightFolder_Click(object sender, RoutedEventArgs e)
        {
            try
            {
                Directory.CreateDirectory(PlaywrightManager.RootPath);
                Process.Start("explorer.exe", "\"" + PlaywrightManager.RootPath + "\"");
            }
            catch (Exception ex)
            {
                SetFooter("Unable to open Playwright folder: " + ex.Message);
            }
        }

        private async void ClearPlaywrightArtifacts_Click(object sender, RoutedEventArgs e)
        {
            if (MessageBox.Show(this, "Delete all Playwright artifacts?", Title, MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes)
            {
                return;
            }
            PlaywrightManager.ClearArtifacts();
            await RefreshPlaywrightAsync();
            SetFooter("Playwright artifacts cleared.");
        }

        private void RefreshRuntimeStatus()
        {
            var service = QueryService();
            var configured = !string.IsNullOrWhiteSpace(_loadedConfig.RelayUrl) &&
                             !string.IsNullOrWhiteSpace(_loadedConfig.Token);
            var auditEntries = HttpAuditStore.ReadRecent(100, "All", "All");
            var latestHeartbeat = auditEntries.FirstOrDefault(entry =>
                entry.endpoint != null &&
                entry.endpoint.IndexOf("/heartbeat", StringComparison.OrdinalIgnoreCase) >= 0);

            SetStatusText(
                HeaderConnectionText,
                configured ? "Configured" : "Not configured",
                configured);
            SetStatusText(
                HeaderServiceText,
                ToTitle(service),
                service == "running");
            HeaderLastSeenText.Text = latestHeartbeat == null
                ? "No heartbeat"
                : FormatTimestamp(latestHeartbeat.timestamp);
            HeaderLastSeenText.ToolTip = latestHeartbeat == null
                ? null
                : latestHeartbeat.timestamp;

            SetStatusText(ServiceStateText, ToTitle(service), service == "running");
            ServiceIdentityText.Text = DatabaseAccessManager.GetServiceIdentity();
            ServicePathText.Text = GetServiceExecutablePath();
            ServicePathText.ToolTip = ServicePathText.Text;

            var serviceInstalled = service != "not installed";
            StartServiceButton.IsEnabled = serviceInstalled && service != "running";
            StopServiceButton.IsEnabled = service == "running";
            RestartServiceButton.IsEnabled = service == "running";
            UninstallServiceButton.IsEnabled = serviceInstalled;

            SetStatusText(
                OverviewConnectionText,
                configured ? "Configured" : "Action required",
                configured);
            SetStatusText(
                OverviewServiceText,
                service == "running" ? "Running" : ToTitle(service),
                service == "running");

            var databaseReady = _lastDatabaseState != null && _lastDatabaseState.ReadReady;
            OverviewDatabaseText.Text = _lastDatabaseState == null
                ? "Not checked"
                : databaseReady ? "Ready" : "Permissions missing";
            OverviewDatabaseText.Foreground = databaseReady ? SuccessBrush : WarningBrush;

            SetStatusText(
                OverviewAuditText,
                _loadedConfig.AuditEnabled ? "Audit enabled" : "Audit disabled",
                _loadedConfig.AuditEnabled);

            SummaryRelayText.Text = AgentConfig.MaskRelayUrl(_loadedConfig.RelayUrl);
            SummaryAgentIdText.Text = string.IsNullOrWhiteSpace(_loadedConfig.AgentId)
                ? "Not configured"
                : _loadedConfig.AgentId;
            SummaryServiceAccountText.Text = DatabaseAccessManager.GetServiceIdentity();
            SummaryPollText.Text = _loadedConfig.PollSeconds + " seconds";
            SummaryAuditText.Text = _loadedConfig.AuditRetentionDays + " days";

            FooterText.Text =
                "Service: " + ToTitle(service) +
                "    |    Audit: " +
                (_loadedConfig.AuditEnabled ? "Enabled" : "Disabled") +
                "    |    Local time: " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");

            if (PlaywrightPage.Visibility == Visibility.Visible)
            {
                _ = RefreshPlaywrightAsync();
            }
        }

        private void SetStatusText(TextBlock control, string value, bool success)
        {
            control.Text = value;
            control.Foreground = success ? SuccessBrush : WarningBrush;
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

        private ProcessResult RunSc(string args)
        {
            var result = RunProcess("sc.exe", args);
            if (result.ExitCode != 0 &&
                result.Output.IndexOf("FAILED 1060", StringComparison.OrdinalIgnoreCase) < 0)
            {
                SetFooter(result.Output.Trim());
            }
            return result;
        }

        private ProcessResult RunProcess(string fileName, string args)
        {
            try
            {
                var info = new ProcessStartInfo(fileName, args)
                {
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };
                using (var process = Process.Start(info))
                {
                    if (process == null)
                    {
                        return new ProcessResult(-1, "Unable to start " + fileName + ".");
                    }
                    var output = process.StandardOutput.ReadToEnd() +
                                 process.StandardError.ReadToEnd();
                    process.WaitForExit();
                    return new ProcessResult(process.ExitCode, output);
                }
            }
            catch (Exception ex)
            {
                return new ProcessResult(-1, ex.Message);
            }
        }

        private string GetServiceExecutablePath()
        {
            using (var key = Registry.LocalMachine.OpenSubKey(
                @"SYSTEM\CurrentControlSet\Services\" + AgentConfig.ServiceName))
            {
                var imagePath = key == null ? null : key.GetValue("ImagePath") as string;
                return string.IsNullOrWhiteSpace(imagePath)
                    ? "Not installed"
                    : Environment.ExpandEnvironmentVariables(imagePath);
            }
        }

        private void RefreshAgentLog()
        {
            try
            {
                if (!File.Exists(AgentConfig.AgentLogPath))
                {
                    AgentLogBox.Text = "No log entries yet.\r\nThe Agent log file is not available.";
                    return;
                }

                var level = GetComboValue(LogLevelFilter, "All");
                var lines = File.ReadLines(AgentConfig.AgentLogPath)
                    .Where(line => level == "All" ||
                                   line.IndexOf(level, StringComparison.OrdinalIgnoreCase) >= 0)
                    .Reverse()
                    .Take(400)
                    .Reverse();
                AgentLogBox.Text = string.Join(Environment.NewLine, lines);
                if (LogAutoScrollCheck.IsChecked == true)
                {
                    AgentLogBox.CaretIndex = AgentLogBox.Text.Length;
                    AgentLogBox.ScrollToEnd();
                }
            }
            catch (Exception ex)
            {
                AgentLogBox.Text = "Log file unavailable\r\n" + ex.Message;
            }
        }

        private void SetFooter(string message)
        {
            FooterText.Text = message;
        }

        private void LogClientAction(string message)
        {
            try
            {
                Directory.CreateDirectory(AgentConfig.ConfigDirectory);
                File.AppendAllText(
                    AgentConfig.AgentLogPath,
                    DateTimeOffset.Now.ToString("o") +
                    " Client: " + message + Environment.NewLine);
            }
            catch
            {
            }
        }

        private AgentConfig LoadConfigSafely()
        {
            try
            {
                _configurationLoadError = "";
                return AgentConfig.Load();
            }
            catch (Exception ex)
            {
                _configurationLoadError = ex.Message;
                return new AgentConfig();
            }
        }

        private static string GetComboValue(ComboBox comboBox, string fallback)
        {
            var item = comboBox == null ? null : comboBox.SelectedItem as ComboBoxItem;
            var value = item == null
                ? Convert.ToString(comboBox == null ? null : comboBox.SelectedItem)
                : Convert.ToString(item.Content);
            return string.IsNullOrWhiteSpace(value) ? fallback : value;
        }

        private static int ReadInteger(
            string value,
            int fallback,
            int minimum,
            int maximum)
        {
            int parsed;
            return int.TryParse(value, out parsed)
                ? Clamp(parsed, minimum, maximum)
                : fallback;
        }

        private static int Clamp(int value, int minimum, int maximum)
        {
            return Math.Max(minimum, Math.Min(value, maximum));
        }

        private static string FormatAccessLevel(DatabaseAccessLevel level)
        {
            if (level == DatabaseAccessLevel.ReadWrite)
            {
                return "read/write";
            }
            if (level == DatabaseAccessLevel.Ddl)
            {
                return "DDL";
            }
            return "read";
        }

        private static string FormatTimestamp(string timestamp)
        {
            DateTimeOffset parsed;
            return DateTimeOffset.TryParse(timestamp, out parsed)
                ? parsed.LocalDateTime.ToString("HH:mm:ss")
                : timestamp;
        }

        private static string ToTitle(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return "";
            }
            return char.ToUpperInvariant(value[0]) + value.Substring(1);
        }

        public sealed class PermissionRow
        {
            public string Permission { get; set; }
            public string Current { get; set; }
            public string Read { get; set; }
            public string Write { get; set; }
            public string Ddl { get; set; }
            public Brush StatusForeground { get; set; }
            public Brush StatusBackground { get; set; }
        }

        public sealed class AuditRow
        {
            public string Time { get; set; }
            public string Method { get; set; }
            public string Endpoint { get; set; }
            public string Status { get; set; }
            public string Duration { get; set; }
            public string JobId { get; set; }
            public string Payload { get; set; }
            public HttpAuditEntry Entry { get; set; }
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
