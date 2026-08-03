$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$scriptRoot = Split-Path -Parent $PSCommandPath
$projectRoot = Split-Path -Parent $scriptRoot
$dataRoot = Join-Path $projectRoot 'data'
$envFile = Join-Path $projectRoot '.env'
$pidFile = Join-Path $dataRoot 'codex-remote-server.json'
$stdoutLog = Join-Path $dataRoot 'codex-remote-server.log'
$stderrLog = Join-Path $dataRoot 'codex-remote-server-error.log'
$tailscaleScript = Join-Path $scriptRoot 'manage-tailscale.ps1'
$helpFile = Join-Path $projectRoot '教程.md'

New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null

function Show-Info([string]$Message, [string]$Title = 'Codex Remote') {
  [System.Windows.Forms.MessageBox]::Show($Message, $Title, [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
}

function Show-Error([string]$Message) {
  [System.Windows.Forms.MessageBox]::Show($Message, 'Codex Remote', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
}

function Read-EnvValues {
  $values = @{}
  if (-not (Test-Path -LiteralPath $envFile)) { return $values }
  foreach ($line in [IO.File]::ReadAllLines($envFile)) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $separator = $line.IndexOf('=')
    if ($separator -lt 1) { continue }
    $key = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1).Trim()
    if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $values[$key] = $value
  }
  return $values
}

function Get-EnvValue([string]$Key, [string]$Fallback = '') {
  $values = Read-EnvValues
  if ($values.ContainsKey($Key) -and $values[$Key]) { return [string]$values[$Key] }
  return $Fallback
}

function Get-ServerPort {
  $parsed = 0
  if ([int]::TryParse((Get-EnvValue 'PORT' '8787'), [ref]$parsed) -and $parsed -ge 1 -and $parsed -le 65535) { return $parsed }
  return 8787
}

function Get-NodePath {
  $preferred = 'D:\Program Files\nodejs\node.exe'
  if (Test-Path -LiteralPath $preferred) { return $preferred }
  return (Get-Command node -ErrorAction Stop).Source
}

function Test-PwaServer {
  try {
    $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$(Get-ServerPort)/api/me"
    return $true
  } catch {
    return $false
  }
}

function Get-ManagedPwaProcess {
  if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
  try {
    $metadata = Get-Content -Raw -LiteralPath $pidFile | ConvertFrom-Json
    $process = Get-Process -Id ([int]$metadata.processId) -ErrorAction Stop
    $startedAt = [datetime]::Parse($metadata.startedAt).ToUniversalTime()
    if ([math]::Abs(($process.StartTime.ToUniversalTime() - $startedAt).TotalSeconds) -gt 5) { return $null }
    return $process
  } catch {
    return $null
  }
}

function Get-ProjectPwaProcess {
  $connection = Get-NetTCPConnection -LocalPort (Get-ServerPort) -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $connection) { return $null }
  try {
    $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction Stop
    if ($process.CommandLine -like "*$projectRoot*" -and $process.CommandLine -match 'server\.mjs') {
      return Get-Process -Id $connection.OwningProcess -ErrorAction Stop
    }
  } catch {}
  return $null
}

