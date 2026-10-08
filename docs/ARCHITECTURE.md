# 架构说明 / Architecture

> 这份文档回答三个问题：**东西由哪几块组成、数据怎么流、为什么这么设计。**
> This document answers three questions: **what the pieces are, how data flows, and why it is built this way.**

---

# 一、中文版

## 1. 一句话

把 **DSH（DeepSeek Harness）** 与 **Obsidian 知识库**接成一个**双向闭环**：DSH 把工作沉淀进库；
库反过来在 DSH 每次开工前补全它没说清的边界；重复经验被提炼成可复用技能。

**设计原则（最要紧的一条）**：

> **知识库是记忆，DSH 是大脑；桥接服务只管搬运，不管思考。**

服务端只做 **扫描 / 索引 / 检索 / 落盘 / 队列**，不做任何推理、不调模型、不联网。
所以它**零依赖、可离线、行为可预测** —— 换一个 DSH 会话、换一个 AI，甚至完全不用 AI，
库和桥接服务照样能工作。这条原则是所有其它决定的依据。

## 2. 组成

```
        DSH（DeepSeek Harness）                   Obsidian
   ┌──────────────────────────────┐      ┌──────────────────────────────┐
   │ 面板插件 dsh-obsidian-panel   │      │ 插件 dsh-bridge              │
   │ 笔记 / 编辑 / 结构 / 进化 / 投喂 │      │ 交给 DSH / 打开面板 / 看状态   │
   └───────────────┬──────────────┘      └───────────────┬──────────────┘
                   │        HTTP  127.0.0.1:8777         │
                   └──────────────────┬───────────────────┘
                            ┌─────────▼──────────┐
                            │ 桥接服务 server.mjs │  零依赖 Node（只搬运，不思考）
                            │ 放在 <vault>/.dsh/  │
                            └─────────┬──────────┘
                                      │ 读写
                            ┌─────────▼──────────┐
                            │ <vault>            │  笔记 / 附件 / .dsh/ 数据
                            └────────────────────┘
                            （附：workbench/extract.py —— 文档提取器，由服务按需调用）
```

| 部分 | 位置 | 职责 | 不能做什么 |
|---|---|---|---|
| **桥接服务** | `workbench/server.mjs` | 索引 / 检索 / 读写笔记 / 队列 / 投喂落盘 / 会话导出 | 不做推理、不联网、不改用户笔记正文（除用户发起的编辑与 delete→回收站） |
| **DSH 面板插件** | `client-plugin/` | DSH 侧五个页签的界面与交互 | 不直接读写磁盘，一律走服务 API |
| **Obsidian 插件** | `obsidian-plugin/` | 把笔记交给 DSH、打开面板、显示桥接状态 | 不碰 `.dsh/` 内部数据 |
| **文档提取器** | `workbench/extract.py` | docx/pptx/xlsx/pdf/老格式 → 文本与图片 | 只读输入文件；缺依赖时**明确报错**，不静默 |

## 3. 三条通道（数据流）

| 方向 | 触发 | 流向 | 落点 |
|---|---|---|---|
| **DSH → 库** | 会话右键「导出到 Obsidian」/ 项目归档 / 自动导出 | 面板 → `POST /api/archive`·`/api/session/export` | `<vault>/<archive_folder>/`（可配置） |
| **库 → DSH** | 笔记列表「🧠 交给 DSH」 | 面板 → `POST /api/handoff` | `<vault>/.dsh/inbox/`（DSH 侧来读） |
| **库自进化** | 进化页任务队列：领取 → 执行 → 完成 | 面板 → `/api/evolution/*` | 完成后归档进 `<vault>/<evolution_log_folder>/`（库内可见） |

外加一条**只读**的横向能力：**开工检索** `GET /api/recall?q=` —— 一次返回相关笔记 / 可复用技能卡 /
同类历史归档 / 已记录缺口 / 库内习惯（标签、目录、frontmatter 约定），用于"动手前先回忆"。

## 4. 目录与状态文件约定

**库内（人可见，可被 Obsidian 直接编辑）**

```
<vault>/<archive_folder>/            项目归档、会话纪要
<vault>/<evolution_log_folder>/      进化任务完成后的归档（"完成即知识"）
<vault>/<attach_dir>/                投喂原件与内嵌图（重名自动 -2/-3，绝不覆盖）
<vault>/<ingest_default_dir>/        投喂笔记的默认落点（表单可改）
<vault>/<skill_mirror_folder>/       技能卡的单向只读副本（给人看）
```

