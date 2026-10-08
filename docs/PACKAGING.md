# 打包发布清单（GitHub）/ Packaging checklist

> 目标：**任何人都能按说明装起来用** —— 前提是**所有本机路径都变成配置项**，且**绝不含任何知识库内容**。
> 本清单基于对仓库的**实际扫描**（不是凭印象）。发布前请逐条走一遍。
>
> Goal: **anyone can install and use this from the docs** — which requires that **every machine-specific path is a
> setting** and that the repo contains **no vault content whatsoever**. This checklist reflects actual scans of the
> repository, not memory. Walk through it before every release.

## 零、红线（逐条确认）/ Red lines

1. **绝不提交知识库内容**：`<你的知识库>` 里的任何笔记、附件、`.dsh/` 数据都**不得**进仓库。仓库只放**代码 + 文档 + 示例**。
2. **不提交个人标识**：用户主目录路径、本机盘符路径、Obsidian REST API key、任何 token。
3. **提交前跑扫描，且命中必须为 0**。⚠️ 扫描要**同时覆盖「当前树」与「历史」**（见第二、三节）。

---

## 一、9 类必查口径 / The 9 classes to scan

| # | 类别 | 例子 |
|---|---|---|
| ① | 知识库根路径 | 盘符 + 目录 |
| ② | 用户名 / 用户目录 | `C:\Users\<name>`、`~/.dsh/...` 里的真实用户名 |
| ③ | 本仓库以外的盘符路径 | 其它盘的绝对路径 |
| ④ | token | 经典前缀（3 字母 + 下划线）、fine-grained 前缀、裸 40 位十六进制 |
| ⑤ | Obsidian REST API Key | 配置文件里的值 |
| ⑥ | **库名** | 你的知识库顶层目录名 |
| ⑦ | **库内主题词** | 你自己的笔记主题 / 标签（最容易漏：它们常出现在**示例文案**里） |
| ⑧ | **库内目录名与统计数字** | 如 `112 篇 / 27 目录` 这类真实计数 |
| ⑤… | **真实 UUID** | 会话 id 等 |

**三个最容易漏的泄露面**：**代码注释**、**UI 占位符**（`placeholder="如 xxx"`）、**文档示例**（示例路径 / 示例查询 / 示例计数）。

## 二、扫描脚本（三段式，缺一段等于没查）/ Three-step scan

```powershell
# ① 当前树
$root = '<发布树>'
$pat  = '<库根路径>|<用户名>|<库名>|<库内主题词>|<库内目录名>|' + 'g' + 'hp_|github' + '_pat_|<REST Key>|session-[0-9a-f]{8}-|\d+ 篇'
Get-ChildItem $root -Recurse -File |
  Where-Object { $_.FullName -notmatch '\\\.git\\|\\node_modules\\' } |
  Select-String -Pattern $pat

# ② 全历史（任何历史提交里的字符串同样是泄露）
git -C $root log --all -p -S"<敏感词>" --oneline     # 逐类核对 9 类

# ③ 匿名 clone 复核（外部看到的就是这个）
git clone <repo-url> <空目录>      # 然后在 clone 出来的目录里重跑 ①②
```

**判定：命中必须为 0。** 已经推上去的历史只能靠**重写历史**消除；tag 与 Release 是**独立对象**，
必须一并删掉重建 —— 详见 [`PUBLISH.md`](PUBLISH.md) 第七节。

## 三、当前发布树（实际结构）/ What the release tree contains

```
README.md  LICENSE  .gitignore
workbench/        server.mjs（零依赖 Node 服务）+ extract.py（文档提取器）
client-plugin/    DSH 面板插件（单文件 client.js，无构建步骤）
obsidian-plugin/  dsh-bridge（运行时推导 vault 根，可用插件设置覆盖）
tools/            autostart.ps1 · push-release.ps1 · make-social-preview.py
docs/             ARCHITECTURE · PACKAGING · PUBLISH · SESSION-IMPORT · CHANGELOG · social-preview.png
```

## 四、已完成的加固（历史，别退回去）/ Hardening already done — do not regress

- **路径与目录名全部配置化**：vault 内所有目录名、`extract.py` 解释器路径都是设置项，
  服务端解析结果经 `GET /api/settings` 的 `effective` 回传；**服务里不再有任何本机绝对路径**。
- **Obsidian 插件**：早期版本硬编码过 vault 路径 ✗ → 现在**运行时从 Obsidian 推导**（取不到就在插件设置里覆盖），
  绝不把用户目录写进代码。
- **脚本**：`autostart.ps1` **不内置默认路径**（必须 `-Vault` 或 `DSH_OBSIDIAN_VAULT`）；
  发布脚本的凭据**只从文件读、只在单条 git 命令里内嵌、绝不落盘**（不写进 `.git/config`）。
