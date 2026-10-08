<#
  DSH × Obsidian 知识桥：开机自启管理

  用法：
    powershell -ExecutionPolicy Bypass -File autostart.ps1 -Action status     查看状态
    powershell -ExecutionPolicy Bypass -File autostart.ps1 -Action install    安装登录自启
    powershell -ExecutionPolicy Bypass -File autostart.ps1 -Action restart    立即重启服务
    powershell -ExecutionPolicy Bypass -File autostart.ps1 -Action uninstall  卸载（完全回退）

  知识库根目录（脚本内不再写死任何本机路径）：
    - 优先读环境变量 DSH_OBSIDIAN_VAULT；
    - 其次读参数 -Vault <路径>；
    - 两者都没有 → 直接报错并打印用法（不静默使用内置默认值）。
    工作台约定：<知识库根>\.dsh\workbench\（server.mjs 与 start-hidden.vbs 都放在这里）。

  设计说明：
    - 采用「任务计划程序 + VBS 隐藏启动器」，登录时**不弹黑框**；
    - 只作用于当前用户、非提权（RunLevel Limited），随时可 uninstall 完全回退；
    - 服务自身在端口被占用时会优雅退出，避免重复实例互相抢端口；
    - VBS 启动器由本脚本生成（单一真源，避免与仓库里的副本漂移），写成 UTF-16 以正确解析中文路径。
#>
param(
  [ValidateSet('status', 'install', 'uninstall', 'restart')][string]$Action = 'status',
  [string]$Vault = '',
  [string]$Node = ''
)

$ErrorActionPreference = 'Stop'
$TaskName = 'DSH-Obsidian-KnowledgeBridge'

# ---- 知识库根目录：环境变量 DSH_OBSIDIAN_VAULT > -Vault 参数 > 报错 ----
$VaultSource = ''
if ($env:DSH_OBSIDIAN_VAULT) {
  $VaultSource = '环境变量 DSH_OBSIDIAN_VAULT'
  $Vault = $env:DSH_OBSIDIAN_VAULT
} elseif ($Vault) {
  $VaultSource = '-Vault 参数'
}
if (-not $Vault) {
  throw @'
未指定知识库根目录，无法继续（本脚本不再内置任何写死的默认路径）。

用法（二选一）：
  1) 环境变量：
       $env:DSH_OBSIDIAN_VAULT = '<你的知识库目录>'
       powershell -ExecutionPolicy Bypass -File autostart.ps1 -Action status
  2) 显式参数：
       powershell -ExecutionPolicy Bypass -File autostart.ps1 -Action install -Vault '<你的知识库目录>'

脚本会使用 <知识库根目录>\.dsh\workbench\server.mjs 及同目录下生成的 start-hidden.vbs。
'@
}
$Vault = $Vault.Trim()
if ($Vault -match '^[A-Za-z]:[\\/]*$') {
  $Vault = $Vault.Substring(0, 2) + '\'
} else {
  $Vault = $Vault.TrimEnd('\', '/')
}

# ---- Node 可执行文件：-Node > DSH_OBSIDIAN_NODE > 本机默认（缺失时回退 PATH 里的 node）----
if (-not $Node) { $Node = $env:DSH_OBSIDIAN_NODE }
if (-not $Node -or -not (Test-Path $Node)) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) { $Node = $nodeCmd.Source }
}

$VaultWorkbench = Join-Path $Vault '.dsh\workbench'
$ServiceScript = Join-Path $VaultWorkbench 'server.mjs'
$VbsPath = Join-Path $VaultWorkbench 'start-hidden.vbs'
$Port = 8777
$UserId = "$env:USERDOMAIN\$env:USERNAME"

function Show-Paths {
  Write-Host "知识库来源: $VaultSource"
  Write-Host "知识库根  : $Vault"
  Write-Host "工作台目录: $VaultWorkbench"
  Write-Host "服务脚本  : $ServiceScript   存在=$([bool](Test-Path $ServiceScript))"
  Write-Host "隐藏启动器: $VbsPath   存在=$([bool](Test-Path $VbsPath))"
  Write-Host "Node      : $Node   存在=$([bool](Test-Path $Node))"
}

