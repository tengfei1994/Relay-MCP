using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Xml;

namespace RelayAgent.Shared
{
    public sealed class PlaywrightRuntimeState
    {
        public string CheckedAt { get; set; }
        public string Status { get; set; }
        public string NodePath { get; set; }
        public string NodeVersion { get; set; }
        public string NpmPath { get; set; }
        public string NpmVersion { get; set; }
        public string PlaywrightVersion { get; set; }
        public string BrowserCachePath { get; set; }
        public bool ChromiumInstalled { get; set; }
        public string ActiveTask { get; set; }
        public int Progress { get; set; }
        public string Message { get; set; }
        public string Log { get; set; }
        public string InstallAction { get; set; }
    }

    public sealed class PlaywrightSuite
    {
        public string Id { get; set; }
        public string Name { get; set; }
        public string BaseUrl { get; set; }
        public string TestFile { get; set; }
        public bool Headless { get; set; }
        public int TimeoutSeconds { get; set; }
        public int Retries { get; set; }
        public bool Enabled { get; set; }
        public string UpdatedAt { get; set; }
    }

    public sealed class PlaywrightRun
    {
        public string Id { get; set; }
        public string SuiteId { get; set; }
        public string SuiteName { get; set; }
        public string Status { get; set; }
        public string StartedAt { get; set; }
        public string FinishedAt { get; set; }
        public long DurationMs { get; set; }
        public int ExitCode { get; set; }
        public string Output { get; set; }
        public string ArtifactDirectory { get; set; }
        public string Error { get; set; }
    }

    public sealed class PlaywrightWebClientCandidate
    {
        public string Name { get; set; }
        public string Url { get; set; }
        public string Source { get; set; }
        public string PhysicalPath { get; set; }

        public string DisplayName
        {
            get { return Name + " · " + Url; }
        }
    }

    internal sealed class PlaywrightTask
    {
        public string Id { get; set; }
        public string Kind { get; set; }
        public string SuiteId { get; set; }
        public string CreatedAt { get; set; }
    }

    public static class PlaywrightManager
    {
        private static readonly object FileLock = new object();
        private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer
        {
            MaxJsonLength = int.MaxValue,
            RecursionLimit = 64
        };

        public static string RootPath
        {
            get { return Path.Combine(AgentConfig.ConfigDirectory, "playwright"); }
        }

        public static string RuntimePath
        {
            get { return Path.Combine(RootPath, "runtime"); }
        }

        public static string BrowserCachePath
        {
            get { return Path.Combine(RootPath, "browser-cache"); }
        }

        public static string TestsPath
        {
            get { return Path.Combine(RootPath, "tests"); }
        }

        public static string ArtifactsPath
        {
            get { return Path.Combine(RootPath, "artifacts"); }
        }

        private static string QueuePath
        {
            get { return Path.Combine(RootPath, "queue"); }
        }

        private static string RunsPath
        {
            get { return Path.Combine(RootPath, "runs"); }
        }

        private static string SuitesFile
        {
            get { return Path.Combine(RootPath, "suites.json"); }
        }

        private static string RuntimeStateFile
        {
            get { return Path.Combine(RootPath, "runtime-state.json"); }
        }

        public static PlaywrightRuntimeState DetectRuntime()
        {
            EnsureDirectories();
            var node = FindExecutable("node.exe");
            var npm = FindExecutable("npm.cmd");
            var nodeVersion = string.IsNullOrWhiteSpace(node) ? "" : RunProcess(node, "--version", RootPath, 15000, null).Output.Trim();
            var npmVersion = string.IsNullOrWhiteSpace(npm) ? "" : RunProcess(npm, "--version", RootPath, 15000, null).Output.Trim();
            var playwrightVersion = "";
            var packageFile = Path.Combine(RuntimePath, "node_modules", "@playwright", "test", "package.json");
            if (File.Exists(packageFile))
            {
                try
                {
                    var package = Serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(packageFile));
                    object value;
                    if (package != null && package.TryGetValue("version", out value))
                    {
                        playwrightVersion = Convert.ToString(value);
                    }
                }
                catch { }
            }