**`.dsh/` 内（机器状态，不参与 Obsidian 索引）**

| 路径 | 内容 | 写入者 |
|---|---|---|
| `settings.json` | 全部可配置项（含**你的真实目录名**、解释器路径） | 用户 / 面板设置 |
| `state.json` | 游标与去重记录（如已自动导出的会话） | 服务 |
| `metrics.jsonl` · `stats.jsonl` | 任务指标与记账（"越用越准"的数据底座） | 服务（来自 DSH 上报） |
| `prompts/`（含 `.history/`） | 提示词 / 模板 / 检查清单，**追加式版本化**，历史只增不删 | 面板 / DSH |
| `skills/` | 本地技能卡 | DSH |
| `evolution/{tasks,logs,gaps}/` | 任务、日志、**缺口清单**（`- [ ]` / `- [x]`） | DSH |
| `inbox/{,files,archive,trash}` | 交给 DSH 的任务、投喂暂存、归档、回收区 | 面板 / DSH / 服务 |
| `trash/` | 删除的笔记（**删除=移入回收站**，可还原回原目录） | 服务 |
| `ingest-manifest.jsonl` | 投喂清单（每篇记下"本该带哪些附件"，**只作恢复依据**，服务从不据它自动改文件） | 服务 |

## 5. 五个关键设计决定（以及为什么）

1. **配置项而不是常量**：库内目录名、解释器路径等"因人而异"的东西**一律不写死在代码里**，
   由 `<vault>/.dsh/settings.json` 提供，服务端解析后经 `GET /api/settings` 的 `effective` 字段回传。
   → 好处：发布出去的代码不含任何个人目录名与本机路径（见 `PACKAGING.md` 的 9 类扫描）。
2. **写操作都可恢复**：删除走回收站（记录原相对路径，可还原回原目录）；投喂附件重名加后缀、绝不覆盖；
   笔记写入用原子写；提示词历史只增不删。
3. **幂等优先**：`/api/skills/mirror`、自动导出、缺口 resolve 等都是"内容没变就不重写"，
   避免把用户文件改出噪声（也让 git 保护真的有意义）。
4. **只读与只写边界清楚**：`/api/recall`、`/api/evolution`（读）**绝不 mkdir、绝不写盘**；
   库内技能（`**/skills/*/SKILL.md`）**永远只读**；缺口条目**原文不可改写**（只允许改勾选框 + 行尾补注）。
5. **UI 与数据解耦**：面板是"可替换的壳"，任何第三方工具只要会说这几个 HTTP API，就能当这个面板用。

## 6. 扩展点

- **面板**：五个页签各自独立渲染，新增页签只需加一段 `buildXxx()` + 分派分支（`client.js` 单文件，无构建步骤）。
- **文档类型**：`extract.py` 按扩展名分派；新增格式加一个分支即可（老格式走 LibreOffice 无头转换）。
- **提示词**：`.dsh/prompts/<类型>/<名>.md`，追加式版本化 —— 这是"提示词也能进化"的载体。
- **技能**：`.dsh/skills/<名>.md`；`GET /api/skills/candidates` 只**发现**值得沉淀的主题，内容由 DSH 写。

## 7. 相关文档

| 文档 | 讲什么 |
|---|---|
| [`README.md`](../README.md) | 安装、配置、接口清单（**中英双语**） |
| [`PACKAGING.md`](PACKAGING.md) | 发布前红线与 9 类隐私扫描 |
| [`PUBLISH.md`](PUBLISH.md) | 发布流程、社交卡片、出问题怎么退 |
| [`SESSION-IMPORT.md`](SESSION-IMPORT.md) | 「会话 → 知识库」的设计稿与技术前提 |
| [`CHANGELOG.md`](CHANGELOG.md) | 版本变更（中文维护；每版带 English highlights） |

---

# 二、English

## 1. In one sentence

Turn your **Obsidian vault** into a **second brain for DSH (DeepSeek Harness)** — a **two-way loop**: DSH writes
its work back into the vault; the vault feeds DSH the context it was missing before each task starts; lessons
that repeat get distilled into reusable skills.

**The design principle that matters most:**

> **The vault is the memory, DSH is the brain; the bridge service only moves things around, it never thinks.**

The service only **scans / indexes / retrieves / writes / queues**. It never reasons, never calls a model, never
goes online. That is why it is **zero-dependency, offline-capable and predictable** — swap the DSH session, swap
the AI, or drop the AI entirely, and the vault plus the bridge still work. Every other decision follows from this.

## 2. Components

