# 发布到 GitHub（最后一公里）

> 本项目的代码已经**全部就绪**：发布树扫描 0 命中、MIT 许可、README 含安装说明、CHANGELOG 完整。
> 只差**一次推送**，而推送需要**你的 GitHub 凭据**（这一步必须由你提供，我不会也不能替你生成）。

## 一、准备凭据（三选一）

### 方式 A：fine-grained Token 写进文件（我最推荐，最可控）
1. 打开 https://github.com/settings/personal-access-tokens/new
2. **Token name**：`dsh-obsidian-panel-push`；**Expiration**：90 天
3. **Repository access**：All repositories（仓库还没建时最省事）
4. **Permissions → Repository permissions**：
   - `Contents`: **Read and write** ← 必需（推代码）
   - `Administration`: **Read and write** ← 勾上才能顺手创建仓库（不勾就先在网页建好空仓库）
5. Generate → 复制
6. **不要贴在聊天里**，写进文件（只放 token 一行）：
   ```powershell
   Set-Content -Path "$env:USERPROFILE\.dsh\gh-token.txt" -Value '<粘贴token>' -NoNewline
   ```

### 方式 B：GitHub CLI（不需要 token 文件）
```powershell
winget install --id GitHub.cli        # 或从 cli.github.com 下载
gh auth login                         # 浏览器授权，一次即可
```

### 方式 C：自己推（不依赖任何脚本）
在网页建好空仓库 `dsh-obsidian-panel`（**不要**勾 README/gitignore），然后：
```powershell
cd <发布树目录>
git remote add origin https://github.com/<你的用户名>/dsh-obsidian-panel.git
git push -u origin main
git tag -a v0.4.0 -m "release v0.4.0"; git push origin v0.4.0
```

## 二、一条命令发布（方式 A 就绪后）

```powershell
powershell -ExecutionPolicy Bypass -File <本仓库>\tools\push-release.ps1 -DryRun   # 先空跑
powershell -ExecutionPolicy Bypass -File <本仓库>\tools\push-release.ps1           # 真发
```

它会依次做：**读 token（不回显）→ 校验身份 → 检查本地仓库 → 建仓库（若无）→ push main → 打 v0.4.0 tag → 建 Release（自动摘录 CHANGELOG）**。

**安全设计**：token 只在单次 git 命令的 `http.extraHeader` 里带过，**不写进 `.git/config`**、不进仓库、不进回复。

## 三、发布后自检

```powershell
# 仓库能匿名访问（公开）
curl.exe -s -o NUL -w "%{http_code}`n" https://github.com/<你的用户名>/dsh-obsidian-panel
# README / LICENSE / CHANGELOG 都在，且**没有**任何知识库内容与个人路径
curl.exe -s https://raw.githubusercontent.com/<你的用户名>/dsh-obsidian-panel/main/README.md | Select-Object -First 5
```

**必须确认**（这是本项目的红线）：
- 仓库里**没有**知识库笔记 / `.dsh/` 数据 / 附件
- **没有** 用户主目录路径、盘符路径、REST API Key、token

## 四、后续版本怎么发

1. 改代码 → `node --check` → 部署 → 核对（见 `AGENTS.md` 第三节）
2. 更新 `docs/CHANGELOG.md`（新增/变更/修复/安全）
3. 重建发布树（**排除 `node_modules`**）→ 跑路径/密钥扫描 → 必须 0 命中
4. 升版本号 → `git commit` → `git tag v<x.y.z>` → 跑 `push-release.ps1 -Tag v<x.y.z>`

## 五、出问题怎么退

- 仓库内容有问题：`git revert <commit>` 后再推
- 想撤 Release：GitHub 网页上删除该 Release（tag 可保留或一并删）
- 部署回滚：源码仓库有历史提交，`tools/rollback.ps1` 可按基线回退插件（需 `-Vault` 指定知识库）

## 六、⚠️ 本机网络注意事项（踩过的坑，2026-10-08）

本机**直连 `github.com:443` 不稳定**（实测有时 7.9s 能通、有时超时 / `Recv failure: Connection was reset`；线路抖动大），而 `api.github.com` 一直正常。表现为：
```
git push → fatal: Recv failure: Connection was reset / Could not connect to server
```
本机有 **sing-box 监听 `127.0.0.1:10808`**，git 默认不走它。**正确做法**（两条缺一不可）：

```powershell
# ① 走本地代理  ② 凭据放在 URL 里（git 用 HTTPS 推要 Basic 认证，Bearer 头无效 ✗）
git -c http.proxy=socks5h://127.0.0.1:10808 push `
    "https://x-access-token:<TOKEN>@github.com/<用户>/<仓库>.git" main:main