- **删除保护**：库内长期区（笔记 / 附件 / 源件）纳入本地 git —— 这是唯一能扛住**手工删除**的机制。
- **社交卡片**：由 `tools/make-social-preview.py` 生成（中心安全构图，含逐元素断言）；
  生效判据见 [`PUBLISH.md`](PUBLISH.md) 第八节。

## 五、版本与变更记录 / Versioning

- 版本号：git tag `v<major>.<minor>.<patch>`（SemVer + `v` 前缀 + annotated tag）
- [`CHANGELOG.md`](CHANGELOG.md) 按 [Keep a Changelog](https://keepachangelog.com/) 维护：`新增 / 变更 / 修复 / 安全`；
  **每版在段首带一行 English highlights**（GitHub Release 正文由该段自动摘录）
- 发布流程：改代码 → `node --check` → 部署 → 核对（源码 vs 部署副本 MD5）→ 写 CHANGELOG →
  **扫描 0 命中** → commit → tag → push → 建 Release

---

## English (condensed)

**Goal**: anyone can install this from the docs — which requires that every machine-specific path is a setting and
that the repository contains no vault content. This checklist reflects real scans, not memory.

### Red lines
1. **Never commit vault content** — no notes, no attachments, no `.dsh/` data. The repo holds **code, docs and examples only**.
2. **Never commit personal identifiers** — home-directory paths, machine drive paths, Obsidian REST API keys, tokens.
3. **Run the scan before committing, and it must return zero hits.** ⚠️ The scan must cover **both the current tree
   and the full history** (steps ② and ③ below).

### The 9 classes
① vault root path ② username / home directory ③ drive paths outside this repo ④ tokens (classic prefix,
fine-grained prefix, bare 40-hex) ⑤ Obsidian REST API key ⑥ **vault name** ⑦ **in-vault topic words** (your own note
topics/tags — they leak most often through example text) ⑧ **in-vault folder names and real counts** ⑨ **real UUIDs**.

**The three leak surfaces most often missed**: **code comments**, **UI placeholders** (`placeholder="e.g. xxx"`), and
**documentation examples** (example paths, queries, counts).

### Three-step scan (skipping a step means you did not check)
1. **Current tree** — PowerShell `Get-ChildItem … | Select-String -Pattern $pat` with all 9 classes.
2. **Full history** — `git log --all -p -S"<sensitive>" --oneline`; strings in *any* historical commit count as leaks.
3. **Anonymous clone** — clone the public repo into an empty directory and re-run ①② inside it. This is what the
   outside world sees.

**Zero hits is the gate.** History that is already pushed can only be removed by **rewriting history** (force push);
tags and Releases are **independent objects** and must be deleted and recreated — see `PUBLISH.md` §7.

### What the release tree contains
`README.md`, `LICENSE`, `.gitignore`, `workbench/` (zero-dependency Node service + `extract.py`), `client-plugin/`
(the DSH panel, a single hand-written `client.js` with no build step), `obsidian-plugin/` (`dsh-bridge`; derives the
vault root at runtime, overridable in plugin settings), `tools/` (`autostart.ps1`, `push-release.ps1`,
`make-social-preview.py`), `docs/` (architecture, packaging, publishing, session import, changelog, social card).

### Hardening already done — do not regress
- **All paths and folder names are settings**: every vault-side folder name and the `extract.py` interpreter path come
  from `<vault>/.dsh/settings.json`; resolved values are reported in the `effective` field of `GET /api/settings`.
  The service contains **no machine-specific absolute paths**.
- **Obsidian plugin**: an early version hard-coded the vault path ✗ → it now **derives** it at runtime (with a manual
  override in plugin settings).
- **Scripts**: `autostart.ps1` has **no built-in default paths** (requires `-Vault` or `DSH_OBSIDIAN_VAULT`); the
  release script reads credentials **from a file only**, embeds them in a **single git command**, and never writes
  them to disk or `.git/config`.
- **Delete protection**: long-term vault areas (notes, attachments, source files) are tracked in a **local** git repo —
  the only mechanism that survives a **manual deletion**.
- **Social card**: generated by `tools/make-social-preview.py` (centre-safe composition with a per-element assertion);
  see `PUBLISH.md` §8 for how to verify it is live.

### Versioning
Tags are `v<major>.<minor>.<patch>` (SemVer with a `v` prefix, annotated). `CHANGELOG.md` follows
[Keep a Changelog](https://keepachangelog.com/) with sections 新增 / 变更 / 修复 / 安全, and **each release carries a
one-line English highlights blurb** at the top of its section (the GitHub Release body is extracted from it).
Release flow: change code → `node --check` → deploy → verify (MD5 of source vs deployed copy) → write the changelog →
**scan returns zero** → commit → tag → push → create the Release.