| Part | Location | Responsibility | Explicitly does **not** |
|---|---|---|---|
| **Bridge service** | `workbench/server.mjs` | Index / search / read-write notes / queues / ingest / session export | reason, go online, or rewrite your note bodies (beyond user-initiated edits and delete→trash) |
| **DSH panel plugin** | `client-plugin/` | The five-tab UI inside DSH | touch the disk directly; everything goes through the service API |
| **Obsidian plugin** | `obsidian-plugin/` | Hand notes to DSH, open the panel, show bridge status | touch `.dsh/` internals |
| **Document extractor** | `workbench/extract.py` | docx/pptx/xlsx/pdf/legacy formats → text and images | write to inputs; it **fails loudly** instead of degrading silently |

## 3. Data flow — the three channels

| Direction | Trigger | Endpoint | Lands in |
|---|---|---|---|
| **DSH → vault** | Session context menu "Export to Obsidian" / project archive / auto-export | `POST /api/archive`, `/api/session/export` | `<vault>/<archive_folder>/` (configurable) |
| **vault → DSH** | Note list → "🧠 Hand off to DSH" | `POST /api/handoff` | `<vault>/.dsh/inbox/` (read by DSH) |
| **vault self-evolution** | Evolution tab: claim → execute → complete | `/api/evolution/*` | archived into `<vault>/<evolution_log_folder>/` (vault-visible) |

Plus one **read-only** transversal capability: **pre-work recall** `GET /api/recall?q=` returns related notes /
reusable skill cards / similar archived history / known gaps / vault conventions in a single call.

## 4. Layout and state files

**Inside the vault (human-visible, editable in Obsidian)** — archive folder, evolution log folder, attachment
folder, default ingest folder and the skill-mirror folder; every name is a **setting**, never a constant.

**Inside `.dsh/` (machine state, not indexed by Obsidian)**

| Path | Contents | Written by |
|---|---|---|
| `settings.json` | Every configurable value, including **your real folder names** and interpreter path | user / panel settings |
| `state.json` | Cursors and de-duplication (e.g. sessions already auto-exported) | service |
| `metrics.jsonl` · `stats.jsonl` | Task metrics and usage scoring (the data behind "gets better with use") | service (reported by DSH) |
| `prompts/` (with `.history/`) | Prompts / templates / checklists, **append-only versioning**; history is never deleted | panel / DSH |
| `skills/` | Local skill cards | DSH |
| `evolution/{tasks,logs,gaps}/` | Tasks, logs, **gap checklists** (`- [ ]` / `- [x]`) | DSH |
| `inbox/{,files,archive,trash}` | Hand-off tasks, ingest staging, archive, recovery area | panel / DSH / service |
| `trash/` | Deleted notes — **delete means move to trash**, restorable to the original folder | service |
| `ingest-manifest.jsonl` | Per-ingest record of "which attachments should exist" — **recovery evidence only**; the service never auto-fixes files from it | service |

## 5. Five decisions worth knowing

1. **Settings, not constants.** Anything that differs per machine or per user (folder names, interpreter path)
   lives in `<vault>/.dsh/settings.json`; the server reports the resolved values in the `effective` field of
   `GET /api/settings`. → The published code contains no personal folder names and no machine paths (see the
   9-class scan in `PACKAGING.md`).
2. **Every write is recoverable.** Deletes go to trash (original relative path recorded → restores in place);
   ingest never overwrites (adds `-2`/`-3`); notes are written atomically; prompt history is append-only.
3. **Idempotence first.** Skill mirroring, auto-export and gap resolution all skip when content is unchanged, so
   your files do not accumulate noise — which is also what makes git-based delete protection meaningful.
4. **Clear read/write boundaries.** Read endpoints (`/api/recall`, `/api/evolution`) never `mkdir` and never write;
   vault-side skills (`**/skills/*/SKILL.md`) are **always read-only**; gap entries are **never rewritten**
   (only the checkbox flips, with an appended note).
5. **UI is separable from data.** The panel is a replaceable shell: any third-party tool that speaks these HTTP
   endpoints can act as the panel.

## 6. Extension points

- **Panel**: each tab renders independently — add a `buildXxx()` plus a dispatch case (single-file `client.js`, no build step).
- **Document types**: `extract.py` dispatches by extension; legacy formats go through headless LibreOffice.
- **Prompts**: `.dsh/prompts/<kind>/<name>.md` with append-only versions — the vehicle for "prompts evolve too".
- **Skills**: `.dsh/skills/<name>.md`; `GET /api/skills/candidates` only *discovers* what deserves distillation —
  DSH writes the content.