git -c http.proxy=socks5h://127.0.0.1:10808 push `
    "https://x-access-token:<TOKEN>@github.com/<用户>/<仓库>.git" v0.4.0
```
- `api.github.com`（建仓库 / 建 Release）**不需要代理**，直接 `Invoke-RestMethod` 即可
- 不要 `git remote set-url` 带 token（会把凭据写进 `.git/config` ✗）；只在单条命令里内嵌
- 代理写法优先级：`socks5h://` > `socks5://` > `http://`；`socks5h` 连 DNS 也走代理，最稳
## 七、⚠️ 扫描必须同时覆盖「当前树」和「**历史**」（2026-10-08 踩过）

`git log -p` 能翻出**任何历史提交里的字符串**，即使当前树已经清干净。实测事故：
当前树的扫描已经是 0 命中，但仓库**历史**里仍带着
「库内目录名」与一条「本机解释器绝对路径」——`git log -p` / 下载旧 tag 都能看到。

**所以发版前的检查顺序是固定的三条**（缺一条就等于没查）：

```powershell
# ① 当前树（工作区）
<按 PACKAGING.md 的 9 类模式扫当前树>
# ② 全历史（所有提交的所有差异）
git log --all -p -S"<敏感词>" --oneline          # 逐一核对 9 类模式
# ③ 公开侧复核（换一个干净目录匿名 clone，再跑 ①②）
git clone https://github.com/<owner>/<repo>.git <空目录>
```

**已经推上去的历史**只能靠**重写历史**消除（`--force` 推送），tag 与 Release 是**独立对象**、
必须一并删掉重建；想连 GitHub 服务端的不可达对象也清掉，唯一的办法是**删库重建**
（注意：经典 token 需要 `delete_repo` 权限，`public_repo` 不够）。

**根治办法（本项目已采用）**：任何"库内目录名 / 本机路径 / 凭据"都**不要写进代码**，
一律走配置项（`<vault>/.dsh/settings.json`）或环境变量 —— 代码与文档里只留通用默认值。
这样"发布树是否干净"就不再依赖每次手工扫描。
## 八、Social preview 卡片图（分享时显示的图）

仓库右上 Settings → **Social preview** 可上传一张 1280×640（2:1，≤1MB）的卡片，
它决定这个链接被贴到别处时显示什么图。**卡片是脚本生成的，不要手绘**：

```powershell
# 依赖 Pillow（DSH 自带 Python 已装）；产物 = docs/social-preview.png
python tools/make-social-preview.py
```

脚本里踩过并修掉的坑值得记住：**Segoe UI 这类西文字体没有 CJK 字形**，
用它画含中文的字符串会出**豆腐块**（□□□）—— 规则是「**字符串里只要有中文就用雅黑**」，
纯西文才用 Segoe UI（脚本里的 `pick()` 就是干这个的）。改完务必**亲眼看一遍产物**再上传。
### 怎么确认卡片**真的生效了**（2026-10-09 绕了三圈才验对，务必按这个判据）

抓仓库页 HTML，看 `og:image`：**它指向哪个域名，就是哪种卡**——

| `og:image` 指向 | 含义 |
|---|---|
| `opengraph.githubassets.com/<hash>/<owner>/<repo>` | **GitHub 自动生成**的默认卡（仓库名 + 描述 + 统计数字）⇒ **自定义卡片没生效** |
| `repository-images.githubusercontent.com/<repo_id>/<uuid>` | **你上传的自定义卡** ⇒ 生效 ✓ |

```powershell
# 一句话取当前 og:image（HTML 里斜杠未转义，直接正则可取）
$h = curl.exe -s -A "Mozilla/5.0" https://github.com/<owner>/<repo>
[regex]::Match($h, '<meta property="og:image" content="([^"]+)"').Groups[1].Value
```

**踩过的两个坑**（别再犯）：
1. **别用 `opengraph.githubassets.com` 自己拼 URL 去验** —— 那个端点的 hash 不是随便填的（填随机的会回落默认卡），
   拿旧 hash 只会看到旧状态；**必须以页面 HTML 里的实际 URL 为准**。
2. **验证判据不要自证**：我一度用"从被怀疑文件上读来的哈希"当期望值，等于拿文件跟它自己比，得出过错误结论。
   图片类校验要用**独立判据**（尺寸 + 平均色：模板/默认卡是浅色 ~(241,239,237)，本项目卡片是深色 ~(24,28,46)）。