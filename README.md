# DSH × Obsidian · 第二大脑

把 [DSH（DeepSeek Harness）](https://github.com/) 与 Obsidian 知识库接成一个**双向闭环**：
DSH 把工作沉淀进你的知识库，知识库反过来在 DSH 每次开工前**补全你没说清的边界**，并把重复经验沉淀成技能。

> 设计原则：**知识库是记忆，DSH 是大脑；桥接服务只管搬运，不管思考。**
> 服务只做扫描 / 索引 / 检索 / 落盘 / 队列，所有推理与提炼都在 DSH 侧完成 —— 因此它零依赖、可离线、行为可预测。

## 三条通道

| 方向 | 入口 | 作用 |
|---|---|---|
| **DSH → 库** | 会话右键「导出到 Obsidian」；项目归档；自动导出（存活 ≥2 天的会话） | **沉淀**：把"做过什么、结论是什么"变成持久笔记 |
| **库 → DSH** | 笔记列表「🧠 交给 DSH」→ 写入 `.dsh/inbox/` | **唤起**：从库里点一下，让 DSH 去读这篇笔记并产出 |
| **库自进化** | 进化页任务队列 → 领取 → 执行 → 完成后归档进「知识库可见的归档目录」（可配置 `evolution_log_folder`） | **提炼**：找缺口、补全、写回、留痕 |

另有**开工检索** `GET /api/recall?q=`：一次返回相关笔记 / 可复用技能卡 / 同类历史归档 / 已记录缺口 / 库内习惯（标签、目录、frontmatter 约定），用于在动手前回忆。

## 组成

| 部分 | 位置 | 说明 |
|---|---|---|
| **桥接服务** | `workbench/server.mjs` | 零依赖 Node（18+），默认 `127.0.0.1:8777`；含文档提取器 `extract.py`（docx/pptx/xlsx/pdf） |
| **DSH 面板插件** | `client-plugin/` | DSH 侧边面板：笔记 / 编辑 / 结构 / 进化 / 投喂 五个页签 |
| **Obsidian 插件** | `obsidian-plugin/` | `dsh-bridge`：把笔记送给 DSH、打开面板、查看知识库状态 |

面板功能概览：笔记列表（搜索 / 标签过滤 / 删除进回收站 / 交给 DSH）、Obsidian 风格阅读视图（属性区块、表格、代码块、双链、**iframe 视频**）、新建笔记表单、结构页目录移动、回收站（查看 / 还原 / 删除 / 清空，**还原回原目录**）、进化任务队列与归档、投喂入库（拖入 PDF/PPT/图片/Office → 识别 → 加入知识库）。

## 安装

### 1. 桥接服务
把 `workbench/` 放到**你的知识库**里：
```
<你的知识库>/.dsh/workbench/{server.mjs, extract.py}
```
启动：
```bash
node <你的知识库>/.dsh/workbench/server.mjs
# 默认 127.0.0.1:8777
```
验证：
```bash
curl http://127.0.0.1:8777/api/ping
# {"ok":true,"vault":"<你的知识库>","port":8777}
```

**开机自启（可选，Windows）**：把 `server.mjs` 就位后
```powershell
powershell -ExecutionPolicy Bypass -File tools/autostart.ps1 -Action install -Vault "<你的知识库>"
```
（脚本不内置任何默认路径，必须用 `-Vault` 或环境变量 `DSH_OBSIDIAN_VAULT` 指定。）

### 2. DSH 面板插件
把 `client-plugin/` 放到 DSH 的插件目录（profile 的 `node_modules/dsh-obsidian-panel/`），重载 DSH。
面板底部出现「● 桥接服务在线」即成功。

### 3. Obsidian 插件
把 `obsidian-plugin/` 放到 `<你的知识库>/.obsidian/plugins/dsh-bridge/`，在 Obsidian 设置里启用。
插件会**自动推导**你的知识库根目录（无需手填路径）；特殊环境可在插件设置里手动覆盖。

## 配置

**环境变量（服务端）**

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_OBSIDIAN_VAULT` | 由服务文件位置推导 | 知识库根目录 |
| `DSH_OBSIDIAN_PORT` | `8777` | 桥接端口 |
| `DSH_OBSIDIAN_SESSIONS` | `%USERPROFILE%\.dsh\sessions` | DSH 会话存储根（用于「导出到 Obsidian」） |

**设置项（`GET/PUT /api/settings`）**

| 键 | 默认 | 说明 |
|---|---|---|
| `archive_folder` | `dsh-archive` | 项目归档 / 会话导出的落库目录 |
| `evolution_log_folder` | `dsh-archive/evolution-log` | 进化任务**完成后归档**的目录（知识库内可见） |
| `attach_dir` | `attachments` | 投喂原件 / 内嵌图归档到 `<vault>/<attach_dir>/` |
| `ingest_default_dir` | `ingest-archive` | 投喂入库的**默认**目标目录（长期保留区；表单里可改） |
| `skill_mirror_folder` | `dsh-skills` | 技能卡单向导出（镜像）目录：`<vault>/<skill_mirror_folder>/` |
| `python_path` | `""` | `extract.py` 解释器绝对路径（留空 = 环境变量 / PATH） |
| `auto_export_sessions` | `false` | 自动导出：存活 ≥2 天且未导出过的会话 |

> 目录名**刻意不写死在代码里**：真实目录名一律由你自己的 `<vault>/.dsh/settings.json` 指定，
> 服务端解析后经 `GET /api/settings` 的 `effective` 字段回传（含 `python_source`，便于排查解释器没找到）。
> 这样发布出来的代码里不含任何个人目录名 / 本机路径。

## 主要接口

```
GET  /api/ping                  健康检查（返回 vault 与 port）
GET  /api/index                 全库索引（笔记 / 目录 / 附件 / 标签）
GET  /api/search?q=&tag=&limit= 检索（多词 AND 优先、OR 兜底、打分排序）
GET  /api/recall?q=&limit=      开工检索（笔记 + 技能卡 + 历史归档 + 缺口 + 库内习惯；每条带 score / used / record）
POST /api/score                 记一次使用结果（success / rework / fail）—— 让「越用越准」有数据可依
GET  /api/score                 使用汇总（used / success / rework / fail / score / record）
GET  /api/skills                技能卡列表（本地 .dsh/skills 与库内 **/skills/*/SKILL.md，带 source 区分来源）
GET  /api/note?path=            读笔记     PUT/POST 写笔记
POST /api/archive               项目归档 / 会话纪要归档
POST /api/delete                删除 → 移入回收站（可还原回原目录）
GET  /api/trash                 回收站列表
POST /api/trash/restore         还原（默认回原目录）
POST /api/trash/purge           删除单条 / 清空回收站
POST /api/move-dir              移动（可改名）整个目录
POST /api/ingest                投喂：提取并暂存    POST /api/ingest/save 加入知识库
POST /api/handoff               把一篇笔记交给 DSH（写入 .dsh/inbox/）
GET  /api/inbox                 收件箱
GET  /api/session/list          可导出的 DSH 会话
POST /api/session/export        导出会话为纪要笔记
GET  /api/evolution             进化队列 / 日志 / 缺口 / 技能
GET  /api/evolution/archive     已完成（归档）的任务
```

## 目录结构

```
├── workbench/          # 桥接服务（零依赖 Node）+ extract.py
├── client-plugin/      # DSH 面板插件
├── obsidian-plugin/    # dsh-bridge（Obsidian 插件）
├── tools/              # 部署 / 自启脚本（安装用）
└── docs/               # 架构、会话导入、打包清单、变更记录
```

## 隐私

**本仓库不含任何知识库内容。** 你的笔记、附件、`.dsh/` 数据都只存在于你自己的磁盘上。
仓库维护者请注意：提交前务必运行 `docs/PACKAGING.md` 里的路径与密钥扫描。

## 许可

[MIT](LICENSE) —— 可自由使用、修改、分发、商用，只需保留版权声明。
