<#
.SYNOPSIS
  把发布树推送到 GitHub：建仓库 → push main → 打 v<版本> tag → 建 Release。

.DESCRIPTION
  凭据只从**文件**读取（默认 %USERPROFILE%\.dsh\gh-token.txt），只读第一行，绝不回显、
  绝不写进 .git/config 或任何仓库文件。

  两条不同的网络路径（本机实测）：
    · api.github.com  —— **直连可用**，建仓库 / 校验身份 / 建 Release 都走它，不需要代理。
    · github.com:443  —— **直连不通**(超时 / Connection was reset)，git push 必须挂代理。

  所以推送姿势是：在**单条 git 命令**里同时内嵌代理与凭据（都不落盘）——
    git -c "http.proxy=<代理>" push "https://x-access-token:<token>@github.com/<owner>/<repo>.git" <ref>
  注意：http.extraHeader=Authorization: Bearer <token> 走 HTTPS 推送**实测无效**
  （会退化成 could not read Username），因此不用它。

.PARAMETER TokenFile
  GitHub fine-grained PAT 所在文件（只读第一行）。默认 %USERPROFILE%\.dsh\gh-token.txt

.PARAMETER RepoDir
  发布树目录（必须是已 git init 并提交过的仓库）

.PARAMETER RepoName
  GitHub 仓库名，默认 dsh-obsidian-panel

.PARAMETER Tag
  版本 tag，默认 v0.4.0

.PARAMETER Proxy
  git push 使用的代理，默认 socks5h://127.0.0.1:10808。
  表示「直连」的写法：-Proxy ''（会话内 / cmd 的 ""）、-Proxy none、-Proxy direct。
  注意 powershell -File 对空参数很挑食（从 PowerShell 里再调 powershell -File 时 '' 会被吞掉并报
  Missing an argument）→ **命令行下最稳的是 -Proxy none**。本机直连 github.com:443 不稳定，建议留默认代理。

.PARAMETER DryRun
  只做检查（token 是否有效、仓库是否已存在、本地状态），不推送、不建 Release

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File push-release.ps1 -DryRun
  powershell -ExecutionPolicy Bypass -File push-release.ps1
  powershell -ExecutionPolicy Bypass -File push-release.ps1 -Proxy ''   # 直连（用于验证代理参数生效）
