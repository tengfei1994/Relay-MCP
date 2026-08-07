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
using Drawing = System.Drawing;
using Forms = System.Windows.Forms;

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
        private Forms.NotifyIcon _trayIcon;
        private Drawing.Icon _trayIconImage;
        private WindowState _windowStateBeforeMinimize = WindowState.Normal;
        private bool _trayHintShown;
        private int _auditRefreshGeneration;
        private int _auditDetailGeneration;
        private int _playwrightRunDetailGeneration;
        private bool _auditResultsStacked;
        private bool _playwrightRefreshInProgress;
        private DateTime _lastPlaywrightRefreshUtc = DateTime.MinValue;
        private const int MaximumTerminalDetailCharacters = 128 * 1024;
        private const int MaximumAgentLogTailBytes = 512 * 1024;

        public MainWindow()
        {
            PermissionRows = new ObservableCollection<PermissionRow>();
            AuditRows = new List<AuditRow>();
            PlaywrightSuites = new ObservableCollection<PlaywrightSuite>();
            PlaywrightRuns = new ObservableCollection<PlaywrightRun>();
            PlaywrightArtifacts = new ObservableCollection<FileInfo>();
            PlaywrightWebClients = new ObservableCollection<PlaywrightWebClientCandidate>();

            InitializeComponent();
            ConfigureInitialWindowSize();
            InitializeTrayIcon();
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
            UpdateStatusText.Text = "Current version " + AutoUpdater.CurrentRelease;

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
            Closed += delegate
            {
                _refreshTimer.Stop();
                DisposeTrayIcon();
            };
            Loaded += delegate { UpdateResponsiveLayout(); };
            SizeChanged += delegate { UpdateResponsiveLayout(); };
            StateChanged += MainWindow_StateChanged;
        }

        public ObservableCollection<PermissionRow> PermissionRows { get; private set; }

        public IList<AuditRow> AuditRows { get; private set; }

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

        private void ConfigureInitialWindowSize()
        {
            var workArea = SystemParameters.WorkArea;

            // WPF sizes use device-independent pixels. A fixed 1240 x 820 window
            // can therefore occupy nearly the full work area on a high-DPI host.
            MinWidth = Math.Min(MinWidth, Math.Max(760, workArea.Width - 32));
            MinHeight = Math.Min(MinHeight, Math.Max(600, workArea.Height - 32));
            Width = Math.Max(MinWidth, Math.Min(1240, workArea.Width * 0.82));
            Height = Math.Max(MinHeight, Math.Min(820, workArea.Height * 0.84));
        }

        private void InitializeTrayIcon()
        {
            try
            {
                var processModule = Process.GetCurrentProcess().MainModule;
                var executablePath = processModule == null ? "" : processModule.FileName;
                if (!string.IsNullOrWhiteSpace(executablePath))
                {
                    _trayIconImage = Drawing.Icon.ExtractAssociatedIcon(executablePath);
                }

                var menu = new Forms.ContextMenuStrip();
                var openItem = new Forms.ToolStripMenuItem("Open Relay MCP Agent Client");
                openItem.Click += delegate { RestoreFromTray(); };
                menu.Items.Add(openItem);
                menu.Items.Add(new Forms.ToolStripSeparator());

                var exitItem = new Forms.ToolStripMenuItem("Exit");
                exitItem.Click += delegate
                {
                    Dispatcher.BeginInvoke(new Action(Close));
                };
                menu.Items.Add(exitItem);

                _trayIcon = new Forms.NotifyIcon
                {
                    Text = "Relay MCP Agent Client",
                    Icon = _trayIconImage ?? Drawing.SystemIcons.Application,
                    ContextMenuStrip = menu,
                    Visible = false
                };
                _trayIcon.DoubleClick += delegate { RestoreFromTray(); };
                _trayIcon.MouseClick += delegate(object sender, Forms.MouseEventArgs e)
                {
                    if (e.Button == Forms.MouseButtons.Left)
                    {
                        RestoreFromTray();
                    }
                };
            }
            catch
            {
                DisposeTrayIcon();
            }
        }

        private void MainWindow_StateChanged(object sender, EventArgs e)
        {
            if (WindowState != WindowState.Minimized)
            {
                _windowStateBeforeMinimize = WindowState;
                return;
            }

            if (_trayIcon == null)
            {
                return;
            }

            _trayIcon.Visible = true;
            ShowInTaskbar = false;
            Hide();

            if (!_trayHintShown)
            {
                _trayIcon.ShowBalloonTip(
                    2500,
                    "Relay MCP Agent Client",
                    "The client is still running in the notification area.",
                    Forms.ToolTipIcon.Info);
                _trayHintShown = true;
            }
        }

        private void RestoreFromTray()
        {
            Dispatcher.BeginInvoke(new Action(delegate
            {
                ShowInTaskbar = true;
                Show();
                WindowState = _windowStateBeforeMinimize == WindowState.Minimized
                    ? WindowState.Normal
                    : _windowStateBeforeMinimize;
                Activate();

                if (_trayIcon != null)
                {
                    _trayIcon.Visible = false;
                }
            }));
        }

        private void DisposeTrayIcon()
        {
            if (_trayIcon != null)
            {
                _trayIcon.Visible = false;
                if (_trayIcon.ContextMenuStrip != null)
                {
                    _trayIcon.ContextMenuStrip.Dispose();
                }
                _trayIcon.Dispose();
                _trayIcon = null;
            }

            if (_trayIconImage != null)
            {
                _trayIconImage.Dispose();
                _trayIconImage = null;
            }
        }

        private void Navigation_Click(object sender, RoutedEventArgs e)
        {
            var button = sender as Button;
            var pageName = button == null ? "" : Convert.ToString(button.Tag);
            ShowPage(pageName);
        }

        private void UpdateResponsiveLayout()
        {
            var width = PageHost == null || PageHost.ActualWidth <= 0
                ? ActualWidth
                : PageHost.ActualWidth;
            var compactShell = ActualWidth < 1120;

            SetSidebarLayout(compactShell);
            SetHeaderLayout(ActualHeight < 760 && width >= 900);
            PageHost.Margin = compactShell
                ? new Thickness(16, 16, 14, 14)
                : new Thickness(24, 20, 22, 18);
            SetConnectionLayout(width < 900);

            SetSidePanelLayout(
                OverviewDetailsGrid,
                OverviewQuickActionsPanel,
                width < 900,
                new GridLength(2, GridUnitType.Star),
                new GridLength(1, GridUnitType.Star));
            SetSidePanelLayout(
                ServiceLayoutGrid,
                ServiceActionsPanel,
                width < 1060,
                new GridLength(2, GridUnitType.Star),
                new GridLength(1, GridUnitType.Star));
            SetDatabaseLayout(width < 1180);
            SetPlaywrightRuntimeLayout(width < 1060);
            SetPlaywrightSuitesLayout(width < 1240);
            var pageHeight = PageHost == null || PageHost.ActualHeight <= 0
                ? ActualHeight
                : PageHost.ActualHeight;
            SetAuditResultsLayout(pageHeight < 560);
            SetPlaywrightRunsLayout(pageHeight < 560);

            var stackToolbars = width < 1050;
            SetToolbarLayout(AuditToolbarGrid, AuditFilterActionsPanel, stackToolbars);
            SetToolbarLayout(PlaywrightHeaderGrid, PlaywrightHeaderActions, width < 760);
            SetToolbarLayout(
                PlaywrightArtifactsHeaderGrid,
                PlaywrightArtifactsActions,
                width < 760);
            SetToolbarLayout(
                DiagnosticsUpdateGrid,
                DiagnosticsUpdateActions,
                width < 760);
        }

        private void SetSidebarLayout(bool compact)
        {
            if (SidebarColumn == null || _navigation == null)
            {
                return;
            }

            SidebarColumn.Width = new GridLength(compact ? 72 : 208);
            SidebarInfoPanel.Visibility = compact
                ? Visibility.Collapsed
                : Visibility.Visible;
            SidebarSubtitleText.Visibility = compact
                ? Visibility.Collapsed
                : Visibility.Visible;
            SidebarTitleText.Text = compact ? "R" : "Relay MCP";
            SidebarTitleText.HorizontalAlignment = compact
                ? HorizontalAlignment.Center
                : HorizontalAlignment.Left;
            SidebarBrandPanel.Margin = compact
                ? new Thickness(8, 22, 8, 20)
                : new Thickness(22, 24, 18, 22);

            foreach (var button in _navigation.Values)
            {
                var content = button.Content as StackPanel;
                var label = content != null && content.Children.Count > 1
                    ? content.Children[1] as TextBlock
                    : null;
                if (label != null)
                {
                    label.Visibility = compact
                        ? Visibility.Collapsed
                        : Visibility.Visible;
                    button.ToolTip = compact ? label.Text : null;
                }

                button.HorizontalContentAlignment = compact
                    ? HorizontalAlignment.Center
                    : HorizontalAlignment.Left;
                button.Padding = compact
                    ? new Thickness(0)
                    : new Thickness(14, 0, 14, 0);
                button.Margin = compact
                    ? new Thickness(8, 2, 8, 2)
                    : new Thickness(10, 2, 10, 2);
            }
        }

        private void SetHeaderLayout(bool compact)
        {
            if (HeaderContentGrid == null || HeaderMetricsPanel == null || HeaderRefreshButton == null)
            {
                return;
            }

            if (compact)
            {
                HeaderContentGrid.RowDefinitions[1].Height = new GridLength(0);
                HeaderMetricsPanel.Margin = new Thickness(14, 4, 0, 4);
                Grid.SetRow(HeaderMetricsPanel, 0);
                Grid.SetColumn(HeaderMetricsPanel, 1);
                Grid.SetColumnSpan(HeaderMetricsPanel, 1);
                Grid.SetRow(HeaderRefreshButton, 0);
                return;
            }

            HeaderContentGrid.RowDefinitions[1].Height = GridLength.Auto;
            HeaderMetricsPanel.Margin = new Thickness(0, 14, 0, 0);
            Grid.SetRow(HeaderMetricsPanel, 1);
            Grid.SetColumn(HeaderMetricsPanel, 0);
            Grid.SetColumnSpan(HeaderMetricsPanel, 3);
            Grid.SetRow(HeaderRefreshButton, 0);
        }

        private void SetConnectionLayout(bool stacked)
        {
            if (ConnectionFieldsGrid == null ||
                ConnectionFieldsGrid.ColumnDefinitions.Count < 3)
            {
                return;
            }

            if (stacked)
            {
                ConnectionFieldsGrid.ColumnDefinitions[0].Width =
                    new GridLength(1, GridUnitType.Star);
                ConnectionFieldsGrid.ColumnDefinitions[1].Width = GridLength.Auto;
                ConnectionFieldsGrid.ColumnDefinitions[2].Width = new GridLength(0);

                PlaceInGrid(RelayUrlLabel, 0, 0, 2);
                PlaceInGrid(RelayUrlBox, 1, 0);
                PlaceInGrid(ReplaceRelayUrlButton, 1, 1);
                PlaceInGrid(AgentIdLabel, 2, 0, 2);
                PlaceInGrid(AgentIdBox, 3, 0, 2);
                PlaceInGrid(AgentTokenLabel, 4, 0, 2);
                PlaceInGrid(AgentTokenBox, 5, 0);
                PlaceInGrid(ReplaceAgentTokenButton, 5, 1);
                PlaceInGrid(PollIntervalLabel, 6, 0, 2);
                PlaceInGrid(PollIntervalPanel, 7, 0, 2);
                ConnectionNoticeBorder.Margin = new Thickness(0, 18, 0, 0);
                ConnectionActionsPanel.Margin = new Thickness(0, 18, 0, 0);
                return;
            }

            ConnectionFieldsGrid.ColumnDefinitions[0].Width = new GridLength(160);
            ConnectionFieldsGrid.ColumnDefinitions[1].Width =
                new GridLength(1, GridUnitType.Star);
            ConnectionFieldsGrid.ColumnDefinitions[2].Width = GridLength.Auto;

            PlaceInGrid(RelayUrlLabel, 0, 0);
            PlaceInGrid(RelayUrlBox, 0, 1);
            PlaceInGrid(ReplaceRelayUrlButton, 0, 2);
            PlaceInGrid(AgentIdLabel, 1, 0);
            PlaceInGrid(AgentIdBox, 1, 1);
            PlaceInGrid(AgentTokenLabel, 2, 0);
            PlaceInGrid(AgentTokenBox, 2, 1);
            PlaceInGrid(ReplaceAgentTokenButton, 2, 2);
            PlaceInGrid(PollIntervalLabel, 3, 0);
            PlaceInGrid(PollIntervalPanel, 3, 1);
            ConnectionNoticeBorder.Margin = new Thickness(160, 18, 0, 0);
            ConnectionActionsPanel.Margin = new Thickness(160, 18, 0, 0);
        }

        private static void PlaceInGrid(
            FrameworkElement element,
            int row,
            int column,
            int columnSpan = 1)
        {
            if (element == null)
            {
                return;
            }
            Grid.SetRow(element, row);
            Grid.SetColumn(element, column);
            Grid.SetColumnSpan(element, columnSpan);
        }

        private static void SetToolbarLayout(
            Grid grid,
            FrameworkElement actions,
            bool stacked)
        {
            if (grid == null ||
                actions == null ||
                grid.ColumnDefinitions.Count < 2 ||
                grid.RowDefinitions.Count < 2)
            {
                return;
            }

            if (stacked)
            {
                grid.ColumnDefinitions[0].Width =
                    new GridLength(1, GridUnitType.Star);
                grid.ColumnDefinitions[1].Width = new GridLength(0);
                Grid.SetColumn(actions, 0);
                Grid.SetRow(actions, 1);
                actions.HorizontalAlignment = HorizontalAlignment.Left;
                actions.Margin = new Thickness(0, 8, 0, 0);
                return;
            }

            grid.ColumnDefinitions[0].Width =
                new GridLength(1, GridUnitType.Star);
            grid.ColumnDefinitions[1].Width = GridLength.Auto;
            Grid.SetColumn(actions, 1);
            Grid.SetRow(actions, 0);
            actions.HorizontalAlignment = HorizontalAlignment.Right;
            actions.Margin = new Thickness(0);
        }

        private static void SetSidePanelLayout(
            Grid grid,
            FrameworkElement sidePanel,
            bool stacked,
            GridLength primaryWidth,
            GridLength sideWidth)
        {
            if (grid == null ||
                sidePanel == null ||
                grid.ColumnDefinitions.Count < 3 ||
                grid.RowDefinitions.Count < 2)
            {
                return;
            }

            if (stacked)
            {
                grid.ColumnDefinitions[0].Width = new GridLength(1, GridUnitType.Star);
                grid.ColumnDefinitions[1].Width = new GridLength(0);
                grid.ColumnDefinitions[2].Width = new GridLength(0);
                Grid.SetColumn(sidePanel, 0);
                Grid.SetRow(sidePanel, 1);
                sidePanel.Margin = new Thickness(0, 14, 0, 0);
                return;
            }

            grid.ColumnDefinitions[0].Width = primaryWidth;
            grid.ColumnDefinitions[1].Width = new GridLength(14);
            grid.ColumnDefinitions[2].Width = sideWidth;
            Grid.SetColumn(sidePanel, 2);
            Grid.SetRow(sidePanel, 0);
            sidePanel.Margin = new Thickness(0);
        }

        private void SetPlaywrightRuntimeLayout(bool stacked)
        {
            if (PlaywrightRuntimeLayoutGrid == null ||
                PlaywrightRuntimeLogPanel == null ||
                PlaywrightRuntimeLayoutGrid.ColumnDefinitions.Count < 3 ||
                PlaywrightRuntimePageGrid == null ||
                PlaywrightRuntimeScroller == null)
            {
                return;
            }

            if (stacked)
            {
                PlaywrightRuntimeScroller.VerticalScrollBarVisibility =
                    ScrollBarVisibility.Auto;
                PlaywrightRuntimePageGrid.RowDefinitions[2].Height =
                    GridLength.Auto;
                PlaywrightRuntimeLayoutGrid.RowDefinitions[0].Height =
                    GridLength.Auto;
                PlaywrightRuntimeLayoutGrid.RowDefinitions[1].Height =
                    GridLength.Auto;
                PlaywrightRuntimeLayoutGrid.ColumnDefinitions[0].Width =
                    new GridLength(1, GridUnitType.Star);
                PlaywrightRuntimeLayoutGrid.ColumnDefinitions[1].Width =
                    new GridLength(0);
                PlaywrightRuntimeLayoutGrid.ColumnDefinitions[2].Width =
                    new GridLength(0);
                PlaywrightRuntimeSplitter.Visibility = Visibility.Collapsed;
                Grid.SetColumn(PlaywrightRuntimeLogPanel, 0);
                Grid.SetRow(PlaywrightRuntimeLogPanel, 1);
                PlaywrightRuntimeLogPanel.Margin = new Thickness(0, 14, 0, 0);
                return;
            }

            PlaywrightRuntimeScroller.VerticalScrollBarVisibility =
                ScrollBarVisibility.Disabled;
            PlaywrightRuntimePageGrid.RowDefinitions[2].Height =
                new GridLength(1, GridUnitType.Star);
            PlaywrightRuntimeLayoutGrid.RowDefinitions[0].Height =
                GridLength.Auto;
            PlaywrightRuntimeLayoutGrid.RowDefinitions[1].Height =
                new GridLength(1, GridUnitType.Star);
            PlaywrightRuntimeLayoutGrid.ColumnDefinitions[0].Width =
                new GridLength(300);
            PlaywrightRuntimeLayoutGrid.ColumnDefinitions[1].Width =
                new GridLength(12);
            PlaywrightRuntimeLayoutGrid.ColumnDefinitions[2].Width =
                new GridLength(1, GridUnitType.Star);
            PlaywrightRuntimeSplitter.Visibility = Visibility.Visible;
            Grid.SetColumn(PlaywrightRuntimeLogPanel, 2);
            Grid.SetRow(PlaywrightRuntimeLogPanel, 0);
            PlaywrightRuntimeLogPanel.Margin = new Thickness(0);
        }

        private void SetDatabaseLayout(bool stacked)
        {
            if (DatabaseLayoutGrid == null ||
                DatabaseTargetPanel == null ||
                DatabasePermissionPanel == null ||
                DatabaseActionsPanel == null ||
                DatabaseLayoutGrid.ColumnDefinitions.Count < 3 ||
                DatabaseLayoutGrid.RowDefinitions.Count < 3)
            {
                return;
            }

            if (stacked)
            {
                DatabaseLayoutGrid.ColumnDefinitions[0].Width =
                    new GridLength(1, GridUnitType.Star);
                DatabaseLayoutGrid.ColumnDefinitions[1].Width = new GridLength(0);
                DatabaseLayoutGrid.ColumnDefinitions[2].Width = new GridLength(0);

                PlaceInGrid(DatabaseTargetPanel, 0, 0);
                PlaceInGrid(DatabaseActionsPanel, 1, 0);
                PlaceInGrid(DatabasePermissionPanel, 2, 0);
                Grid.SetRowSpan(DatabaseActionsPanel, 1);
                DatabaseTargetPanel.Margin = new Thickness(0);
                DatabaseActionsPanel.Margin = new Thickness(0);
                DatabasePermissionPanel.Margin = new Thickness(0);
                return;
            }

            DatabaseLayoutGrid.ColumnDefinitions[0].Width =
                new GridLength(2, GridUnitType.Star);
            DatabaseLayoutGrid.ColumnDefinitions[1].Width = new GridLength(14);
            DatabaseLayoutGrid.ColumnDefinitions[2].Width =
                new GridLength(1, GridUnitType.Star);

            PlaceInGrid(DatabaseTargetPanel, 0, 0);
            PlaceInGrid(DatabasePermissionPanel, 1, 0);
            PlaceInGrid(DatabaseActionsPanel, 0, 2);
            Grid.SetRowSpan(DatabaseActionsPanel, 2);
            DatabaseTargetPanel.Margin = new Thickness(0, 0, 0, 16);
            DatabaseActionsPanel.Margin = new Thickness(0, 0, 0, 16);
            DatabasePermissionPanel.Margin = new Thickness(0);
        }

        private void SetPlaywrightSuitesLayout(bool stacked)
        {
            if (PlaywrightSuitesLayoutGrid == null ||
                PlaywrightSuiteDetailsPanel == null ||
                PlaywrightSuitesScroller == null ||
                PlaywrightSuitesLayoutGrid.ColumnDefinitions.Count < 3 ||
                PlaywrightSuitesLayoutGrid.RowDefinitions.Count < 2)
            {
                return;
            }

            PlaywrightSuitesLayoutGrid.ColumnDefinitions[2].MinWidth =
                stacked ? 0 : 320;

            SetSidePanelLayout(
                PlaywrightSuitesLayoutGrid,
                PlaywrightSuiteDetailsPanel,
                stacked,
                new GridLength(1, GridUnitType.Star),
                new GridLength(390));

            if (stacked)
            {
                PlaywrightSuitesScroller.VerticalScrollBarVisibility =
                    ScrollBarVisibility.Auto;
                PlaywrightSuitesLayoutGrid.RowDefinitions[0].Height =
                    GridLength.Auto;
                PlaywrightSuitesLayoutGrid.RowDefinitions[1].Height =
                    GridLength.Auto;
                PlaywrightSuiteGrid.MinHeight = 280;
                return;
            }

            PlaywrightSuitesScroller.VerticalScrollBarVisibility =
                ScrollBarVisibility.Disabled;
            PlaywrightSuitesLayoutGrid.RowDefinitions[0].Height =
                new GridLength(1, GridUnitType.Star);
            PlaywrightSuitesLayoutGrid.RowDefinitions[1].Height =
                GridLength.Auto;
            PlaywrightSuiteGrid.MinHeight = 0;
        }

        private void SetPlaywrightRunsLayout(bool stacked)
        {
            if (PlaywrightRunsLayoutGrid == null ||
                PlaywrightRunsLayoutGrid.RowDefinitions.Count < 3 ||
                PlaywrightRunsScroller == null ||
                PlaywrightRunGrid == null ||
                PlaywrightRunDetailPanel == null)
            {
                return;
            }

            if (stacked)
            {
                PlaywrightRunsScroller.VerticalScrollBarVisibility =
                    ScrollBarVisibility.Auto;
                PlaywrightRunsLayoutGrid.RowDefinitions[0].Height =
                    GridLength.Auto;
                PlaywrightRunsLayoutGrid.RowDefinitions[2].Height =
                    GridLength.Auto;
                PlaywrightRunGrid.MinHeight = 0;
                PlaywrightRunGrid.MaxHeight = 320;
                PlaywrightRunDetailPanel.MinHeight = 220;
                return;
            }

            PlaywrightRunsScroller.VerticalScrollBarVisibility =
                ScrollBarVisibility.Disabled;
            PlaywrightRunsLayoutGrid.RowDefinitions[0].Height =
                new GridLength(1, GridUnitType.Star);
            PlaywrightRunsLayoutGrid.RowDefinitions[2].Height =
                new GridLength(0.55, GridUnitType.Star);
            PlaywrightRunGrid.MinHeight = 0;
            PlaywrightRunGrid.MaxHeight = double.PositiveInfinity;
            PlaywrightRunDetailPanel.MinHeight = 0;
        }

        private void SetAuditResultsLayout(bool stacked)
        {
            if (AuditResultsGrid == null ||
                AuditResultsGrid.RowDefinitions.Count < 3 ||
                AuditResultsScroller == null ||
                AuditGrid == null ||
                AuditDetailPanel == null)
            {
                return;
            }

            _auditResultsStacked = stacked;

            if (stacked)
            {
                AuditResultsScroller.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
                AuditResultsGrid.RowDefinitions[0].Height = GridLength.Auto;
                AuditResultsGrid.RowDefinitions[2].Height = GridLength.Auto;
                AuditGrid.MinHeight = 140;
                AuditGrid.MaxHeight = 240;
                AuditDetailPanel.MinHeight = 260;
                return;
            }

            AuditResultsScroller.VerticalScrollBarVisibility = ScrollBarVisibility.Disabled;
            AuditResultsGrid.RowDefinitions[0].Height = new GridLength(1, GridUnitType.Star);
            AuditResultsGrid.RowDefinitions[2].Height = new GridLength(0.72, GridUnitType.Star);
            AuditGrid.MinHeight = 0;
            AuditGrid.MaxHeight = double.PositiveInfinity;
            AuditDetailPanel.MinHeight = 0;
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

            if (!pageName.Equals("AuditPage", StringComparison.OrdinalIgnoreCase))
            {
                ReleaseAuditDetail();
            }
            if (!pageName.Equals("PlaywrightPage", StringComparison.OrdinalIgnoreCase))
            {
                ReleasePlaywrightRunDetail();
            }

            if (pageName.Equals("AuditPage", StringComparison.OrdinalIgnoreCase))
            {
                RefreshAudit();
            }
            else if (pageName.Equals("PlaywrightPage", StringComparison.OrdinalIgnoreCase))
            {
                _ = RefreshPlaywrightAsync(false);
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
            DatabaseResultText.Background = ResolveStatusBackground(foreground);
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
                SetFooter("Command audit settings saved securely.");
                LogClientAction("Command audit settings updated.");
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

        private async void RefreshAudit()
        {
            if (!_initialized)
            {
                return;
            }

            var generation = Interlocked.Increment(ref _auditRefreshGeneration);
            var kind = GetComboValue(AuditMethodFilter, "All");
            var status = GetComboValue(AuditStatusFilter, "All");
            AuditGrid.IsEnabled = false;
            AuditEmptyText.Text = "Loading command executions...";
            AuditEmptyText.Visibility = Visibility.Visible;

            IList<CommandAuditSummary> entries;
            try
            {
                entries = await Task.Run(() => CommandAuditStore.ReadRecent(100, kind, status));
            }
            catch (Exception ex)
            {
                if (generation != _auditRefreshGeneration) return;
                AuditGrid.IsEnabled = true;
                AuditEmptyText.Text = "Unable to load command audit.";
                SetFooter("Command audit load failed: " + ex.Message);
                return;
            }

            if (generation != _auditRefreshGeneration) return;
            var rows = new List<AuditRow>(entries.Count);
            foreach (var entry in entries)
            {
                DateTimeOffset timestamp;
                var displayTime = DateTimeOffset.TryParse(entry.startedAt, out timestamp)
                    ? timestamp.LocalDateTime.ToString("yyyy-MM-dd HH:mm:ss")
                    : entry.startedAt;
                rows.Add(new AuditRow
                {
                    Time = displayTime,
                    Kind = CommandAuditStore.DisplayKind(entry.kind),
                    Instruction = entry.instruction,
                    Status = ToTitle(entry.status),
                    ExitCode = entry.exitCode.HasValue ? entry.exitCode.Value.ToString() : "-",
                    Duration = entry.durationMs > 0 ? entry.durationMs + " ms" : "-",
                    JobId = entry.jobId,
                    Summary = entry
                });
            }
            AuditRows = rows;
            AuditGrid.ItemsSource = AuditRows;
            AuditResultsScroller.ScrollToTop();

            AuditGrid.IsEnabled = true;
            AuditEmptyText.Text = "No command executions recorded yet.";
            AuditEmptyText.Visibility = AuditRows.Count == 0
                ? Visibility.Visible
                : Visibility.Collapsed;
            ShowSelectedAuditDetail();
        }

        private async void ShowSelectedAuditDetail()
        {
            var row = AuditGrid.SelectedItem as AuditRow;
            var summary = row == null ? null : row.Summary;
            var generation = Interlocked.Increment(ref _auditDetailGeneration);
            if (summary == null)
            {
                AuditDetailBox.IsEnabled = true;
                AuditDetailBox.Text = "Select a command to inspect details.";
                return;
            }

            AuditDetailBox.IsEnabled = true;
            AuditDetailBox.Text = "Loading command result...";
            CommandAuditEntry entry;
            try
            {
                entry = await Task.Run(() => CommandAuditStore.ReadDetail(summary.jobId));
            }
            catch (Exception ex)
            {
                if (generation != _auditDetailGeneration) return;
                AuditDetailBox.Text = "Unable to load command result.\r\n" + ex.Message;
                return;
            }

            if (generation != _auditDetailGeneration) return;
            var selected = AuditGrid.SelectedItem as AuditRow;
            if (selected == null || selected.Summary == null ||
                !string.Equals(selected.Summary.jobId, summary.jobId, StringComparison.Ordinal))
            {
                return;
            }
            if (entry == null)
            {
                AuditDetailBox.Text = "Command detail is unavailable. The record may have been cleared.";
                return;
            }

            var builder = new StringBuilder();
            builder.AppendLine("Job ID: " + entry.jobId);
            builder.AppendLine("Kind: " + CommandAuditStore.DisplayKind(entry.kind));
            builder.AppendLine("Status: " + ToTitle(entry.status));
            builder.AppendLine("Exit code: " + (entry.exitCode.HasValue ? entry.exitCode.Value.ToString() : "-"));
            builder.AppendLine("Duration: " + entry.durationMs + " ms");
            builder.AppendLine("Timeout: " + entry.timeoutMs + " ms");
            builder.AppendLine("Started: " + entry.startedAt);
            if (!string.IsNullOrWhiteSpace(entry.finishedAt))
            {
                builder.AppendLine("Finished: " + entry.finishedAt);
            }
            builder.AppendLine("Result posted to Relay: " +
                (entry.resultPosted.HasValue ? (entry.resultPosted.Value ? "Yes" : "No") : "Pending"));
            var remaining = Math.Max(0, MaximumTerminalDetailCharacters - builder.Length);
            AppendTerminalSection(builder, "Instruction", entry.instruction, ref remaining);
            AppendTerminalSection(builder, "Executed command", entry.executedCommand, ref remaining);
            AppendTerminalSection(builder, "Command / script", entry.command, ref remaining);
            AppendTerminalSection(builder, "Message", entry.message, ref remaining);
            AppendTerminalSection(builder, "STDOUT", entry.stdout, ref remaining);
            AppendTerminalSection(builder, "STDERR", entry.stderr, ref remaining);
            AppendTerminalSection(builder, "Relay result post error", entry.resultPostError, ref remaining);
            if (remaining == 0)
            {
                builder.AppendLine();
                builder.AppendLine("[DISPLAY TRUNCATED - export the command audit record for the complete stored payload]");
            }
            AuditDetailBox.Text = builder.ToString();
            if (_auditResultsStacked)
            {
                _ = Dispatcher.BeginInvoke(
                    new Action(delegate { AuditDetailBox.BringIntoView(); }),
                    DispatcherPriority.Background);
            }
        }

        private void ReleaseAuditDetail()
        {
            Interlocked.Increment(ref _auditDetailGeneration);
            if (AuditGrid != null) AuditGrid.SelectedItem = null;
            if (AuditDetailBox != null) AuditDetailBox.Text = "Select a command to inspect details.";
        }

        private static void AppendTerminalSection(
            StringBuilder builder,
            string title,
            string value,
            ref int remaining)
        {
            if (string.IsNullOrWhiteSpace(value) || remaining <= 0) return;
            var heading = Environment.NewLine + title + Environment.NewLine;
            if (heading.Length >= remaining)
            {
                remaining = 0;
                return;
            }
            builder.Append(heading);
            remaining -= heading.Length;
            var count = Math.Min(value.Length, remaining);
            builder.Append(value, 0, count);
            remaining -= count;
        }

        private void ExportAudit_Click(object sender, RoutedEventArgs e)
        {
            try
            {
                var dialog = new SaveFileDialog
                {
                    Title = "Export Relay command audit",
                    Filter = "JSON Lines (*.jsonl)|*.jsonl|All files (*.*)|*.*",
                    FileName = "relay-command-audit-" +
                               DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".jsonl"
                };
                if (dialog.ShowDialog(this) == true)
                {
                    CommandAuditStore.Export(dialog.FileName);
                    SetFooter("Command audit exported to " + dialog.FileName);
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
                    "Clear the local command execution audit history?",
                    Title,
                    MessageBoxButton.YesNo,
                    MessageBoxImage.Warning) != MessageBoxResult.Yes)
            {
                return;
            }

            try
            {
                CommandAuditStore.Clear();
                RefreshAudit();
                SetFooter("Command audit cleared.");
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
        }

        private async void RefreshPlaywright_Click(object sender, RoutedEventArgs e)
        {
            await RefreshPlaywrightAsync(true);
            SetFooter("Playwright runtime refreshed.");
        }

        private async Task RefreshPlaywrightAsync(bool force)
        {
            if (_playwrightRefreshInProgress) return;
            if (!force && DateTime.UtcNow - _lastPlaywrightRefreshUtc < TimeSpan.FromSeconds(15)) return;
            _playwrightRefreshInProgress = true;
            try
            {
                var snapshot = await Task.Run(() => new
                {
                    Runtime = PlaywrightManager.DetectRuntime(),
                    Suites = PlaywrightManager.ReadSuites(),
                    Runs = PlaywrightManager.ReadRuns(50),
                    Artifacts = PlaywrightManager.ReadArtifacts(150)
                });

                PlaywrightSuites.Clear();
                foreach (var item in snapshot.Suites) PlaywrightSuites.Add(item);
                PlaywrightRuns.Clear();
                foreach (var item in snapshot.Runs) PlaywrightRuns.Add(item);
                PlaywrightArtifacts.Clear();
                foreach (var item in snapshot.Artifacts) PlaywrightArtifacts.Add(item);

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
            finally
            {
                _lastPlaywrightRefreshUtc = DateTime.UtcNow;
                _playwrightRefreshInProgress = false;
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
                _ = RefreshPlaywrightAsync(true);
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
                await RefreshPlaywrightAsync(true);
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
            await RefreshPlaywrightAsync(true);
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
                await RefreshPlaywrightAsync(true);
            }
            catch (Exception ex)
            {
                SetFooter("Unable to queue Playwright test: " + ex.Message);
            }
        }

        private async void PlaywrightRunGrid_SelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            var summary = PlaywrightRunGrid.SelectedItem as PlaywrightRun;
            var generation = Interlocked.Increment(ref _playwrightRunDetailGeneration);
            if (summary == null)
            {
                PlaywrightRunDetailBox.Text = "Select a run to inspect details.";
                return;
            }

            PlaywrightRunDetailBox.Text = "Loading Playwright run output...";
            PlaywrightRun run;
            try
            {
                run = await Task.Run(() => PlaywrightManager.ReadRun(summary.Id));
            }
            catch (Exception ex)
            {
                if (generation != _playwrightRunDetailGeneration) return;
                PlaywrightRunDetailBox.Text = "Unable to load Playwright run.\r\n" + ex.Message;
                return;
            }

            if (generation != _playwrightRunDetailGeneration) return;
            var selected = PlaywrightRunGrid.SelectedItem as PlaywrightRun;
            if (selected == null || !string.Equals(selected.Id, summary.Id, StringComparison.Ordinal)) return;
            if (run == null)
            {
                PlaywrightRunDetailBox.Text = "Playwright run detail is unavailable.";
                return;
            }

            var builder = new StringBuilder();
            builder.Append(
                "Run ID: " + run.Id + Environment.NewLine +
                "Suite: " + run.SuiteName + Environment.NewLine +
                "Status: " + run.Status + Environment.NewLine +
                "Started: " + run.StartedAt + Environment.NewLine +
                "Finished: " + run.FinishedAt + Environment.NewLine +
                "Duration: " + run.DurationMs + " ms" + Environment.NewLine +
                "Exit code: " + run.ExitCode + Environment.NewLine +
                "Artifacts: " + run.ArtifactDirectory + Environment.NewLine);
            var remaining = Math.Max(0, MaximumTerminalDetailCharacters - builder.Length);
            AppendTerminalSection(builder, "Error", run.Error, ref remaining);
            AppendTerminalSection(builder, "Output", run.Output, ref remaining);
            if (remaining == 0)
            {
                builder.AppendLine();
                builder.AppendLine("[DISPLAY TRUNCATED - open the run artifact for the complete output]");
            }
            PlaywrightRunDetailBox.Text = builder.ToString();
        }

        private void PlaywrightTabs_SelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            if (!ReferenceEquals(e.OriginalSource, PlaywrightTabs)) return;
            if (PlaywrightTabs.SelectedIndex != 3)
            {
                ReleasePlaywrightRunDetail();
            }
        }

        private void ReleasePlaywrightRunDetail()
        {
            Interlocked.Increment(ref _playwrightRunDetailGeneration);
            if (PlaywrightRunGrid != null) PlaywrightRunGrid.SelectedItem = null;
            if (PlaywrightRunDetailBox != null)
            {
                PlaywrightRunDetailBox.Text = "Select a run to inspect details.";
            }
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
                await RefreshPlaywrightAsync(true);
            SetFooter("Playwright artifacts cleared.");
        }

        private void RefreshRuntimeStatus()
        {
            var service = QueryService();
            var configured = !string.IsNullOrWhiteSpace(_loadedConfig.RelayUrl) &&
                             !string.IsNullOrWhiteSpace(_loadedConfig.Token);
            var latestHeartbeat = ReadLastHeartbeat();

            SetStatusText(
                HeaderConnectionText,
                configured ? "Configured" : "Not configured",
                configured);
            SetStatusText(
                HeaderServiceText,
                ToTitle(service),
                service == "running");
            HeaderLastSeenText.Text = string.IsNullOrWhiteSpace(latestHeartbeat)
                ? "No heartbeat"
                : FormatTimestamp(latestHeartbeat);
            HeaderLastSeenText.ToolTip = string.IsNullOrWhiteSpace(latestHeartbeat)
                ? null
                : latestHeartbeat;

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
                _loadedConfig.AuditEnabled ? "Command audit enabled" : "Command audit disabled",
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
                "    |    Command audit: " +
                (_loadedConfig.AuditEnabled ? "Enabled" : "Disabled") +
                "    |    Local time: " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");

            if (PlaywrightPage.Visibility == Visibility.Visible)
            {
                _ = RefreshPlaywrightAsync(false);
            }
        }

        private static string ReadLastHeartbeat()
        {
            try
            {
                return File.Exists(AgentConfig.LastHeartbeatPath)
                    ? File.ReadAllText(AgentConfig.LastHeartbeatPath).Trim()
                    : "";
            }
            catch
            {
                return "";
            }
        }

        private void SetStatusText(TextBlock control, string value, bool success)
        {
            control.Text = value;
            control.Foreground = success ? SuccessBrush : WarningBrush;
            control.Background = success ? SuccessSoftBrush : WarningSoftBrush;
        }

        private Brush ResolveStatusBackground(Brush foreground)
        {
            if (foreground == SuccessBrush)
            {
                return SuccessSoftBrush;
            }
            if (foreground == DangerBrush)
            {
                return DangerSoftBrush;
            }
            if (foreground == WarningBrush)
            {
                return WarningSoftBrush;
            }
            return (Brush)FindResource("SurfaceAltBrush");
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
                var lines = ReadTailLines(
                    AgentConfig.AgentLogPath,
                    1200,
                    MaximumAgentLogTailBytes)
                    .Where(line => level == "All" ||
                                   line.IndexOf(level, StringComparison.OrdinalIgnoreCase) >= 0)
                    .ToList();
                if (lines.Count > 400)
                {
                    lines = lines.Skip(lines.Count - 400).ToList();
                }
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

        private static IList<string> ReadTailLines(string path, int maximumLines, int maximumBytes)
        {
            using (var stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete))
            {
                var start = Math.Max(0, stream.Length - Math.Max(4096, maximumBytes));
                stream.Seek(start, SeekOrigin.Begin);
                var bytes = new byte[(int)(stream.Length - start)];
                var offset = 0;
                while (offset < bytes.Length)
                {
                    var read = stream.Read(bytes, offset, bytes.Length - offset);
                    if (read <= 0) break;
                    offset += read;
                }

                var text = Encoding.UTF8.GetString(bytes, 0, offset);
                if (start > 0)
                {
                    var firstNewLine = text.IndexOf('\n');
                    text = firstNewLine < 0 ? "" : text.Substring(firstNewLine + 1);
                }

                var lines = text
                    .Split(new[] { "\r\n", "\n" }, StringSplitOptions.None)
                    .Where(line => line.Length > 0)
                    .ToList();
                var keep = Math.Max(1, maximumLines);
                if (lines.Count > keep)
                {
                    lines.RemoveRange(0, lines.Count - keep);
                }
                return lines;
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

    }
}
