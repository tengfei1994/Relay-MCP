using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Security.Cryptography;
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
        public string QueuedAt { get; set; }
        public string StartedAt { get; set; }
        public string FinishedAt { get; set; }
        public long DurationMs { get; set; }
        public int ExitCode { get; set; }
        public string Output { get; set; }
        public string ArtifactDirectory { get; set; }
        public string Error { get; set; }
    }

    public sealed class PlaywrightDispatch
    {
        public string TaskId { get; set; }
        public string RunId { get; set; }
        public string SuiteId { get; set; }
        public string Status { get; set; }
    }

    public sealed class PlaywrightArtifact
    {
        public string Name { get; set; }
        public string RelativePath { get; set; }
        public long Bytes { get; set; }
        public string LastWriteTime { get; set; }
    }

    public sealed class PlaywrightWebClientCandidate
    {
        public string Name { get; set; }
        public string Url { get; set; }
        public string Source { get; set; }
        public string PhysicalPath { get; set; }
        public string ConfigPath { get; set; }
        public string SiteName { get; set; }
        public string Protocol { get; set; }
        public string BindingInformation { get; set; }
        public string Port { get; set; }
        public string Host { get; set; }
        public string ApplicationPath { get; set; }

        public string DisplayName
        {
            get { return Name + " · " + Url; }
        }

        public string Evidence
        {
            get
            {
                var source = string.IsNullOrWhiteSpace(Source) ? "IIS" : Source;
                var binding = string.IsNullOrWhiteSpace(BindingInformation) ? "" : " (" + BindingInformation + ")";
                return source + binding;
            }
        }
    }

    internal sealed class PlaywrightTask
    {
        public string Id { get; set; }
        public string Kind { get; set; }
        public string SuiteId { get; set; }
        public string RunId { get; set; }
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
            return QueueRunDetailed(suiteId, null).TaskId;
        }

        public static PlaywrightDispatch QueueRunDetailed(string suiteId, string requestedRunId)
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
            EnsureDirectories();
            var runId = string.IsNullOrWhiteSpace(requestedRunId)
                ? "run-" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "-" + Guid.NewGuid().ToString("N").Substring(0, 6)
                : requestedRunId;
            var queuedAt = DateTimeOffset.Now.ToString("o");
            SaveRun(new PlaywrightRun
            {
                Id = runId,
                SuiteId = suite.Id,
                SuiteName = suite.Name,
                Status = "queued",
                QueuedAt = queuedAt,
                ArtifactDirectory = Path.Combine(ArtifactsPath, runId)
            });
            var taskId = QueueTask(new PlaywrightTask
            {
                Id = "pw-run-" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                Kind = "run",
                SuiteId = suiteId,
                RunId = runId,
                CreatedAt = DateTimeOffset.UtcNow.ToString("o")
            });
            return new PlaywrightDispatch
            {
                TaskId = taskId,
                RunId = runId,
                SuiteId = suite.Id,
                Status = "queued"
            };
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
            var migrated = false;
            var runs = Directory.EnumerateFiles(RunsPath, "*.json")
                .OrderByDescending(File.GetLastWriteTimeUtc)
                .Take(Math.Max(1, maximum))
                .Select(path => ReadRunSummary(path, ref migrated))
                .Where(item => item != null)
                .ToList();
            if (migrated)
            {
                GC.Collect(2, GCCollectionMode.Optimized, false);
            }
            return runs;
        }

        public static PlaywrightRun ReadRun(string runId)
        {
            if (string.IsNullOrWhiteSpace(runId)) return null;
            EnsureDirectories();
            var path = Path.Combine(RunsPath, runId + ".json");
            var fullRunsPath = Path.GetFullPath(RunsPath) + Path.DirectorySeparatorChar;
            if (!Path.GetFullPath(path).StartsWith(fullRunsPath, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("Run ID resolves outside the Playwright runs directory.");
            }
            return ReadJson<PlaywrightRun>(path);
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

        public static IList<PlaywrightArtifact> ReadArtifactMetadata(int maximum)
        {
            EnsureDirectories();
            var fullArtifactsPath = Path.GetFullPath(ArtifactsPath) + Path.DirectorySeparatorChar;
            return Directory.EnumerateFiles(ArtifactsPath, "*", SearchOption.AllDirectories)
                .Select(path => new FileInfo(path))
                .OrderByDescending(file => file.LastWriteTimeUtc)
                .Take(Math.Max(1, maximum))
                .Select(file => new PlaywrightArtifact
                {
                    Name = file.Name,
                    RelativePath = file.FullName.Substring(fullArtifactsPath.Length).Replace(Path.DirectorySeparatorChar, '/'),
                    Bytes = file.Length,
                    LastWriteTime = file.LastWriteTimeUtc.ToString("o")
                })
                .ToList();
        }

        public static string ResolveArtifactPath(string relativePath)
        {
            if (string.IsNullOrWhiteSpace(relativePath))
            {
                throw new InvalidOperationException("Artifact path is required.");
            }
            EnsureDirectories();
            var fullArtifactsPath = Path.GetFullPath(ArtifactsPath) + Path.DirectorySeparatorChar;
            var candidate = Path.GetFullPath(Path.Combine(ArtifactsPath, relativePath.Replace('/', Path.DirectorySeparatorChar)));
            if (!candidate.StartsWith(fullArtifactsPath, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("Artifact path resolves outside the Playwright artifacts directory.");
            }
            if (!File.Exists(candidate))
            {
                throw new FileNotFoundException("Playwright artifact was not found.", relativePath);
            }
            return candidate;
        }

        public static PlaywrightSuite SaveUploadedSuite(string suiteJson, string testFileBase64, string expectedSha256)
        {
            if (string.IsNullOrWhiteSpace(suiteJson))
            {
                throw new InvalidOperationException("Suite metadata is required.");
            }
            if (string.IsNullOrWhiteSpace(testFileBase64))
            {
                throw new InvalidOperationException("Playwright test file content is required.");
            }
            var suite = Serializer.Deserialize<PlaywrightSuite>(suiteJson);
            if (suite == null) throw new InvalidOperationException("Suite metadata could not be parsed.");
            var bytes = Convert.FromBase64String(testFileBase64);
            using (var hash = SHA256.Create())
            {
                var actual = BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
                if (!string.IsNullOrWhiteSpace(expectedSha256) &&
                    !string.Equals(actual, expectedSha256, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException("Playwright test file SHA-256 mismatch: expected " + expectedSha256 + ", received " + actual);
                }
            }
            var saved = SaveSuite(suite);
            var testPath = Path.GetFullPath(Path.Combine(TestsPath, saved.TestFile));
            Directory.CreateDirectory(Path.GetDirectoryName(testPath));
            File.WriteAllBytes(testPath, bytes);
            return saved;
        }

        public static IList<PlaywrightWebClientCandidate> DiscoverWebClients()
        {
            var candidates = new List<PlaywrightWebClientCandidate>();
            foreach (var configPath in GetIisConfigPaths())
            {
                if (!File.Exists(configPath)) continue;
                try
                {
                    candidates.AddRange(DiscoverWebClientsFromConfig(
                        configPath,
                        "IIS applicationHost.config"));
                }
                catch
                {
                    // A 32-bit process can see a redirected path or lack access to one IIS view.
                }

                if (candidates.Count > 0)
                {
                    break;
                }
            }

            if (candidates.Count == 0)
            {
                candidates.AddRange(DiscoverWebClientsFromAppCmd());
            }

            return SortWebClientCandidates(candidates);
        }

        // Public overload keeps discovery testable with an applicationHost.config fixture.
        public static IList<PlaywrightWebClientCandidate> DiscoverWebClients(string configPath)
        {
            if (string.IsNullOrWhiteSpace(configPath) || !File.Exists(configPath))
            {
                return new List<PlaywrightWebClientCandidate>();
            }

            try
            {
                return SortWebClientCandidates(DiscoverWebClientsFromConfig(
                    configPath,
                    "IIS applicationHost.config"));
            }
            catch
            {
                return new List<PlaywrightWebClientCandidate>();
            }
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

            PlaywrightTask task = null;
            try
            {
                task = ReadJson<PlaywrightTask>(runningFile);
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
                if (task != null && task.Kind == "run" && !string.IsNullOrWhiteSpace(task.RunId))
                {
                    MarkRunFailed(task.RunId, ex);
                }
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

        private static void MarkRunFailed(string runId, Exception error)
        {
            try
            {
                var run = ReadRun(runId);
                if (run == null) return;
                run.Status = "failed";
                run.ExitCode = 1;
                run.Error = error == null ? "Playwright task failed." : error.Message;
                run.FinishedAt = DateTimeOffset.Now.ToString("o");
                SaveRun(run);
            }
            catch
            {
                // Preserve the original task failure; the runtime log contains the diagnostic.
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

            var run = string.IsNullOrWhiteSpace(task.RunId) ? null : ReadRun(task.RunId);
            if (run == null)
            {
                run = new PlaywrightRun
                {
                    Id = "run-" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + "-" + Guid.NewGuid().ToString("N").Substring(0, 6),
                    SuiteId = suite.Id,
                    SuiteName = suite.Name,
                    QueuedAt = DateTimeOffset.Now.ToString("o"),
                    ArtifactDirectory = Path.Combine(ArtifactsPath, task.Id)
                };
            }
            run.SuiteId = suite.Id;
            run.SuiteName = suite.Name;
            run.Status = "running";
            run.StartedAt = DateTimeOffset.Now.ToString("o");
            if (string.IsNullOrWhiteSpace(run.ArtifactDirectory))
            {
                run.ArtifactDirectory = Path.Combine(ArtifactsPath, task.Id);
            }
            Directory.CreateDirectory(run.ArtifactDirectory);
            SaveRun(run);

            var testFile = Path.GetFullPath(Path.Combine(TestsPath, suite.TestFile));
            if (!File.Exists(testFile))
            {
                throw new FileNotFoundException("Playwright test file was not found.", testFile);
            }
            var safeSuiteId = new string((suite.Id ?? "suite")
                .Select(character => char.IsLetterOrDigit(character) || character == '-' || character == '_'
                    ? character
                    : '_')
                .ToArray());
            if (string.IsNullOrWhiteSpace(safeSuiteId))
            {
                safeSuiteId = "suite";
            }
            var stagedRelativeTestFile = Path.Combine(
                "suite-tests",
                safeSuiteId,
                Path.GetFileName(testFile));
            var stagedTestFile = Path.Combine(RuntimePath, stagedRelativeTestFile);
            Directory.CreateDirectory(Path.GetDirectoryName(stagedTestFile));
            File.Copy(testFile, stagedTestFile, true);

            var npx = FindExecutable("npx.cmd");
            var testFilter = stagedRelativeTestFile.Replace(Path.DirectorySeparatorChar, '/');
            var args = "playwright test \"" + testFilter + "\" --reporter=line --workers=1 --output=\"" +
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

        private static IList<PlaywrightWebClientCandidate> DiscoverWebClientsFromConfig(
            string configPath,
            string source)
        {
            var document = new XmlDocument();
            document.Load(configPath);
            return ParseWebClientDocument(document, source, configPath);
        }

        private static IList<PlaywrightWebClientCandidate> DiscoverWebClientsFromAppCmd()
        {
            var executable = FindIisExecutable("appcmd.exe");
            if (string.IsNullOrWhiteSpace(executable))
            {
                return new List<PlaywrightWebClientCandidate>();
            }

            try
            {
                var result = RunProcess(
                    executable,
                    "list site /config /xml",
                    Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                    30000,
                    null);
                if (result.ExitCode != 0 || string.IsNullOrWhiteSpace(result.Output))
                {
                    return new List<PlaywrightWebClientCandidate>();
                }

                var document = new XmlDocument();
                document.LoadXml(result.Output);
                return ParseWebClientDocument(document, "IIS appcmd", executable);
            }
            catch
            {
                return new List<PlaywrightWebClientCandidate>();
            }
        }

        private static IList<PlaywrightWebClientCandidate> ParseWebClientDocument(
            XmlDocument document,
            string source,
            string evidencePath)
        {
            var candidates = new List<PlaywrightWebClientCandidate>();
            var sites = document.SelectNodes("//site");
            if (sites == null) return candidates;

            foreach (XmlNode site in sites)
            {
                var siteName = GetAttribute(site, "name", "IIS site");
                var bindings = site.SelectNodes("bindings/binding");
                var applications = site.SelectNodes("application");
                if (bindings == null || bindings.Count == 0) continue;

                if (applications == null || applications.Count == 0)
                {
                    AddWebClientBindings(
                        candidates,
                        siteName,
                        "/",
                        "",
                        bindings,
                        source,
                        evidencePath);
                    continue;
                }

                foreach (XmlNode application in applications)
                {
                    var applicationPath = GetAttribute(application, "path", "/");
                    var virtualDirectory = application.SelectSingleNode("virtualDirectory[@path='/']");
                    var physicalPath = virtualDirectory == null
                        ? ""
                        : Environment.ExpandEnvironmentVariables(
                            GetAttribute(virtualDirectory, "physicalPath", ""));
                    AddWebClientBindings(
                        candidates,
                        siteName,
                        applicationPath,
                        physicalPath,
                        bindings,
                        source,
                        evidencePath);
                }
            }

            return candidates;
        }

        private static void AddWebClientBindings(
            IList<PlaywrightWebClientCandidate> candidates,
            string siteName,
            string applicationPath,
            string physicalPath,
            XmlNodeList bindings,
            string source,
            string evidencePath)
        {
            foreach (XmlNode binding in bindings)
            {
                var protocol = GetAttribute(binding, "protocol", "http").ToLowerInvariant();
                if (protocol != "http" && protocol != "https") continue;

                var bindingInformation = GetAttribute(binding, "bindingInformation", "*:80:");
                string host;
                string port;
                ParseIisBinding(bindingInformation, out host, out port);
                var url = BuildWebClientUrl(protocol, host, port, applicationPath);
                candidates.Add(new PlaywrightWebClientCandidate
                {
                    Name = siteName + (applicationPath == "/" ? "" : " " + applicationPath),
                    Url = url,
                    Source = source,
                    PhysicalPath = physicalPath,
                    ConfigPath = evidencePath,
                    SiteName = siteName,
                    Protocol = protocol,
                    BindingInformation = bindingInformation,
                    Port = port,
                    Host = host,
                    ApplicationPath = applicationPath
                });
            }
        }

        private static string BuildWebClientUrl(
            string protocol,
            string host,
            string port,
            string applicationPath)
        {
            var url = protocol + "://" + (string.IsNullOrWhiteSpace(host) ? "localhost" : host);
            var defaultPort = protocol == "https" ? "443" : "80";
            if (!string.IsNullOrWhiteSpace(port) && port != defaultPort)
            {
                url += ":" + port;
            }
            if (!string.IsNullOrWhiteSpace(applicationPath) && applicationPath != "/")
            {
                url += "/" + applicationPath.Trim('/');
            }
            return url.TrimEnd('/') + "/";
        }

        private static IList<PlaywrightWebClientCandidate> SortWebClientCandidates(
            IEnumerable<PlaywrightWebClientCandidate> candidates)
        {
            return candidates
                .Where(item => item != null && !string.IsNullOrWhiteSpace(item.Url))
                .GroupBy(item => item.Url, StringComparer.OrdinalIgnoreCase)
                .Select(group => group
                    .OrderByDescending(item => IsPreferredWebClient(item))
                    .ThenBy(item => item.Source)
                    .First())
                .OrderByDescending(IsPreferredWebClient)
                .ThenBy(item => item.Name)
                .ThenBy(item => item.Url)
                .ToList();
        }

        private static bool IsPreferredWebClient(PlaywrightWebClientCandidate candidate)
        {
            var text = (candidate.Name ?? "") + " " + (candidate.PhysicalPath ?? "");
            return text.IndexOf("SampleManager", StringComparison.OrdinalIgnoreCase) >= 0 ||
                   text.IndexOf("Thermo", StringComparison.OrdinalIgnoreCase) >= 0 ||
                   text.IndexOf("LIMS", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static IEnumerable<string> GetIisConfigPaths()
        {
            var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            if (string.IsNullOrWhiteSpace(windows))
            {
                windows = Environment.GetEnvironmentVariable("windir") ?? @"C:\Windows";
            }

            var paths = new[]
            {
                Path.Combine(windows, "Sysnative", "inetsrv", "config", "applicationHost.config"),
                Path.Combine(windows, "System32", "inetsrv", "config", "applicationHost.config"),
                Path.Combine(windows, "SysWOW64", "inetsrv", "config", "applicationHost.config")
            };
            return paths.Distinct(StringComparer.OrdinalIgnoreCase);
        }

        private static string FindIisExecutable(string name)
        {
            var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            if (string.IsNullOrWhiteSpace(windows))
            {
                windows = Environment.GetEnvironmentVariable("windir") ?? @"C:\Windows";
            }

            return new[]
            {
                Path.Combine(windows, "Sysnative", "inetsrv", name),
                Path.Combine(windows, "System32", "inetsrv", name),
                Path.Combine(windows, "SysWOW64", "inetsrv", name)
            }
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault(File.Exists) ?? "";
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
                if (!string.IsNullOrWhiteSpace(configuredHost) &&
                    configuredHost != "*" &&
                    configuredHost != "+")
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
            WriteJsonAtomic(Path.Combine(RunsPath, run.Id + ".index"), CreateRunSummary(run));
        }

        private static PlaywrightRun ReadRunSummary(string detailPath, ref bool migrated)
        {
            var indexPath = Path.ChangeExtension(detailPath, ".index");
            var summary = ReadJson<PlaywrightRun>(indexPath);
            if (summary != null) return summary;

            var legacy = ReadJson<PlaywrightRun>(detailPath);
            if (legacy == null) return null;
            summary = CreateRunSummary(legacy);
            try
            {
                WriteJsonAtomic(indexPath, summary);
                migrated = true;
            }
            catch { }
            return summary;
        }

        private static PlaywrightRun CreateRunSummary(PlaywrightRun run)
        {
            return new PlaywrightRun
            {
                Id = run.Id,
                SuiteId = run.SuiteId,
                SuiteName = run.SuiteName,
                Status = run.Status,
                QueuedAt = run.QueuedAt,
                StartedAt = run.StartedAt,
                FinishedAt = run.FinishedAt,
                DurationMs = run.DurationMs,
                ExitCode = run.ExitCode,
                Output = "",
                ArtifactDirectory = run.ArtifactDirectory,
                Error = Compact(run.Error, 500)
            };
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
            var candidates = new List<string>();
            foreach (var directory in path.Split(Path.PathSeparator))
            {
                try
                {
                    var candidate = Path.Combine(directory.Trim(), name);
                    candidates.Add(candidate);
                }
                catch { }
            }
            candidates.Add(Path.Combine(Environment.GetEnvironmentVariable("ProgramW6432") ?? "", "nodejs", name));
            candidates.Add(Path.Combine(Environment.GetEnvironmentVariable("ProgramFiles") ?? "", "nodejs", name));
            candidates.Add(Path.Combine(Environment.GetEnvironmentVariable("ProgramFiles(x86)") ?? "", "nodejs", name));
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", name));
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", name));
            candidates.Add(Path.Combine(@"C:\Program Files", "nodejs", name));
            return candidates
                .Where(item => !string.IsNullOrWhiteSpace(item))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault(File.Exists) ?? "";
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

        private static string Compact(string value, int maximum)
        {
            if (string.IsNullOrWhiteSpace(value)) return "";
            var compact = value.Replace("\r", " ").Replace("\n", " ").Trim();
            return compact.Length <= maximum
                ? compact
                : compact.Substring(0, maximum) + "...";
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
