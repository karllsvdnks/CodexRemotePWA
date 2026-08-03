using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Security.Cryptography;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace CodexRemoteSetup
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm());
        }
    }

    internal sealed class SetupForm : Form
    {
        private const string PasswordPlaceholder = "replace-with-a-long-random-password";
        private readonly string projectRoot;
        private readonly string envFile;
        private readonly string tailscaleInstaller;
        private readonly bool passwordNeedsReplacement;
        private TextBox passwordInput;
        private TextBox workspaceInput;
        private TextBox codexHomeInput;
        private TextBox apiKeyInput;
        private TextBox codexCommandInput;
        private TextBox portInput;
        private TextBox publicOriginInput;
        private CheckBox showPassword;
        private CheckBox clearApiKey;
        private CheckBox initializeApiLogin;
        private CheckBox useTailscale;
        private CheckBox configureTailscaleServe;
        private CheckBox desktopHistory;
        private CheckBox launchConsole;
        private ComboBox sandbox;
        private Label tailscaleStatus;
        private TextBox diagnostics;

        public SetupForm()
        {
            projectRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            envFile = Path.Combine(projectRoot, ".env");
            tailscaleInstaller = Path.Combine(projectRoot, "installers", "tailscale-setup-1.98.10.exe");
            Dictionary<string, string> values = ReadEnv();
            string currentPassword = ValueOr(values, "REMOTE_PASSWORD", "");
            passwordNeedsReplacement = String.IsNullOrWhiteSpace(currentPassword) || currentPassword == PasswordPlaceholder;

            Text = "Codex Remote 配置向导";
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(760, 575);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            Font = new Font("Segoe UI", 9F);

            Label title = new Label();
            title.Text = "首次配置";
            title.Font = new Font("Segoe UI", 12F, FontStyle.Bold);
            title.Location = new Point(18, 12);
            title.Size = new Size(170, 28);
            Controls.Add(title);
            Label subtitle = new Label();
            subtitle.Text = "完成本机服务、Codex 身份和可选 Tailscale HTTPS 设置。密钥不会显示在此界面。";
            subtitle.ForeColor = Color.DimGray;
            subtitle.Location = new Point(18, 40);
            subtitle.Size = new Size(710, 24);
            Controls.Add(subtitle);

            TabControl tabs = new TabControl();
            tabs.Location = new Point(18, 70);
            tabs.Size = new Size(724, 430);
            TabPage localTab = new TabPage("1. 本机服务");
            TabPage networkTab = new TabPage("2. 私网访问");
            TabPage reviewTab = new TabPage("3. 检查并应用");
            tabs.TabPages.Add(localTab);
            tabs.TabPages.Add(networkTab);
            tabs.TabPages.Add(reviewTab);
            Controls.Add(tabs);

            BuildLocalTab(localTab, values);
            BuildNetworkTab(networkTab, values);
            BuildReviewTab(reviewTab, values);

            Button apply = NewButton("应用配置", new Point(550, 520), new Size(92, 32), delegate { ApplyConfiguration(); });
            Controls.Add(apply);
            Button close = NewButton("关闭", new Point(650, 520), new Size(92, 32), delegate { Close(); });
            Controls.Add(close);
            AcceptButton = apply;
            CancelButton = close;
            Shown += delegate { RefreshDiagnostics(); };
        }

        private void BuildLocalTab(TabPage page, Dictionary<string, string> values)
        {
            AddLabel(page, "访问密码", 18, 25, 165);
            passwordInput = NewTextBox(188, 21, 385);
            passwordInput.UseSystemPasswordChar = true;
            passwordInput.Text = passwordNeedsReplacement ? GeneratePassword() : "";
            page.Controls.Add(passwordInput);
            Button generate = NewButton("生成", new Point(582, 20), new Size(58, 27), delegate { passwordInput.Text = GeneratePassword(); });
            page.Controls.Add(generate);
            showPassword = new CheckBox();
            showPassword.Text = "显示";
            showPassword.Location = new Point(646, 22);
            showPassword.Size = new Size(58, 24);
            showPassword.CheckedChanged += delegate { passwordInput.UseSystemPasswordChar = !showPassword.Checked; };
            page.Controls.Add(showPassword);
            AddHint(page, passwordNeedsReplacement ? "发行包的默认密码无效，已生成新的随机密码。" : "若不填写新密码，将保留现有访问密码。", 188, 50, 500);

            AddLabel(page, "工作目录", 18, 88, 165);
            workspaceInput = NewTextBox(188, 84, 385);
            workspaceInput.Text = ValueOr(values, "WORKSPACE_ROOT", projectRoot);
            page.Controls.Add(workspaceInput);
            page.Controls.Add(NewButton("选择...", new Point(582, 83), new Size(72, 27), delegate { SelectFolder(workspaceInput); }));
            AddHint(page, "手机端和 Codex 只能访问这个目录。", 188, 113, 500);

            AddLabel(page, "独立 Codex 状态目录", 18, 151, 165);
            codexHomeInput = NewTextBox(188, 147, 385);
            codexHomeInput.Text = ValueOr(values, "CODEX_HOME", Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexRemotePWA", "codex-home"));
            page.Controls.Add(codexHomeInput);
            page.Controls.Add(NewButton("选择...", new Point(582, 146), new Size(72, 27), delegate { SelectFolder(codexHomeInput); }));
            AddHint(page, "此目录与 Codex Desktop 登录和会话隔离。", 188, 176, 500);

            AddLabel(page, "API Key（可选）", 18, 214, 165);
            apiKeyInput = NewTextBox(188, 210, 466);
            apiKeyInput.UseSystemPasswordChar = true;
            page.Controls.Add(apiKeyInput);
            clearApiKey = new CheckBox();
            clearApiKey.Text = "清除已有 Key";
            clearApiKey.Location = new Point(188, 240);
            clearApiKey.Size = new Size(130, 24);
            clearApiKey.CheckedChanged += delegate { apiKeyInput.Enabled = !clearApiKey.Checked; initializeApiLogin.Enabled = !clearApiKey.Checked; };
            page.Controls.Add(clearApiKey);
            initializeApiLogin = new CheckBox();
            initializeApiLogin.Text = "应用后初始化 Codex API 登录";
            initializeApiLogin.Location = new Point(330, 240);
            initializeApiLogin.Size = new Size(240, 24);
            page.Controls.Add(initializeApiLogin);

            AddLabel(page, "高级 Codex 命令", 18, 284, 165);
            codexCommandInput = NewTextBox(188, 280, 466);
            codexCommandInput.Text = ValueOr(values, "CODEX_COMMAND", "");
            page.Controls.Add(codexCommandInput);
            AddHint(page, "仅当系统无法找到 Codex CLI 时填写。", 188, 309, 500);
        }

        private void BuildNetworkTab(TabPage page, Dictionary<string, string> values)
        {
            useTailscale = new CheckBox();
            useTailscale.Text = "通过 Tailscale HTTPS 从 iPhone 私网访问";
            useTailscale.Location = new Point(18, 24);
            useTailscale.Size = new Size(350, 26);
            useTailscale.Checked = !String.IsNullOrWhiteSpace(ValueOr(values, "PUBLIC_ORIGIN", ""));
            useTailscale.CheckedChanged += delegate { UpdateNetworkControls(); };
            page.Controls.Add(useTailscale);

            AddLabel(page, "HTTPS 地址", 18, 72, 165);
            publicOriginInput = NewTextBox(188, 68, 466);
            publicOriginInput.Text = ValueOr(values, "PUBLIC_ORIGIN", "");
            page.Controls.Add(publicOriginInput);
            AddHint(page, "填写 tailscale serve status 显示的 HTTPS 地址，不含路径。", 188, 97, 500);

            configureTailscaleServe = new CheckBox();
            configureTailscaleServe.Text = "应用配置时运行 tailscale serve --bg <端口>";
            configureTailscaleServe.Location = new Point(188, 132);
            configureTailscaleServe.Size = new Size(360, 26);
            page.Controls.Add(configureTailscaleServe);
            AddHint(page, "此选项只配置本机 Tailscale HTTPS 代理，不会开放路由器端口或修改 Tailscale 自启动。", 188, 158, 500);

            Label installerLabel = AddLabel(page, "Tailscale 安装", 18, 208, 165);
            installerLabel.Text = "Tailscale 安装";
            page.Controls.Add(NewButton("运行附带安装程序", new Point(188, 204), new Size(140, 28), delegate { RunTailscaleInstaller(); }));
            AddHint(page, "安装和登录 tailnet 必须在 Tailscale 官方窗口中由你完成。", 340, 208, 330);

            tailscaleStatus = new Label();
            tailscaleStatus.Location = new Point(188, 260);
            tailscaleStatus.Size = new Size(490, 50);
            tailscaleStatus.ForeColor = Color.DimGray;
            page.Controls.Add(tailscaleStatus);

            Label note = new Label();
            note.Text = "保持服务只监听 127.0.0.1。不要把端口映射到路由器或改为公网监听。";
            note.Location = new Point(18, 348);
            note.Size = new Size(660, 32);
            note.ForeColor = Color.Firebrick;
            page.Controls.Add(note);
            UpdateNetworkControls();
        }

        private void BuildReviewTab(TabPage page, Dictionary<string, string> values)
        {
            AddLabel(page, "本地端口", 18, 25, 165);
            portInput = NewTextBox(188, 21, 120);
            portInput.Text = ValueOr(values, "PORT", "8787");
            page.Controls.Add(portInput);
            AddHint(page, "服务始终绑定到 127.0.0.1。", 320, 25, 320);

            AddLabel(page, "Codex 权限", 18, 70, 165);
            sandbox = new ComboBox();
            sandbox.DropDownStyle = ComboBoxStyle.DropDownList;
            sandbox.Items.AddRange(new object[] { "workspace-write", "read-only" });
            sandbox.SelectedItem = ValueOr(values, "CODEX_SANDBOX", "workspace-write") == "read-only" ? "read-only" : "workspace-write";
            sandbox.Location = new Point(188, 66);
            sandbox.Size = new Size(170, 26);
            page.Controls.Add(sandbox);
            AddHint(page, "仅提供安全沙箱选项。", 370, 70, 250);

            desktopHistory = new CheckBox();
            desktopHistory.Text = "显示本机 Codex 历史";
            desktopHistory.Checked = ValueOr(values, "ENABLE_DESKTOP_SESSION_HISTORY", "1") != "0";
            desktopHistory.Location = new Point(188, 112);
            desktopHistory.Size = new Size(190, 24);
            page.Controls.Add(desktopHistory);
            launchConsole = new CheckBox();
            launchConsole.Text = "完成后打开控制台";
            launchConsole.Checked = true;
            launchConsole.Location = new Point(390, 112);
            launchConsole.Size = new Size(180, 24);
            page.Controls.Add(launchConsole);

            Label diagnosticsLabel = AddLabel(page, "环境检查", 18, 158, 165);
            diagnosticsLabel.Text = "环境检查";
            diagnostics = new TextBox();
            diagnostics.Multiline = true;
            diagnostics.ReadOnly = true;
            diagnostics.ScrollBars = ScrollBars.Vertical;
            diagnostics.Location = new Point(188, 154);
            diagnostics.Size = new Size(490, 165);
            diagnostics.BackColor = Color.White;
            diagnostics.Font = new Font("Consolas", 9F);
            page.Controls.Add(diagnostics);
            page.Controls.Add(NewButton("重新检查", new Point(588, 328), new Size(90, 28), delegate { RefreshDiagnostics(); }));

            AddHint(page, "应用配置不会启动 PWA；请在控制台中显式点击“启动服务”。", 18, 370, 650);
        }

        private void UpdateNetworkControls()
        {
            bool enabled = useTailscale != null && useTailscale.Checked;
            if (publicOriginInput != null) publicOriginInput.Enabled = enabled;
            if (configureTailscaleServe != null) configureTailscaleServe.Enabled = enabled;
        }

        private void RefreshDiagnostics()
        {
            if (diagnostics == null) return;
            List<string> lines = new List<string>();
            lines.Add("项目目录: " + projectRoot);
            lines.Add("Node: " + (File.Exists(NodePath()) ? NodePath() : "将从 PATH 查找 node.exe"));
            lines.Add("Codex CLI: " + (String.IsNullOrWhiteSpace(codexCommandInput.Text) ? "将使用系统默认位置" : "使用自定义命令"));
            lines.Add("工作目录: " + (Directory.Exists(ResolveProjectPath(workspaceInput.Text.Trim())) ? "可用" : "需要选择已有目录"));
            lines.Add("Codex 状态目录: " + (Directory.Exists(ResolveProjectPath(codexHomeInput.Text.Trim())) ? "已存在" : "应用配置时创建"));
            string tailscale = ReadTailscaleStatus();
            lines.Add("Tailscale: " + tailscale);
            lines.Add("附带安装程序: " + (File.Exists(tailscaleInstaller) ? "可用" : "缺失"));
            diagnostics.Text = String.Join(Environment.NewLine, lines.ToArray());
            if (tailscaleStatus != null) tailscaleStatus.Text = "当前状态：" + tailscale;
        }

        private string ReadTailscaleStatus()
        {
            try
            {
                using (ServiceController service = new ServiceController("Tailscale"))
                {
                    return service.Status == ServiceControllerStatus.Running ? "服务正在运行" : "服务状态：" + service.Status;
                }
            }
            catch
            {
                return "未检测到服务";
            }
        }

        private void RunTailscaleInstaller()
        {
            if (!File.Exists(tailscaleInstaller))
            {
                Error("找不到附带的 Tailscale 安装程序。");
                return;
            }
            try
            {
                Process.Start(new ProcessStartInfo(tailscaleInstaller) { UseShellExecute = true });
            }
            catch (Exception exception)
            {
                Error("无法启动 Tailscale 安装程序：" + exception.Message);
            }
        }

        private void ApplyConfiguration()
        {
            string workspace;
            string codexHome;
            int port;
            try
            {
                workspace = ResolveProjectPath(workspaceInput.Text.Trim());
                codexHome = ResolveProjectPath(codexHomeInput.Text.Trim());
            }
            catch
            {
                Error("工作目录和 Codex 状态目录必须是有效路径。");
                return;
            }
            if (!Directory.Exists(workspace))
            {
                Error("工作目录必须是已存在的文件夹。");
                return;
            }
            if (!Int32.TryParse(portInput.Text.Trim(), out port) || port < 1 || port > 65535)
            {
                Error("端口必须介于 1 到 65535。\n");
                return;
            }
            string newPassword = passwordInput.Text.Trim();
            if (passwordNeedsReplacement && newPassword.Length == 0)
            {
                Error("请生成或输入新的访问密码。");
                return;
            }
            if (newPassword.Length > 0 && newPassword.Length < 20)
            {
                Error("访问密码至少需要 20 个字符。\n");
                return;
            }
            string publicOrigin = publicOriginInput.Text.Trim().TrimEnd('/');
            if (useTailscale.Checked && !Regex.IsMatch(publicOrigin, "^https://[^/]+$"))
            {
                Error("Tailscale HTTPS 地址必须是 https://域名 形式。\n");
                return;
            }
            if (initializeApiLogin.Checked && apiKeyInput.Text.Trim().Length == 0)
            {
                Error("初始化 API 登录时，请在此窗口输入 API Key。\n");
                return;
            }

            try
            {
                Directory.CreateDirectory(codexHome);
                Dictionary<string, string> updates = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                if (newPassword.Length > 0) updates.Add("REMOTE_PASSWORD", newPassword);
                updates.Add("WORKSPACE_ROOT", workspace);
                updates.Add("CODEX_HOME", codexHome);
                updates.Add("HOST", "127.0.0.1");
                updates.Add("PORT", port.ToString());
                updates.Add("CODEX_SANDBOX", Convert.ToString(sandbox.SelectedItem));
                updates.Add("ENABLE_DESKTOP_SESSION_HISTORY", desktopHistory.Checked ? "1" : "0");
                updates.Add("CODEX_COMMAND", codexCommandInput.Text.Trim());
                updates.Add("PUBLIC_ORIGIN", useTailscale.Checked ? publicOrigin : "");
                updates.Add("COOKIE_SECURE", useTailscale.Checked ? "1" : "0");
                updates.Add("TRUST_PROXY", useTailscale.Checked ? "1" : "0");
                if (!String.IsNullOrWhiteSpace(apiKeyInput.Text)) updates.Add("OPENAI_API_KEY", apiKeyInput.Text.Trim());
                HashSet<string> removals = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                if (clearApiKey.Checked) removals.Add("OPENAI_API_KEY");
                WriteEnv(updates, removals);
            }
            catch (Exception exception)
            {
                Error("无法保存配置：" + exception.Message);
                return;
            }

            bool serveConfigured = true;
            if (useTailscale.Checked && configureTailscaleServe.Checked) serveConfigured = ConfigureTailscaleServe(port);
            bool apiInitialized = true;
            if (initializeApiLogin.Checked) apiInitialized = InitializeApiLogin();
            if (!serveConfigured || !apiInitialized)
            {
                Error("配置已保存，但有一个可选步骤未完成。请检查 Tailscale 是否已登录，或确认 Node、Codex CLI 和 API Key 可用后重新运行向导。");
                return;
            }

            Info("配置已保存。请在控制台中显式启动 PWA 服务。");
            if (launchConsole.Checked) OpenConsole();
            Close();
        }

        private bool ConfigureTailscaleServe(int port)
        {
            try
            {
                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = TailscalePath();
                startInfo.Arguments = "serve --bg " + port;
                startInfo.WorkingDirectory = projectRoot;
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                using (Process process = Process.Start(startInfo))
                {
                    return process != null && process.WaitForExit(15000) && process.ExitCode == 0;
                }
            }
            catch
            {
                return false;
            }
        }

        private bool InitializeApiLogin()
        {
            try
            {
                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = NodePath();
                startInfo.Arguments = "\"" + Path.Combine(projectRoot, "scripts", "bootstrap-codex-api-auth.mjs") + "\"";
                startInfo.WorkingDirectory = projectRoot;
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                startInfo.RedirectStandardOutput = true;
                startInfo.RedirectStandardError = true;
                using (Process process = Process.Start(startInfo))
                {
                    if (process == null) return false;
                    process.StandardOutput.ReadToEnd();
                    process.StandardError.ReadToEnd();
                    return process.WaitForExit(60000) && process.ExitCode == 0;
                }
            }
            catch
            {
                return false;
            }
        }

        private void OpenConsole()
        {
            string console = Path.Combine(projectRoot, "CodexRemoteConsole.exe");
            if (!File.Exists(console)) return;
            try { Process.Start(new ProcessStartInfo(console) { UseShellExecute = true }); } catch { }
        }

        private string TailscalePath()
        {
            string installed = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Tailscale", "tailscale.exe");
            return File.Exists(installed) ? installed : "tailscale.exe";
        }

        private string NodePath()
        {
            string preferred = @"D:\Program Files\nodejs\node.exe";
            if (File.Exists(preferred)) return preferred;
            string programFiles = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
            return File.Exists(programFiles) ? programFiles : "node.exe";
        }

        private void SelectFolder(TextBox target)
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                string selectedPath = ResolveProjectPath(target.Text.Trim());
                dialog.SelectedPath = Directory.Exists(selectedPath) ? selectedPath : projectRoot;
                if (dialog.ShowDialog(this) == DialogResult.OK) target.Text = dialog.SelectedPath;
            }
        }

        private string ResolveProjectPath(string value)
        {
            if (String.IsNullOrWhiteSpace(value)) throw new ArgumentException("路径不能为空。");
            return Path.GetFullPath(Path.IsPathRooted(value) ? value : Path.Combine(projectRoot, value));
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
                values[line.Substring(0, separator).Trim()] = line.Substring(separator + 1).Trim().Trim('"', '\'');
            }
            return values;
        }

        private void WriteEnv(Dictionary<string, string> updates, HashSet<string> removals)
        {
            List<string> lines = File.Exists(envFile) ? new List<string>(File.ReadAllLines(envFile)) : new List<string>();
            HashSet<string> written = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (int index = lines.Count - 1; index >= 0; index--)
            {
                Match match = Regex.Match(lines[index], @"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=");
                if (!match.Success) continue;
                string key = match.Groups[1].Value;
                if (removals.Contains(key))
                {
                    lines.RemoveAt(index);
                    continue;
                }
                if (updates.ContainsKey(key))
                {
                    lines[index] = key + "=" + updates[key];
                    written.Add(key);
                }
            }
            foreach (KeyValuePair<string, string> update in updates)
            {
                if (!written.Contains(update.Key)) lines.Add(update.Key + "=" + update.Value);
            }
            File.WriteAllLines(envFile, lines.ToArray(), new UTF8Encoding(false));
        }

        private static string GeneratePassword()
        {
            byte[] bytes = new byte[24];
            using (RandomNumberGenerator random = RandomNumberGenerator.Create()) random.GetBytes(bytes);
            return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }

        private static string ValueOr(Dictionary<string, string> values, string key, string fallback)
        {
            string value;
            return values.TryGetValue(key, out value) && !String.IsNullOrWhiteSpace(value) ? value : fallback;
        }

        private static Label AddLabel(Control parent, string text, int left, int top, int width)
        {
            Label label = new Label();
            label.Text = text;
            label.Location = new Point(left, top + 4);
            label.Size = new Size(width, 24);
            parent.Controls.Add(label);
            return label;
        }

        private static TextBox NewTextBox(int left, int top, int width)
        {
            TextBox input = new TextBox();
            input.Location = new Point(left, top);
            input.Size = new Size(width, 24);
            return input;
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

        private static void AddHint(Control parent, string text, int left, int top, int width)
        {
            Label hint = new Label();
            hint.Text = text;
            hint.ForeColor = Color.DimGray;
            hint.Location = new Point(left, top);
            hint.Size = new Size(width, 24);
            parent.Controls.Add(hint);
        }

        private static void Info(string message)
        {
            MessageBox.Show(message, "Codex Remote 配置向导", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        private static void Error(string message)
        {
            MessageBox.Show(message, "Codex Remote 配置向导", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
