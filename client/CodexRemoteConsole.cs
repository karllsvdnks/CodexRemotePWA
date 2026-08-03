using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace CodexRemoteConsole
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new ConsoleForm());
        }
    }

    internal sealed class ConsoleForm : Form
    {
        private readonly string projectRoot;
        private readonly string dataRoot;
        private readonly string envFile;
        private readonly string pidFile;
        private readonly string outputLog;
        private readonly string errorLog;
        private readonly string tailscaleScript;
        private readonly string helpFile;
        private readonly string setupFile;
        private readonly Label pwaStatus;
        private readonly Label pwaAddress;
        private readonly Label tailscaleStatus;
        private readonly Timer refreshTimer;

        public ConsoleForm()
        {
            projectRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            dataRoot = Path.Combine(projectRoot, "data");
            envFile = Path.Combine(projectRoot, ".env");
            pidFile = Path.Combine(dataRoot, "codex-remote-server.json");
            outputLog = Path.Combine(dataRoot, "codex-remote-server.log");
            errorLog = Path.Combine(dataRoot, "codex-remote-server-error.log");
            tailscaleScript = Path.Combine(projectRoot, "scripts", "manage-tailscale.ps1");
            helpFile = Path.Combine(projectRoot, "教程.md");
            setupFile = Path.Combine(projectRoot, "CodexRemoteSetup.exe");
            Directory.CreateDirectory(dataRoot);

            Text = "Codex Remote 控制台";
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(700, 390);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            Font = new Font("Segoe UI", 9F);

            GroupBox pwaBox = new GroupBox();
            pwaBox.Text = "Codex Remote PWA";
            pwaBox.Location = new Point(18, 18);
            pwaBox.Size = new Size(664, 134);
            Controls.Add(pwaBox);

            pwaStatus = NewLabel(new Point(18, 30), new Size(620, 24));
            pwaBox.Controls.Add(pwaStatus);
            pwaAddress = NewLabel(new Point(18, 56), new Size(620, 22));
            pwaAddress.ForeColor = Color.DimGray;
            pwaBox.Controls.Add(pwaAddress);
            pwaBox.Controls.Add(NewButton("启动服务", new Point(18, 91), new Size(92, 28), delegate { StartPwaServer(); }));
            pwaBox.Controls.Add(NewButton("停止服务", new Point(118, 91), new Size(92, 28), delegate { StopPwaServer(); }));
            pwaBox.Controls.Add(NewButton("打开本机页面", new Point(218, 91), new Size(112, 28), delegate { OpenLocalPage(); }));
            pwaBox.Controls.Add(NewButton("查看日志", new Point(338, 91), new Size(92, 28), delegate { OpenLog(); }));

            GroupBox tailscaleBox = new GroupBox();
            tailscaleBox.Text = "Tailscale";
            tailscaleBox.Location = new Point(18, 164);
            tailscaleBox.Size = new Size(664, 106);
            Controls.Add(tailscaleBox);
            tailscaleStatus = NewLabel(new Point(18, 29), new Size(620, 24));
            tailscaleBox.Controls.Add(tailscaleStatus);
            tailscaleBox.Controls.Add(NewButton("启动 Tailscale", new Point(18, 65), new Size(112, 28), delegate { ManageTailscale("Start"); }));
            tailscaleBox.Controls.Add(NewButton("停止 Tailscale", new Point(138, 65), new Size(112, 28), delegate { ManageTailscale("Stop"); }));

            Controls.Add(NewButton("设置", new Point(18, 314), new Size(82, 30), delegate { ShowSettings(); }));
            Controls.Add(NewButton("帮助文档", new Point(108, 314), new Size(92, 30), delegate { OpenHelp(); }));
            Controls.Add(NewButton("配置向导", new Point(208, 314), new Size(92, 30), delegate { OpenSetup(); }));
            Controls.Add(NewButton("刷新状态", new Point(510, 314), new Size(82, 30), delegate { UpdateStatus(); }));
            Controls.Add(NewButton("关闭", new Point(600, 314), new Size(82, 30), delegate { Close(); }));

            refreshTimer = new Timer();
            refreshTimer.Interval = 2500;
            refreshTimer.Tick += delegate { UpdateStatus(); };
            Shown += delegate { UpdateStatus(); refreshTimer.Start(); Activate(); };
            FormClosed += delegate { refreshTimer.Stop(); refreshTimer.Dispose(); };
        }

        private static Label NewLabel(Point location, Size size)
        {
            Label label = new Label();
            label.Location = location;
            label.Size = size;
            return label;
        }

        private static Button NewButton(string text, Point location, Size size, EventHandler click)
        {
            Button button = new Button();
            button.Text = text;
            button.Location = location;
            button.Size = size;
            button.Click += click;
            return button;
        }

        private Dictionary<string, string> ReadEnv()
        {
            Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (!File.Exists(envFile)) return values;
            foreach (string line in File.ReadAllLines(envFile))
            {
                string trimmed = line.Trim();
                if (trimmed.Length == 0 || trimmed.StartsWith("#")) continue;
                int separator = line.IndexOf('=');
                if (separator < 1) continue;
                string key = line.Substring(0, separator).Trim();
                string value = line.Substring(separator + 1).Trim();
                if (value.Length >= 2 && ((value.StartsWith("\"") && value.EndsWith("\"")) || (value.StartsWith("'") && value.EndsWith("'"))))
                {
                    value = value.Substring(1, value.Length - 2);
                }
                values[key] = value;
            }
            return values;
        }

        private string EnvValue(string key, string fallback)
        {
            Dictionary<string, string> values = ReadEnv();
            string value;
            return values.TryGetValue(key, out value) && !String.IsNullOrWhiteSpace(value) ? value : fallback;
        }

        private int ServerPort()
        {
            int port;
            return Int32.TryParse(EnvValue("PORT", "8787"), out port) && port >= 1 && port <= 65535 ? port : 8787;
        }

        private bool ServerResponds()
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + ServerPort() + "/api/me");
                request.Timeout = 2000;
                request.ReadWriteTimeout = 2000;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse()) return true;
            }
            catch (WebException exception)
            {
                return exception.Response != null;
            }
            catch
            {
                return false;
            }
        }

        private bool ServerIsListening()
        {
            try
            {
                using (TcpClient client = new TcpClient())
                {
                    IAsyncResult connect = client.BeginConnect(IPAddress.Loopback, ServerPort(), null, null);
                    if (!connect.AsyncWaitHandle.WaitOne(250)) return false;
                    client.EndConnect(connect);
                    return true;
                }
            }
            catch
            {
                return false;
            }
        }

        private int ManagedProcessId()
        {
            try
            {
                if (!File.Exists(pidFile)) return 0;
                Match match = Regex.Match(File.ReadAllText(pidFile), "\\\"processId\\\"\\s*:\\s*(\\d+)");
                int processId;
                if (!match.Success || !Int32.TryParse(match.Groups[1].Value, out processId)) return 0;
                Process.GetProcessById(processId);
                return processId;
            }
            catch
            {
                return 0;
            }
        }

        private string NodePath()
        {
            string preferred = @"D:\Program Files\nodejs\node.exe";
            if (File.Exists(preferred)) return preferred;
            return "node.exe";
        }

        private void StartPwaServer()
        {
            if (ServerResponds())
            {
                Info("Codex Remote PWA 已在运行。");
                UpdateStatus();
                return;
            }
            try
            {
                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = NodePath();
                startInfo.Arguments = "\"" + Path.Combine(projectRoot, "server.mjs") + "\"";
                startInfo.WorkingDirectory = projectRoot;
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                startInfo.RedirectStandardOutput = true;
                startInfo.RedirectStandardError = true;
                Process process = new Process();
                process.StartInfo = startInfo;
                process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs) { AppendLog(outputLog, eventArgs.Data); };
                process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs) { AppendLog(errorLog, eventArgs.Data); };
                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                File.WriteAllText(pidFile, "{\"processId\":" + process.Id + ",\"startedAtUtc\":\"" + DateTime.UtcNow.ToString("o") + "\"}", new UTF8Encoding(false));
                DateTime verifyDeadline = DateTime.UtcNow.AddSeconds(8);
                Timer verifyTimer = new Timer();
                verifyTimer.Interval = 250;
                verifyTimer.Tick += delegate
                {
                    if (ServerIsListening())
                    {
                        verifyTimer.Stop();
                        verifyTimer.Dispose();
                        UpdateStatus();
                        return;
                    }
                    if (process.HasExited)
                    {
                        verifyTimer.Stop();
                        verifyTimer.Dispose();
                        Error("服务未成功启动。请打开日志检查：" + errorLog);
                        UpdateStatus();
                        return;
                    }
                    if (DateTime.UtcNow >= verifyDeadline)
                    {
                        verifyTimer.Stop();
                        verifyTimer.Dispose();
                        UpdateStatus();
                    }
                };
                verifyTimer.Start();
            }
            catch (Exception exception)
            {
                Error("无法启动 Codex Remote PWA：" + exception.Message);
                UpdateStatus();
            }
        }

        private static void AppendLog(string file, string line)
        {
            if (line == null) return;
            try { File.AppendAllText(file, line + Environment.NewLine, new UTF8Encoding(false)); } catch { }
        }

        private void StopPwaServer()
        {
            int processId = ManagedProcessId();
            if (processId == 0)
            {
                Info(ServerResponds() ? "服务正在运行，但不是由该客户端启动，无法安全停止。" : "Codex Remote PWA 未运行。");
                UpdateStatus();
                return;
            }
            try
            {
                Process.GetProcessById(processId).Kill();
                if (File.Exists(pidFile)) File.Delete(pidFile);
            }
            catch (Exception exception)
            {
                Error("无法停止 Codex Remote PWA：" + exception.Message);
            }
            UpdateStatus();
        }

        private void OpenLocalPage()
        {
            OpenShell("http://127.0.0.1:" + ServerPort());
        }

        private void OpenLog()
        {
            if (!File.Exists(outputLog) && !File.Exists(errorLog))
            {
                Info("尚未生成服务日志。");
                return;
            }
            Process.Start(new ProcessStartInfo("notepad.exe", File.Exists(errorLog) ? errorLog : outputLog) { UseShellExecute = true });
        }

        private void OpenHelp()
        {
            if (!File.Exists(helpFile))
            {
                Error("找不到帮助文档：" + helpFile);
                return;
            }
            OpenShell(helpFile);
        }

        private void OpenSetup()
        {
            if (!File.Exists(setupFile))
            {
                Error("找不到配置向导：" + setupFile);
                return;
            }
            OpenShell(setupFile);
        }

        private static void OpenShell(string target)
        {
            Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
        }

        private void ManageTailscale(string action)
        {
            if (action == "Stop" && MessageBox.Show("停止 Tailscale 会断开 iPhone 对 PWA 的私网访问。继续吗？", "Codex Remote", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
            if (!File.Exists(tailscaleScript))
            {
                Error("找不到 Tailscale 管理脚本。");
                return;
            }
            try
            {
                ProcessStartInfo startInfo = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -File \"" + tailscaleScript + "\" -Action " + action);
                startInfo.UseShellExecute = true;
                startInfo.Verb = "runas";
                Process process = Process.Start(startInfo);
                if (process != null) process.EnableRaisingEvents = true;
            }
            catch (Exception exception)
            {
                Error("无法管理 Tailscale：" + exception.Message);
            }
            Timer updateTimer = new Timer();
            updateTimer.Interval = 1200;
            updateTimer.Tick += delegate { updateTimer.Stop(); updateTimer.Dispose(); UpdateStatus(); };
            updateTimer.Start();
        }

        private void UpdateStatus()
        {
            bool pwaRunning = ServerResponds();
            int managedProcessId = ManagedProcessId();
            pwaStatus.Text = pwaRunning ? (managedProcessId > 0 ? "运行中，客户端管理的进程 PID " + managedProcessId : "运行中") : "已停止";
            pwaStatus.ForeColor = pwaRunning ? Color.ForestGreen : Color.Firebrick;
            pwaAddress.Text = "本机地址：http://127.0.0.1:" + ServerPort();

            try
            {
                using (ServiceController service = new ServiceController("Tailscale"))
                {
                    ServiceControllerStatus status = service.Status;
                    bool running = status == ServiceControllerStatus.Running;
                    tailscaleStatus.Text = running ? "服务正在运行" : "服务状态：" + status;
                    tailscaleStatus.ForeColor = running ? Color.ForestGreen : Color.Firebrick;
                }
            }
            catch
            {
                tailscaleStatus.Text = "未检测到 Tailscale 服务";
                tailscaleStatus.ForeColor = Color.Firebrick;
            }
        }

        private void ShowSettings()
        {
            Dictionary<string, string> values = ReadEnv();
            Form dialog = new Form();
            dialog.Text = "Codex Remote 设置";
            dialog.StartPosition = FormStartPosition.CenterParent;
            dialog.ClientSize = new Size(540, 345);
            dialog.FormBorderStyle = FormBorderStyle.FixedDialog;
            dialog.MaximizeBox = false;
            dialog.MinimizeBox = false;
            dialog.Font = new Font("Segoe UI", 9F);

            TextBox workspace = AddField(dialog, "工作目录", ValueOr(values, "WORKSPACE_ROOT", ""), 20);
            TextBox port = AddField(dialog, "本地端口", ValueOr(values, "PORT", "8787"), 58);
            TextBox origin = AddField(dialog, "Tailscale HTTPS 地址", ValueOr(values, "PUBLIC_ORIGIN", ""), 96);
            Label sandboxCaption = NewLabel(new Point(20, 142), new Size(150, 24));
            sandboxCaption.Text = "Codex 权限";
            dialog.Controls.Add(sandboxCaption);
            ComboBox sandbox = new ComboBox();
            sandbox.DropDownStyle = ComboBoxStyle.DropDownList;
            sandbox.Items.AddRange(new object[] { "workspace-write", "read-only" });
            sandbox.SelectedItem = ValueOr(values, "CODEX_SANDBOX", "workspace-write") == "read-only" ? "read-only" : "workspace-write";
            sandbox.Location = new Point(175, 138);
            sandbox.Size = new Size(180, 24);
            dialog.Controls.Add(sandbox);
            CheckBox cookieSecure = AddCheckBox(dialog, "HTTPS Cookie", 175, 178, ValueOr(values, "COOKIE_SECURE", "") == "1");
            CheckBox trustProxy = AddCheckBox(dialog, "信任 Tailscale 代理", 315, 178, ValueOr(values, "TRUST_PROXY", "") == "1");
            CheckBox desktopHistory = AddCheckBox(dialog, "显示本机 Codex 历史", 175, 208, ValueOr(values, "ENABLE_DESKTOP_SESSION_HISTORY", "1") != "0");
            Label hint = NewLabel(new Point(20, 250), new Size(495, 28));
            hint.Text = "访问密码和 API Key 不会在此窗口显示或修改。保存后需重启 PWA。";
            hint.ForeColor = Color.DimGray;
            dialog.Controls.Add(hint);
            Button save = NewButton("保存", new Point(350, 295), new Size(80, 30), null);
            save.Click += delegate
            {
                int portValue;
                string workspacePath = workspace.Text.Trim();
                string publicOrigin = origin.Text.Trim().TrimEnd('/');
                if (!Directory.Exists(workspacePath)) { Error("工作目录必须是存在的文件夹。"); return; }
                if (!Int32.TryParse(port.Text.Trim(), out portValue) || portValue < 1 || portValue > 65535) { Error("端口必须介于 1 到 65535。"); return; }
                if (publicOrigin.Length > 0 && !Regex.IsMatch(publicOrigin, "^https://[^/]+$")) { Error("Tailscale HTTPS 地址必须是 https://域名 形式。"); return; }
                UpdateEnv(new Dictionary<string, string>
                {
                    { "WORKSPACE_ROOT", workspacePath }, { "PORT", portValue.ToString() }, { "PUBLIC_ORIGIN", publicOrigin },
                    { "CODEX_SANDBOX", Convert.ToString(sandbox.SelectedItem) }, { "COOKIE_SECURE", cookieSecure.Checked ? "1" : "0" },
                    { "TRUST_PROXY", trustProxy.Checked ? "1" : "0" }, { "ENABLE_DESKTOP_SESSION_HISTORY", desktopHistory.Checked ? "1" : "0" }
                });
                dialog.DialogResult = DialogResult.OK;
                dialog.Close();
            };
            dialog.Controls.Add(save);
            Button cancel = NewButton("取消", new Point(435, 295), new Size(80, 30), delegate { dialog.Close(); });
            dialog.Controls.Add(cancel);
            dialog.AcceptButton = save;
            dialog.CancelButton = cancel;
            if (dialog.ShowDialog(this) == DialogResult.OK)
            {
                Info("设置已保存。请停止后重新启动 PWA 以应用修改。");
                UpdateStatus();
            }
        }

        private static string ValueOr(Dictionary<string, string> values, string key, string fallback)
        {
            string value;
            return values.TryGetValue(key, out value) ? value : fallback;
        }

        private static TextBox AddField(Form dialog, string caption, string value, int top)
        {
            Label label = NewLabel(new Point(20, top + 4), new Size(150, 24));
            label.Text = caption;
            dialog.Controls.Add(label);
            TextBox input = new TextBox();
            input.Text = value;
            input.Location = new Point(175, top);
            input.Size = new Size(340, 24);
            dialog.Controls.Add(input);
            return input;
        }

        private static CheckBox AddCheckBox(Form dialog, string text, int left, int top, bool value)
        {
            CheckBox checkBox = new CheckBox();
            checkBox.Text = text;
            checkBox.Checked = value;
            checkBox.Location = new Point(left, top);
            checkBox.Size = new Size(180, 24);
            dialog.Controls.Add(checkBox);
            return checkBox;
        }

        private void UpdateEnv(Dictionary<string, string> updates)
        {
            List<string> lines = File.Exists(envFile) ? new List<string>(File.ReadAllLines(envFile)) : new List<string>();
            HashSet<string> written = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (int index = 0; index < lines.Count; index++)
            {
                Match match = Regex.Match(lines[index], "^\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*=");
                if (!match.Success || !updates.ContainsKey(match.Groups[1].Value)) continue;
                string key = match.Groups[1].Value;
                lines[index] = key + "=" + updates[key];
                written.Add(key);
            }
            foreach (KeyValuePair<string, string> update in updates)
            {
                if (!written.Contains(update.Key)) lines.Add(update.Key + "=" + update.Value);
            }
            File.WriteAllLines(envFile, lines.ToArray(), new UTF8Encoding(false));
        }

        private static void Info(string message)
        {
            MessageBox.Show(message, "Codex Remote", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        private static void Error(string message)
        {
            MessageBox.Show(message, "Codex Remote", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
