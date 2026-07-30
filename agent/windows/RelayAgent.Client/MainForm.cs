using Microsoft.Win32;
using RelayAgent.Shared;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace RelayAgent.Client
{
    public sealed class MainForm : Form
    {
        private readonly Dictionary<string, NavButton> _navigation =
            new Dictionary<string, NavButton>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, Control> _pages =
            new Dictionary<string, Control>(StringComparer.OrdinalIgnoreCase);
        private readonly Panel _pageHost = new Panel();
        private readonly Label _headerConnection = new Label();
        private readonly Label _headerService = new Label();
        private readonly Label _headerVersion = new Label();
        private readonly Label _headerLastSeen = new Label();
        private readonly Label _footerStatus = new Label();
        private readonly ToolTip _toolTips = new ToolTip();
        private readonly System.Windows.Forms.Timer _refreshTimer =
            new System.Windows.Forms.Timer();

        private AgentConfig _loadedConfig;
        private string _configurationLoadError;
        private DatabasePermissionState _lastDatabaseState;

        private TextBox _relayUrlBox;
        private TextBox _agentIdBox;
        private TextBox _tokenBox;
        private NumericUpDown _pollSeconds;
        private Label _connectionNotice;

        private Label _overviewConnection;
        private Label _overviewService;
        private Label _overviewDatabase;
        private Label _overviewAudit;

        private Label _serviceState;
        private Label _servicePath;
        private Label _serviceIdentity;
        private ModernButton _startServiceButton;
        private ModernButton _stopServiceButton;
        private ModernButton _restartServiceButton;
        private ModernButton _uninstallServiceButton;

        private ComboBox _sqlServerBox;
        private ComboBox _databaseBox;
        private Label _databaseIdentity;
        private Label _databaseResult;
        private DataGridView _permissionGrid;

        private CheckBox _auditEnabled;
        private CheckBox _auditPayloads;
        private NumericUpDown _auditRetention;
        private ComboBox _auditMethodFilter;
        private ComboBox _auditStatusFilter;
        private DataGridView _auditGrid;
        private TextBox _auditDetail;
        private SectionPanel _auditDetailSection;

        private TextBox _agentLog;
        private Label _updateStatus;
        private CheckBox _logAutoScroll;
        private ComboBox _logLevelFilter;

        public MainForm()
        {
            Text = "Relay MCP Agent Client";
            Icon = UiTheme.CreateAppIcon();
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(1120, 720);
            Size = new Size(1320, 840);
            BackColor = UiTheme.AppBackground;
            Font = UiTheme.BodyFont;
            DoubleBuffered = true;

            _loadedConfig = LoadConfigSafely();
            BuildShell();
            AutoScaleMode = AutoScaleMode.None;
            LoadConfigurationIntoView();
            LoadSqlServers();
            ShowPage("overview");
            RefreshAll();

            _refreshTimer.Interval = 5000;
            _refreshTimer.Tick += (sender, args) => RefreshRuntimeStatus();
            _refreshTimer.Start();
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            _refreshTimer.Stop();
            base.OnFormClosed(e);
        }

        private void BuildShell()
        {
            var root = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 2,
                RowCount = 1,
                Margin = Padding.Empty,
                Padding = Padding.Empty,
                BackColor = UiTheme.AppBackground
            };
            root.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 216));
            root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            Controls.Add(root);

            root.Controls.Add(BuildSidebar(), 0, 0);
            root.Controls.Add(BuildMainArea(), 1, 0);
        }

        private Control BuildSidebar()
        {
            var sidebar = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                BackColor = UiTheme.Sidebar,
                Padding = new Padding(12, 0, 12, 12),
                ColumnCount = 1,
                RowCount = 2
            };
            sidebar.RowStyles.Add(new RowStyle(SizeType.Absolute, 76));
            sidebar.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

            var brand = new Panel
            {
                Dock = DockStyle.Fill,
                BackColor = UiTheme.Sidebar
            };
            var mark = new Label
            {
                Text = "R",
                ForeColor = Color.White,
                BackColor = UiTheme.Primary,
                Font = new Font("Segoe UI Semibold", 13f, FontStyle.Bold),
                TextAlign = ContentAlignment.MiddleCenter,
                Bounds = new Rectangle(4, 20, 34, 34)
            };
            var title = new Label
            {
                Text = "Relay MCP",
                ForeColor = UiTheme.Text,
                Font = new Font("Segoe UI Semibold", 12f, FontStyle.Bold),
                AutoSize = true,
                Location = new Point(48, 19)
            };
            var subtitle = new Label
            {
                Text = "Agent Client",
                ForeColor = UiTheme.MutedText,
                Font = UiTheme.SmallFont,
                AutoSize = true,
                Location = new Point(48, 40)
            };
            brand.Controls.Add(mark);
            brand.Controls.Add(title);
            brand.Controls.Add(subtitle);
            var nav = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                AutoScroll = true,
                BackColor = UiTheme.Sidebar,
                Padding = new Padding(0, 8, 0, 0)
            };
            sidebar.Controls.Add(brand, 0, 0);
            sidebar.Controls.Add(nav, 0, 1);

            AddNav(nav, "overview", "Overview", "\uE80F", BuildOverviewPage());
            AddNav(nav, "connection", "Connection", "\uE774", BuildConnectionPage());
            AddNav(nav, "service", "Service Control", "\uE713", BuildServicePage());
            AddNav(nav, "database", "Database Access", "\uE8B7", BuildDatabasePage());
            AddNav(nav, "audit", "Request Audit", "\uE9D5", BuildAuditPage());
            AddNav(nav, "diagnostics", "Updates & Logs", "\uE9D9", BuildDiagnosticsPage());

            return sidebar;
        }

        private Control BuildMainArea()
        {
            var main = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                RowCount = 3,
                ColumnCount = 1,
                Margin = Padding.Empty,
                Padding = Padding.Empty,
                BackColor = UiTheme.AppBackground
            };
            main.RowStyles.Add(new RowStyle(SizeType.Absolute, 84));
            main.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            main.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));

            main.Controls.Add(BuildHeader(), 0, 0);

            _pageHost.Dock = DockStyle.Fill;
            _pageHost.BackColor = UiTheme.AppBackground;
            foreach (var page in _pages.Values)
            {
                page.Dock = DockStyle.Fill;
                page.Visible = false;
                _pageHost.Controls.Add(page);
            }
            main.Controls.Add(_pageHost, 0, 1);

            var footer = new Panel
            {
                Dock = DockStyle.Fill,
                BackColor = UiTheme.Surface,
                Padding = new Padding(22, 0, 22, 0)
            };
            footer.Paint += (sender, args) =>
            {
                using (var pen = new Pen(UiTheme.Border))
                {
                    args.Graphics.DrawLine(pen, 0, 0, footer.Width, 0);
                }
            };
            _footerStatus.Dock = DockStyle.Fill;
            _footerStatus.TextAlign = ContentAlignment.MiddleLeft;
            _footerStatus.ForeColor = UiTheme.MutedText;
            _footerStatus.Font = UiTheme.SmallFont;
            footer.Controls.Add(_footerStatus);
            main.Controls.Add(footer, 0, 2);

            return main;
        }

        private Control BuildHeader()
        {
            var header = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 6,
                RowCount = 1,
                Padding = new Padding(24, 10, 18, 10),
                BackColor = UiTheme.Surface,
                Margin = Padding.Empty
            };
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 154));
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 142));
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 108));
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 158));
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 48));
            header.Paint += (sender, args) =>
            {
                using (var pen = new Pen(UiTheme.Border))
                {
                    args.Graphics.DrawLine(pen, 0, header.Height - 1, header.Width, header.Height - 1);
                }
            };

            var heading = new Label
            {
                Text = "Agent operations",
                Font = new Font("Segoe UI Semibold", 14f, FontStyle.Bold),
                ForeColor = UiTheme.Text,
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleLeft,
                Padding = new Padding(0, 2, 0, 2)
            };
            header.Controls.Add(heading, 0, 0);
            header.Controls.Add(BuildHeaderMetric("CONNECTION", _headerConnection), 1, 0);
            header.Controls.Add(BuildHeaderMetric("SERVICE", _headerService), 2, 0);
            header.Controls.Add(BuildHeaderMetric("VERSION", _headerVersion), 3, 0);
            header.Controls.Add(BuildHeaderMetric("LAST SEEN", _headerLastSeen), 4, 0);

            var refreshHost = new Panel
            {
                Dock = DockStyle.Fill,
                AutoSize = true,
                MinimumSize = new Size(48, 48),
                Padding = new Padding(2),
                BackColor = Color.Transparent
            };
            var refresh = UiTheme.CreateButton("", (sender, args) => RefreshAll(), ButtonTone.Ghost, "\uE72C");
            refresh.AutoSize = false;
            refresh.MinimumSize = new Size(36, 36);
            refresh.MaximumSize = new Size(36, 36);
            refresh.Size = new Size(36, 36);
            refresh.Margin = Padding.Empty;
            refresh.Anchor = AnchorStyles.None;
            refreshHost.Controls.Add(refresh);
            refreshHost.Resize += (sender, args) =>
            {
                refresh.Location = new Point(
                    Math.Max(0, (refreshHost.ClientSize.Width - refresh.Width) / 2),
                    Math.Max(0, (refreshHost.ClientSize.Height - refresh.Height) / 2));
            };
            _toolTips.SetToolTip(refresh, "Refresh connection, service, audit, and log status");
            header.Controls.Add(refreshHost, 5, 0);
            return header;
        }

        private Control BuildHeaderMetric(string caption, Label value)
        {
            var panel = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                RowCount = 2,
                ColumnCount = 1,
                Margin = new Padding(8, 0, 8, 0)
            };
            panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 24));
            panel.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            panel.Controls.Add(new Label
            {
                Text = caption,
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleLeft,
                ForeColor = UiTheme.MutedText,
                Font = new Font("Segoe UI Semibold", 7.5f),
                Padding = new Padding(0, 2, 0, 2)
            }, 0, 0);
            value.Dock = DockStyle.Fill;
            value.TextAlign = ContentAlignment.MiddleLeft;
            value.ForeColor = UiTheme.Text;
            value.Font = UiTheme.BodyFont;
            value.Padding = new Padding(0, 2, 0, 2);
            value.AutoEllipsis = true;
            panel.Controls.Add(value, 0, 1);
            return panel;
        }

        private void AddNav(
            FlowLayoutPanel container,
            string key,
            string text,
            string glyph,
            Control page)
        {
            var button = new NavButton
            {
                Name = key,
                Text = text,
                Glyph = glyph,
                Width = 180,
                Margin = new Padding(0, 0, 0, 3)
            };
            button.Click += (sender, args) => ShowPage(key);
            container.Controls.Add(button);
            _navigation[key] = button;
            _pages[key] = page;
        }

        private Control BuildOverviewPage()
        {
            Panel body;
            var page = CreatePage(
                "Overview",
                "Connection, service, database, and audit readiness at a glance.",
                out body);

            var layout = new TableLayoutPanel
            {
                Dock = DockStyle.Top,
                AutoSize = true,
                ColumnCount = 2,
                RowCount = 2,
                Margin = Padding.Empty
            };
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 65));
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 35));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 176));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 354));
            body.Controls.Add(layout);

            var readiness = new SectionPanel
            {
                Dock = DockStyle.Fill
            };
            var readinessLayout = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 4,
                RowCount = 1
            };
            readinessLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            for (var i = 0; i < 4; i++)
            {
                readinessLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25));
            }
            _overviewConnection = CreateReadinessItem(readinessLayout, 0, "1", "Connect Relay");
            _overviewService = CreateReadinessItem(readinessLayout, 1, "2", "Install Service");
            _overviewDatabase = CreateReadinessItem(readinessLayout, 2, "3", "Database Access");
            _overviewAudit = CreateReadinessItem(readinessLayout, 3, "4", "Verify Agent");
            readiness.Controls.Add(readinessLayout);
            layout.Controls.Add(readiness, 0, 0);
            layout.SetColumnSpan(readiness, 2);

            var summary = CreateSection("Agent summary");
            var summaryList = new Panel
            {
                Dock = DockStyle.Top,
                Height = 184,
                Margin = Padding.Empty,
                Padding = Padding.Empty,
                BackColor = Color.Transparent
            };
            AddSummaryRow(summaryList, 0, "Relay endpoint", () => AgentConfig.MaskRelayUrl(_loadedConfig.RelayUrl));
            AddSummaryRow(summaryList, 1, "Agent ID", () => _loadedConfig.AgentId);
            AddSummaryRow(summaryList, 2, "Service account", DatabaseAccessManager.GetServiceIdentity);
            AddSummaryRow(summaryList, 3, "Polling interval", () => _loadedConfig.PollSeconds + " seconds");
            AddSummaryRow(summaryList, 4, "Audit retention", () => _loadedConfig.AuditRetentionDays + " days");
            summary.Controls.Add(summaryList);
            layout.Controls.Add(summary, 0, 1);

            var actions = CreateSection("Quick actions");
            var actionStack = new TableLayoutPanel
            {
                Dock = DockStyle.Top,
                AutoSize = true,
                ColumnCount = 1,
                RowCount = 0,
                Margin = Padding.Empty,
                Padding = Padding.Empty
            };
            actionStack.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            AddStackButton(actionStack, "Test relay", "\uE8FA", (sender, args) => TestRelayAsync());
            AddStackButton(actionStack, "Restart service", "\uE72C", (sender, args) => RestartService());
            AddStackButton(actionStack, "Check database access", "\uE8B7", (sender, args) =>
            {
                ShowPage("database");
                TestDatabaseAccessAsync();
            });
            AddStackButton(actionStack, "Open request audit", "\uE9D5", (sender, args) =>
            {
                ShowPage("audit");
                RefreshAudit();
            });
            actions.Controls.Add(actionStack);
            layout.Controls.Add(actions, 1, 1);

            return page;
        }

        private Label CreateReadinessItem(
            TableLayoutPanel parent,
            int column,
            string number,
            string title)
        {
            var panel = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 2,
                RowCount = 2,
                Margin = new Padding(column == 0 ? 0 : 10, 10, 10, 10)
            };
            panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 48));
            panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            panel.RowStyles.Add(new RowStyle(SizeType.Percent, 55));
            panel.RowStyles.Add(new RowStyle(SizeType.Percent, 45));

            var badgeHost = new Panel
            {
                Dock = DockStyle.Fill,
                Margin = new Padding(0, 0, 12, 0),
                BackColor = Color.Transparent
            };
            var badge = new StepBadge
            {
                Text = number,
                Size = new Size(32, 32)
            };
            badgeHost.Controls.Add(badge);
            badgeHost.Resize += (sender, args) =>
            {
                badge.Location = new Point(
                    Math.Max(0, (badgeHost.ClientSize.Width - badge.Width) / 2),
                    Math.Max(0, (badgeHost.ClientSize.Height - badge.Height) / 2));
            };
            panel.Controls.Add(badgeHost, 0, 0);
            panel.SetRowSpan(badgeHost, 2);
            var titleLabel = UiTheme.CreateLabel(title, UiTheme.Text, UiTheme.SectionFont);
            titleLabel.MinimumSize = new Size(0, 34);
            titleLabel.Padding = new Padding(0, 2, 0, 2);
            panel.Controls.Add(titleLabel, 1, 0);
            var state = UiTheme.CreateLabel("Checking...", UiTheme.MutedText, UiTheme.BodyFont);
            state.MinimumSize = new Size(0, 30);
            state.Padding = new Padding(0, 2, 0, 2);
            panel.Controls.Add(state, 1, 1);
            parent.Controls.Add(panel, column, 0);
            return state;
        }

        private Control BuildConnectionPage()
        {
            Panel body;
            var page = CreatePage(
                "Secure connection",
                "Relay address and Agent token are encrypted locally and never shown in plaintext after save.",
                out body);

            var section = CreateSection("Connection configuration");
            section.Dock = DockStyle.Top;
            section.Height = 470;
            section.MaximumSize = new Size(900, 470);
            body.Controls.Add(section);

            var table = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 3,
                RowCount = 7,
                Padding = new Padding(0, 10, 0, 0)
            };
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 170));
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 140));
            table.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
            table.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
            table.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
            table.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
            table.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
            table.RowStyles.Add(new RowStyle(SizeType.Absolute, 50));
            table.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

            _relayUrlBox = UiTheme.StyleTextBox(new TextBox { Dock = DockStyle.Fill });
            _agentIdBox = UiTheme.StyleTextBox(new TextBox { Dock = DockStyle.Fill });
            _tokenBox = UiTheme.StyleTextBox(new TextBox { Dock = DockStyle.Fill });
            _pollSeconds = UiTheme.StyleNumericUpDown(new NumericUpDown
            {
                Minimum = 2,
                Maximum = 120,
                Value = 10,
                Dock = DockStyle.Left,
                Width = 120,
            });

            AddField(table, 0, "Relay MCP address", _relayUrlBox);
            AddField(table, 1, "Agent ID", _agentIdBox);
            AddField(table, 2, "Agent token", _tokenBox);
            AddField(table, 3, "Poll interval", _pollSeconds);
            var replaceUrl = UiTheme.CreateButton("Replace", ReplaceRelayUrl, ButtonTone.Secondary, "\uE70F");
            replaceUrl.Dock = DockStyle.Fill;
            replaceUrl.Margin = new Padding(4, 2, 0, 2);
            table.Controls.Add(replaceUrl, 2, 0);
            var replaceToken = UiTheme.CreateButton("Replace token", ReplaceToken, ButtonTone.Secondary, "\uE72E");
            replaceToken.Dock = DockStyle.Fill;
            replaceToken.Margin = new Padding(4, 2, 0, 2);
            table.Controls.Add(replaceToken, 2, 2);

            var security = new Label
            {
                Text = "Protected with Windows DPAPI (LocalMachine) and restricted file permissions.",
                ForeColor = UiTheme.Success,
                Font = UiTheme.SmallFont,
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleLeft,
                Padding = new Padding(0, 3, 0, 3)
            };
            table.Controls.Add(security, 1, 4);
            table.SetColumnSpan(security, 2);

            var actions = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.LeftToRight,
                WrapContents = false,
                Padding = new Padding(0, 2, 0, 2)
            };
            actions.Controls.Add(UiTheme.CreateButton("Save securely", SaveConfiguration, ButtonTone.Primary, "\uE74E"));
            actions.Controls.Add(UiTheme.CreateButton("Test relay", (sender, args) => TestRelayAsync(), ButtonTone.Secondary, "\uE8FA"));
            table.Controls.Add(actions, 1, 5);
            table.SetColumnSpan(actions, 2);

            _connectionNotice = new Label
            {
                Text = "",
                Dock = DockStyle.Fill,
                ForeColor = UiTheme.MutedText,
                Font = UiTheme.SmallFont,
                TextAlign = ContentAlignment.TopLeft,
                AutoEllipsis = true
            };
            table.Controls.Add(_connectionNotice, 1, 6);
            table.SetColumnSpan(_connectionNotice, 2);
            section.Controls.Add(table);
            return page;
        }

        private Control BuildServicePage()
        {
            Panel body;
            var page = CreatePage(
                "Service control",
                "Install, update, start, and inspect the Windows Service that runs the Agent.",
                out body);

            var layout = new TableLayoutPanel
            {
                Dock = DockStyle.Top,
                AutoSize = true,
                ColumnCount = 2,
                RowCount = 1
            };
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 62));
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 38));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 390));
            body.Controls.Add(layout);

            var details = CreateSection("Windows Service");
            var table = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 2,
                RowCount = 4,
                Padding = new Padding(0, 10, 0, 0)
            };
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 160));
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            for (var i = 0; i < 4; i++)
            {
                table.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
            }
            _serviceState = AddValueRow(table, 0, "Status");
            _serviceIdentity = AddValueRow(table, 1, "Running as");
            _servicePath = AddValueRow(table, 2, "Executable");
            var startMode = AddValueRow(table, 3, "Startup");
            startMode.Text = "Automatic";
            _toolTips.SetToolTip(_servicePath, "The full executable path registered for the Windows Service.");
            details.Controls.Add(table);
            layout.Controls.Add(details, 0, 0);

            var actions = CreateSection("Service actions");
            var flow = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                Padding = new Padding(0, 38, 0, 0),
                AutoScroll = true
            };
            flow.Controls.Add(WideButton("Install or update service", "\uE896", InstallService));
            _startServiceButton = (ModernButton)WideButton("Start service", "\uE768", StartService);
            _stopServiceButton = (ModernButton)WideButton("Stop service", "\uE71A", StopService);
            _restartServiceButton = (ModernButton)WideButton("Restart service", "\uE72C", (sender, args) => RestartService());
            flow.Controls.Add(_startServiceButton);
            flow.Controls.Add(_stopServiceButton);
            flow.Controls.Add(_restartServiceButton);
            var uninstall = WideButton("Uninstall service", "\uE74D", UninstallService);
            _uninstallServiceButton = (ModernButton)uninstall;
            _uninstallServiceButton.Tone = ButtonTone.Danger;
            _uninstallServiceButton.Margin = new Padding(0, 12, 0, 10);
            flow.Controls.Add(_uninstallServiceButton);
            _toolTips.SetToolTip(_startServiceButton, "Start the installed Relay MCP Agent service.");
            _toolTips.SetToolTip(_stopServiceButton, "Stop the running Relay MCP Agent service.");
            _toolTips.SetToolTip(_restartServiceButton, "Restart the running Relay MCP Agent service.");
            _toolTips.SetToolTip(_uninstallServiceButton, "Remove the Relay MCP Agent Windows Service.");
            actions.Controls.Add(flow);
            layout.Controls.Add(actions, 1, 0);
            return page;
        }

        private Control BuildDatabasePage()
        {
            Panel body;
            var page = CreatePage(
                "Database access",
                "Detect SampleManager databases and grant the Agent service identity only the permissions it needs.",
                out body);

            var layout = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 2,
                RowCount = 2
            };
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 54));
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 46));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 270));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            body.Controls.Add(layout);

            var target = CreateSection("Target");
            var targetTable = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 2,
                RowCount = 4,
                Padding = new Padding(0, 10, 0, 0)
            };
            targetTable.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 140));
            targetTable.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            for (var i = 0; i < 4; i++)
            {
                targetTable.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
            }
            _sqlServerBox = UiTheme.StyleComboBox(new ComboBox { Dock = DockStyle.Fill });
            _sqlServerBox.DropDownStyle = ComboBoxStyle.DropDown;
            _databaseBox = UiTheme.StyleComboBox(new ComboBox { Dock = DockStyle.Fill });
            _databaseIdentity = UiTheme.CreateLabel("", UiTheme.Text, UiTheme.BodyFont);
            _databaseResult = UiTheme.CreateLabel("Not checked", UiTheme.MutedText, UiTheme.BodyFont);
            AddField(targetTable, 0, "SQL Server", _sqlServerBox);
            AddField(targetTable, 1, "Database", _databaseBox);
            AddField(targetTable, 2, "Service identity", _databaseIdentity);
            AddField(targetTable, 3, "Current result", _databaseResult);
            target.Controls.Add(targetTable);
            layout.Controls.Add(target, 0, 0);

            var targetActions = CreateSection("Discovery and verification");
            var actionFlow = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                Padding = new Padding(0, 38, 0, 0),
                AutoScroll = true
            };
            actionFlow.Controls.Add(WideButton("Detect databases", "\uE721", (sender, args) => DetectDatabasesAsync()));
            actionFlow.Controls.Add(WideButton("Test current access", "\uE8FA", (sender, args) => TestDatabaseAccessAsync()));
            targetActions.Controls.Add(actionFlow);
            layout.Controls.Add(targetActions, 1, 0);

            var permissions = CreateSection("Permission evidence");
            _permissionGrid = new DataGridView { Dock = DockStyle.Fill };
            UiTheme.StyleGrid(_permissionGrid);
            _permissionGrid.Columns.Add("Permission", "Permission");
            _permissionGrid.Columns.Add("Current", "Current");
            _permissionGrid.Columns.Add("Read", "Required for read");
            _permissionGrid.Columns.Add("Write", "Required for write");
            _permissionGrid.Columns.Add("Ddl", "Required for DDL");
            permissions.Padding = new Padding(18, 50, 18, 18);
            _permissionGrid.Columns["Permission"].MinimumWidth = 150;
            _permissionGrid.Columns["Current"].MinimumWidth = 105;
            _permissionGrid.Columns["Read"].MinimumWidth = 125;
            _permissionGrid.Columns["Write"].MinimumWidth = 125;
            _permissionGrid.Columns["Ddl"].MinimumWidth = 120;
            permissions.Controls.Add(_permissionGrid);
            layout.Controls.Add(permissions, 0, 1);

            var grant = CreateSection("Access actions");
            var grantFlow = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                Padding = new Padding(0, 38, 0, 0),
                AutoScroll = true
            };
            grantFlow.Controls.Add(WideButton("Grant read access", "\uE72E", (sender, args) =>
                GrantDatabaseAccessAsync(DatabaseAccessLevel.Read)));
            grantFlow.Controls.Add(WideButton("Grant read/write access", "\uE70F", (sender, args) =>
                GrantDatabaseAccessAsync(DatabaseAccessLevel.ReadWrite)));
            var grantDdl = WideButton("Grant DDL access", "\uE713", (sender, args) =>
                GrantDatabaseAccessAsync(DatabaseAccessLevel.Ddl));
            ((ModernButton)grantDdl).Tone = ButtonTone.Danger;
            grantFlow.Controls.Add(grantDdl);
            var revoke = WideButton("Revoke database access", "\uE74D", (sender, args) => RevokeDatabaseAccessAsync());
            ((ModernButton)revoke).Tone = ButtonTone.Danger;
            grantFlow.Controls.Add(revoke);
            grant.Controls.Add(grantFlow);
            layout.Controls.Add(grant, 1, 1);

            PopulatePermissionGrid(null);
            return page;
        }

        private Control BuildAuditPage()
        {
            Panel body;
            var page = CreatePage(
                "Request audit",
                "A separate history of every audited Relay GET and POST request. Credentials are always redacted.",
                out body);

            var layout = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 3
            };
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 108));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 174));
            body.Controls.Add(layout);

            var filters = new SectionPanel
            {
                Dock = DockStyle.Fill,
                Padding = new Padding(14, 38, 14, 10)
            };
            var filterTitle = new Label
            {
                Text = "Filters",
                AutoSize = true,
                Font = UiTheme.SectionFont,
                ForeColor = UiTheme.Text,
                UseMnemonic = false,
                Location = new Point(14, 10),
                BackColor = Color.Transparent
            };
            filters.Controls.Add(filterTitle);
            filters.ControlAdded += (sender, args) => filterTitle.BringToFront();
            var filterLayout = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 2,
                RowCount = 1
            };
            filterLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 48));
            filterLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 52));
            var settingsFlow = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.LeftToRight,
                WrapContents = false,
                AutoScroll = true
            };
            var actionFlow = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.LeftToRight,
                WrapContents = false,
                AutoScroll = true
            };
            _auditEnabled = new CheckBox
            {
                Text = "Audit enabled",
                AutoSize = true,
                Font = UiTheme.BodyFont,
                Margin = new Padding(4, 8, 18, 0)
            };
            _auditPayloads = new CheckBox
            {
                Text = "Log redacted payloads",
                AutoSize = true,
                Font = UiTheme.BodyFont,
                Margin = new Padding(4, 8, 18, 0)
            };
            _auditMethodFilter = UiTheme.StyleComboBox(new ComboBox { Width = 92 });
            _auditMethodFilter.Items.AddRange(new object[] { "All", "GET", "POST" });
            _auditMethodFilter.SelectedIndex = 0;
            _auditStatusFilter = UiTheme.StyleComboBox(new ComboBox { Width = 100 });
            _auditStatusFilter.Items.AddRange(new object[] { "All", "Success", "Failed" });
            _auditStatusFilter.SelectedIndex = 0;
            _auditRetention = UiTheme.StyleNumericUpDown(new NumericUpDown
            {
                Minimum = 1,
                Maximum = 365,
                Width = 72
            });
            _auditRetention.Margin = new Padding(4, 4, 12, 0);
            settingsFlow.Controls.Add(_auditEnabled);
            settingsFlow.Controls.Add(_auditPayloads);
            settingsFlow.Controls.Add(InlineCaption("Retention days"));
            settingsFlow.Controls.Add(_auditRetention);
            actionFlow.Controls.Add(InlineCaption("Method"));
            actionFlow.Controls.Add(_auditMethodFilter);
            actionFlow.Controls.Add(InlineCaption("Status"));
            actionFlow.Controls.Add(_auditStatusFilter);
            actionFlow.Controls.Add(UiTheme.CreateButton("Apply", ApplyAuditSettings, ButtonTone.Primary, "\uE74E"));
            actionFlow.Controls.Add(UiTheme.CreateButton("Export", ExportAudit, ButtonTone.Secondary, "\uEDE1"));
            actionFlow.Controls.Add(UiTheme.CreateButton("Clear", ClearAudit, ButtonTone.Danger, "\uE74D"));
            filterLayout.Controls.Add(settingsFlow, 0, 0);
            filterLayout.Controls.Add(actionFlow, 1, 0);
            filters.Controls.Add(filterLayout);
            layout.Controls.Add(filters, 0, 0);

            var gridSection = new SectionPanel
            {
                Dock = DockStyle.Fill,
                Padding = new Padding(10)
            };
            _auditGrid = new DataGridView { Dock = DockStyle.Fill };
            UiTheme.StyleGrid(_auditGrid);
            _auditGrid.Columns.Add("Time", "Time");
            _auditGrid.Columns.Add("Method", "Method");
            _auditGrid.Columns.Add("Endpoint", "Endpoint");
            _auditGrid.Columns.Add("Status", "Status");
            _auditGrid.Columns.Add("Duration", "Duration");
            _auditGrid.Columns.Add("JobId", "Job ID");
            _auditGrid.Columns.Add("Payload", "Payload");
            _auditGrid.Columns["Time"].FillWeight = 105;
            _auditGrid.Columns["Method"].FillWeight = 55;
            _auditGrid.Columns["Endpoint"].FillWeight = 210;
            _auditGrid.Columns["Status"].FillWeight = 70;
            _auditGrid.Columns["Duration"].FillWeight = 65;
            _auditGrid.Columns["JobId"].FillWeight = 115;
            _auditGrid.Columns["Payload"].FillWeight = 55;
            _auditGrid.Columns["Endpoint"].MinimumWidth = 190;
            _auditGrid.Columns["JobId"].MinimumWidth = 120;
            _auditGrid.Columns["Payload"].MinimumWidth = 70;
            _auditGrid.SelectionChanged += (sender, args) => ShowSelectedAuditDetail();
            gridSection.Controls.Add(_auditGrid);
            layout.Controls.Add(gridSection, 0, 1);

            var detail = CreateSection("Selected request");
            _auditDetailSection = detail;
            detail.Padding = new Padding(18, 50, 18, 18);
            _auditDetail = new TextBox
            {
                Dock = DockStyle.Fill,
                Multiline = true,
                ReadOnly = true,
                Enabled = false,
                ScrollBars = ScrollBars.Both,
                WordWrap = false,
                Font = new Font("Consolas", 8.5f),
                BorderStyle = BorderStyle.None,
                BackColor = Color.FromArgb(250, 250, 251),
                ForeColor = UiTheme.Text,
                Text = "Select a request to inspect details."
            };
            detail.Controls.Add(_auditDetail);
            layout.Controls.Add(detail, 0, 2);

            _auditMethodFilter.SelectedIndexChanged += (sender, args) => RefreshAudit();
            _auditStatusFilter.SelectedIndexChanged += (sender, args) => RefreshAudit();
            return page;
        }

        private Control BuildDiagnosticsPage()
        {
            Panel body;
            var page = CreatePage(
                "Updates & logs",
                "Keep the single-file Agent current and inspect local service diagnostics.",
                out body);

            var layout = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                ColumnCount = 1,
                RowCount = 2
            };
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 132));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            body.Controls.Add(layout);

            var update = CreateSection("Client update");
            var updateFlow = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.LeftToRight,
                WrapContents = false,
                Padding = new Padding(0, 10, 0, 0),
                AutoScroll = true
            };
            _updateStatus = new Label
            {
                Text = "Current version " + AutoUpdater.CurrentRelease,
                AutoSize = false,
                Width = 260,
                Height = 40,
                TextAlign = ContentAlignment.MiddleLeft,
                ForeColor = UiTheme.MutedText,
                Font = UiTheme.BodyFont,
                Padding = new Padding(0, 2, 0, 2)
            };
            updateFlow.Controls.Add(_updateStatus);
            var checkUpdate = UiTheme.CreateButton("Check update", CheckUpdate, ButtonTone.Primary, "\uE896");
            var openDataFolder = UiTheme.CreateButton("Open data folder", OpenDataFolder, ButtonTone.Secondary, "\uE838");
            updateFlow.Controls.Add(checkUpdate);
            updateFlow.Controls.Add(openDataFolder);
            _toolTips.SetToolTip(checkUpdate, "Check GitHub for a newer Relay MCP Agent Client release.");
            _toolTips.SetToolTip(openDataFolder, "Open the local Relay MCP Agent data folder.");
            update.Controls.Add(updateFlow);
            layout.Controls.Add(update, 0, 0);

            var log = CreateSection("Agent log");
            log.Padding = new Padding(18, 50, 18, 18);
            var logLayout = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                RowCount = 2,
                ColumnCount = 1
            };
            logLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            logLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
            _agentLog = new TextBox
            {
                Dock = DockStyle.Fill,
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Both,
                WordWrap = false,
                Font = new Font("Consolas", 8.5f),
                BackColor = Color.FromArgb(250, 250, 251),
                BorderStyle = BorderStyle.None
            };
            logLayout.Controls.Add(_agentLog, 0, 0);
            var logActions = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.LeftToRight
            };
            logActions.Controls.Add(UiTheme.CreateButton("Refresh log", (sender, args) => RefreshAgentLog(), ButtonTone.Secondary, "\uE72C"));
            var openLog = UiTheme.CreateButton("Open log file", OpenAgentLog, ButtonTone.Secondary, "\uE8A5");
            logActions.Controls.Add(openLog);
            _toolTips.SetToolTip(openLog, "Open the full local Agent log file.");
            _logAutoScroll = new CheckBox
            {
                Text = "Auto-scroll",
                Checked = true,
                AutoSize = true,
                Font = UiTheme.SmallFont,
                Margin = new Padding(8, 10, 12, 0)
            };
            logActions.Controls.Add(_logAutoScroll);
            logActions.Controls.Add(InlineCaption("Level"));
            _logLevelFilter = UiTheme.StyleComboBox(new ComboBox { Width = 96 });
            _logLevelFilter.Items.AddRange(new object[] { "All", "Error", "Warning", "Info" });
            _logLevelFilter.SelectedIndex = 0;
            _logLevelFilter.SelectedIndexChanged += (sender, args) => RefreshAgentLog();
            logActions.Controls.Add(_logLevelFilter);
            logActions.Controls.Add(UiTheme.CreateButton("Clear log", ClearAgentLog, ButtonTone.Danger, "\uE74D"));
            logActions.Controls.Add(UiTheme.CreateButton("Copy selected", CopySelectedLog, ButtonTone.Secondary, "\uE8C8"));
            logLayout.Controls.Add(logActions, 0, 1);
            log.Controls.Add(logLayout);
            layout.Controls.Add(log, 0, 1);
            return page;
        }

        private Control CreatePage(string title, string subtitle, out Panel body)
        {
            var page = new Panel
            {
                BackColor = UiTheme.AppBackground,
                Padding = Padding.Empty
            };
            var header = new Panel
            {
                Dock = DockStyle.Top,
                Height = 88,
                Padding = new Padding(24, 16, 24, 6),
                BackColor = UiTheme.AppBackground
            };
            header.Controls.Add(new Label
            {
                Text = title,
                Font = UiTheme.TitleFont,
                ForeColor = UiTheme.Text,
                AutoSize = true,
                UseMnemonic = false,
                Location = new Point(24, 14)
            });
            header.Controls.Add(new Label
            {
                Text = subtitle,
                Font = UiTheme.BodyFont,
                ForeColor = UiTheme.MutedText,
                AutoSize = true,
                UseMnemonic = false,
                Location = new Point(26, 50)
            });
            body = new Panel
            {
                Dock = DockStyle.Fill,
                AutoScroll = true,
                Padding = new Padding(24, 8, 10, 20),
                BackColor = UiTheme.AppBackground
            };
            page.Controls.Add(body);
            page.Controls.Add(header);
            header.BringToFront();
            return page;
        }

        private SectionPanel CreateSection(string title)
        {
            var section = new SectionPanel
            {
                Dock = DockStyle.Fill,
                Padding = new Padding(18, 50, 18, 18)
            };
            var titleLabel = new Label
            {
                Text = title,
                AutoSize = true,
                Font = UiTheme.SectionFont,
                ForeColor = UiTheme.Text,
                UseMnemonic = false,
                Location = new Point(18, 16),
                BackColor = Color.Transparent
            };
            section.Controls.Add(titleLabel);
            section.ControlAdded += (sender, args) => titleLabel.BringToFront();
            return section;
        }

        private Control WideButton(string text, string glyph, EventHandler handler)
        {
            var button = UiTheme.CreateButton(text, handler, ButtonTone.Secondary, glyph);
            button.Width = 250;
            button.MinimumSize = new Size(250, 40);
            button.Margin = new Padding(0, 0, 0, 10);
            return button;
        }

        private void AddStackButton(
            TableLayoutPanel table,
            string text,
            string glyph,
            EventHandler handler,
            ButtonTone tone = ButtonTone.Secondary)
        {
            var row = table.RowCount++;
            table.RowStyles.Add(new RowStyle(SizeType.Absolute, 50));
            var button = UiTheme.CreateButton(text, handler, tone, glyph);
            button.Dock = DockStyle.Fill;
            button.Margin = new Padding(0, 0, 0, 10);
            button.MinimumSize = new Size(0, 40);
            table.Controls.Add(button, 0, row);
        }

        private Label InlineCaption(string text)
        {
            return new Label
            {
                Text = text,
                AutoSize = true,
                Font = UiTheme.SmallFont,
                ForeColor = UiTheme.MutedText,
                Margin = new Padding(8, 10, 4, 0)
            };
        }

        private void AddField(
            TableLayoutPanel table,
            int row,
            string label,
            Control field)
        {
            table.Controls.Add(new Label
            {
                Text = label,
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleLeft,
                ForeColor = UiTheme.MutedText,
                Font = UiTheme.BodyFont,
                Padding = new Padding(0, 2, 0, 2)
            }, 0, row);
            field.Dock = field is NumericUpDown ? DockStyle.Left : DockStyle.Fill;
            field.Anchor = field is NumericUpDown
                ? AnchorStyles.Left
                : AnchorStyles.Left | AnchorStyles.Right;
            table.Controls.Add(field, 1, row);
        }

        private Label AddValueRow(TableLayoutPanel table, int row, string caption)
        {
            table.Controls.Add(UiTheme.CreateLabel(caption, UiTheme.MutedText), 0, row);
            var value = UiTheme.CreateLabel("", UiTheme.Text);
            value.AutoEllipsis = true;
            value.Padding = new Padding(0, 2, 0, 2);
            table.Controls.Add(value, 1, row);
            return value;
        }

        private void AddSummaryRow(
            Panel table,
            int row,
            string caption,
            Func<string> value)
        {
            const int captionWidth = 170;
            const int rowHeight = 36;
            var top = row * rowHeight;
            var captionLabel = UiTheme.CreateLabel(caption, UiTheme.MutedText);
            captionLabel.Dock = DockStyle.None;
            captionLabel.Location = new Point(0, top);
            captionLabel.Size = new Size(captionWidth, rowHeight);
            table.Controls.Add(captionLabel);

            var label = UiTheme.CreateLabel(value(), UiTheme.Text);
            label.Dock = DockStyle.None;
            label.Location = new Point(captionWidth, top);
            label.Size = new Size(Math.Max(10, table.Width - captionWidth), rowHeight);
            label.Tag = value;
            label.Padding = new Padding(0, 2, 0, 2);
            label.AutoEllipsis = true;
            table.Resize += (sender, args) =>
            {
                label.Width = Math.Max(10, table.ClientSize.Width - captionWidth);
            };
            table.Controls.Add(label);
        }

        private void ShowPage(string key)
        {
            foreach (var pair in _pages)
            {
                pair.Value.Visible = pair.Key.Equals(key, StringComparison.OrdinalIgnoreCase);
            }
            foreach (var pair in _navigation)
            {
                pair.Value.Selected = pair.Key.Equals(key, StringComparison.OrdinalIgnoreCase);
            }

            if (key.Equals("audit", StringComparison.OrdinalIgnoreCase))
            {
                RefreshAudit();
            }
            else if (key.Equals("diagnostics", StringComparison.OrdinalIgnoreCase))
            {
                RefreshAgentLog();
            }
        }

        private void LoadConfigurationIntoView()
        {
            _relayUrlBox.Text = AgentConfig.MaskRelayUrl(_loadedConfig.RelayUrl);
            _relayUrlBox.ReadOnly = true;
            _relayUrlBox.Tag = "protected";
            _relayUrlBox.BackColor = Color.FromArgb(248, 249, 251);

            _agentIdBox.Text = _loadedConfig.AgentId;

            _tokenBox.Text = AgentConfig.MaskToken(_loadedConfig.Token);
            _tokenBox.ReadOnly = true;
            _tokenBox.Tag = "protected";
            _tokenBox.UseSystemPasswordChar = false;
            _tokenBox.BackColor = Color.FromArgb(248, 249, 251);

            _pollSeconds.Value = Math.Max(
                _pollSeconds.Minimum,
                Math.Min(_pollSeconds.Maximum, _loadedConfig.PollSeconds));
            _auditEnabled.Checked = _loadedConfig.AuditEnabled;
            _auditPayloads.Checked = _loadedConfig.AuditLogPayloads;
            _auditRetention.Value = Math.Max(
                _auditRetention.Minimum,
                Math.Min(_auditRetention.Maximum, _loadedConfig.AuditRetentionDays));
            _databaseIdentity.Text = DatabaseAccessManager.GetServiceIdentity();
            if (!string.IsNullOrWhiteSpace(_configurationLoadError))
            {
                _connectionNotice.ForeColor = UiTheme.Danger;
                _connectionNotice.Text = _configurationLoadError +
                    " Use Replace to enter new values and save them on this machine.";
            }
        }

        private AgentConfig ReadConfigurationFromView()
        {
            var relayUrl = Equals(_relayUrlBox.Tag, "protected")
                ? _loadedConfig.RelayUrl
                : _relayUrlBox.Text.Trim();
            var token = Equals(_tokenBox.Tag, "protected")
                ? _loadedConfig.Token
                : _tokenBox.Text.Trim();

            return new AgentConfig
            {
                RelayUrl = relayUrl,
                AgentId = _agentIdBox.Text.Trim(),
                Token = token,
                PollSeconds = Decimal.ToInt32(_pollSeconds.Value),
                AuditEnabled = _auditEnabled.Checked,
                AuditLogPayloads = _auditPayloads.Checked,
                AuditRetentionDays = Decimal.ToInt32(_auditRetention.Value)
            };
        }

        private void ReplaceRelayUrl(object sender, EventArgs e)
        {
            _relayUrlBox.Tag = "";
            _relayUrlBox.ReadOnly = false;
            _relayUrlBox.Text = "";
            _relayUrlBox.BackColor = UiTheme.Surface;
            _relayUrlBox.Focus();
            _connectionNotice.Text = "Enter the new Relay URL. The old value remains active until Save securely succeeds.";
        }

        private void ReplaceToken(object sender, EventArgs e)
        {
            _tokenBox.Tag = "";
            _tokenBox.ReadOnly = false;
            _tokenBox.Text = "";
            _tokenBox.UseSystemPasswordChar = true;
            _tokenBox.BackColor = UiTheme.Surface;
            _tokenBox.Focus();
            _connectionNotice.Text = "Enter the replacement Agent token. It will not be shown again after save.";
        }

        private void SaveConfiguration(object sender, EventArgs e)
        {
            try
            {
                var config = ReadConfigurationFromView();
                config.Save();
                _loadedConfig = config;
                _configurationLoadError = "";
                LoadConfigurationIntoView();
                _connectionNotice.ForeColor = UiTheme.Success;
                _connectionNotice.Text = "Saved securely to " + AgentConfig.ConfigPath;
                LogClientAction("Configuration saved securely.");
                if (QueryService() == "running")
                {
                    RestartService();
                }
                RefreshAll();
            }
            catch (Exception ex)
            {
                _connectionNotice.ForeColor = UiTheme.Danger;
                _connectionNotice.Text = ex.Message;
            }
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
                        _connectionNotice.ForeColor = response.IsSuccessStatusCode
                            ? UiTheme.Success
                            : UiTheme.Danger;
                        _connectionNotice.Text = "Relay test returned " + message + ".";
                    }
                }
                RefreshAll();
            }
            catch (Exception ex)
            {
                SetFooter("Relay test failed.");
                _connectionNotice.ForeColor = UiTheme.Danger;
                _connectionNotice.Text = ex.Message;
            }
        }

        private void LoadSqlServers()
        {
            _sqlServerBox.Items.Clear();
            foreach (var server in DatabaseAccessManager.DiscoverLocalServers())
            {
                _sqlServerBox.Items.Add(server);
            }
            if (_sqlServerBox.Items.Count > 0)
            {
                _sqlServerBox.SelectedIndex = 0;
            }
            else
            {
                _sqlServerBox.Text = "localhost";
            }
        }

        private async void DetectDatabasesAsync()
        {
            var server = _sqlServerBox.Text.Trim();
            try
            {
                _databaseResult.ForeColor = UiTheme.Primary;
                _databaseResult.Text = "Scanning...";
                SetFooter("Detecting accessible SQL Server databases...");
                var databases = await Task.Run(() => DatabaseAccessManager.DiscoverDatabases(server));
                _databaseBox.Items.Clear();
                foreach (var database in databases)
                {
                    _databaseBox.Items.Add(database);
                }
                if (_databaseBox.Items.Count > 0)
                {
                    _databaseBox.SelectedIndex = 0;
                }
                _databaseResult.ForeColor = UiTheme.MutedText;
                _databaseResult.Text = databases.Count + " database(s) detected";
                SetFooter("Database discovery completed.");
                LogClientAction("Database discovery completed for " + server + ": " + databases.Count + " database(s).");
            }
            catch (Exception ex)
            {
                _databaseResult.ForeColor = UiTheme.Danger;
                _databaseResult.Text = "Discovery failed";
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
                _databaseResult.ForeColor = UiTheme.Primary;
                _databaseResult.Text = "Checking...";
                _lastDatabaseState = await Task.Run(() =>
                    DatabaseAccessManager.Test(server, database, identity));
                PopulatePermissionGrid(_lastDatabaseState);
                _databaseResult.ForeColor = _lastDatabaseState.ReadReady
                    ? UiTheme.Success
                    : UiTheme.Warning;
                _databaseResult.Text = _lastDatabaseState.ReadReady
                    ? "Read access ready"
                    : "Permissions incomplete";
                SetFooter("Database access check completed.");
                RefreshRuntimeStatus();
            }
            catch (Exception ex)
            {
                _databaseResult.ForeColor = UiTheme.Danger;
                _databaseResult.Text = "Access check failed";
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

            var confirmation = MessageBox.Show(
                "Grant " + FormatAccessLevel(level) + " access to " + identity +
                " on " + server + " / " + database + "?\r\n\r\n" +
                "The operation is idempotent and will verify the result afterward.",
                Text,
                MessageBoxButtons.YesNo,
                level == DatabaseAccessLevel.Read
                    ? MessageBoxIcon.Information
                    : MessageBoxIcon.Warning);
            if (confirmation != DialogResult.Yes)
            {
                return;
            }

            try
            {
                _databaseResult.ForeColor = UiTheme.Primary;
                _databaseResult.Text = "Applying permissions...";
                _lastDatabaseState = await Task.Run(() =>
                    DatabaseAccessManager.Grant(server, database, identity, level));
                PopulatePermissionGrid(_lastDatabaseState);
                _databaseResult.ForeColor = UiTheme.Success;
                _databaseResult.Text = FormatAccessLevel(level) + " access granted";
                SetFooter("Database permissions applied and verified.");
                LogClientAction(
                    "Granted " + level + " database access to " + identity +
                    " on " + server + " / " + database + ".");
                RefreshRuntimeStatus();
            }
            catch (Exception ex)
            {
                _databaseResult.ForeColor = UiTheme.Danger;
                _databaseResult.Text = "Grant failed";
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
                    "Remove the database user and database-level permissions for " +
                    identity + " on " + database + "?\r\n\r\n" +
                    "The server login is retained in case another database uses it.",
                    Text,
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Warning) != DialogResult.Yes)
            {
                return;
            }

            try
            {
                _databaseResult.ForeColor = UiTheme.Primary;
                _databaseResult.Text = "Revoking...";
                _lastDatabaseState = await Task.Run(() =>
                    DatabaseAccessManager.RevokeDatabaseAccess(server, database, identity));
                PopulatePermissionGrid(_lastDatabaseState);
                _databaseResult.ForeColor = UiTheme.Warning;
                _databaseResult.Text = "Database access revoked";
                SetFooter("Database access removed.");
                LogClientAction(
                    "Revoked database access for " + identity +
                    " on " + server + " / " + database + ".");
                RefreshRuntimeStatus();
            }
            catch (Exception ex)
            {
                _databaseResult.ForeColor = UiTheme.Danger;
                _databaseResult.Text = "Revoke failed";
                SetFooter(ex.Message);
            }
        }

        private bool TryGetDatabaseTarget(
            out string server,
            out string database,
            out string identity)
        {
            server = _sqlServerBox.Text.Trim();
            var selected = _databaseBox.SelectedItem as DatabaseCandidate;
            database = selected == null ? _databaseBox.Text.Trim() : selected.Name;
            identity = DatabaseAccessManager.GetServiceIdentity();
            _databaseIdentity.Text = identity;

            if (string.IsNullOrWhiteSpace(server) || string.IsNullOrWhiteSpace(database))
            {
                SetFooter("Choose a SQL Server and database first.");
                return false;
            }
            return true;
        }

        private void PopulatePermissionGrid(DatabasePermissionState state)
        {
            _permissionGrid.Rows.Clear();
            AddPermissionRow("Server login", state == null ? null : (bool?)state.LoginExists, true, true, true);
            AddPermissionRow("Database user", state == null ? null : (bool?)state.UserExists, true, true, true);
            AddPermissionRow("db_datareader", state == null ? null : (bool?)state.CanRead, true, true, true);
            AddPermissionRow("VIEW DEFINITION", state == null ? null : (bool?)state.CanViewDefinition, true, true, true);
            AddPermissionRow("db_datawriter", state == null ? null : (bool?)state.CanWrite, false, true, true);
            AddPermissionRow("db_ddladmin", state == null ? null : (bool?)state.CanChangeSchema, false, false, true);
        }

        private void AddPermissionRow(
            string permission,
            bool? current,
            bool read,
            bool write,
            bool ddl)
        {
            var index = _permissionGrid.Rows.Add(
                permission,
                current.HasValue ? (current.Value ? "Granted" : "Missing") : "Not checked",
                read ? "Required" : "No",
                write ? "Required" : "No",
                ddl ? "Required" : "No");
            var row = _permissionGrid.Rows[index];
            row.Cells[1].Style.ForeColor = !current.HasValue
                ? UiTheme.MutedText
                : current.Value ? UiTheme.Success : UiTheme.Danger;
            row.Cells[1].Style.BackColor = !current.HasValue
                ? UiTheme.WarningSoft
                : current.Value ? UiTheme.SuccessSoft : UiTheme.DangerSoft;
            row.Cells[1].ToolTipText = row.Cells[1].Value == null
                ? ""
                : Convert.ToString(row.Cells[1].Value);
        }

        private void ApplyAuditSettings(object sender, EventArgs e)
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

        private void RefreshAudit()
        {
            if (_auditGrid == null)
            {
                return;
            }

            var method = _auditMethodFilter == null ? "All" : Convert.ToString(_auditMethodFilter.SelectedItem);
            var status = _auditStatusFilter == null ? "All" : Convert.ToString(_auditStatusFilter.SelectedItem);
            var entries = HttpAuditStore.ReadRecent(1000, method, status);
            _auditGrid.Rows.Clear();
            foreach (var entry in entries)
            {
                DateTimeOffset timestamp;
                var displayTime = DateTimeOffset.TryParse(entry.timestamp, out timestamp)
                    ? timestamp.LocalDateTime.ToString("yyyy-MM-dd HH:mm:ss")
                    : entry.timestamp;
                var statusText = entry.statusCode.HasValue
                    ? entry.statusCode.Value.ToString()
                    : "Failed";
                var payloadLogged =
                    !string.IsNullOrWhiteSpace(entry.requestBody) ||
                    !string.IsNullOrWhiteSpace(entry.responseBody)
                        ? "Yes"
                        : "No";
                var rowIndex = _auditGrid.Rows.Add(
                    displayTime,
                    entry.method,
                    entry.endpoint,
                    statusText,
                    entry.durationMs + " ms",
                    entry.jobId,
                    payloadLogged);
                var row = _auditGrid.Rows[rowIndex];
                row.Tag = entry;
                row.Cells[3].Style.ForeColor =
                    entry.statusCode.HasValue && entry.statusCode.Value < 400
                        ? UiTheme.Success
                        : UiTheme.Danger;
            }
            ShowSelectedAuditDetail();
        }

        private void ShowSelectedAuditDetail()
        {
            if (_auditDetail == null || _auditGrid.SelectedRows.Count == 0)
            {
                if (_auditDetail != null)
                {
                    _auditDetail.Enabled = false;
                    _auditDetail.Text = "Select a request to inspect details.";
                }
                return;
            }

            var entry = _auditGrid.SelectedRows[0].Tag as HttpAuditEntry;
            if (entry == null)
            {
                _auditDetail.Enabled = false;
                _auditDetail.Text = "Select a request to inspect details.";
                return;
            }

            _auditDetail.Enabled = true;
            var builder = new StringBuilder();
            builder.AppendLine(entry.method + " " + entry.endpoint);
            builder.AppendLine("Status: " + (entry.statusCode.HasValue ? entry.statusCode.Value.ToString() : "Failed"));
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
            _auditDetail.Text = builder.ToString();
        }

        private void ExportAudit(object sender, EventArgs e)
        {
            try
            {
                using (var dialog = new SaveFileDialog
                {
                    Title = "Export Relay request audit",
                    Filter = "JSON Lines (*.jsonl)|*.jsonl|All files (*.*)|*.*",
                    FileName = "relay-http-audit-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".jsonl"
                })
                {
                    if (dialog.ShowDialog(this) == DialogResult.OK)
                    {
                        HttpAuditStore.Export(dialog.FileName);
                        SetFooter("Audit exported to " + dialog.FileName);
                    }
                }
            }
            catch (Exception ex)
            {
                SetFooter("Audit export failed: " + ex.Message);
            }
        }

        private void ClearAudit(object sender, EventArgs e)
        {
            if (MessageBox.Show(
                    "Clear the local HTTP request audit history?",
                    Text,
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Warning) != DialogResult.Yes)
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

        private void InstallService(object sender, EventArgs e)
        {
            var clientExe = Process.GetCurrentProcess().MainModule.FileName;
            if (!File.Exists(clientExe))
            {
                SetFooter("Unable to locate RelayAgent.Client.exe.");
                return;
            }

            var serviceArgs = "binPath= \"\\\"" + clientExe + "\\\" --service\" start= auto";
            var result = QueryService() == "not installed"
                ? RunSc("create " + AgentConfig.ServiceName + " " + serviceArgs + " DisplayName= \"Relay MCP Agent\"")
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

        private void UninstallService(object sender, EventArgs e)
        {
            if (MessageBox.Show(
                    "Stop and uninstall the Relay MCP Agent Windows Service?",
                    Text,
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Warning) != DialogResult.Yes)
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

        private void StartService(object sender, EventArgs e)
        {
            var result = RunSc("start " + AgentConfig.ServiceName);
            if (result.ExitCode == 0)
            {
                SetFooter("Windows Service started.");
            }
            RefreshAll();
        }

        private void StopService(object sender, EventArgs e)
        {
            var result = RunSc("stop " + AgentConfig.ServiceName);
            if (result.ExitCode == 0)
            {
                SetFooter("Windows Service stopped.");
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

        private async void CheckUpdate(object sender, EventArgs e)
        {
            try
            {
                _updateStatus.ForeColor = UiTheme.Primary;
                _updateStatus.Text = "Checking GitHub release...";
                var updater = new AutoUpdater();
                var update = await updater.CheckLatestAsync();
                if (update.IsCurrent)
                {
                    _updateStatus.ForeColor = UiTheme.Success;
                    _updateStatus.Text = "Up to date: " + update.TagName;
                    return;
                }

                _updateStatus.ForeColor = UiTheme.Warning;
                _updateStatus.Text = "Update available: " + update.TagName;
                if (MessageBox.Show(
                        "Latest release is " + update.TagName + ". Install it now?",
                        Text,
                        MessageBoxButtons.YesNo,
                        MessageBoxIcon.Question) == DialogResult.Yes)
                {
                    await updater.StageAndRestartAsync(update);
                    Application.Exit();
                }
            }
            catch (Exception ex)
            {
                _updateStatus.ForeColor = UiTheme.Danger;
                _updateStatus.Text = ex.Message;
            }
        }

        private void RefreshAll()
        {
            _loadedConfig = LoadConfigSafely();
            RefreshRuntimeStatus();
            RefreshAudit();
            RefreshAgentLog();
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

            _headerConnection.Text = configured ? "Configured" : "Not configured";
            _headerConnection.ForeColor = configured ? UiTheme.Success : UiTheme.Warning;
            _headerService.Text = ToTitle(service);
            _headerService.ForeColor = service == "running" ? UiTheme.Success : UiTheme.Warning;
            _headerVersion.Text = AutoUpdater.CurrentRelease;
            _headerLastSeen.Text = latestHeartbeat == null
                ? "No heartbeat"
                : FormatTimestamp(latestHeartbeat.timestamp);

            _serviceState.Text = ToTitle(service);
            _serviceState.ForeColor = service == "running" ? UiTheme.Success : UiTheme.Warning;
            _serviceIdentity.Text = DatabaseAccessManager.GetServiceIdentity();
            _servicePath.Text = GetServiceExecutablePath();
            _toolTips.SetToolTip(_servicePath, _servicePath.Text);
            var serviceInstalled = service != "not installed";
            if (_startServiceButton != null)
            {
                _startServiceButton.Enabled = serviceInstalled && service != "running";
            }
            if (_stopServiceButton != null)
            {
                _stopServiceButton.Enabled = service == "running";
            }
            if (_restartServiceButton != null)
            {
                _restartServiceButton.Enabled = service == "running";
            }
            if (_uninstallServiceButton != null)
            {
                _uninstallServiceButton.Enabled = serviceInstalled;
            }

            _overviewConnection.Text = configured ? "Configured" : "Action required";
            _overviewConnection.ForeColor = configured ? UiTheme.Success : UiTheme.Warning;
            _overviewService.Text = service == "running" ? "Running" : ToTitle(service);
            _overviewService.ForeColor = service == "running" ? UiTheme.Success : UiTheme.Warning;
            _overviewDatabase.Text = _lastDatabaseState == null
                ? "Not checked"
                : _lastDatabaseState.ReadReady ? "Ready" : "Permissions missing";
            _overviewDatabase.ForeColor = _lastDatabaseState != null && _lastDatabaseState.ReadReady
                ? UiTheme.Success
                : UiTheme.Warning;
            _overviewAudit.Text = _loadedConfig.AuditEnabled ? "Audit enabled" : "Audit disabled";
            _overviewAudit.ForeColor = _loadedConfig.AuditEnabled ? UiTheme.Success : UiTheme.Warning;
            RefreshComputedLabels(_pageHost);

            _footerStatus.Text =
                "Service: " + ToTitle(service) +
                "    |    Audit: " + (_loadedConfig.AuditEnabled ? "Enabled" : "Disabled") +
                "    |    Local time: " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
        }

        private void RefreshComputedLabels(Control root)
        {
            foreach (Control child in root.Controls)
            {
                var label = child as Label;
                var value = label == null ? null : label.Tag as Func<string>;
                if (value != null)
                {
                    label.Text = value();
                }
                RefreshComputedLabels(child);
            }
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
            var info = new ProcessStartInfo(fileName, args)
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };
            using (var process = Process.Start(info))
            {
                var output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
                process.WaitForExit();
                return new ProcessResult(process.ExitCode, output);
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
            if (_agentLog == null)
            {
                return;
            }
            try
            {
                if (!File.Exists(AgentConfig.AgentLogPath))
                {
                    _agentLog.Text = "No log entries yet.\r\nThe Agent log file is not available.";
                    return;
                }
                var level = _logLevelFilter == null
                    ? "All"
                    : Convert.ToString(_logLevelFilter.SelectedItem);
                var lines = File.ReadLines(AgentConfig.AgentLogPath)
                    .Where(line => level == "All" ||
                        line.IndexOf(level, StringComparison.OrdinalIgnoreCase) >= 0)
                    .Reverse()
                    .Take(400)
                    .Reverse();
                _agentLog.Lines = lines.ToArray();
                if (_logAutoScroll == null || _logAutoScroll.Checked)
                {
                    _agentLog.SelectionStart = _agentLog.TextLength;
                    _agentLog.ScrollToCaret();
                }
            }
            catch (Exception ex)
            {
                _agentLog.Text = "Log file unavailable\r\n" + ex.Message;
            }
        }

        private void ClearAgentLog(object sender, EventArgs e)
        {
            if (MessageBox.Show(
                    "Clear the local Agent log?",
                    Text,
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Warning) != DialogResult.Yes)
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

        private void CopySelectedLog(object sender, EventArgs e)
        {
            if (_agentLog == null || string.IsNullOrEmpty(_agentLog.SelectedText))
            {
                SetFooter("Select log text to copy.");
                return;
            }

            Clipboard.SetText(_agentLog.SelectedText);
            SetFooter("Selected log text copied.");
        }

        private void OpenDataFolder(object sender, EventArgs e)
        {
            Directory.CreateDirectory(AgentConfig.ConfigDirectory);
            Process.Start("explorer.exe", "\"" + AgentConfig.ConfigDirectory + "\"");
        }

        private void OpenAgentLog(object sender, EventArgs e)
        {
            if (!File.Exists(AgentConfig.AgentLogPath))
            {
                SetFooter("Agent log does not exist yet.");
                return;
            }
            Process.Start(AgentConfig.AgentLogPath);
        }

        private void SetFooter(string message)
        {
            _footerStatus.Text = message;
        }

        private void LogClientAction(string message)
        {
            try
            {
                Directory.CreateDirectory(AgentConfig.ConfigDirectory);
                File.AppendAllText(
                    AgentConfig.AgentLogPath,
                    DateTimeOffset.Now.ToString("o") + " Client: " + message + Environment.NewLine);
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