            var chromiumInstalled = Directory.Exists(BrowserCachePath) &&
                                    Directory.EnumerateFiles(BrowserCachePath, "chrome.exe", SearchOption.AllDirectories).Any();
            var previous = LoadRuntimeState();
            var hasNode = !string.IsNullOrWhiteSpace(node) && !string.IsNullOrWhiteSpace(npm);
            var hasPackage = !string.IsNullOrWhiteSpace(playwrightVersion);
            var ready = hasNode &&
                        !string.IsNullOrWhiteSpace(npm) &&
                        hasPackage &&
                        chromiumInstalled;
            var status = ready
                ? "ready"
                : !hasNode ? "needs-node"
                : !hasPackage ? "needs-playwright"
                : "needs-browser";
            var installAction = !hasNode
                ? "Install Node.js + Playwright"
                : !hasPackage ? "Install Playwright"
                : !chromiumInstalled ? "Install Chromium"
                : "Runtime ready";
            var state = new PlaywrightRuntimeState
            {
                CheckedAt = DateTimeOffset.Now.ToString("o"),
                Status = status,
                NodePath = node ?? "",
                NodeVersion = nodeVersion,
                NpmPath = npm ?? "",
                NpmVersion = npmVersion,
                PlaywrightVersion = playwrightVersion,
                BrowserCachePath = BrowserCachePath,
                ChromiumInstalled = chromiumInstalled,
                ActiveTask = previous.ActiveTask ?? "",
                Progress = previous.Progress,
                Message = ready
                    ? "Playwright runtime is ready."
                    : !hasNode
                        ? "Node.js LTS is missing. The Agent can download and install it before Playwright."
                        : !hasPackage
                            ? "Node.js is ready. Install the Playwright test package next."
                            : "Playwright is ready. Install and verify Chromium next.",
                Log = previous.Log ?? "",
                InstallAction = installAction
            };
            if (!string.IsNullOrWhiteSpace(previous.ActiveTask) &&
                string.Equals(previous.Status, "installing", StringComparison.OrdinalIgnoreCase))
            {
                state.Status = "installing";
                state.Message = previous.Message;
                state.InstallAction = "Installation in progress";
            }
            if (string.IsNullOrWhiteSpace(state.ActiveTask))
            {
                state.Progress = ready ? 100 : 0;
            }
            SaveRuntimeState(state);
            EnsureSampleSuite();
            return state;
        }

        public static string QueueInstall()
        {
            return QueueTask(new PlaywrightTask
            {
                Id = "pw-install-" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                Kind = "install",
                CreatedAt = DateTimeOffset.UtcNow.ToString("o")
            });
        }

        public static string QueueRun(string suiteId)
        {
            var suite = ReadSuites().FirstOrDefault(item => item.Id == suiteId);
            if (suite == null)
            {
                throw new InvalidOperationException("Playwright suite was not found.");
            }
            if (!suite.Enabled)
            {
                throw new InvalidOperationException("Playwright suite is disabled.");
            }
            return QueueTask(new PlaywrightTask
            {
                Id = "pw-run-" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                Kind = "run",
                SuiteId = suiteId,
                CreatedAt = DateTimeOffset.UtcNow.ToString("o")
            });
        }

        public static IList<PlaywrightSuite> ReadSuites()
        {
            EnsureDirectories();
            lock (FileLock)
            {
                if (!File.Exists(SuitesFile))
                {
                    return new List<PlaywrightSuite>();
                }
                try
                {
                    return Serializer.Deserialize<List<PlaywrightSuite>>(File.ReadAllText(SuitesFile)) ??
                           new List<PlaywrightSuite>();
                }
                catch
                {
                    return new List<PlaywrightSuite>();
                }
            }
        }

