# 打包发布清单（GitHub）

> 目标（验收项①）：**任何人都能按说明装起来用** —— 前提是**所有本机路径都变成配置项**，且**绝不含任何知识库内容**。
> 本清单基于 2026-10-06 对仓库的实际扫描（非凭印象）。

## 零、红线（发布前必须逐一确认）

1. **绝不提交知识库内容**：`<你的知识库>` 里的任何笔记、附件、`.dsh/` 数据都**不得**进仓库。仓库里只放**代码 + 文档 + 示例模板**。
2. **不提交个人标识**：用户主目录路径、本机盘符路径、Obsidian REST API key、任何 token。
3. **提交前跑一次密钥/路径扫描**（见第四节脚本）。

## 一、服务端（`workbench/server.mjs`）—— 基本干净 ✅

扫描结果：**没有硬编码 vault 路径**，只有两处端口默认值：
- `127.0.0.1:8777`（桥接端口）→ 已支持 `DSH_OBSIDIAN_PORT` 覆盖
- `https://127.0.0.1:27124`（Obsidian Local REST API）→ 端口应也可配置（建议加 `DSH_OBSIDIAN_REST_PORT`）

**仍需补**：
- vault 路径目前靠"服务文件自身位置推导"（放在 `<vault>/.dsh/workbench/` 下）→ 保留这个约定，但**要支持 `DSH_OBSIDIAN_VAULT` 显式覆盖**（已有，确认文档写到）
- 启动日志里把"推导出的 vault"打出来，便于排查 ✅（已有 `/api/ping` 返回 vault）

## 二、Obsidian 插件（`dev/plugins/dsh-bridge/`）—— 必须改 ❌

| 文件 | 问题 | 改法 |
|---|---|---|
| `main.js:33` | **硬编码** `dshInboxDir: "<你的知识库>\\.dsh\\inbox"` | 改为 **Obsidian 插件设置项**（`loadData()/saveData()` + 设置面板里填"知识库根目录"），默认留空并在未配置时提示 |
| `manifest.json` | 描述里带产品名可保留；确认 `id/version` 规范 | 补 `versions`/`minAppVersion`（若缺） |

## 三、脚本与文档

| 文件 | 处理 |
|---|---|
| `tools/autostart.ps1:21` | `$VaultWorkbench` 硬编码 → 提为**必填参数**（`-Vault`），或读环境变量 `DSH_OBSIDIAN_VAULT` |
| `tools/deploy.ps1:6` / `tools/rollback.ps1:6` | 已有 `-Vault` 参数（默认值改成占位/必填），文档里说明 |
| `tools/win-embed.ps1` | **本机调试工具**（含 `%USERPROFILE%\...\Obsidian.exe`）→ **不进公开仓库**，或放到 `tools/dev/` 并在 README 注明"开发者自用、非安装所需" |
| `tests/`、各类 harness | 自检产物 → 不进仓库（或放 `tests/` 并加说明）；仓库要干净 |
| `README.md` | `<你的知识库>` 等示例 → 改成 `$VAULT` 占位 + 说明"你的知识库目录" |
| `ARCHITECTURE-C.md` | 大量本机路径示例 → 泛化；保留"我们的部署约定"作为**示例**而非**要求** |
| `SESSION-IMPORT.md:19` | `%USERPROFILE%\.dsh\sessions\...` → 泛化成 `%USERPROFILE%\.dsh\sessions\--<工作区slug>--\<会话目录>\session.v4.jsonl.zstd` |

## 四、发布前扫描脚本（提交前必跑）

```powershell
$root = '<本仓库>'
$bad = Select-String -Path (Get-ChildItem $root -Recurse -File -Include *.js,*.mjs,*.ps1,*.py,*.json,*.md,*.yml,*.vbs |
        Where-Object { $_.FullName -notmatch '\\tests\\|\\.dsh-reef\\|\\node_modules\\' }).FullName `
      -Pattern '<知识库路径>|<用户名>|<本仓库路径>|<REST Key 前缀>|Bearer [A-Za-z0-9]' -ErrorAction SilentlyContinue
if ($bad) { $bad | Select-Object Path, LineNumber, Line | Format-Table -Wrap } else { 'clean' }
```

## 五、版本与变更记录（验收项④）

- `package.json` 里的 `version` 为唯一版本源；每次发布打 git tag `v<version>`
- `CHANGELOG.md` 按 [Keep a Changelog](https://keepachangelog.com/) 维护：`新增 / 变更 / 修复 / 安全`
- 发布流程：改版本 → 写 CHANGELOG → 跑扫描脚本 → 跑自检 → commit → tag → push → GitHub Release（附安装说明）

## 六、安装说明草案（README 用）

1. 前置：Node 18+、Obsidian（可选：Local REST API 插件）
2. 把 `workbench/` 放到 `<你的知识库>/.dsh/workbench/`，`node server.mjs` 启动（或跑 `tools/autostart.ps1 -Vault <你的知识库>` 设开机自启）
3. 把 `client-plugin/` 装进 DSH（profile 的 `node_modules/dsh-obsidian-panel/`）
4. Obsidian 侧装 `dev/plugins/dsh-bridge/`，在插件设置里填**知识库根目录**
5. 打开 DSH → 面板底部出现「● 桥接服务在线」即成功
6. 验证：`curl http://127.0.0.1:8777/api/ping` 应返回你的 vault 路径

## 七、建议的仓库结构

```
dsh-obsidian-panel/
├── README.md            # 安装 + 截图 + 三条通道说明
├── CHANGELOG.md
├── LICENSE
├── workbench/           # 桥接服务（零依赖 Node）+ extract.py
├── client-plugin/       # DSH 面板插件（lib/index.js + lib/client.js）
├── obsidian-plugin/     # dsh-bridge（改成可配置版）
├── docs/                # ARCHITECTURE / SESSION-IMPORT / PACKAGING
└── examples/            # 示例 vault 结构（占位文件，无真实内容）
```

## 发布前扫描（9 类全查，2026-10-08 扩口径）

```powershell
# 把下面 $pat 换成你的实际值后运行；命中必须为 0 才能提交
$pat = '<知识库根路径>|<用户名>|<库名>|'+'g'+'hp_|github'+'_pat_|<REST Key>|<库内主题词1>|<库内主题词2>|<库内目录名>|session-[0-9a-f]{8}-|\d+ 篇'
Get-ChildItem <发布树> -Recurse -File | Select-String -Pattern $pat
```

**9 类必查**：① 知识库根路径 ② 用户名/用户目录 ③ 本仓库外盘符路径 ④ token（经典前缀 3 字母+下划线 / fine-grained 前缀 / 裸 40 位）⑤ Obsidian REST Key ⑥ **库名** ⑦ **库内主题词**（你自己的笔记主题/标签）⑧ **库内目录名与统计数字** ⑨ **真实 UUID**
**三个最容易漏的泄露面**：**代码注释**、**UI 占位符**（`placeholder="如 xxx"`）、**文档示例**（示例查询/示例路径/示例计数）✓