function Remove-PwaPidFile {
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

function Start-PwaServer {
  if (Test-PwaServer) {
    Show-Info 'Codex Remote PWA 已在运行。'
    Update-Status
    return
  }
  try {
    $nodePath = Get-NodePath
    $process = Start-Process -FilePath $nodePath -ArgumentList (Join-Path $projectRoot 'server.mjs') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
    @{ processId = $process.Id; startedAt = $process.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8
    Start-Sleep -Milliseconds 800
    if (-not (Test-PwaServer)) {
      Show-Error "服务未成功启动。请打开日志检查：$stderrLog"
    }
  } catch {
    Show-Error "无法启动 Codex Remote PWA：$($_.Exception.Message)"
  }
  Update-Status
}

function Stop-PwaServer {
  $process = Get-ManagedPwaProcess
  if (-not $process) { $process = Get-ProjectPwaProcess }
  if (-not $process) {
    if (Test-PwaServer) {
      Show-Info '服务正在运行，但不是由该客户端或可识别的项目进程启动。请关闭原始启动窗口。'
    } else {
      Show-Info 'Codex Remote PWA 未运行。'
    }
    Update-Status
    return
  }
  try {
    Stop-Process -Id $process.Id -Force -ErrorAction Stop
    Remove-PwaPidFile
  } catch {
    Show-Error "无法停止 Codex Remote PWA：$($_.Exception.Message)"
  }
  Start-Sleep -Milliseconds 300
  Update-Status
}

function Get-TailscaleService {
  return Get-Service -Name Tailscale -ErrorAction SilentlyContinue
}

function Invoke-TailscaleAction([ValidateSet('Start', 'Stop')][string]$Action) {
  if ($Action -eq 'Stop') {
    $choice = [System.Windows.Forms.MessageBox]::Show('停止 Tailscale 会断开 iPhone 对 PWA 的私网访问。继续吗？', 'Codex Remote', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning)
    if ($choice -ne [System.Windows.Forms.DialogResult]::Yes) { return }
  }
  try {
    $process = Start-Process -FilePath 'powershell.exe' -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$tailscaleScript`" -Action $Action" -Verb RunAs -Wait -PassThru
    if ($process.ExitCode -ne 0) { Show-Error 'Tailscale 服务操作未完成。请在 Windows 管理员确认窗口中检查结果。' }
  } catch {
    Show-Error "无法管理 Tailscale：$($_.Exception.Message)"
  }
  Start-Sleep -Milliseconds 500
  Update-Status
}

function Write-EnvValues([hashtable]$Updates) {
  $lines = New-Object 'System.Collections.Generic.List[string]'
  if (Test-Path -LiteralPath $envFile) { $lines.AddRange([string[]][IO.File]::ReadAllLines($envFile)) }
  $written = New-Object 'System.Collections.Generic.HashSet[string]'
  for ($index = 0; $index -lt $lines.Count; $index += 1) {
    $match = [regex]::Match($lines[$index], '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=')
    if (-not $match.Success) { continue }
    $key = $match.Groups[1].Value
    if (-not $Updates.ContainsKey($key)) { continue }
    $lines[$index] = "$key=$($Updates[$key])"
    [void]$written.Add($key)
  }
  foreach ($key in $Updates.Keys) {
    if (-not $written.Contains($key)) { $lines.Add("$key=$($Updates[$key])") }
  }
  [IO.File]::WriteAllLines($envFile, $lines, (New-Object Text.UTF8Encoding($false)))
}

function Show-SettingsDialog {
  $values = Read-EnvValues
  $dialog = New-Object System.Windows.Forms.Form
  $dialog.Text = 'Codex Remote 设置'
  $dialog.StartPosition = 'CenterParent'
  $dialog.ClientSize = New-Object System.Drawing.Size(540, 345)
  $dialog.FormBorderStyle = 'FixedDialog'
  $dialog.MaximizeBox = $false
  $dialog.MinimizeBox = $false
  $dialog.Font = New-Object System.Drawing.Font('Segoe UI', 9)

  function Add-Field([string]$Label, [string]$Value, [int]$Top) {
    $caption = New-Object System.Windows.Forms.Label
    $caption.Text = $Label
    $caption.Location = New-Object System.Drawing.Point(20, $Top + 4)
    $caption.Size = New-Object System.Drawing.Size(150, 24)
    $dialog.Controls.Add($caption)
    $input = New-Object System.Windows.Forms.TextBox
    $input.Text = $Value
    $input.Location = New-Object System.Drawing.Point(175, $Top)
    $input.Size = New-Object System.Drawing.Size(340, 24)
    $dialog.Controls.Add($input)
    return $input
  }

  $workspace = Add-Field '工作目录' ($values['WORKSPACE_ROOT']) 20
  $port = Add-Field '本地端口' ($(if ($values['PORT']) { $values['PORT'] } else { '8787' })) 58
  $origin = Add-Field 'Tailscale HTTPS 地址' ($values['PUBLIC_ORIGIN']) 96
  $sandboxLabel = New-Object System.Windows.Forms.Label
  $sandboxLabel.Text = 'Codex 权限'
  $sandboxLabel.Location = New-Object System.Drawing.Point(20, 138)
  $sandboxLabel.Size = New-Object System.Drawing.Size(150, 24)
  $dialog.Controls.Add($sandboxLabel)
  $sandbox = New-Object System.Windows.Forms.ComboBox
  [void]$sandbox.Items.AddRange(@('workspace-write', 'read-only'))
  $sandbox.DropDownStyle = 'DropDownList'
  $sandbox.SelectedItem = $(if ($values['CODEX_SANDBOX'] -eq 'read-only') { 'read-only' } else { 'workspace-write' })
  $sandbox.Location = New-Object System.Drawing.Point(175, 134)
  $sandbox.Size = New-Object System.Drawing.Size(180, 24)
  $dialog.Controls.Add($sandbox)
  $secureCookie = New-Object System.Windows.Forms.CheckBox
  $secureCookie.Text = 'HTTPS Cookie'
  $secureCookie.Checked = $values['COOKIE_SECURE'] -eq '1'
  $secureCookie.Location = New-Object System.Drawing.Point(175, 174)
  $secureCookie.Size = New-Object System.Drawing.Size(130, 24)
  $dialog.Controls.Add($secureCookie)
  $trustProxy = New-Object System.Windows.Forms.CheckBox
  $trustProxy.Text = '信任 Tailscale 代理'
  $trustProxy.Checked = $values['TRUST_PROXY'] -eq '1'
  $trustProxy.Location = New-Object System.Drawing.Point(315, 174)
  $trustProxy.Size = New-Object System.Drawing.Size(170, 24)
  $dialog.Controls.Add($trustProxy)
  $desktopHistory = New-Object System.Windows.Forms.CheckBox
  $desktopHistory.Text = '显示本机 Codex 历史'
  $desktopHistory.Checked = $values['ENABLE_DESKTOP_SESSION_HISTORY'] -ne '0'
  $desktopHistory.Location = New-Object System.Drawing.Point(175, 204)
  $desktopHistory.Size = New-Object System.Drawing.Size(190, 24)
  $dialog.Controls.Add($desktopHistory)
  $hint = New-Object System.Windows.Forms.Label
  $hint.Text = '访问密码和 API Key 不会在此窗口显示或修改。保存后需重启 PWA。'
  $hint.Location = New-Object System.Drawing.Point(20, 250)
  $hint.Size = New-Object System.Drawing.Size(495, 28)
  $hint.ForeColor = [System.Drawing.Color]::DimGray
  $dialog.Controls.Add($hint)
  $save = New-Object System.Windows.Forms.Button
  $save.Text = '保存'
  $save.Location = New-Object System.Drawing.Point(350, 295)
  $save.Size = New-Object System.Drawing.Size(80, 30)
  $save.Add_Click({
    $workspacePath = $workspace.Text.Trim()
    $portValue = 0
    if (-not (Test-Path -LiteralPath $workspacePath -PathType Container)) { Show-Error '工作目录必须是存在的文件夹。'; return }
    if (-not [int]::TryParse($port.Text.Trim(), [ref]$portValue) -or $portValue -lt 1 -or $portValue -gt 65535) { Show-Error '端口必须介于 1 到 65535。'; return }
    $publicOrigin = $origin.Text.Trim()
    if ($publicOrigin -and -not ($publicOrigin -match '^https://[^/]+/?$')) { Show-Error 'Tailscale HTTPS 地址必须是 https://域名 形式。'; return }
    Write-EnvValues @{
      WORKSPACE_ROOT = $workspacePath
      PORT = "$portValue"
      PUBLIC_ORIGIN = $publicOrigin.TrimEnd('/')
      CODEX_SANDBOX = [string]$sandbox.SelectedItem
      COOKIE_SECURE = $(if ($secureCookie.Checked) { '1' } else { '0' })
      TRUST_PROXY = $(if ($trustProxy.Checked) { '1' } else { '0' })
      ENABLE_DESKTOP_SESSION_HISTORY = $(if ($desktopHistory.Checked) { '1' } else { '0' })
    }
    $dialog.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $dialog.Close()
  })
  $dialog.Controls.Add($save)
  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = '取消'
  $cancel.Location = New-Object System.Drawing.Point(435, 295)
  $cancel.Size = New-Object System.Drawing.Size(80, 30)
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $dialog.Controls.Add($cancel)
  $dialog.AcceptButton = $save
  $dialog.CancelButton = $cancel
  if ($dialog.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) {
    Show-Info '设置已保存。请停止后重新启动 PWA 以应用修改。'
    Update-Status
  }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Codex Remote 控制台'
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object System.Drawing.Size(690, 385)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)

$pwaBox = New-Object System.Windows.Forms.GroupBox
$pwaBox.Text = 'Codex Remote PWA'
$pwaBox.Location = New-Object System.Drawing.Point(18, 18)
$pwaBox.Size = New-Object System.Drawing.Size(654, 132)
$form.Controls.Add($pwaBox)
$pwaStatus = New-Object System.Windows.Forms.Label
$pwaStatus.Location = New-Object System.Drawing.Point(18, 30)
$pwaStatus.Size = New-Object System.Drawing.Size(610, 24)
$pwaBox.Controls.Add($pwaStatus)
$pwaAddress = New-Object System.Windows.Forms.Label
$pwaAddress.Location = New-Object System.Drawing.Point(18, 56)
$pwaAddress.Size = New-Object System.Drawing.Size(610, 22)
$pwaAddress.ForeColor = [System.Drawing.Color]::DimGray
$pwaBox.Controls.Add($pwaAddress)
$startPwa = New-Object System.Windows.Forms.Button
$startPwa.Text = '启动服务'
$startPwa.Location = New-Object System.Drawing.Point(18, 90)
$startPwa.Size = New-Object System.Drawing.Size(90, 28)
$startPwa.Add_Click({ Start-PwaServer })
$pwaBox.Controls.Add($startPwa)
$stopPwa = New-Object System.Windows.Forms.Button
$stopPwa.Text = '停止服务'
$stopPwa.Location = New-Object System.Drawing.Point(116, 90)
$stopPwa.Size = New-Object System.Drawing.Size(90, 28)
$stopPwa.Add_Click({ Stop-PwaServer })
$pwaBox.Controls.Add($stopPwa)
$openPwa = New-Object System.Windows.Forms.Button
$openPwa.Text = '打开本机页面'
$openPwa.Location = New-Object System.Drawing.Point(214, 90)
$openPwa.Size = New-Object System.Drawing.Size(110, 28)
$openPwa.Add_Click({ Start-Process "http://127.0.0.1:$(Get-ServerPort)" })
$pwaBox.Controls.Add($openPwa)
$openLog = New-Object System.Windows.Forms.Button
$openLog.Text = '查看日志'
$openLog.Location = New-Object System.Drawing.Point(332, 90)
$openLog.Size = New-Object System.Drawing.Size(90, 28)
$openLog.Add_Click({ if (Test-Path -LiteralPath $stdoutLog) { Start-Process notepad.exe -ArgumentList $stdoutLog } else { Show-Info '尚未生成服务日志。' } })
$pwaBox.Controls.Add($openLog)

$tailBox = New-Object System.Windows.Forms.GroupBox
$tailBox.Text = 'Tailscale'
$tailBox.Location = New-Object System.Drawing.Point(18, 162)
$tailBox.Size = New-Object System.Drawing.Size(654, 105)
$form.Controls.Add($tailBox)
$tailStatus = New-Object System.Windows.Forms.Label
$tailStatus.Location = New-Object System.Drawing.Point(18, 29)
$tailStatus.Size = New-Object System.Drawing.Size(610, 24)
$tailBox.Controls.Add($tailStatus)
$startTail = New-Object System.Windows.Forms.Button
$startTail.Text = '启动 Tailscale'
$startTail.Location = New-Object System.Drawing.Point(18, 65)
$startTail.Size = New-Object System.Drawing.Size(110, 28)
$startTail.Add_Click({ Invoke-TailscaleAction 'Start' })
$tailBox.Controls.Add($startTail)
$stopTail = New-Object System.Windows.Forms.Button
$stopTail.Text = '停止 Tailscale'
$stopTail.Location = New-Object System.Drawing.Point(136, 65)
$stopTail.Size = New-Object System.Drawing.Size(110, 28)
$stopTail.Add_Click({ Invoke-TailscaleAction 'Stop' })
$tailBox.Controls.Add($stopTail)

$settings = New-Object System.Windows.Forms.Button
$settings.Text = '设置'
$settings.Location = New-Object System.Drawing.Point(18, 312)
$settings.Size = New-Object System.Drawing.Size(82, 30)
$settings.Add_Click({ Show-SettingsDialog })
$form.Controls.Add($settings)
$help = New-Object System.Windows.Forms.Button
$help.Text = '帮助文档'
$help.Location = New-Object System.Drawing.Point(108, 312)
$help.Size = New-Object System.Drawing.Size(92, 30)
$help.Add_Click({ Start-Process $helpFile })
$form.Controls.Add($help)
$refresh = New-Object System.Windows.Forms.Button
$refresh.Text = '刷新状态'
$refresh.Location = New-Object System.Drawing.Point(500, 312)
$refresh.Size = New-Object System.Drawing.Size(82, 30)
$refresh.Add_Click({ Update-Status })
$form.Controls.Add($refresh)
$close = New-Object System.Windows.Forms.Button
$close.Text = '关闭'
$close.Location = New-Object System.Drawing.Point(590, 312)
$close.Size = New-Object System.Drawing.Size(82, 30)
$close.Add_Click({ $form.Close() })
$form.Controls.Add($close)

function Update-Status {
  $port = Get-ServerPort
  $running = Test-PwaServer
  $managed = Get-ManagedPwaProcess
  if ($running) {
    $pwaStatus.Text = $(if ($managed) { "运行中，客户端管理的进程 PID $($managed.Id)" } else { '运行中' })
    $pwaStatus.ForeColor = [System.Drawing.Color]::ForestGreen
  } else {
    $pwaStatus.Text = '已停止'
    $pwaStatus.ForeColor = [System.Drawing.Color]::Firebrick
  }
  $pwaAddress.Text = "本机地址：http://127.0.0.1:$port"
  $tail = Get-TailscaleService
  if (-not $tail) {
    $tailStatus.Text = '未检测到 Tailscale 服务'
    $tailStatus.ForeColor = [System.Drawing.Color]::Firebrick
  } elseif ($tail.Status -eq 'Running') {
    $tailStatus.Text = '服务正在运行'
    $tailStatus.ForeColor = [System.Drawing.Color]::ForestGreen
  } else {
    $tailStatus.Text = "服务状态：$($tail.Status)"
    $tailStatus.ForeColor = [System.Drawing.Color]::Firebrick
  }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2500
$timer.Add_Tick({ Update-Status })
$form.Add_Shown({ Update-Status; $timer.Start(); $form.Activate() })
$form.Add_FormClosed({ $timer.Stop() })
[void]$form.ShowDialog()