#>
[CmdletBinding()]
param(
  [string]$TokenFile = (Join-Path $env:USERPROFILE '.dsh\gh-token.txt'),
  [string]$RepoDir   = '',
  [string]$RepoName  = 'dsh-obsidian-panel',
  [string]$Tag       = 'v0.4.0',
  [string]$Description = '把 Obsidian 接成 DSH 的第二大脑：双向知识闭环（会话导出 / 交给 DSH / 库自进化 / 开工检索）',
  [string]$Proxy     = 'socks5h://127.0.0.1:10808',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
if (-not $RepoDir) {
  if ($PSScriptRoot) { $RepoDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path } else { $RepoDir = (Get-Location).Path }
}
function Die($m) { Write-Host "✗ $m" -ForegroundColor Red; exit 1 }
function Ok($m)  { Write-Host "✓ $m" -ForegroundColor Green }
function Step($m){ Write-Host "`n── $m" -ForegroundColor Cyan }
function Warn($m){ Write-Host "⚠ $m" -ForegroundColor Yellow }

# 代理类型：Invoke-RestMethod -Proxy 只认 HTTP(S) 代理，socks 不支持（失败时不重试，只在报错里说明）
# 「直连」的容错写法：powershell -File 的参数解析对空字符串很挑食 --
#   · 会话内  & .\push-release.ps1 -Proxy ''      → 绑到空串 ✓
#   · cmd.exe powershell -File ... -Proxy ""      → 绑到空串 ✓
#   · cmd.exe powershell -File ... -Proxy ''      → 会绑成字面量两个引号 '  ✗
#   · 从 PowerShell 里再调 powershell -File ... -Proxy ''  → 空参数被吞，直接报 Missing an argument
# 所以下面统一把 ''/""/none/direct/off/- 都归一成「直连」；最稳的写法是 -Proxy none。
$Proxy = ([string]$Proxy).Trim()
if ($Proxy -in @("''", '""', 'none', 'direct', 'off', '-')) { $Proxy = '' }

$proxyKind = if (-not $Proxy) { 'none' } elseif ($Proxy -match '^(?i)https?://') { 'http' } else { 'socks' }
# 不让 git 弹交互式用户名/密码提示（无凭据时会直接失败而不是卡住）
$env:GIT_TERMINAL_PROMPT = '0'

$headers = $null

# API 调用：优先直连；直连失败且代理是 HTTP(S) 时用 -Proxy 重试一次；socks 则跳过并在结果里说明
function Invoke-GhApi {
  param([string]$Uri, [string]$Method = 'Get', [byte[]]$Body = $null, [int]$TimeoutSec = 20)
  $sp = @{ Uri = $Uri; Method = $Method; Headers = $headers; TimeoutSec = $TimeoutSec }
  if ($Body) { $sp['Body'] = $Body; $sp['ContentType'] = 'application/json; charset=utf-8' }
  try {
    return @{ Ok = $true; Value = (Invoke-RestMethod @sp) }
  } catch {
    $first = $_.Exception.Message
    $code  = 0
    if ($_.Exception.Response) { try { $code = [int]$_.Exception.Response.StatusCode } catch { } }
    if ($Proxy -and $proxyKind -eq 'http') {
      Warn "直连 api.github.com 失败，改用 HTTP 代理重试：$Proxy"
      $sp['Proxy'] = $Proxy
      try { return @{ Ok = $true; Value = (Invoke-RestMethod @sp) } }
      catch {
        $c2 = 0
        if ($_.Exception.Response) { try { $c2 = [int]$_.Exception.Response.StatusCode } catch { } }
        return @{ Ok = $false; Code = $c2; Error = $_.Exception.Message; ProxySkipped = $false }
      }
    }
    return @{ Ok = $false; Code = $code; Error = $first; ProxySkipped = [bool]($Proxy -and $proxyKind -ne 'http') }
  }
}

function ApiFailHint($r) {
  if ($r.ProxySkipped) {
    return "  已给出 -Proxy '$Proxy'，但它是 socks 代理：Invoke-RestMethod -Proxy 只支持 HTTP(S) 代理，无法用它重试。`n  请确认本机能直连 api.github.com（实测可用），或改用 -Proxy http://127.0.0.1:<端口> 形式。"
  }
  return "  请检查网络/DNS 是否可达 api.github.com（本机实测应可直连）。`n  若确需走代理，请用 HTTP 代理：-Proxy http://127.0.0.1:<端口>（socks5 不支持此重试路径）。"
}

# 区分「凭据问题」与「网络问题」：401 是 token 本身被拒，不要误导成网络/代理问题
function DieApi($r, [string]$What) {
  if ($r.Code -eq 401) {
    Die "$What：token 被 GitHub 拒绝（401 Bad credentials，与网络/代理无关）。`n  → token 已失效 / 被撤销 / 复制不全。`n  → 请到 github.com/settings/personal-access-tokens/new 重新生成（Contents: Read and write），`n    把新 token 单独一行写进 $TokenFile（首行、无引号、无多余空格），再重跑本脚本。"
  }
  if ($r.Code -eq 403) {
    Die "$What：403（权限不足或触发限流）。$($r.Error)`n  → 权限对照：推送/建 Release 需 Contents: Read and write；创建仓库还需 Administration: Read and write。"
  }
  Die "$What：$($r.Error)`n$(ApiFailHint $r)"
}

# ── 1. 凭据 ────────────────────────────────────────────────────────────────
Step '凭据'
if (-not (Test-Path $TokenFile)) {
  Die "找不到 token 文件：$TokenFile`n  请先创建 fine-grained PAT（Contents: Read and write），把 token 单独一行写进该文件。`n  或在 github.com/settings/personal-access-tokens/new 生成。"
}
$token = (Get-Content -Path $TokenFile -TotalCount 1).Trim()
if ([string]::IsNullOrWhiteSpace($token)) { Die "token 文件是空的：$TokenFile" }
Ok "已读取 token（$($token.Length) 字符，未回显）"
if ($Proxy) { Ok "git push 代理：$Proxy（类型 $proxyKind）" } else { Warn "未启用代理（-Proxy ''/none）：将直连 github.com:443 —— 本机这条线路很慢、易超时/被重置，推送多半失败" }

$headers = @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'dsh-obsidian-panel-release' }
Step '校验 token 与身份（直连 api.github.com）'
$r = Invoke-GhApi -Uri 'https://api.github.com/user'
if (-not $r.Ok) { DieApi $r '无法校验 token / 身份' }
$me = $r.Value
$owner = $me.login
Ok "身份：$owner（$($me.html_url)）"