function Show-Status {
  Write-Host "任务名 : $TaskName"
  Show-Paths
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $t) {
    Write-Host "状态   : 未安装" -ForegroundColor Yellow
  } else {
    $i = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "状态   : $($t.State)" -ForegroundColor Green
    Write-Host "上次运行: $($i.LastRunTime)  结果=$($i.LastTaskResult)"
    Write-Host "下次运行: $($i.NextRunTime)"
  }
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($conn) {
    $pid2 = $conn | Select-Object -First 1 -ExpandProperty OwningProcess
    $p = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
    Write-Host "服务   : 端口 $Port 监听中（pid=$pid2 $($p.ProcessName)）" -ForegroundColor Green
  } else {
    Write-Host "服务   : 端口 $Port 未监听" -ForegroundColor Red
  }
}

function Write-Launcher {
  if (-not (Test-Path $VaultWorkbench)) { throw "找不到工作台目录：$VaultWorkbench" }
  $vbs = @"
' DSH x Obsidian knowledge bridge - hidden launcher
' 由 tools/autostart.ps1 生成，请勿手改；改启动参数请改 autostart.ps1
Option Explicit
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$VaultWorkbench"
sh.Run """$Node"" ""$ServiceScript""", 0, False
"@
  # 写 UTF-16 LE（带 BOM）：wscript 才能正确解析含中文的路径
  [System.IO.File]::WriteAllText($VbsPath, $vbs, [System.Text.Encoding]::Unicode)
  Write-Host "已生成隐藏启动器：$VbsPath"
}

function Stop-Bridge {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue; Write-Host "已停止旧实例 pid=$_" }
  Start-Sleep -Milliseconds 600
}

switch ($Action) {
  'status' { Show-Status }

  'install' {
    Write-Launcher
    # 注意：局部变量不要叫 $action，会与脚本参数 -Action 冲突（PowerShell 变量大小写不敏感）
    $taskAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$VbsPath`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
    $settings = New-ScheduledTaskSettingsSet `
      -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
      -ExecutionTimeLimit ([TimeSpan]::Zero) `
      -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
      -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger `
      -Settings $settings -Principal $principal -Force `
      -Description 'DSH × Obsidian 知识桥服务（127.0.0.1:8777），登录时隐藏启动。卸载：autostart.ps1 -Action uninstall' | Out-Null
    Write-Host "已注册登录自启任务：$TaskName" -ForegroundColor Green

    Write-Host '--- 立即验证：停掉现有实例，改由任务拉起 ---'
    Stop-Bridge
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 4
    try {
      $ping = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/ping" -TimeoutSec 8
      Write-Host "验证通过：任务启动的服务响应正常 vault=$($ping.vault)" -ForegroundColor Green
    } catch {
      Write-Host "验证失败：任务已注册但服务未响应 —— $($_.Exception.Message)" -ForegroundColor Red
    }
    Show-Status
  }

  'restart' {
    Stop-Bridge
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
      Start-ScheduledTask -TaskName $TaskName
      Start-Sleep -Seconds 3
    } else {
      Write-Host '任务未安装，改为直接启动' -ForegroundColor Yellow
      Start-Process -FilePath $Node -ArgumentList "`"$ServiceScript`"" -WindowStyle Hidden
      Start-Sleep -Seconds 3
    }
    Show-Status
  }

  'uninstall' {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
      Write-Host "已卸载自启任务：$TaskName" -ForegroundColor Green
    } else {
      Write-Host '任务本就不存在' -ForegroundColor Yellow
    }
    if (Test-Path $VbsPath) { Remove-Item $VbsPath -Force; Write-Host "已删除启动器：$VbsPath" }
    Write-Host '（服务进程未被结束；如需停止：autostart.ps1 -Action status 查看 pid 后手动结束）'
  }
}