        public static PlaywrightSuite SaveSuite(PlaywrightSuite suite)
        {
            if (suite == null) throw new ArgumentNullException("suite");
            if (string.IsNullOrWhiteSpace(suite.Name)) throw new InvalidOperationException("Suite name is required.");
            Uri baseUrl;
            if (!Uri.TryCreate(suite.BaseUrl, UriKind.Absolute, out baseUrl) ||
                (baseUrl.Scheme != Uri.UriSchemeHttp && baseUrl.Scheme != Uri.UriSchemeHttps))
            {
                throw new InvalidOperationException("Web Client URL must be an absolute HTTP or HTTPS URL.");
            }
            EnsureDirectories();
            var testFile = string.IsNullOrWhiteSpace(suite.TestFile) ? "samplemanager-smoke.spec.js" : suite.TestFile.Trim();
            if (Path.IsPathRooted(testFile))
            {
                throw new InvalidOperationException("Test file must be relative to the Playwright tests directory.");
            }
            var fullTestPath = Path.GetFullPath(Path.Combine(TestsPath, testFile));
            if (!fullTestPath.StartsWith(Path.GetFullPath(TestsPath) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("Test file resolves outside the Playwright tests directory.");
            }

            lock (FileLock)
            {
                var suites = ReadSuites().ToList();
                var existing = suites.FirstOrDefault(item => item.Id == suite.Id);
                if (existing == null)
                {
                    suite.Id = string.IsNullOrWhiteSpace(suite.Id) ? Guid.NewGuid().ToString("N") : suite.Id;
                    suites.Add(suite);
                }
                else
                {
                    suites[suites.IndexOf(existing)] = suite;
                }
                suite.TestFile = testFile;
                suite.TimeoutSeconds = Math.Max(10, Math.Min(suite.TimeoutSeconds <= 0 ? 120 : suite.TimeoutSeconds, 3600));
                suite.Retries = Math.Max(0, Math.Min(suite.Retries, 5));
                suite.UpdatedAt = DateTimeOffset.Now.ToString("o");
                WriteJsonAtomic(SuitesFile, suites);
                return suite;
            }
        }

        public static void DeleteSuite(string suiteId)
        {
            lock (FileLock)
            {
                var suites = ReadSuites().Where(item => item.Id != suiteId).ToList();
                WriteJsonAtomic(SuitesFile, suites);
            }
        }

        public static IList<PlaywrightRun> ReadRuns(int maximum)
        {
            EnsureDirectories();
            return Directory.EnumerateFiles(RunsPath, "*.json")
                .OrderByDescending(File.GetLastWriteTimeUtc)
                .Take(Math.Max(1, maximum))
                .Select(ReadJson<PlaywrightRun>)
                .Where(item => item != null)
                .ToList();
        }

        public static IList<FileInfo> ReadArtifacts(int maximum)
        {
            EnsureDirectories();
            return Directory.EnumerateFiles(ArtifactsPath, "*", SearchOption.AllDirectories)
                .Select(path => new FileInfo(path))
                .OrderByDescending(file => file.LastWriteTimeUtc)
                .Take(Math.Max(1, maximum))
                .ToList();
        }

        public static IList<PlaywrightWebClientCandidate> DiscoverWebClients()
        {
            var candidates = new List<PlaywrightWebClientCandidate>();
            try
            {
                var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
                var configPath = Path.Combine(windows, "System32", "inetsrv", "config", "applicationHost.config");
                if (!File.Exists(configPath))
                {
                    return candidates;
                }

                var document = new XmlDocument();
                document.Load(configPath);
                var sites = document.SelectNodes("/configuration/system.applicationHost/sites/site");
                if (sites == null) return candidates;
                foreach (XmlNode site in sites)
                {
                    var siteName = GetAttribute(site, "name", "IIS site");
                    var bindings = site.SelectNodes("bindings/binding");
                    var applications = site.SelectNodes("application");
                    if (bindings == null || applications == null) continue;
                    foreach (XmlNode application in applications)
                    {
                        var applicationPath = GetAttribute(application, "path", "/");
                        var virtualDirectory = application.SelectSingleNode("virtualDirectory[@path='/']");
                        var physicalPath = virtualDirectory == null ? "" : Environment.ExpandEnvironmentVariables(GetAttribute(virtualDirectory, "physicalPath", ""));
                        foreach (XmlNode binding in bindings)
                        {
                            var protocol = GetAttribute(binding, "protocol", "http").ToLowerInvariant();
                            if (protocol != "http" && protocol != "https") continue;
                            string host;
                            string port;
                            ParseIisBinding(GetAttribute(binding, "bindingInformation", "*:80:"), out host, out port);
                            var url = protocol + "://" + host;
                            var defaultPort = protocol == "https" ? "443" : "80";
                            if (!string.IsNullOrWhiteSpace(port) && port != defaultPort) url += ":" + port;
                            if (!string.IsNullOrWhiteSpace(applicationPath) && applicationPath != "/")
                            {
                                url += "/" + applicationPath.Trim('/');
                            }
                            candidates.Add(new PlaywrightWebClientCandidate
                            {
                                Name = siteName + (applicationPath == "/" ? "" : " " + applicationPath),
                                Url = url.TrimEnd('/') + "/",
                                Source = "IIS binding",
                                PhysicalPath = physicalPath
                            });
                        }
                    }
                }
            }
            catch
            {
                // Discovery is advisory and must not block manual suite configuration.
            }

            return candidates
                .GroupBy(item => item.Url, StringComparer.OrdinalIgnoreCase)
                .Select(group => group.First())
                .OrderByDescending(item =>
                    (item.Name + " " + item.PhysicalPath).IndexOf("SampleManager", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    (item.Name + " " + item.PhysicalPath).IndexOf("Thermo", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    (item.Name + " " + item.PhysicalPath).IndexOf("LIMS", StringComparison.OrdinalIgnoreCase) >= 0)
                .ThenBy(item => item.Name)
                .ToList();
        }

        public static void ClearArtifacts()
        {
            EnsureDirectories();
            foreach (var directory in Directory.EnumerateDirectories(ArtifactsPath))
            {
                try { Directory.Delete(directory, true); } catch { }
            }
            foreach (var file in Directory.EnumerateFiles(ArtifactsPath))
            {
                try { File.Delete(file); } catch { }
            }
        }

        public static bool ProcessNextTask(CancellationToken token)
        {
            EnsureDirectories();
            var taskFile = Directory.EnumerateFiles(QueuePath, "*.json")
                .OrderBy(File.GetCreationTimeUtc)
                .FirstOrDefault();
            if (string.IsNullOrWhiteSpace(taskFile))
            {
                return false;
            }

            var runningFile = taskFile + ".running";
            try
            {
                File.Move(taskFile, runningFile);
            }
            catch
            {
                return false;
            }

            try
            {
                var task = ReadJson<PlaywrightTask>(runningFile);
                if (task == null) throw new InvalidOperationException("Playwright task could not be read.");
                if (task.Kind == "install")
                {
                    InstallRuntime(task.Id, token);
                }
                else if (task.Kind == "run")
                {
                    RunSuite(task, token);
                }
                return true;
            }
            catch (Exception ex)
            {
                var state = LoadRuntimeState();
                state.ActiveTask = "";
                state.Progress = 0;
                state.Status = "failed";
                state.Message = ex.Message;
                state.Log = AppendLog(state.Log, "ERROR: " + ex);
                SaveRuntimeState(state);
                return true;
            }
            finally
            {
                try { File.Delete(runningFile); } catch { }
            }
        }

        private static void InstallRuntime(string taskId, CancellationToken token)
        {
            EnsureDirectories();
            UpdateProgress(taskId, 5, "Checking Node.js and npm.", "Installation started.");
            var node = FindExecutable("node.exe");
            var npm = FindExecutable("npm.cmd");
            if (string.IsNullOrWhiteSpace(node) || string.IsNullOrWhiteSpace(npm))
            {
                UpdateProgress(taskId, 8, "Downloading Node.js LTS.", "Node.js is missing. Resolving the latest Windows x64 LTS installer.");
                InstallNodeLts(taskId, token);
                node = FindExecutable("node.exe");
                npm = FindExecutable("npm.cmd");
                if (string.IsNullOrWhiteSpace(node) || string.IsNullOrWhiteSpace(npm))
                {
                    throw new InvalidOperationException("Node.js LTS installation completed but node.exe or npm.cmd could not be found.");
                }
            }

            var packageJson = Path.Combine(RuntimePath, "package.json");
            if (!File.Exists(packageJson))
            {
                File.WriteAllText(packageJson, "{\"private\":true,\"name\":\"relay-agent-playwright-runtime\",\"version\":\"1.0.0\"}", new UTF8Encoding(false));
            }

            UpdateProgress(taskId, 20, "Installing @playwright/test.", "Running npm install @playwright/test.");
            var install = RunProcess(npm, "install --no-audit --no-fund @playwright/test", RuntimePath, 900000, token);
            if (install.ExitCode != 0)
            {
                throw new InvalidOperationException("Playwright package installation failed: " + install.Output);
            }

            UpdateProgress(taskId, 60, "Installing Chromium.", install.Output);
            var npx = FindExecutable("npx.cmd");
            if (string.IsNullOrWhiteSpace(npx))
            {
                throw new InvalidOperationException("npx.cmd was not found.");
            }
            var environment = new Dictionary<string, string>
            {
                { "PLAYWRIGHT_BROWSERS_PATH", BrowserCachePath }
            };
            var browserInstall = RunProcess(npx, "playwright install chromium", RuntimePath, 1200000, token, environment);
            if (browserInstall.ExitCode != 0)
            {
                throw new InvalidOperationException("Chromium installation failed: " + browserInstall.Output);
            }

            UpdateProgress(taskId, 90, "Verifying Playwright runtime.", browserInstall.Output);
            var state = DetectRuntime();
            if (string.IsNullOrWhiteSpace(state.PlaywrightVersion) || !state.ChromiumInstalled)
            {
                throw new InvalidOperationException("Playwright installation completed but runtime verification did not pass.");
            }
            state.Status = "ready";
            state.ActiveTask = "";
            state.Progress = 100;
            state.Message = "Playwright and Chromium are ready.";
            state.InstallAction = "Runtime ready";
            state.Log = AppendLog(state.Log, "Installation and verification completed.");
            SaveRuntimeState(state);
        }

        private static void RunSuite(PlaywrightTask task, CancellationToken token)
        {
            var suite = ReadSuites().FirstOrDefault(item => item.Id == task.SuiteId);
            if (suite == null) throw new InvalidOperationException("Playwright suite was not found.");
            var runtime = DetectRuntime();
            if (runtime.Status != "ready")
            {
                throw new InvalidOperationException("Playwright runtime is not ready.");
            }

            var run = new PlaywrightRun
            {
                Id = "run-" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                SuiteId = suite.Id,
                SuiteName = suite.Name,
                Status = "running",
                StartedAt = DateTimeOffset.Now.ToString("o"),
                ArtifactDirectory = Path.Combine(ArtifactsPath, task.Id)
            };
            Directory.CreateDirectory(run.ArtifactDirectory);
            SaveRun(run);

            var testFile = Path.GetFullPath(Path.Combine(TestsPath, suite.TestFile));
            if (!File.Exists(testFile))
            {
                throw new FileNotFoundException("Playwright test file was not found.", testFile);
            }
            var npx = FindExecutable("npx.cmd");
            var args = "playwright test \"" + testFile + "\" --reporter=line --workers=1 --output=\"" +
                       run.ArtifactDirectory + "\" --timeout=" + (suite.TimeoutSeconds * 1000) +
                       " --retries=" + suite.Retries;
            if (!suite.Headless)
            {
                args += " --headed";
            }
            var environment = new Dictionary<string, string>
            {
                { "PLAYWRIGHT_BROWSERS_PATH", BrowserCachePath },
                { "RELAY_PLAYWRIGHT_BASE_URL", suite.BaseUrl },
                { "RELAY_PLAYWRIGHT_ARTIFACTS", run.ArtifactDirectory }
            };
            var watch = Stopwatch.StartNew();
            try
            {
                var result = RunProcess(npx, args, RuntimePath, Math.Max(60000, suite.TimeoutSeconds * 1000 * 4), token, environment);
                watch.Stop();
                run.Status = result.ExitCode == 0 ? "passed" : "failed";
                run.ExitCode = result.ExitCode;
                run.Output = Limit(result.Output, 500000);
                run.Error = result.ExitCode == 0 ? "" : "Playwright exited with code " + result.ExitCode + ".";
            }
            catch (Exception ex)
            {
                watch.Stop();
                run.Status = "failed";
                run.ExitCode = 1;
                run.Error = ex.Message;
                run.Output = Limit(ex.ToString(), 500000);
            }
            finally
            {
                run.DurationMs = watch.ElapsedMilliseconds;
                run.FinishedAt = DateTimeOffset.Now.ToString("o");
                SaveRun(run);
            }
        }

        private static void EnsureSampleSuite()
        {
            EnsureDirectories();
            var samplePath = Path.Combine(TestsPath, "samplemanager-smoke.spec.js");
            if (!File.Exists(samplePath))
            {
                File.WriteAllText(samplePath,
@"const { test, expect } = require('@playwright/test');

test('SampleManager Web Client responds', async ({ page }) => {
  const baseUrl = process.env.RELAY_PLAYWRIGHT_BASE_URL;
  if (!baseUrl) throw new Error('RELAY_PLAYWRIGHT_BASE_URL is required');
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toBeVisible();
});", new UTF8Encoding(false));
            }

            if (ReadSuites().Count == 0)
            {
                SaveSuite(new PlaywrightSuite
                {
                    Name = "SampleManager Web Client smoke test",
                    BaseUrl = "http://localhost/",
                    TestFile = "samplemanager-smoke.spec.js",
                    Headless = true,
                    TimeoutSeconds = 120,
                    Retries = 0,
                    Enabled = true
                });
            }
        }

        private static void InstallNodeLts(string taskId, CancellationToken token)
        {
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            UpdateProgress(taskId, 10, "Downloading Node.js release metadata.", "GET https://nodejs.org/dist/index.json");
            string version = null;
            using (var client = new WebClient())
            {
                client.Headers.Add(HttpRequestHeader.UserAgent, "RelayAgent.Client");
                var json = client.DownloadString("https://nodejs.org/dist/index.json");
                var releases = Serializer.Deserialize<List<Dictionary<string, object>>>(json);
                if (releases != null)
                {
                    foreach (var release in releases)
                    {
                        object lts;
                        object files;
                        object releaseVersion;
                        if (!release.TryGetValue("lts", out lts) ||
                            lts == null ||
                            string.Equals(Convert.ToString(lts), "false", StringComparison.OrdinalIgnoreCase) ||
                            !release.TryGetValue("files", out files) ||
                            !release.TryGetValue("version", out releaseVersion))
                        {
                            continue;
                        }
                        var availableFiles = files as System.Collections.ArrayList;
                        if (availableFiles != null &&
                            availableFiles.Cast<object>().Any(item => string.Equals(Convert.ToString(item), "win-x64-msi", StringComparison.OrdinalIgnoreCase)))
                        {
                            version = Convert.ToString(releaseVersion);
                            break;
                        }
                    }
                }
                if (string.IsNullOrWhiteSpace(version))
                {
                    throw new InvalidOperationException("Unable to resolve a Node.js LTS Windows x64 MSI.");
                }

                var installer = Path.Combine(Path.GetTempPath(), "relay-node-" + version + "-x64.msi");
                var url = "https://nodejs.org/dist/" + version + "/node-" + version + "-x64.msi";
                UpdateProgress(taskId, 12, "Downloading Node.js " + version + ".", "GET " + url);
                client.DownloadFile(url, installer);
                try
                {
                    UpdateProgress(taskId, 16, "Installing Node.js " + version + ".", "Running silent MSI installation.");
                    var result = RunProcess(
                        "msiexec.exe",
                        "/i \"" + installer + "\" /qn /norestart ALLUSERS=1",
                        Path.GetTempPath(),
                        600000,
                        token);
                    if (result.ExitCode != 0 && result.ExitCode != 3010)
                    {
                        throw new InvalidOperationException("Node.js MSI installation failed with exit code " + result.ExitCode + ": " + result.Output);
                    }
                }
                finally
                {
                    try { File.Delete(installer); } catch { }
                }
            }
        }

        private static string GetAttribute(XmlNode node, string name, string fallback)
        {
            var attribute = node == null || node.Attributes == null ? null : node.Attributes[name];
            return attribute == null || string.IsNullOrWhiteSpace(attribute.Value) ? fallback : attribute.Value;
        }

        private static void ParseIisBinding(string bindingInformation, out string host, out string port)
        {
            host = "localhost";
            port = "";
            var parts = (bindingInformation ?? "").Split(':');
            if (parts.Length >= 2) port = parts[parts.Length - 2];
            if (parts.Length >= 3)
            {
                var configuredHost = parts[parts.Length - 1];
                if (!string.IsNullOrWhiteSpace(configuredHost) && configuredHost != "*")
                {
                    host = configuredHost;
                }
            }
        }

        private static string QueueTask(PlaywrightTask task)
        {
            EnsureDirectories();
            WriteJsonAtomic(Path.Combine(QueuePath, task.Id + ".json"), task);
            return task.Id;
        }

        private static void UpdateProgress(string taskId, int progress, string message, string log)
        {
            var state = LoadRuntimeState();
            state.ActiveTask = taskId;
            state.Status = "installing";
            state.Progress = progress;
            state.Message = message;
            state.Log = AppendLog(state.Log, log);
            SaveRuntimeState(state);
        }

        private static PlaywrightRuntimeState LoadRuntimeState()
        {
            var state = ReadJson<PlaywrightRuntimeState>(RuntimeStateFile);
            return state ?? new PlaywrightRuntimeState
            {
                Status = "unknown",
                BrowserCachePath = BrowserCachePath,
                Message = "Runtime has not been checked.",
                Log = ""
            };
        }

        private static void SaveRuntimeState(PlaywrightRuntimeState state)
        {
            WriteJsonAtomic(RuntimeStateFile, state);
        }

        private static void SaveRun(PlaywrightRun run)
        {
            WriteJsonAtomic(Path.Combine(RunsPath, run.Id + ".json"), run);
        }

        private static void EnsureDirectories()
        {
            Directory.CreateDirectory(RootPath);
            Directory.CreateDirectory(RuntimePath);
            Directory.CreateDirectory(BrowserCachePath);
            Directory.CreateDirectory(TestsPath);
            Directory.CreateDirectory(ArtifactsPath);
            Directory.CreateDirectory(QueuePath);
            Directory.CreateDirectory(RunsPath);
        }

        private static string FindExecutable(string name)
        {
            var path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (var directory in path.Split(Path.PathSeparator))
            {
                try
                {
                    var candidate = Path.Combine(directory.Trim(), name);
                    if (File.Exists(candidate)) return candidate;
                }
                catch { }
            }
            var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            var nodeCandidate = Path.Combine(programFiles, "nodejs", name);
            return File.Exists(nodeCandidate) ? nodeCandidate : "";
        }

        private static ProcessResult RunProcess(
            string fileName,
            string arguments,
            string workingDirectory,
            int timeoutMs,
            CancellationToken? token,
            IDictionary<string, string> environment = null)
        {
            var info = new ProcessStartInfo
            {
                FileName = fileName,
                Arguments = arguments,
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            if (environment != null)
            {
                foreach (var item in environment)
                {
                    info.EnvironmentVariables[item.Key] = item.Value;
                }
            }
            using (var process = new Process { StartInfo = info })
            {
                process.Start();
                var stdout = process.StandardOutput.ReadToEndAsync();
                var stderr = process.StandardError.ReadToEndAsync();
                var started = DateTime.UtcNow;
                while (!process.WaitForExit(250))
                {
                    if ((DateTime.UtcNow - started).TotalMilliseconds > timeoutMs ||
                        (token.HasValue && token.Value.IsCancellationRequested))
                    {
                        try { process.Kill(); } catch { }
                        throw new TimeoutException("Process timed out or was cancelled: " + fileName);
                    }
                }
                System.Threading.Tasks.Task.WaitAll(stdout, stderr);
                return new ProcessResult(process.ExitCode, stdout.Result + stderr.Result);
            }
        }

        private static T ReadJson<T>(string path) where T : class
        {
            try
            {
                return File.Exists(path) ? Serializer.Deserialize<T>(File.ReadAllText(path)) : null;
            }
            catch
            {
                return null;
            }
        }

        private static void WriteJsonAtomic(string path, object value)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            var temp = path + ".tmp";
            File.WriteAllText(temp, Serializer.Serialize(value), new UTF8Encoding(false));
            if (File.Exists(path))
            {
                File.Copy(temp, path, true);
                File.Delete(temp);
            }
            else
            {
                File.Move(temp, path);
            }
        }

        private static string AppendLog(string current, string message)
        {
            var line = DateTimeOffset.Now.ToString("o") + " " + (message ?? "");
            return Limit((current ?? "") + (string.IsNullOrWhiteSpace(current) ? "" : Environment.NewLine) + line, 200000);
        }

        private static string Limit(string value, int maximum)
        {
            if (string.IsNullOrEmpty(value) || value.Length <= maximum) return value ?? "";
            return value.Substring(value.Length - maximum);
        }

        private sealed class ProcessResult
        {
            public ProcessResult(int exitCode, string output)
            {
                ExitCode = exitCode;
                Output = output ?? "";
            }
            public int ExitCode { get; private set; }
            public string Output { get; private set; }
        }
    }
}
