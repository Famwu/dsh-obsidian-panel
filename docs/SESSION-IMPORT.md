# DSH 会话 → Obsidian 知识库（设计稿）

> 2026-10-06 定稿。对应需求：「每完成一个项目可在对话列表选择是否归入知识库（或插件选项自动归档）」。

## 一、两个已验证的事实（技术前提）

### 1. 会话右键菜单是**开放的插件插槽**
DSH 文档（`app.asar`）原文：

> Pin, Rename, Fork, and Archive are themselves entries of the **`sidebar.workspaces.session.menu.item`** list (pin and archive also of `sidebar.workspaces.session.row.action`), so a client plugin's action takes whatever position its `order` gives it.

- `sidebar.workspaces.session.menu.item` —— 会话行「…」右键菜单的 **list 插槽**（置顶 / 重命名 / 分叉 / 归档 / 删除都在这里）
- `sidebar.workspaces.session.row.action` —— 会话行 **hover 按钮**插槽（可另做悬停入口）
- 结论：**「导入 Obsidian」可以正规注册进这个菜单**，不是 hack。

### 2. 会话内容可被程序读取
```
%USERPROFILE%\.dsh\sessions\--<工作区slug>--\<会话目录>\session.v4.jsonl.zstd
例：%USERPROFILE%\.dsh\sessions\--<工作区slug>--\session-<uuid>-13f5-46ab-bb84-8b895ec1cf25\session.v4.jsonl.zstd
```
- **zstd 压缩的 JSONL**；Node 24 自带 `zlib.zstdDecompressSync`，桥接服务可直接解压解析。
- 体积参考：本会话压缩后 ~2.9MB → 解压后可能十几 MB，**不可整篇入库**，必须抽取后再落盘。

### 3. 落库通路已存在
`POST /api/archive {title, content, tags[], folder?}` —— 按 vault 结构写笔记、frontmatter 带 `dsh-processed`、追加 `.dsh/evolution/logs/archive-YYYY-MM.md`、`archiveCount` +1。**已实跑验证**。

## 二、档位（用户选 B）

| 档 | 内容 | 状态 |
|---|---|---|
| A 原始对话 | 完整逐条记录 | 未采用（太长） |
| **B 对话纪要** | 抽掉思考/工具细节，保留用户与助手正文 | **采用** |
| C 深度提炼 | 排队交 DSH 读全篇写成知识条目 | 后续可选 |

## 三、通路

```
右键会话 →【导入 Obsidian】
   → POST /api/session/import {sessionId}
   → 服务：定位会话文件 → zstd 解压 → 逐行解析（坏行跳过）
          → 抽取 user/assistant 正文 → 组装 markdown（上限 20 万字符）
   → 复用 archive 通路落库（默认 <你的归档目录>/）
   → toast 提示 + 笔记相对路径
```

## 四、自动导入开关

**位置**：用户提议放侧栏底栏（Obsidian 开关的收件箱下方）。
**我的建议**：改放**面板「进化」页 → 收件箱区块正下方**。理由：
1. 与收件箱同属「外部内容进库」语义区，位置一致；
2. 面板展开时才占空间，不挤侧栏竖向空间（侧栏底栏已两行、且要避让「会话管理」）；
3. 打开面板顺手即可改。

若坚持「不开面板也能看见」，退化为底栏第 3 行小号字单行紧凑式。

**已确认语义**（用户 2026-10-06 拍板）：

- **命名统一用「导出」**（从 DSH 视角是**导出**对话，不是导入）
  → 菜单项文案：「**导出到 Obsidian**」；开关文案：「**自动导出对话**」
- 开关开启时，服务**每 12 小时扫描一次**会话目录，对同时满足以下条件的会话生成纪要入库：
  1. **已静置 ≥ 2 天**（`now - mtime ≥ 2 天`）—— 用户明确否决了「静置 5 分钟」的方案：太频繁、后期占磁盘；
     语义即用户所说「2 天内没有删除对话」→ 能活过 2 天的会话才值得进库（随口一问的早被删了）；
  2. **未曾自动导出过**（去重记录写 `.dsh/state.json` 的 `exportedSessions`）
- 用户给定的提示文案（挂在开关后的 `?` 上，鼠标悬停显示）：
  > 2 天内没有删除对话且没有触发过对话的自动导出，将自动导出到 Obsidian 知识库。
- 开关关闭即停止扫描。**只写入知识库，不改动 DSH 会话本身**。

**开关位置**：面板「进化」页 → **收件箱区块下方**（用户已确认采纳建议），开关后带 `?` 悬停提示。