# ── 2. 本地仓库状态 ────────────────────────────────────────────────────────
Step '本地仓库'
if (-not (Test-Path (Join-Path $RepoDir '.git'))) { Die "$RepoDir 不是 git 仓库" }
Push-Location $RepoDir
try {
  $branch = git branch --show-current
  $dirty  = git status --porcelain
  $count  = git rev-list --count HEAD
  Ok "分支=$branch  提交数=$count  工作区=$(if($dirty){'✗ 有未提交'}else{'干净'})"
  if ($dirty) { Die '工作区有未提交内容，先提交再发布' }
  if ($branch -ne 'main') {
    Die "当前分支是 '$branch'，但本脚本按 main:main 推送。`n  请先切到 main 分支再重跑：git -C `"$RepoDir`" checkout main"
  }
} finally { Pop-Location }

# ── 3. 远端仓库（不存在则创建）─────────────────────────────────────────────
Step "远端仓库 $owner/$RepoName"
$exists = $true
$r = Invoke-GhApi -Uri "https://api.github.com/repos/$owner/$RepoName"
if ($r.Ok) { $exists = $true }
elseif ($r.Code -eq 404) { $exists = $false }
else { DieApi $r '无法查询远端仓库（未做任何改动）' }

if ($exists) { Ok '已存在，将直接推送' }
elseif ($DryRun) { Ok '不存在（DryRun 不创建）' }
else {
  $body = @{ name = $RepoName; description = $Description; private = $false; has_issues = $true; has_wiki = $false } | ConvertTo-Json
  $r = Invoke-GhApi -Uri 'https://api.github.com/user/repos' -Method Post -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 30
  if (-not $r.Ok) { DieApi $r '创建仓库失败（若 token 没有 Administration 权限，请先在网页建好空仓库再重跑）' }
  Ok "已创建公开仓库 https://github.com/$owner/$RepoName"
  Start-Sleep -Seconds 2
}

if ($DryRun) { Write-Host "`n(DryRun 结束：未推送、未建 Release)" -ForegroundColor Yellow; return }

# ── 4. 推送（代理 + 凭据都只存在于这一条命令里，不落盘）──────────────────
# 说明：http.extraHeader 走 HTTPS 推送实测无效（会退化成 could not read Username），
#       必须把凭据内嵌进 URL；同时**绝不** git remote set-url 带 token（会写进 .git/config）。
function Push-GitRef([string]$Ref) {
  $pushUrl = "https://x-access-token:$token@github.com/$owner/$RepoName.git"
  $gitArgs = @()
  if ($Proxy) { $gitArgs += @('-c', "http.proxy=$Proxy") } else { $gitArgs += @('-c', 'http.proxy=') }
  $gitArgs += @('push', $pushUrl, $Ref)
  # 注意：本脚本 $ErrorActionPreference='Stop'，而 Windows PowerShell 5.1 下
  #       `& git ... 2>&1` 只要 git 写了 stderr 就会抛 NativeCommandError（终结脚本、连提示都打不出）。
  #       必须临时降到 Continue，才能把失败输出交给下面的分类提示。
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out  = & git @gitArgs 2>&1
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prevEap }
  $text = ($out | ForEach-Object { [string]$_ }) -join "`n"
  Write-Host (($text -replace [regex]::Escape($token), '***') -split "`n" | ForEach-Object { "  $_" } | Out-String).TrimEnd()
  return @{ Code = $code; Text = ($text -replace [regex]::Escape($token), '***') }
}
# 按 git 的实际报错分类给提示：认证失败 ≠ 网络/代理问题，别把两者说混
function PushFailHint([string]$Out) {
  if ($Out -match '(?i)Authentication failed|Invalid username or token|not supported for Git operations|could not read Username|terminal prompts disabled') {
    return "  → 这是**认证失败**（请求已到达 GitHub，与代理/IP 无关）：`n   · 确认 $TokenFile 首行是**未过期**的 fine-grained PAT，且对该仓库有 Contents: Read and write 权限`n   · 本项目固定用 x-access-token + PAT；账号密码已不被 GitHub 支持"
  }
  if ($Out -match '(?i)Connection was reset|Recv failure|Failed to connect|Could not resolve host|timed out|Operation timed out|SSL|TLS|ServicePointManager') {
    if ($Proxy) {
      return "  → 这是**网络层失败**：代理 $Proxy 没能连通 github.com:443。`n   · 确认 sing-box 正在 127.0.0.1:10808 监听（socks5），或换端口：-Proxy 'socks5h://127.0.0.1:<端口>'"
    }
    return "  → 这是**网络层失败**：当前 -Proxy 为空（直连），本机直连 github.com:443 不通/不稳定。`n   · 请带上代理重试：-Proxy 'socks5h://127.0.0.1:10808'（先用 Test-NetConnection 127.0.0.1 -Port 10808 确认端口在听）"
  }
  $p = if ($Proxy) { "已用代理 $Proxy。" } else { "当前为直连（-Proxy ''）。" }
  return "  $p 请依次检查：token 是否有效且有 Contents 写权限；代理端口是否为 socks5；网络是否可达 github.com:443。"
}

Step '推送 main'
Push-Location $RepoDir
try {
  $url = "https://github.com/$owner/$RepoName.git"
  if ((git remote) -contains 'origin') { git remote remove origin | Out-Null }
  git remote add origin $url            # 干净 URL（无 token），仅供本地日常 fetch/查看
  Ok "origin = $url（不含凭据）"

  $res = Push-GitRef 'main:main'
  if ($res.Code -ne 0) { Die "推送 main 失败（退出码 $($res.Code)）`n$(PushFailHint $res.Text)" }
  Ok "已推送 main → $url"

  # 让本地 main 跟踪 origin/main（纯本地 config，不涉及凭据）
  git config "branch.$branch.remote" origin
  git config "branch.$branch.merge" "refs/heads/main"

  # ── 5. tag ──────────────────────────────────────────────────────────────
  Step "打 tag $Tag"
  $has = git tag --list $Tag
  if ($has) { Ok "tag $Tag 已存在" }
  else { git tag -a $Tag -m "release $Tag" ; Ok "已创建 tag $Tag" }

  $res = Push-GitRef $Tag
  if ($res.Code -ne 0) { Die "推送 tag $Tag 失败（退出码 $($res.Code)）`n$(PushFailHint $res.Text)" }
  Ok "已推送 tag $Tag"
} finally { Pop-Location }

# ── 6. Release ─────────────────────────────────────────────────────────────
Step "创建 Release $Tag"
$notes = ''
$chg = Join-Path $RepoDir 'docs\CHANGELOG.md'
if (Test-Path $chg) {
  $all = Get-Content $chg -Raw -Encoding UTF8
  $want = $Tag -replace '^v', ''
  $m = [regex]::Match($all, "(?s)##\s*\[?$([regex]::Escape($want))\]?.*?(?=\r?\n##\s|\z)")
  if (-not $m.Success) { $m = [regex]::Match($all, "(?s)##\s*\[?0\.3\.0\]?.*?(?=\r?\n##\s|\z)") }
  if ($m.Success) { $notes = $m.Value.Trim() }
}
if (-not $notes) { $notes = "首个可发布版本（详见 docs/CHANGELOG.md）" }
$relBody = @{ tag_name = $Tag; name = $Tag; body = $notes; draft = $false; prerelease = $false } | ConvertTo-Json -Depth 4
$r = Invoke-GhApi -Uri "https://api.github.com/repos/$owner/$RepoName/releases" -Method Post -Body ([Text.Encoding]::UTF8.GetBytes($relBody)) -TimeoutSec 30
if ($r.Ok) { Ok "Release 已创建：$($r.Value.html_url)" }
else { Warn "Release 创建失败（不影响代码已推送）：$($r.Error)" }

Write-Host "`n════════ 完成 ════════" -ForegroundColor Green
Write-Host "仓库：https://github.com/$owner/$RepoName"
Write-Host "发布：https://github.com/$owner/$RepoName/releases/tag/$Tag"
