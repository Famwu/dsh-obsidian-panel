"use strict";
/* dsh-obsidian-panel — DSH × Obsidian 原生面板（手写 CJS bundle，无构建依赖）
 * M2：删除「内嵌外部网页」的旧方案，改为 DSH 原生 DOM 面板，直接调用 127.0.0.1:8777 桥接服务。
 * 四个页签：笔记（读/搜） · 编辑（读/写/新建） · 结构（目录/移动/标签） · 进化（报告/缺口/触发）。
 */
window.__ModuleLoader__.load({ id: "dsh-obsidian-panel", factory: (require) => {
  var module = { exports: {} };
  var React = require("react");
  var h = React.createElement;
  var BASE = "http://127.0.0.1:8777";
  var LS = { open: "dsh-obs.open", theme: "dsh-obs.theme", width: "dsh-obs.width", editmode: "dsh-obs.editmode", skillFilter: "dsh-obs.skillfilter" };
  /* 自动导出开关的 ? 悬停提示（文案由用户给定，逐字不改） */
  var AUTO_EXPORT_TIP = "2 天内没有删除对话且没有触发过对话的自动导出，将自动导出到 Obsidian 知识库。";
  /* 任务队列：原来摊在队列上方的**固定长说明**（实测没人读）收进标题旁的 ? 里。
     随状态变化的那一句在每张卡内（.evo-task-next）—— 卡与卡状态不同，提示必须跟着卡走。 */
  var TASK_QUEUE_TIP = "队列按时间顺序推进：「领取任务」总是领取最早的一条「待执行」任务，状态随即变成「执行中」；" +
    "做完点「标为完成」，任务会**归档**（搬进知识库可见的归档目录、从队列消失，可在「已完成」里查看）——归档 ≠ 删除。";
  /* 徽标 ? 图例：三个状态各是什么意思、下一步该点什么 */
  var TASK_LEGEND = "待执行 = 还没人接手（下一步：点「领取任务」）／执行中 = 已接手在办（下一步：点「标为完成」）／已完成 = 已归档，只读";
  var EVO_STEPS = ["待执行", "执行中", "已完成"];
  /* 一行「下一步」提示：索引 = 相位（0 待执行 / 1 执行中 / 2 已完成） */
  var EVO_TASK_NEXT = [
    "点「领取任务」开始；领取后状态变「执行中」",
    "做完后点「标为完成」，任务会自动归档到「已完成」",
    "已归档（只读），可在上方「已完成」查看"
  ];
  /* 「DSH Skill 待提炼候选」卡内的一行说明：**同样索引 = 相位**，且同样放在卡里 ——
     候选与任务队列是**同一条任务、同一套生命周期**（待执行 → 执行中 → 已完成），卡与卡状态不同，提示必须跟着卡走。
     三句逐字固定（用户口径）：状态一律来自服务端 handoff，前端不编。
     ⚠️ 服务端 handoff 读的就是 `.dsh/evolution/tasks/`（+ 归档）—— 即下方「任务队列」那批文件本身。 */
  var CAND_HANDOFF_NEXT = [
    "已交给 DSH · 它下次开工时会读到这个任务",
    "DSH 正在提炼…（提炼完成后会写进技能卡）",
    "已提炼 ✓ 到技能区看成果（本地技能）"
  ];
  /* ── 提示词 / 模板 / 检查清单（**第四类进化对象**，与技能区并列）──
     服务端口径（workbench/server.mjs「进化对象 · 第四类」）：kind 只认三态，其余文件算坏文件 → skipped；
     前端因此**只做中文标签翻译**，不猜第四种、也不因为多了个 kind 就整条丢掉（丢掉 = 用户写的文件凭空消失）。
     与技能区的**分工差异**（为什么这里没有「交给 DSH 提炼」）：
       技能的产物由 DSH 写 → 所以技能候选的唯一动作是「交给 DSH 提炼」（写进化任务队列）；
       提示词/模板是 **DSH 自己怎么问、怎么写** 的东西，用户也可以直接写 → 所以这里给的是「据此新建」
       （只把候选名/建议 kind 填进表单，**不生成正文**、不写任何文件），正文仍由人来定稿。
     删除口径：只删当前版本 `<名>.md`，`.history/<名>/` 原样保留（历史只增不删）→ 文案里必须说清，
       否则用户会以为「删了就等于清干净」。 */
  var PROMPT_KINDS = ["prompt", "template", "checklist"];
  var PROMPT_KIND_LABEL = { prompt: "提示词", template: "模板", checklist: "检查清单" };
  var PROMPT_KIND_BADGE = { prompt: "local", template: "tag", checklist: "dir" };
  var PROMPT_TIP = "DSH 自己用的提示词 / 模板 / 检查清单（「开工检索怎么问」「周报模板」「入库检查清单」）。" +
    "落盘 .dsh/prompts/<名称>.md；每次保存都把上一版**逐字节**存进 .dsh/prompts/.history/<名称>/（只增不删，可回看）。" +
    "删除只移除当前版本，历史版本保留 —— 所以删掉再建同名时，版本号会从旧历史接着涨。";
  /* 提示词候选（GET /api/prompts/candidates）：来自库内标签 / 目录 / 归档 / 记账 / 缺口，
     与技能候选同一个哲学 —— 服务端**只发现模式给证据，绝不生成一句正文**。 */
  var PROMPT_CAND_TIP = "候选来自库内标签 / 目录 / 进化归档 / 记账 / 缺口（机器标签与剪藏容器已过滤）。" +
    "点「据此新建」只把名称与建议类型填进上方表单，**不生成正文、不写任何文件** —— 正文由人定稿后点「创建」才落盘。";

  var savedTheme = localStorage.getItem(LS.theme) || "dark";
  if (savedTheme.indexOf("custom:") === 0) savedTheme = "dark"; // 自定义底色已下线
  var state = {
    open: localStorage.getItem(LS.open) !== "0",
    theme: savedTheme,      // dark | light | auto
    tab: "notes",           // notes | edit | struct | evo
    online: false,          // 桥接服务探活结果
    index: null,            // GET /api/index 结果
    q: "", tag: "",         // 搜索关键词 / 标签过滤
    edit: { path: "", text: "", tags: [], frontmatter: {}, missing: false },
    editMode: localStorage.getItem(LS.editmode) === "read" ? "read" : "edit", // 编辑页子模式：edit | read
    newNote: false,         // 编辑页：是否处于「新建笔记」状态（整个编辑区切换为新建表单）
    nfSnap: null,           // 进入新建状态前的编辑区快照 {path, text}，取消时原样还原
    treeOpen: {},           // 目录树展开状态（内存态）
    evo: null,              // GET /api/evolution 结果
    evoArch: null,          // GET /api/evolution/archive 结果（已完成归档，只读）
    evoArchOpen: false,     // 任务队列区：是否展开「已完成」归档视图
    inbox: null,            // GET /api/inbox 结果
    scan: null,             // GET /api/evolution/scan 结果（M3-B）
    skills: null,           // GET /api/skills 归一化后的技能数组（M3-B）
    /* 技能区来源筛选：local（默认）/ vault / all。
       默认「本地」的原因：库内常驻十几条 copilot 插件自带技能，全列会把我们自己沉淀的 1~2 条淹掉。
       持久化到 localStorage → 面板重开 / 插件热重载后仍是上次的选择。 */
    skillFilter: (function () {
      try { var f = localStorage.getItem(LS.skillFilter); return (f === "vault" || f === "all") ? f : "local"; }
      catch (e) { return "local"; }
    })(),
    settings: null,         // GET /api/settings（自动导出开关 auto_export_sessions 等）
    /* 服务端解析后的**生效目录**（GET /api/settings 的 effective 字段）：
       真实目录名只在用户自己的 .dsh/settings.json 里 —— 面板源码只留通用兜底值。
       用途：新建笔记的默认目标目录 / 投喂默认落点 / 技能镜像目录名 / python 路径。 */
    effective: null,
    /* 「待提炼候选」= GET /api/skills/candidates 的归一化数组（**默认只含 kind=topic** 的真主题）。
       它是「技能区」的上游：候选 → 交给 DSH → DSH 提炼成技能卡 → 出现在技能区。
       载入中 / 失败都靠 evoErr.candidates 在面板内可见提示（不静默）。 */
    candidates: null,
    candContainers: 0,      // 后端给的 containerCount（被过滤掉的容器型候选数，只用于说明文案）
    evoCandOpen: true,      // 候选区展开态（**默认展开**；仅内存态，不持久化）
    /* 提示词 / 模板 / 检查清单（第四类进化对象，数据 = GET /api/prompts）：
       prompts = 归一化后的条目数组；promptFilter = all|prompt|template|checklist。
       筛选在**前端**做（一次拉全量再过滤）—— 提示词是自己沉淀的，不会有「库内十几条把本地淹掉」那种体量，
       所以默认 all，也不需要像技能区那样把选择持久化到 localStorage。 */
    prompts: null,
    promptFilter: "all",
    promptCands: null,      // GET /api/prompts/candidates 的候选（上游：候选 → 固化成提示词）
    promptCandTotal: 0,     // 后端给的 total（未截断的候选总数，用于「显示 N / 共 M」）
    promptCandsOpen: true,  // 候选子区展开态（**默认展开**；仅内存态）
    evoErr: { main: "", scan: "", skills: "", candidates: "", prompts: "", promptCands: "", settings: "", arch: "" }, // 进化页各分区错误（面板内可见，不静默）
    scanGapsOpen: false,    // 扫描结果的缺口清单展开态
    // 投喂页：list = GET /api/ingest/list 的暂存清单；res = id → POST /api/ingest 的识别结果
    //   skipOpen = 「跳过 N 个图像流」清单的展开态；zoomSrc/zoomCap = 点开的缩略图（面板内浮层，只读）
    //   trash = GET /api/ingest/trash/list 的回收区清单；orphan = 打开页面时 GET /api/ingest/reconcile?dry=1 的**只读**对账结果
    //   trashOpen = 回收区展开态（默认收起）；reconErr/reconRunning = 对账失败原因 / 正在对账（防并发）
    ingest: { list: null, res: {}, cur: "", lastNote: "", err: "", stat: "", skipOpen: false, zoomSrc: "", zoomCap: "",
      trash: null, trashOpen: false, orphan: null, reconErr: "", reconRunning: false },
    // 回收站（笔记页内饰视图）：items = GET /api/trash 的条目（null=未拉取）；count = 徽标计数；
    // view = 当前是否停在回收站视图；err = 最近一次读取失败的可见提示
    trash: { items: null, count: 0, view: false, err: "" },
  };
  var panelEl = null, footBtn = null, disposed = false;
  var footInboxEl = null;                       // 侧栏入口里的收件箱徽标（面板关着时也在）
  var footAutoSwEl = null;                      // 侧栏入口里的「自动导出」小开关（底栏第 3 行）
  var settingsAsked = false;                    // 底栏挂载时补拉一次设置，避免每次重渲染都打接口
  var insetSaved = null, insetRO = null;        // 需求二：聊天区左移的原样式快照 / 宽度观察器
  /* DSH 切页（插件 / 自动化任务 ↔ 对话）会卸载并重建会话视图 DOM，旧的左移目标随之脱离，
     而 resize 与 panelEl 的 ResizeObserver 都不会触发 → 左移静默失效、面板遮住聊天内容。
     补一个 MutationObserver（观察 body 的 childList + role/aria-modal 两个属性：切页重建与
     宿主模态弹窗的插拔/显形都在里面，同一份回调里顺手重算面板层级），结构变稳后重算一次。 */
  var insetMO = null, insetMOTimer = null;
  var INSET_MO_DELAY = 180;                     // 结构变化 debounce（150–250ms 区间）
  /* 需求：面板 z-index(9990) 远高于宿主模态弹窗层 → 弹窗被面板盖住。
     检测到「可见的模态弹窗」时给面板挂 .behind 降到 1，弹窗消失后把原值写回。
     panelZSaved 只存一份原值；面板关闭时清空（DOM 一起销毁，重开时重新采一次）。 */
  var panelZSaved = null, panelZFallback = "9990";
  var notesBuilt = false, evoBuilt = false, ingestBuilt = false, pendingConfirm = null, toastTimer = null, searchTimer = null;

  var CSS = `
.dsh-obs-foot{flex:0 0 auto;display:flex;flex-direction:column;align-items:stretch;gap:5px;color:#9aa3bc;font-size:12px;padding:6px 9px;border-radius:10px;cursor:pointer;min-width:0;max-width:132px}
.dsh-obs-foot .row{display:flex;align-items:center;gap:8px;width:100%}
/* ── 底栏卡片自己的主题令牌（--ob-* 命名与面板一致） ──
   面板的 --ob-* 只声明在 .dsh-obs-panel[data-theme="dark"|"light"] 上，而底栏卡片挂在宿主侧栏里
   （不在面板子树内）→ 继承不到，所以在卡片上按同一命名补一份。
   字色与宿主标签色 --dsw-alias-label-primary 混合：宿主在 body（浅）/ body[data-ds-dark-theme]（深）
   上给值，卡片是 body 的后代 → 深浅主题自动适配，不必自己判断主题、也不怕主题属性改名。
   深色下混合结果 ≈ #c8cefc（即面板靛蓝 #6d7cff 系的浅靛蓝），浅色下 ≈ #303667（同色系深靛蓝）。 */
.dsh-obs-foot{--ob-chip-bg:rgba(109,124,255,.14);--ob-chip-bd:rgba(109,124,255,.30);--ob-chip-tx:color-mix(in srgb,#6d7cff 35%,var(--dsw-alias-label-primary,#e8ebf4));--ob-chip-tx-hi:color-mix(in srgb,#6d7cff 20%,var(--dsw-alias-label-primary,#e8ebf4))}
.dsh-obs-foot:hover{background:rgba(109,124,255,.08)}
.dsh-obs-foot.on{background:linear-gradient(135deg,rgba(109,124,255,.20),rgba(52,211,153,.10));border:1px solid rgba(109,124,255,.40);color:var(--ob-hi,#e8ebf4);font-weight:600;box-shadow:0 0 18px rgba(109,124,255,.16);position:relative}
.dsh-obs-foot.on::before{content:"";position:absolute;left:-1px;top:20%;bottom:20%;width:2.5px;border-radius:2px;background:linear-gradient(180deg,#6d7cff,#a78bfa);box-shadow:0 0 8px #6d7cff}
.dsh-obs-foot .vtag{flex:0 0 auto;font-size:9px;color:var(--ob-info,#8fb8ff);background:rgba(109,124,255,.18);border:1px solid rgba(109,124,255,.35);padding:1.5px 5px;border-radius:7px;white-space:nowrap}
/* ── 底栏卡片第 1 行：标准开关形态（左「Obsidian」文字 + 右带滑块轨道）──
   结构：<button.obsbtn role="switch"> [i.pulse 在线点] [span.obslbl Obsidian] [span.obssw 轨道 > i 滑块] </button>
   整行仍是**一个可点击的开关**：点文字、点轨道、点行内空白都切换面板开合（只翻一次，见 FooterRow 的 stopPropagation）。
   开态 = 轨道填充蓝 #2563eb 并渐入 0.46s cubic-bezier(.4,0,.2,1)（沿用原有口径，用户要求「肉眼可见的渐入」）；
         滑块用 transform:translateX(16px) 滑到右侧，0.28s ease —— 底色渐入与位移**同时开始**。
   关态 = 轨道深灰 #2a2f40（与第 3 行 .asw 同一个深灰体系）、滑块在左。
   轨道 34×18 / 滑块 14 / 视觉内边距 2（= 1px 边框 + 1px 定位），都在按钮盒内，不占额外布局盒。
   层次一律用纯色 + box-shadow 做，绝不用渐变背景图——渐变图不参与 background-color 过渡，会和 transition 打架。
   桥接在线点（6px）移到文字左侧：绿=在线 / 灰=离线；它与「面板开/关」（轨道颜色）是两个独立通道，
   因此「面板关着 + 在线」与「面板开着 + 离线」这两组组合一眼可分。 */
.dsh-obs-foot .obsbtn{box-sizing:border-box;display:flex;align-items:center;gap:4px;width:100%;min-width:0;font:inherit;font-size:11.5px;font-weight:700;line-height:15px;color:var(--ob-dim,#c3cadd);background:#2b3145;border:1px solid rgba(148,163,215,.22);border-radius:8px;padding:3px 5px;cursor:pointer;box-shadow:inset 0 0 0 1px rgba(109,124,255,0),inset 0 0 14px rgba(109,124,255,0),0 2px 10px rgba(59,130,246,0);transition:background-color .46s cubic-bezier(.4,0,.2,1),color .46s cubic-bezier(.4,0,.2,1),box-shadow .46s cubic-bezier(.4,0,.2,1),border-color .46s cubic-bezier(.4,0,.2,1),transform .12s ease}
.dsh-obs-foot .obsbtn:hover{background:#343b52}
.dsh-obs-foot .obsbtn:active{transform:scale(.97)}
.dsh-obs-foot .obsbtn:focus-visible{outline:2px solid rgba(109,124,255,.7);outline-offset:2px}
/* 开态：保留原蓝系 #2563eb，描边与内发光统一用面板强调色 #6d7cff → 和面板同一个色族 */
.dsh-obs-foot .obsbtn.on{color:#fff;background:#2563eb;border-color:rgba(109,124,255,.75);box-shadow:inset 0 0 0 1px rgba(109,124,255,.55),inset 0 0 14px rgba(109,124,255,.34),0 2px 10px rgba(59,130,246,.34)}
.dsh-obs-foot .obsbtn.on:hover{background:#2f6ff0}
/* 文字在左、轨道在右：margin-right:auto 把剩余空间全给「文字与轨道之间」，
   窄卡片下（空间不足）label 先省略号收缩，轨道 flex:0 0 auto 恒定 34px 不被压扁。 */
.dsh-obs-foot .obsbtn .obslbl{flex:0 1 auto;min-width:0;margin-right:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 轨道（switch 本体）：底色渐入 .46s；滑块位移 .28s ease */
.dsh-obs-foot .obsbtn .obssw{box-sizing:border-box;position:relative;flex:0 0 auto;width:34px;height:18px;border-radius:9px;background:#2a2f40;border:1px solid rgba(148,163,215,.18);transition:background-color .46s cubic-bezier(.4,0,.2,1),border-color .46s cubic-bezier(.4,0,.2,1),box-shadow .46s cubic-bezier(.4,0,.2,1)}
.dsh-obs-foot .obsbtn .obssw i{position:absolute;top:1px;left:1px;width:14px;height:14px;border-radius:50%;background:#6b7288;transform:translateX(0);transition:transform .28s ease,background-color .28s ease}
.dsh-obs-foot .obsbtn.on .obssw{background:#2563eb;border-color:rgba(109,124,255,.75);box-shadow:0 0 8px rgba(109,124,255,.35)}
.dsh-obs-foot .obsbtn.on .obssw i{transform:translateX(16px);background:#fff}
.dsh-obs-foot .pulse{width:6px;height:6px;border-radius:50%;background:#34d399;box-shadow:0 0 0 1px rgba(255,255,255,.5),0 0 0 0 rgba(52,211,153,.55);animation:dshobspl 2s infinite;flex-shrink:0}
.dsh-obs-foot .pulse.bad{background:#b9c0d4;box-shadow:0 0 0 1px rgba(255,255,255,.4);animation:none}
/* ── 底栏卡片第 3 行：自动导出（窄卡片；? 与开关和「进化」页那行同源） ──
   框=信息 / 框外=操作：靛蓝紫信息框里只放「标签 + ?」（与第 2 行「收件箱 N」同一个口径，
   见下面 .fin.has,.fin.fauto 那一条，颜色只声明一次），小开关留在框外右侧。
   宽度预算（max-width:132px 未改动，宿主「会话管理」位置不动）：
   ① 第 1 行开关 [在线点6 + 间距4 + Obsidian(8字×~6.4≈51) + 间距4 + 轨道34 + 内边距10 + 边框2] ≈ 111px ← 三行里最宽（实测按钮 110.41px）
   ② 第 2 行「收件箱 N」4字×11 + 空格 + 数字 + 内边距10 ≈ 55px
   ③ 第 3 行 [标签 4×11=44 + 间距3 + ?12 + 框内边距10 = 69] + 行间距4 + 开关24 = 97px
   卡片宽 ≈ 111 + 内边距18 = 129px（面板开着多 1px 边框 → 131px）≤ 132px → 不挤压右侧宿主按钮。
   若日后仍超宽，按此优先级压缩：① 内边距 5→4 且 gap 4→3、② 轨道 34→30、③ ? 12→11px、④ 开关 24→20px。 */
.dsh-obs-foot .row.auto{gap:4px;margin-top:1px}
.dsh-obs-foot .albl{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:14px;color:inherit}
.dsh-obs-foot .qm{box-sizing:border-box;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:12px;height:12px;border-radius:50%;font-size:10px;font-weight:700;line-height:1;color:inherit;background:rgba(148,163,215,.12);border:1px solid rgba(148,163,215,.28);cursor:help}
.dsh-obs-foot .qm:hover{border-color:#6d7cff;background:rgba(109,124,255,.18)}
.dsh-obs-foot .asw{box-sizing:border-box;margin-left:auto;position:relative;flex:0 0 auto;width:24px;height:13px;border-radius:8px;background:#2a2f40;border:1px solid rgba(148,163,215,.18);cursor:pointer;transition:background .15s,border-color .15s}
.dsh-obs-foot .asw i{position:absolute;width:9px;height:9px;border-radius:50%;background:#6b7288;top:1px;left:1px;transition:all .15s}
.dsh-obs-foot .asw.on{background:linear-gradient(90deg,#3b82f6,#8b5cf6);border-color:rgba(109,124,255,.5);box-shadow:0 0 8px rgba(109,124,255,.35)}
.dsh-obs-foot .asw.on i{left:12px;background:#fff}
.dsh-obs-foot .asw[data-busy="1"]{opacity:.55;cursor:default}
.dsh-obs-foot .asw:focus-visible{outline:2px solid rgba(109,124,255,.7);outline-offset:2px}
@keyframes dshobspl{0%{box-shadow:0 0 0 1px rgba(255,255,255,.5),0 0 0 0 rgba(52,211,153,.55)}70%{box-shadow:0 0 0 1px rgba(255,255,255,.5),0 0 0 7px rgba(52,211,153,0)}100%{box-shadow:0 0 0 1px rgba(255,255,255,.5),0 0 0 0 rgba(52,211,153,0)}}
.dsh-obs-panel{position:fixed;top:var(--dsh-frame-top-clearance,0px);right:0;bottom:0;width:470px;min-width:260px;max-width:80vw;z-index:9990;display:flex;flex-direction:column;background:var(--ob-bg);border-left:1px solid var(--ob-line2);box-shadow:none;font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:var(--ob-tx)}
/* 面板阴影 = **只在左边缘**一条横向渐变（.dsh-obs-panel::before），刻意不用 box-shadow：
   ① box-shadow 会往**上沿**溢出（面板上沿在工具条下方）→ 观感像「光从右上角往下打」、顶部挂着一道影；
   ② 它的暗度在四周均匀，近边缘那一圈会显出一道硬边。
   改用「近边缘一档 + 外围更淡一档」的**纯横向**渐变：它是一条贴在面板左侧的竖直窄条，
   顶部/底部一点不出、也没有任何竖向方向性；两档颜色令牌化 → 深浅主题各一套（浅色要很轻）。
   right:100% 把它放在面板左边缘外侧；pointer-events:none 保证不吃聊天区边缘的点击。 */
.dsh-obs-panel::before{content:"";position:absolute;right:100%;top:0;bottom:0;width:var(--ob-edge-w,26px);pointer-events:none;
  background:linear-gradient(to left,var(--ob-edge-near,rgba(0,0,0,.30)),var(--ob-edge-far,rgba(0,0,0,.08)) 45%,transparent)}
/* 宿主模态弹窗（设置 / 归档会话…）打开时给面板挂 .behind：面板下移一层，弹窗不再被盖住。
   弹窗消失后由 JS 把原 z-index 写回（见 ensurePanelBehind）。 */
.dsh-obs-panel.behind{z-index:1}
/* 收件箱 / 回收站入口这一排**不再带主题色**（用户：靛蓝底「没有意义」）：
   悬停只给中性灰蓝一档，字色走主题令牌（旧版的 rgba(109,124,255,.16) 靛蓝底 + 硬编码 #e8ebf4 已去掉）。 */
.dsh-obs-inbox-link{cursor:pointer;border-radius:6px;padding:1px 4px;transition:background .15s,color .15s}
.dsh-obs-inbox-link:hover{background:rgba(148,163,215,.12);color:var(--ob-tx)}
.dsh-obs-flash{outline:2px solid rgba(109,124,255,.85);outline-offset:3px;border-radius:10px}
.dsh-obs-foot .fin{cursor:pointer;font-size:11px;line-height:14px;font-weight:600;color:var(--ob-chip-tx);padding:1px 5px;border-radius:7px;background:var(--ob-chip-bg);box-shadow:inset 0 0 0 1px var(--ob-chip-bd);transition:background-color .3s cubic-bezier(.4,0,.2,1),color .3s cubic-bezier(.4,0,.2,1),box-shadow .3s cubic-bezier(.4,0,.2,1)}
.dsh-obs-foot .fin:hover{background:rgba(109,124,255,.22);color:var(--ob-hi,#e8ebf4)}
/* 靛蓝紫信息框：第 2 行「收件箱 N」与第 3 行「自动导出 ?」共用上面那一套口径 ——
   底色/描边/字号/圆角/内边距/字重全一致（两行在任何状态下都统一；字重也从原来的 400/600 拉平到 600），
   差别只剩「有计数」那一档的字色。原来的黄框（琥珀底 + 黄字）已删除。
   描边用 inset box-shadow 而不是 border：不占布局盒，132px 宽度预算不变。 */
/* 有未处理笔记时字色再亮一档：同一混合公式（20% 强调色）在深色下更靠近白、浅色下更靠近黑，
   两端都是「更远离底色」→ 两种主题下都只是对比更强，不会变成看不清的一档。 */
.dsh-obs-foot .fin.has{color:var(--ob-chip-tx-hi)}
/* 第 3 行的框内是「标签 + ?」两件东西（框=信息，不可点）；开关在框外右侧（框外=操作） */
.dsh-obs-foot .fin.fauto{display:inline-flex;align-items:center;gap:3px;cursor:default}
.dsh-obs-grip{position:absolute;left:0;top:0;bottom:0;width:7px;cursor:col-resize;z-index:12;background:transparent;touch-action:none}
.dsh-obs-grip:hover,.dsh-obs-grip.on{background:linear-gradient(180deg,rgba(109,124,255,.55),rgba(52,211,153,.45))}
.dsh-obs-panel.dsh-obs-dragging{user-select:none}
.dsh-obs-panel.dsh-obs-dragging .dsh-obs-body{pointer-events:none}
/* ── 面板内的「靛蓝信息档」令牌：命名与底栏 .dsh-obs-foot 的那套完全一致
      （--ob-chip-bg / --ob-chip-bd / --ob-chip-tx / --ob-chip-tx-hi），口径也一致 ——
      底色 rgba(109,124,255,.14)、字 #c8cefc、强调档 #dde1fc（深色）；浅色下换成同色系的深靛蓝，
      保证两种主题都可读。面板内除下面那对**计数徽标令牌**（--ob-cnt-*）外没有任何黄/琥珀系，
      其余一律走这四个变量（改一处即全局统一）。 */
.dsh-obs-panel[data-theme="dark"]{--ob-bg:#0e1220;--ob-bg2:#0b0e18;--ob-tx:#e8ebf4;--ob-tx2:#9aa3bc;--ob-tx3:#7b849d;--ob-line:rgba(148,163,215,.10);--ob-line2:rgba(148,163,215,.18);--ob-link:#8fb8ff;--ob-link2:#6ee7b7;--ob-code:rgba(148,163,215,.09);--ob-hl:rgba(109,124,255,.30);--ob-chip-bg:rgba(109,124,255,.14);--ob-chip-bd:rgba(109,124,255,.30);--ob-chip-tx:#c8cefc;--ob-chip-tx-hi:#dde1fc;--ob-cnt-bg:rgba(251,191,36,.18);--ob-cnt-bd:rgba(251,191,36,.40);--ob-cnt-tx:#fcd34d;--ob-info:#8fb8ff;--ob-info2:#38bdf8;--ob-ok:#6ee7b7;--ob-ok2:#a7f3d0;--ob-ok3:#d1fae5;--ob-run:#93c5fd;--ob-bad:#fca5a5;--ob-bad2:#f87171;--ob-purple:#c4b5fd;--ob-dim:#c3cadd;--ob-hi:#e8ebf4;--ob-step-on:#4f46e5;--ob-on-dark:#e8ebf4;--ob-on-dark-dim:#c3cadd;--ob-edge-w:28px;--ob-edge-near:rgba(0,0,0,.086);--ob-edge-far:rgba(0,0,0,.024);--ob-shadow-pop:0 14px 34px rgba(0,0,0,.45);--ob-shadow-view:0 18px 50px rgba(0,0,0,.50);--ob-shadow-bar:0 8px 20px rgba(0,0,0,.38)}
.dsh-obs-panel[data-theme="light"]{--ob-bg:#f7f9fd;--ob-bg2:#eef2fa;--ob-tx:#1d2436;--ob-tx2:#4a5470;--ob-tx3:#5f6980;--ob-line:rgba(90,110,170,.14);--ob-line2:rgba(90,110,170,.24);--ob-link:#2f5fd0;--ob-link2:#0f766e;--ob-code:rgba(90,110,170,.07);--ob-hl:rgba(109,124,255,.22);--ob-chip-bg:rgba(109,124,255,.12);--ob-chip-bd:rgba(109,124,255,.34);--ob-chip-tx:#39408f;--ob-chip-tx-hi:#272e77;--ob-cnt-bg:rgba(202,138,4,.16);--ob-cnt-bd:rgba(202,138,4,.38);--ob-cnt-tx:#854d0e;--ob-info:#1d4ed8;--ob-info2:#0369a1;--ob-ok:#0f766e;--ob-ok2:#115e59;--ob-ok3:#134e4a;--ob-run:#1d4ed8;--ob-bad:#b91c1c;--ob-bad2:#991b1b;--ob-purple:#6d28d9;--ob-dim:#3f4a63;--ob-hi:#111827;--ob-step-on:#4338ca;--ob-on-dark:#e8ebf4;--ob-on-dark-dim:#c3cadd;--ob-edge-w:28px;--ob-edge-near:rgba(15,23,42,.086);--ob-edge-far:rgba(15,23,42,.024);--ob-shadow-pop:0 8px 18px rgba(15,23,42,.14);--ob-shadow-view:0 10px 26px rgba(15,23,42,.16);--ob-shadow-bar:0 5px 12px rgba(15,23,42,.12)}
.dsh-obs-head{padding:11px 13px 9px;border-bottom:1px solid var(--ob-line);display:flex;align-items:center;gap:9px;background:var(--ob-bg)}
.dsh-obs-head .logo{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,rgba(109,124,255,.3),rgba(167,139,250,.25));border:1px solid rgba(109,124,255,.45);display:flex;align-items:center;justify-content:center;font-size:13px;flex:0 0 auto}
.dsh-obs-head .t{min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:13.5px;font-weight:700;line-height:1.25;white-space:nowrap}
.dsh-obs-head .t small{display:block;font-size:10px;color:var(--ob-tx3);font-weight:400}
.dsh-obs-head .sp{flex:1}
.dsh-obs-btn{flex:0 0 auto;white-space:nowrap;font-size:11px;color:var(--ob-tx2);background:var(--ob-bg2);border:1px solid var(--ob-line2);border-radius:8px;padding:5.5px 10px;cursor:pointer;font-family:inherit}
.dsh-obs-btn:hover{border-color:#6d7cff;color:var(--ob-tx)}
.dsh-obs-btn:disabled{opacity:.55;cursor:default}
.dsh-obs-btn.evo{background:linear-gradient(135deg,#34d399,#3b82f6);color:#fff;font-weight:700;border:none;box-shadow:0 3px 12px rgba(59,130,246,.3)}
.dsh-obs-btn.primary{background:linear-gradient(135deg,rgba(59,130,246,.85),rgba(139,92,246,.85));color:#fff;border:none;font-weight:600}
.dsh-obs-btn.danger{background:var(--ob-chip-bg);border-color:var(--ob-chip-bd);color:var(--ob-chip-tx-hi);font-weight:700}
.dsh-obs-btn.danger:hover{background:rgba(109,124,255,.28);border-color:#6d7cff}
.dsh-obs-btn.x{padding:5.5px 8px}
/* 「新建笔记」在新建状态下的激活态：与「✎ 编辑 / 👁 阅读」选中态**同一条声明**
   （见下面 .dsh-obs-mb.on,.dsh-obs-btn.on 那一条），这里只把按钮自带的 1px 边框置透明，
   让两处可见描边都来自同一层 inset 阴影 —— 视觉语言（渐变/字重/描边/字色）完全一致。
   选择器与 .dsh-obs-btn:hover 同权重且在后面 → 悬停时激活态不被灰边框盖掉。 */
.dsh-obs-btn.on{border-color:transparent}
.dsh-obs-status{border-top:1px solid var(--ob-line);padding:8px 13px;display:flex;align-items:center;gap:12px;font-size:10.5px;color:var(--ob-tx3);background:var(--ob-bg);flex:0 0 auto;white-space:nowrap}
.dsh-obs-status .dot{width:7px;height:7px;border-radius:50%;background:#34d399;box-shadow:0 0 8px rgba(52,211,153,.7);display:inline-block;margin-right:5px;vertical-align:1px}
.dsh-obs-status .dot.bad{background:#6d7cff;box-shadow:0 0 8px rgba(109,124,255,.7)}
/* 收件箱 / 回收站**计数徽标**：整排里唯一带底色的元素，也是全面板唯一放开黄/琥珀的地方
   （用户明确要求「数字用回以前那种高亮底色」）。标签文字（"📥 收件箱"/"♻ 回收站"）保持灰字低调口径，
   整排不套任何底色框；同名的 .dsh-obs-foot .fin（侧栏底栏那行）仍是靛蓝档，不受这里影响。 */
.dsh-obs-status .inbox,.dsh-obs-status .trashn{background:var(--ob-cnt-bg);color:var(--ob-cnt-tx);border:1px solid var(--ob-cnt-bd);padding:1.5px 8px;border-radius:8px;font-weight:700}
.dsh-obs-pop{position:absolute;top:44px;right:12px;width:270px;background:var(--ob-bg);border:1px solid var(--ob-line2);border-radius:14px;box-shadow:var(--ob-shadow-pop);padding:10px;z-index:25}
.dsh-obs-pop .row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;border:1px solid var(--ob-line2);cursor:pointer;margin-bottom:6px}
.dsh-obs-pop .row.on{border-color:#6d7cff;box-shadow:0 0 14px rgba(109,124,255,.2)}
.dsh-obs-pop .row b{font-size:12px;display:block}
.dsh-obs-pop .row small{font-size:10px;color:var(--ob-tx3);display:block;margin-top:1px}
.dsh-obs-pop .thumb{width:46px;height:28px;border-radius:7px;flex-shrink:0;border:1px solid rgba(148,163,215,.3)}
.dsh-obs-pop .ck{margin-left:auto;width:16px;height:16px;border-radius:50%;border:1.5px solid var(--ob-line2)}
.dsh-obs-pop .row.on .ck{background:#6d7cff;border-color:#6d7cff;box-shadow:inset 0 0 0 2.5px var(--ob-bg)}
/* ── 页签条 ── */
.dsh-obs-tabs{display:flex;align-items:center;gap:4px;padding:6px 10px;border-bottom:1px solid var(--ob-line);background:var(--ob-bg2);flex:0 0 auto}
.dsh-obs-tabs .sp{flex:1}
.dsh-obs-tab{white-space:nowrap;font-size:11.5px;color:var(--ob-tx2);background:transparent;border:1px solid transparent;border-radius:8px;padding:4px 10px;cursor:pointer;font-family:inherit}
.dsh-obs-tab:hover{color:var(--ob-tx);background:rgba(109,124,255,.10)}
.dsh-obs-tab.on{color:var(--ob-hi,#e8ebf4);font-weight:700;background:linear-gradient(135deg,rgba(109,124,255,.22),rgba(52,211,153,.10));border-color:rgba(109,124,255,.40)}
.dsh-obs-live{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--ob-tx3);white-space:nowrap;flex:0 0 auto}
.dsh-obs-live i{width:7px;height:7px;border-radius:50%;background:#6d7cff;display:inline-block}
.dsh-obs-live.ok{color:var(--ob-ok,#6ee7b7)}
.dsh-obs-live.ok i{background:#34d399;box-shadow:0 0 8px rgba(52,211,153,.7)}
/* ── 面板主体 ── */
.dsh-obs-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.dsh-obs-pane{flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto;padding:9px 11px 11px;scrollbar-width:thin}
.dsh-obs-pane[hidden]{display:none}
.dsh-obs-tool{display:flex;align-items:center;gap:6px;margin-bottom:6px}
.dsh-obs-tool .sp{flex:1}
.dsh-obs-in{min-width:0;flex:1;background:var(--ob-bg2);color:var(--ob-tx);border:1px solid var(--ob-line2);border-radius:8px;padding:5px 8px;font-size:11.5px;font-family:inherit;outline:none}
.dsh-obs-in:focus{border-color:#6d7cff}
select.dsh-obs-in{flex:0 0 auto;max-width:104px}
.line{font-size:10.5px;color:var(--ob-tx3);line-height:1.6;margin-bottom:6px;word-break:break-word}
.line.bad{color:var(--ob-bad,#fca5a5)}
.dsh-obs-list{flex:1;min-height:0}
.dsh-obs-item{border:1px solid var(--ob-line);border-radius:9px;padding:6px 8px;margin-bottom:5px;cursor:pointer;background:var(--ob-bg2)}
.dsh-obs-item:hover{border-color:rgba(109,124,255,.45)}
.dsh-obs-item .it{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-obs-item .ip{font-size:10px;color:var(--ob-tx3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
.dsh-obs-item .im{display:flex;flex-wrap:wrap;gap:5px;margin-top:3px;font-size:10px;color:var(--ob-tx3);align-items:center}
.dsh-obs-item .tg{color:var(--ob-info,#8fb8ff);background:rgba(109,124,255,.14);border-radius:6px;padding:0 5px}
.dsh-obs-item .ex{font-size:10.5px;color:var(--ob-tx2);margin-top:4px;line-height:1.55;word-break:break-word}
.dsh-obs-item mark{background:rgba(109,124,255,.32);color:inherit;border-radius:3px}
/* 笔记列表条目的标题行（含右侧删除键）：只加在笔记页，其他页的 .it 不受影响 */
.dsh-obs-item .itrow{display:flex;align-items:center;gap:6px}
.dsh-obs-item .itrow .itt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-obs-del{flex:0 0 auto;font-family:inherit;font-size:12px;line-height:1;color:var(--ob-tx2);background:transparent;border:1px solid transparent;border-radius:6px;padding:2px 5px;cursor:pointer}
.dsh-obs-del:hover{color:var(--ob-bad,#fca5a5);border-color:rgba(248,113,113,.5);background:rgba(248,113,113,.12)}
/* 「交给 DSH」键：与删除键同尺寸并排；hover 用紫（=DSH/AI）而非红（危险），避免和删除混淆 */
.dsh-obs-hand{flex:0 0 auto;font-family:inherit;font-size:12px;line-height:1;color:var(--ob-tx2);background:transparent;border:1px solid transparent;border-radius:6px;padding:2px 5px;cursor:pointer}
.dsh-obs-hand:hover{color:var(--ob-purple,#c4b5fd);border-color:rgba(167,139,250,.5);background:rgba(167,139,250,.12)}
.dsh-obs-hand[disabled]{opacity:.45;cursor:default}
.dsh-obs-empty{font-size:11px;color:var(--ob-tx3);padding:10px 2px;line-height:1.7}
.dsh-obs-empty.bad{color:var(--ob-bad,#fca5a5)}
/* ── 编辑页 ── */
.dsh-obs-ta{flex:1;min-height:190px;width:100%;box-sizing:border-box;resize:none;background:var(--ob-bg2);color:var(--ob-tx);border:1px solid var(--ob-line2);border-radius:9px;padding:8px 9px;font:12px/1.65 Consolas,"Microsoft YaHei",monospace;white-space:pre;overflow:auto;outline:none;tab-size:2}
.dsh-obs-ta:focus{border-color:#6d7cff}
.dsh-obs-fm{border:1px dashed var(--ob-line2);border-radius:8px;padding:5px 8px;margin-bottom:6px;font-size:10.5px;color:var(--ob-tx2);line-height:1.6;word-break:break-word;max-height:96px;overflow:auto}
.dsh-obs-fm .k{color:var(--ob-info,#8fb8ff)}
/* ── 结构页 ── */
.dsh-obs-sec{border-top:1px dashed var(--ob-line);padding:7px 0 2px;margin-top:5px}
.dsh-obs-sec:first-child{border-top:none;padding-top:0;margin-top:0}
.dsh-obs-sec .sh{font-size:11px;font-weight:700;color:var(--ob-tx2);margin-bottom:5px;display:flex;align-items:center;gap:6px}
.dsh-obs-sec .sh .sp{flex:1}
.tnode{display:flex;align-items:center;gap:5px;font-size:11.5px;padding:2px 4px;cursor:pointer;border-radius:6px;white-space:nowrap}
.tnode:hover{background:rgba(109,124,255,.10)}
.tnode .tgl{width:12px;flex:0 0 auto;color:var(--ob-tx3);font-size:10px;text-align:center}
.tnode .tdir{overflow:hidden;text-overflow:ellipsis}
.tnode .tcnt{margin-left:auto;font-size:9.5px;color:var(--ob-tx3)}
/* 目录节点上的「移动」入口：与笔记页「还原」键同一套小按钮口径，常驻可见（不靠 hover 才出现），
   有计数徽标时让计数先占 margin-left:auto，入口再靠右贴边。
   .tdir 加 min-width:0：目录名过长时让它收缩出省略号，入口不会被挤出面板外点不到。 */
.tnode .tdir{min-width:0}
.tnode .tmv{flex:0 0 auto;font-family:inherit;font-size:9.5px;line-height:1;font-weight:700;color:var(--ob-chip-tx-hi);background:var(--ob-chip-bg);border:1px solid var(--ob-chip-bd);border-radius:6px;padding:2px 6px;margin-left:6px;cursor:pointer;white-space:nowrap}
.tnode .tcnt + .tmv{margin-left:6px}
.tnode .tmv:hover{background:rgba(109,124,255,.28);border-color:#6d7cff;color:var(--ob-tx)}
/* 目录「移动」浮层：位置/视觉与面板既有浮层（.dsh-obs-pop / toast / 确认条）同一口径 ——
   挂在 panelEl（fixed）上做 absolute，右上角落下，不盖住底栏的 toast/确认条 */
.dsh-obs-dmv{position:absolute;top:44px;right:12px;width:306px;max-width:calc(100% - 24px);background:var(--ob-bg);border:1px solid rgba(109,124,255,.5);border-radius:14px;box-shadow:var(--ob-shadow-pop);padding:10px;z-index:26}
.dsh-obs-dmv .dmv-h{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;color:var(--ob-tx2);margin-bottom:6px}
.dsh-obs-dmv .dmv-h .sp{flex:1}
.dsh-obs-dmv .dmv-cur{font-size:10.5px;line-height:1.6;color:var(--ob-tx3);margin-bottom:6px;word-break:break-all}
.dsh-obs-dmv .dmv-cur b{color:var(--ob-chip-tx-hi)}
.dsh-obs-dmv .dmv-tip{font-size:10px;color:var(--ob-tx3)}
.dsh-obs-dmv .dmv-err{font-size:10.5px;line-height:1.55;color:var(--ob-bad,#fca5a5);margin-top:5px;word-break:break-word}
/* ── 进化页 ── */
.efile{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--ob-tx2);padding:3px 6px;border-radius:6px;cursor:pointer;border:1px solid transparent;white-space:nowrap}
.efile:hover{background:rgba(109,124,255,.10);border-color:var(--ob-line2)}
.efile span{overflow:hidden;text-overflow:ellipsis}
.efile b{margin-left:auto;font-size:9.5px;color:var(--ob-info,#8fb8ff);font-weight:600}
/* 技能来源筛选（分段控件）：本地 / 库内 / 全部，计数直接写在按钮上。
   三个按钮等宽（flex:1），窄面板下也不会换行。 */
.evo-sk-f{display:flex;gap:4px;margin:0 0 6px}
.evo-sk-t{flex:1 1 0;min-width:0;font-family:inherit;font-size:10.5px;line-height:1.5;color:var(--ob-tx2);background:var(--ob-bg2);border:1px solid var(--ob-line2);border-radius:8px;padding:3.5px 4px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.evo-sk-t:hover{border-color:rgba(109,124,255,.45);color:var(--ob-tx)}
.evo-sk-t.on{color:var(--ob-hi,#e8ebf4);font-weight:700;background:linear-gradient(135deg,rgba(109,124,255,.22),rgba(52,211,153,.10));border-color:rgba(109,124,255,.40)}
.evo-sk-t .n{color:var(--ob-chip-tx-hi);font-weight:700}
/* 内容查看器（技能 / 任务 / .dsh 文件）：**只读浮层**，复用笔记页的 markdown 渲染（.obs-doc / .obs-props）。
   技能正文往往很长，浮层刻意比面板（默认 470px）宽，内容区独立滚动 —— 但**不动面板自身的尺寸/定位**，
   所以左移、底栏三行、工具条响应式收缩都不受影响。定位用 fixed：面板及其祖先都没有 transform
   （唯一的 transform 在底栏开关的滑块 .obssw i 上，不是祖先），故这里是相对视口居中。
   注意 [hidden] 必须显式写：下面给了 display:flex，会盖掉 UA 的 [hidden]{display:none}。 */
.evo-view{position:fixed;top:5vh;left:50%;transform:translateX(-50%);width:min(900px,92vw);max-height:88vh;display:flex;flex-direction:column;box-sizing:border-box;background:var(--ob-bg);border:1px solid var(--ob-line2);border-radius:14px;box-shadow:var(--ob-shadow-view);padding:9px 12px 11px;margin:0;z-index:40}
.evo-view[hidden]{display:none}
.evo-view .sh{flex:0 0 auto;margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid var(--ob-line)}
.evo-view .evo-view-t{max-width:54%}
.evo-view .evo-view-b{flex:0 0 auto;display:inline-flex;gap:5px}
.evo-view .evo-doc{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding-right:3px}
.evo-view .evo-doc .obs-doc{max-width:none;margin:0;padding:2px 2px 16px}
/* M3-B 知识自进化控制台：状态条 / 徽标 / 内联表单 */
.evo-sb{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;font-size:10.5px;color:var(--ob-tx3);background:var(--ob-bg2);border:1px solid var(--ob-line2);border-radius:9px;padding:6px 8px;margin-bottom:8px}
.evo-sb b{color:var(--ob-tx);font-weight:700}
.evo-sb .sp{flex:1}
.evo-sb .dot{width:7px;height:7px;border-radius:50%;background:#34d399;box-shadow:0 0 8px rgba(52,211,153,.7);display:inline-block;margin-right:4px;vertical-align:1px}
.evo-sb .dot.bad{background:#6d7cff;box-shadow:0 0 8px rgba(109,124,255,.7)}
.evo-badge{flex:0 0 auto;font-size:9.5px;line-height:1.55;padding:0 5px;border-radius:7px;border:1px solid var(--ob-line2);color:var(--ob-tx3);white-space:nowrap}
.evo-badge.dir{color:var(--ob-info,#8fb8ff);background:rgba(109,124,255,.14);border-color:rgba(109,124,255,.35)}
.evo-badge.tag{color:var(--ob-ok,#6ee7b7);background:rgba(52,211,153,.14);border-color:rgba(52,211,153,.35)}
.evo-badge.wait{color:var(--ob-chip-tx-hi);background:var(--ob-chip-bg);border-color:var(--ob-chip-bd)}
.evo-badge.run{color:var(--ob-run,#93c5fd);background:rgba(59,130,246,.16);border-color:rgba(59,130,246,.40)}
.evo-badge.done{color:var(--ob-ok,#6ee7b7);background:rgba(52,211,153,.14);border-color:rgba(52,211,153,.35)}
/* 技能来源标签：本地（桥写的 .dsh/skills/*.md，可删） / 库内（vault 内 <名>/SKILL.md，只读） */
.evo-badge.local{color:var(--ob-run,#93c5fd);background:rgba(59,130,246,.16);border-color:rgba(59,130,246,.40)}
.evo-badge.vault{color:var(--ob-chip-tx-hi);background:var(--ob-chip-bg);border-color:var(--ob-chip-bd)}
/* 技能卡「可管」三态：已导出 / 未导出 / 已停用（停用只改 frontmatter，正文不动） */
.evo-badge.mirror{color:var(--ob-ok,#6ee7b7);background:rgba(52,211,153,.14);border-color:rgba(52,211,153,.35)}
.evo-badge.nomirror{color:var(--ob-tx3);background:transparent;border-color:var(--ob-line2)}
.evo-badge.off{color:var(--ob-bad,#fca5a5);background:rgba(239,68,68,.14);border-color:rgba(239,68,68,.35)}
/* 停用的技能卡：整张灰掉（一眼看出「开工检索会跳过它」），但按钮仍可用（方便再启用） */
.evo-skills .dsh-obs-item.off{opacity:.55;filter:grayscale(1)}
.evo-skills .dsh-obs-item.off:hover{filter:grayscale(.35)}
/* 技能卡度量行：用过 N 次 · 成功 M · 最近 X（无记录 = 尚未使用） */
.evo-sk-m{font-size:10px;line-height:1.5;color:var(--ob-tx3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.evo-sk-acts{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end}
.evo-ro{flex:0 0 auto;font-size:9.5px;line-height:1.55;padding:0 4px;border-radius:7px;color:var(--ob-tx3);opacity:.75;white-space:nowrap}
/* ── 5b) 提示词 / 模板 / 检查清单（第四类进化对象） ──
   面板里只有这一个下拉（类型），样式与 .dsh-obs-in 同一套，只额外给自绘箭头留 18px 内边距；
   刻意**不加 .tagsel**：那个 class 被 onChange 当成「标签筛选」监听（会触发 doSearch），挂上会串台。 */
.dsh-obs-sel{flex:0 0 auto;width:96px;appearance:none;-webkit-appearance:none;padding-right:18px;cursor:pointer;
  background-image:linear-gradient(45deg,transparent 50%,var(--ob-tx3) 50%),linear-gradient(135deg,var(--ob-tx3) 50%,transparent 50%);
  background-position:calc(100% - 12px) 52%,calc(100% - 8px) 52%;background-size:4px 4px,4px 4px;background-repeat:no-repeat}
.evo-prompt-form{border:1px solid rgba(109,124,255,.42);border-radius:10px;padding:7px 8px;margin:5px 0;background:var(--ob-bg2)}
.evo-prompt-form .line{margin-bottom:4px}
.evo-pr-f{display:flex;gap:4px;margin:4px 0 6px}
.evo-pr-cands{border:1px solid var(--ob-line2);border-radius:9px;background:var(--ob-code);padding:5px 7px;margin:6px 0}
.evo-pcand-n{font-weight:700;color:var(--ob-tx2)}
.evo-pcand-tip{font-size:10px;line-height:1.6;color:var(--ob-tx3);margin:2px 0 5px}
.evo-pr-cands .dsh-obs-item{margin-bottom:5px}
.evo-pr-cands[hidden],.evo-pcand-body[hidden]{display:none}
.evo-rpta{width:100%;box-sizing:border-box;height:52px;min-height:44px;resize:vertical;background:var(--ob-bg2);color:var(--ob-tx);border:1px solid var(--ob-line2);border-radius:8px;padding:5px 8px;font:11px/1.6 Consolas,"Microsoft YaHei",monospace;outline:none;margin-bottom:5px;white-space:pre-wrap}
.evo-rpta:focus{border-color:#6d7cff}
.evo-report[hidden],.evo-skill-form[hidden]{display:none}
/* 任务队列 / 已完成归档视图（两者互斥显示；归档是只读列表，故不显示手型光标） */
.evo-queue[hidden],.evo-archive[hidden]{display:none}
.evo-archive .dsh-obs-item{cursor:default}
.evo-archive .dsh-obs-item:hover{border-color:var(--ob-line)}
.evo-arch-n{font-weight:700;color:var(--ob-tx2)}
.evo-arch-res{font-size:10.5px;color:var(--ob-tx2);margin-top:2px;line-height:1.5;word-break:break-word}
/* ── 任务卡「自解释」UI：状态步进器 + 一行「下一步」提示 + 主/次按钮分级 ──
   验收口径：**不看解释，第一眼就知道下一步点哪** ——
   · 每个状态只有 1 个主按钮（复用 .dsh-obs-btn.primary：实心渐变），其余动作降级为扁平次级按钮；
   · 生命周期画在卡里（待执行 → 执行中 → 已完成：当前步高亮 / 走过的打勾），不靠外部说明；
   · 固定长说明收进标题旁 .evo-qm 的 title（悬停才看），不再常驻占位。 */
.evo-steps{display:flex;align-items:center;gap:4px;flex-wrap:wrap;font-size:10px;line-height:1.7;color:var(--ob-tx3);margin:5px 0 1px}
.evo-step{display:inline-flex;align-items:center;gap:3px;padding:0 6px;border-radius:7px;border:1px dashed var(--ob-line2)}
.evo-step .n{display:inline-flex;align-items:center;justify-content:center;width:12px;height:12px;border-radius:50%;font-size:9px;font-weight:700;background:var(--ob-code);border:1px solid var(--ob-line2)}
.evo-step.done{color:var(--ob-ok,#6ee7b7);border-style:solid;border-color:rgba(52,211,153,.40);background:rgba(52,211,153,.10)}
.evo-step.done .n{background:rgba(52,211,153,.22);border-color:rgba(52,211,153,.45);color:var(--ob-ok,#6ee7b7)}
.evo-step.on{color:var(--ob-hi,#e8ebf4);font-weight:700;border-style:solid;border-color:rgba(109,124,255,.60);background:linear-gradient(135deg,rgba(109,124,255,.30),rgba(59,130,246,.16))}
.evo-step.on .n{background:var(--ob-step-on,#6d7cff);border-color:var(--ob-step-on,#6d7cff);color:#fff}
.evo-step.done.on{color:var(--ob-ok2,#a7f3d0);border-color:rgba(52,211,153,.65);background:rgba(52,211,153,.18);box-shadow:0 0 10px rgba(52,211,153,.16)}
.evo-step.done.on .n{background:rgba(52,211,153,.30);border-color:rgba(52,211,153,.60);color:var(--ob-ok3,#d1fae5)}
.evo-step-ar{opacity:.65}
.evo-task-next{font-size:10.5px;line-height:1.6;color:var(--ob-tx2);margin:3px 0 4px;padding-left:7px;border-left:2px solid rgba(109,124,255,.5)}
.evo-task-next::before{content:"→ ";color:var(--ob-info,#8fb8ff);font-weight:700}
/* 候选卡里的一句「同源」锚点：这条提炼任务**就是**下方「任务队列」里的那张卡（同一份状态，不是两件事） */
.evo-cand-same{font-size:10px;line-height:1.6;color:var(--ob-tx3);margin:2px 0 1px;padding-left:7px;border-left:2px solid rgba(52,211,153,.45)}
.evo-task-ro{flex:0 0 auto;font-size:9.5px;line-height:1.55;padding:0 5px;border-radius:7px;color:var(--ob-tx3);background:var(--ob-code);border:1px solid var(--ob-line2);white-space:nowrap}
/* 候选区「已交给 DSH」状态化反馈：按钮点完就地变成这枚绿标（不可能重复点） */
.evo-cand-sent{flex:0 0 auto;font-size:10px;line-height:1.55;padding:0 6px;border-radius:7px;color:var(--ob-ok,#6ee7b7);background:rgba(52,211,153,.14);border:1px solid rgba(52,211,153,.38);white-space:nowrap}
/* ── DSH Skill 待提炼候选（技能区**上方**：先「待提炼」→ 再「已有技能」，符合工作流） ──
   只读列表；每条**未交给 DSH** 时一个「交给 DSH 提炼」按钮，**已交给 DSH** 时按钮换绿标、
   卡内直接画它自己的流程（复用 .evo-steps / .evo-task-next，无需新样式）；
   **本区不出现任何删除 / 编辑入口**（红线）。 */
.evo-cands[hidden],.evo-cand-body[hidden]{display:none}
.evo-cand{cursor:default}
.evo-cand:hover{border-color:var(--ob-line)}
.evo-cand-score{flex:0 0 auto;font-size:9.5px;line-height:1.55;padding:0 5px;border-radius:7px;color:var(--ob-info,#8fb8ff);background:rgba(109,124,255,.14);border:1px solid rgba(109,124,255,.35);white-space:nowrap}
.evo-cand-ev{font-size:10px;color:var(--ob-tx3);margin-top:3px;line-height:1.6;word-break:break-word}
.evo-cand-n{font-weight:700;color:var(--ob-tx2)}
.evo-topics .sh,.evo-gaps-h .sh{margin:6px 0 4px}
.evo-sb .line{margin:0}
/* ── 自动导出开关（进化页 · 收件箱区块下方）：小开关 + 文案后的 ? 悬停提示 ── */
.evo-sw-row{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--ob-tx2);padding:1px 0 2px}
.evo-sw-row .sp{flex:1}
.evo-sw{position:relative;flex:0 0 auto;width:34px;height:19px;border-radius:11px;background:#2a2f40;border:1px solid var(--ob-line2);cursor:pointer;transition:background .15s,border-color .15s}
.evo-sw i{position:absolute;width:15px;height:15px;border-radius:50%;background:#6b7288;top:1px;left:1px;transition:all .15s}
.evo-sw.on{background:linear-gradient(90deg,#3b82f6,#8b5cf6);border-color:rgba(109,124,255,.5);box-shadow:0 0 10px rgba(109,124,255,.35)}
.evo-sw.on i{left:16px;background:#fff}
.evo-sw[data-busy="1"]{opacity:.55;cursor:default}
.evo-sw:focus-visible{outline:2px solid rgba(109,124,255,.7);outline-offset:2px}
.evo-qm{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;font-size:10px;font-weight:700;line-height:1;color:var(--ob-tx3);background:var(--ob-code);border:1px solid var(--ob-line2);cursor:help}
.evo-qm:hover{color:var(--ob-tx);border-color:#6d7cff}
/* ── 面板内提示条 / 覆盖确认条（不使用 alert 打断操作） ── */
.dsh-obs-toast{position:absolute;left:12px;right:12px;bottom:44px;z-index:19;background:var(--ob-bg2);border:1px solid var(--ob-line2);border-radius:10px;padding:8px 10px;font-size:11px;line-height:1.55;color:var(--ob-tx2);box-shadow:var(--ob-shadow-bar);word-break:break-word}
.dsh-obs-toast.ok{border-color:rgba(52,211,153,.55);color:var(--ob-ok2,#a7f3d0)}
.dsh-obs-toast.bad{border-color:rgba(248,113,113,.55);color:var(--ob-bad,#fca5a5)}
.dsh-obs-toast[hidden]{display:none}
.dsh-obs-cf{position:absolute;left:12px;right:12px;bottom:44px;z-index:20;background:var(--ob-bg2);border:1px solid rgba(109,124,255,.55);border-radius:10px;padding:8px 10px;display:flex;align-items:center;gap:8px;font-size:11px;color:var(--ob-tx2);box-shadow:var(--ob-shadow-bar)}
.dsh-obs-cf .cfm{flex:1;min-width:0;line-height:1.55;word-break:break-word}
.dsh-obs-cf[hidden]{display:none}
/* ── 面板内「新建笔记」表单（字段：标题/描述/标签/日期/目标目录/正文）
      · 基类 .dsh-obs-nf 是浮层形态（保留给需要覆盖在内容之上的场合）；
      · .nfin = 新建状态变体：编辑区整体切换成这个表单时用它 —— 去绝对定位、随面板滚动，
        旧笔记内容与其编辑框在该状态下根本不渲染（见 renderEdit） ── */
.dsh-obs-nf{position:absolute;left:12px;right:12px;bottom:44px;z-index:21;background:var(--ob-bg2);border:1px solid rgba(109,124,255,.55);border-radius:10px;padding:9px 10px;box-shadow:var(--ob-shadow-pop)}
.dsh-obs-nf[hidden]{display:none}
.dsh-obs-nf .nfh{font-size:11.5px;font-weight:700;color:var(--ob-tx);margin-bottom:7px;display:flex;align-items:center;gap:6px}
.dsh-obs-nf .nfr{display:flex;align-items:center;gap:6px;margin-bottom:5px}
.dsh-obs-nf .nfr .lb{flex:0 0 52px;font-size:11px;color:var(--ob-tx2);text-align:right}
.dsh-obs-nf .nfr .dsh-obs-in{flex:1;min-width:0}
.dsh-obs-nf .nf-foot{display:flex;align-items:center;gap:6px;margin-top:7px}
.dsh-obs-nf .nf-foot .sp{flex:1}
.dsh-obs-nf .nferr{font-size:10.5px;color:var(--ob-bad,#fca5a5);line-height:1.55;margin-top:5px;word-break:break-word}
.dsh-obs-nf .nferr[hidden]{display:none}
/* 正文输入框（多行、可滚动）：字段之后 / 创建取消之前，占表单的主要高度。
   .nfr-body 这一行把 .nfr 的 align-items:center 改成 stretch，让 textarea 撑满整行高度。 */
.dsh-obs-nf .nfr-body{align-items:stretch}
.dsh-obs-nf .nfr-body .lb{padding-top:5px}
.dsh-obs-nf .nf-body{flex:1;min-width:0;min-height:170px;box-sizing:border-box;resize:none;background:var(--ob-bg2);color:var(--ob-tx);border:1px solid var(--ob-line2);border-radius:9px;padding:8px 9px;font:12px/1.65 Consolas,"Microsoft YaHei",monospace;white-space:pre-wrap;overflow:auto;outline:none;tab-size:2;scrollbar-width:thin}
.dsh-obs-nf .nf-body:focus{border-color:#6d7cff}
/* ── 新建状态（编辑区整体替换）── */
.dsh-obs-nf.nfin{position:static;left:auto;right:auto;bottom:auto;z-index:auto;box-shadow:none;padding:11px 12px;display:flex;flex-direction:column;flex:1;min-height:0}
.dsh-obs-nf.nfin .nfh{margin-bottom:9px}
.dsh-obs-nf.nfin .nfh .sp{flex:1}
.dsh-obs-nf.nfin .nfh .nfsub{font-size:10.5px;font-weight:400;color:var(--ob-tx3)}
.dsh-obs-nf.nfin .nfr{margin-bottom:8px}
.dsh-obs-nf.nfin .nfr .lb{flex:0 0 60px;font-size:11.5px}
.dsh-obs-nf.nfin .nfr-body{flex:1;min-height:150px;margin-bottom:0}
.dsh-obs-nf.nfin .nf-foot{margin-top:10px;padding-top:9px;border-top:1px dashed var(--ob-line2)}
/* ══ 阅读视图：模式切换 + Obsidian 风格排版（颜色全部走 --ob-*，深/浅主题自动适配） ══ */
.dsh-obs-mode{display:flex;align-items:center;gap:2px;flex:0 0 auto;background:var(--ob-bg2);border:1px solid var(--ob-line2);border-radius:8px;padding:2px}
.dsh-obs-mb{font-family:inherit;font-size:11px;line-height:1;color:var(--ob-tx2);background:transparent;border:none;border-radius:6px;padding:4px 9px;cursor:pointer;white-space:nowrap}
.dsh-obs-mb:hover{color:var(--ob-tx);background:rgba(109,124,255,.12)}
.dsh-obs-mb.on,.dsh-obs-btn.on{color:var(--ob-hi,#e8ebf4);font-weight:700;background:linear-gradient(135deg,rgba(109,124,255,.30),rgba(52,211,153,.14));box-shadow:inset 0 0 0 1px rgba(109,124,255,.40)}
.dsh-obs-pane[data-mode="read"] .dsh-obs-fm{display:none}
.dsh-obs-pane[data-mode="read"] .dsh-obs-ta{display:none}
.dsh-obs-read{flex:1;min-height:190px;overflow:auto;border:1px solid var(--ob-line2);border-radius:9px;background:var(--ob-bg2);scrollbar-width:thin}
.dsh-obs-read[hidden]{display:none}
/* ══ 笔记查看器：投喂附件护栏提示（**只读**；missing > 0 才出现）══
   口径：GET /api/ingest/manifest?note=… 比对投喂清单里记的附件是否还在（present/missing）。
   只提示、给出恢复思路，**绝不自动改/补/删任何文件** ✗；无记录 / 全在 / 请求失败 → hidden。 */
.ing-mani{margin:0 0 6px;padding:5px 8px;font-size:11px;line-height:1.6;color:var(--ob-bad,#fca5a5);
  background:rgba(248,113,113,.10);border:1px solid rgba(248,113,113,.35);border-radius:8px;word-break:break-all}
.ing-mani[hidden]{display:none}
.obs-doc{max-width:700px;margin:0 auto;padding:14px 12px 26px;font-size:13.5px;line-height:1.7;color:var(--ob-tx);overflow-wrap:anywhere}
.obs-doc>*:first-child{margin-top:0}
.obs-doc p{margin:0 0 10px}
.obs-doc h1,.obs-doc h2,.obs-doc h3,.obs-doc h4,.obs-doc h5,.obs-doc h6{line-height:1.35;margin:18px 0 8px;font-weight:700;color:var(--ob-tx)}
.obs-doc h1{font-size:20px;padding-bottom:6px;border-bottom:1px solid var(--ob-line)}
.obs-doc h2{font-size:17px}.obs-doc h3{font-size:15px}.obs-doc h4{font-size:13.5px}
.obs-doc h5,.obs-doc h6{font-size:12.5px;color:var(--ob-tx2)}
.obs-doc hr{border:none;border-top:1px solid var(--ob-line2);margin:16px 0}
.obs-doc del{opacity:.72}
.obs-doc mark{background:var(--ob-hl);color:inherit;border-radius:3px;padding:0 2px}
.obs-doc code{font:12px/1.6 Consolas,"Microsoft YaHei",monospace;background:var(--ob-code);border:1px solid var(--ob-line);border-radius:5px;padding:1px 4px}
.obs-doc a{color:var(--ob-link);text-decoration:none;cursor:pointer}
.obs-doc a:hover{text-decoration:underline}
.obs-doc .obs-tag{color:var(--ob-link2);background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.30);border-radius:9px;padding:0 6px;font-size:12px;white-space:nowrap}
.obs-doc .obs-img{display:block;max-width:100%;height:auto;margin:8px 0;border:1px solid var(--ob-line);border-radius:8px}
.obs-doc .obs-video{display:block;max-width:100%;margin:8px 0;border:1px solid var(--ob-line2);border-radius:8px;background:#000}
.obs-doc .obs-audio{display:block;width:100%;margin:8px 0}
.obs-doc .obs-file{display:inline-block;margin:6px 0;font-size:12px;color:var(--ob-link);background:var(--ob-code);border:1px solid var(--ob-line2);border-radius:8px;padding:3px 9px}
.obs-doc .obs-code{position:relative;margin:10px 0;border:1px solid var(--ob-line2);border-radius:9px;background:var(--ob-code);overflow:hidden}
.obs-doc .obs-code pre{margin:0;padding:11px 10px;overflow:auto;max-width:100%}
.obs-doc .obs-code code{background:transparent;border:none;padding:0;font-size:12px;line-height:1.65;white-space:pre}
.obs-doc .obs-code-lang{position:absolute;top:0;right:0;font-size:9.5px;letter-spacing:.4px;color:var(--ob-tx3);background:var(--ob-bg2);border-left:1px solid var(--ob-line);border-bottom:1px solid var(--ob-line);border-radius:0 8px 0 8px;padding:1px 7px}
.obs-doc .obs-quote{margin:10px 0;padding:4px 12px;border-left:3px solid rgba(109,124,255,.55);border-radius:0 8px 8px 0;background:rgba(109,124,255,.06);color:var(--ob-tx2)}
.obs-doc .obs-quote>*:last-child{margin-bottom:0}
.obs-doc .obs-callout{margin:10px 0;padding:8px 10px;border:1px solid var(--ob-line2);border-left-width:3px;border-radius:9px;background:var(--ob-code)}
.obs-doc .obs-callout-t{font-weight:700;font-size:12.5px;margin-bottom:4px;color:var(--ob-tx2)}
.obs-doc .obs-callout-b>*:last-child{margin-bottom:0}
.obs-doc .obs-callout.note{border-left-color:#6d7cff}.obs-doc .obs-callout.note .obs-callout-t{color:var(--ob-link)}
.obs-doc .obs-callout.info{border-left-color:var(--ob-info2,#38bdf8)}.obs-doc .obs-callout.info .obs-callout-t{color:var(--ob-info2,#38bdf8)}
.obs-doc .obs-callout.tip{border-left-color:#34d399}.obs-doc .obs-callout.tip .obs-callout-t{color:var(--ob-link2)}
.obs-doc .obs-callout.warning{border-left-color:#6d7cff}.obs-doc .obs-callout.warning .obs-callout-t{color:var(--ob-link)}
.obs-doc .obs-callout.danger{border-left-color:var(--ob-bad2,#f87171)}.obs-doc .obs-callout.danger .obs-callout-t{color:var(--ob-bad2,#f87171)}
.obs-doc ul,.obs-doc ol{margin:6px 0 10px;padding-left:22px}
.obs-doc li{margin:2px 0}
.obs-doc li.obs-task{list-style:none;margin-left:-18px;display:flex;gap:6px;align-items:flex-start}
.obs-doc li.obs-task input{margin:4px 0 0;flex:0 0 auto;accent-color:#6d7cff}
.obs-doc .obs-tablewrap{max-width:100%;overflow-x:auto;margin:10px 0;border:1px solid var(--ob-line2);border-radius:9px}
.obs-doc table.obs-table{border-collapse:collapse;width:100%;font-size:12.5px}
.obs-doc .obs-table th,.obs-doc .obs-table td{padding:5px 9px;text-align:left;white-space:nowrap;border-right:1px solid var(--ob-line);border-bottom:1px solid var(--ob-line)}
.obs-doc .obs-table th{background:var(--ob-code);font-weight:700;color:var(--ob-tx)}
.obs-doc .obs-table tr:last-child td{border-bottom:none}
.obs-doc .obs-table .al-center{text-align:center}
.obs-doc .obs-table .al-right{text-align:right}
.obs-props{margin:0 0 14px;padding:6px 9px;border:1px solid var(--ob-line);border-radius:9px;background:var(--ob-code)}
.obs-prop{display:flex;gap:8px;font-size:12px;line-height:1.75;padding:1px 0}
.obs-prop .k{flex:0 0 84px;color:var(--ob-tx3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.obs-prop .v{flex:1;min-width:0;color:var(--ob-tx2);overflow-wrap:anywhere}
.obs-prop .pill{display:inline-block;margin:0 4px 2px 0;font-size:11px;color:var(--ob-link2);background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.30);border-radius:9px;padding:0 7px;cursor:pointer}
.obs-embed-bar{display:flex;align-items:center;gap:8px;margin-top:10px;padding:4px 8px;font-size:10.5px;color:var(--ob-tx3);background:var(--ob-code);border:1px solid var(--ob-line2);border-bottom:none;border-radius:9px 9px 0 0}
.obs-embed-url{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.obs-embed-bar a{color:var(--ob-link);text-decoration:none;white-space:nowrap}
.obs-doc iframe{display:block;width:100%;max-width:100%;min-height:210px;margin:0 0 10px;border:1px solid var(--ob-line2);border-radius:0 0 9px 9px;background:rgba(0,0,0,.18)}
.obs-embed-tip{margin:0 0 10px;padding:6px 8px;font-size:11px;line-height:1.6;color:var(--ob-chip-tx-hi);background:var(--ob-chip-bg);border:1px solid var(--ob-chip-bd);border-radius:8px}
.obs-embed-tip[hidden]{display:none}
/* ══ 笔记查看器：「电脑理解信息」只读卡片（DSH-IMAGE-DESC 机器注释） ══
   正文里跨行的 <!-- DSH-IMAGE-DESC v1 {…JSON…} --> 是**给机器读的结构**，用户也要能看懂：
   渲染成灰底 + 边框 + 等宽的卡片，与正文一眼可分；卡内**没有任何编辑 / 保存 / 删除入口**（纯只读）。
   警告条走已有的红系（danger 那一档），不为它新增配色；文件里的注释原文**一律不动**（只渲染）✗。 */
.obs-doc .obs-mnote{margin:12px 0;border:1px solid var(--ob-line2);border-left:3px solid #f87171;border-radius:9px;background:var(--ob-code);font:11.5px/1.7 Consolas,"Microsoft YaHei",monospace;overflow:hidden}
.obs-doc .obs-mnote-warn{padding:6px 9px;background:rgba(248,113,113,.10);border-bottom:1px solid var(--ob-line2)}
.obs-doc .obs-mnote-warn-t{font-weight:700;color:var(--ob-bad,#fca5a5);line-height:1.6}
.obs-doc .obs-mnote-warn-s{color:var(--ob-tx2);font-size:10.5px;line-height:1.6}
.obs-doc .obs-mnote-hd{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:5px 9px;border-bottom:1px solid var(--ob-line);background:var(--ob-bg2)}
.obs-doc .obs-mnote-ver{font-size:9.5px;color:var(--ob-tx3);letter-spacing:.4px}
.obs-doc .obs-mnote-kind{font-size:10px;color:var(--ob-chip-tx);background:var(--ob-chip-bg);border:1px solid var(--ob-chip-bd);border-radius:7px;padding:0 6px}
.obs-doc .obs-mnote-bd{padding:4px 9px 8px}
.obs-doc .obs-mnote-row{display:flex;gap:8px;padding:4px 0;border-bottom:1px dashed var(--ob-line)}
.obs-doc .obs-mnote-row:last-child{border-bottom:none}
.obs-doc .obs-mnote-k{flex:0 0 82px;color:var(--ob-tx3);font-size:10.5px;line-height:1.8}
.obs-doc .obs-mnote-v{flex:1;min-width:0;color:var(--ob-tx2);overflow-wrap:anywhere}
.obs-doc .obs-mnote-sv{color:var(--ob-tx2)}
.obs-doc .obs-mnote-t{color:var(--ob-tx);font-weight:700}
.obs-doc ul.obs-mnote-list{margin:0;padding-left:16px}
.obs-doc ul.obs-mnote-list li{font-size:11px;line-height:1.75;color:var(--ob-tx)}
.obs-doc ul.obs-mnote-sub{margin:0;padding-left:16px}
.obs-doc .obs-mnote-kv{display:flex;flex-direction:column;gap:1px}
.obs-doc .obs-mnote-kv.sub{padding-left:9px;border-left:1px solid var(--ob-line)}
.obs-doc .obs-mnote-pair{display:flex;gap:7px}
.obs-doc .obs-mnote-pk{flex:0 0 auto;color:var(--ob-link);font-size:10.5px}
.obs-doc .obs-mnote-pv{flex:1;min-width:0}
.obs-doc .obs-mnote-tags{display:inline-flex;flex-wrap:wrap;gap:4px}
.obs-doc .obs-mnote-tag{font-size:10px;color:var(--ob-link2);background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.30);border-radius:9px;padding:0 6px}
.obs-doc .obs-mnote-conf{font-size:10px;border-radius:7px;padding:0 6px;border:1px solid var(--ob-line2);color:var(--ob-tx2)}
.obs-doc .obs-mnote-conf.ok{color:var(--ob-ok,#6ee7b7);border-color:rgba(52,211,153,.45);background:rgba(52,211,153,.10)}
.obs-doc .obs-mnote-conf.warn{color:var(--ob-info,#8fb8ff);border-color:rgba(109,124,255,.45);background:rgba(109,124,255,.12)}
.obs-doc .obs-mnote-conf.bad{color:var(--ob-bad,#fca5a5);border-color:rgba(248,113,113,.45);background:rgba(248,113,113,.10)}
.obs-doc .obs-mnote-notes{color:var(--ob-tx2);font-size:11px;line-height:1.75;background:var(--ob-bg2);border:1px solid var(--ob-line);border-radius:7px;padding:4px 7px;display:block}
.obs-doc .obs-mnote-json{margin:0;border-top:1px solid var(--ob-line)}
.obs-doc .obs-mnote-json>summary{cursor:pointer;font-size:10px;color:var(--ob-tx3);padding:5px 9px}
.obs-doc .obs-mnote-json>summary:hover{color:var(--ob-tx2)}
.obs-doc .obs-mnote-json pre{margin:0;padding:0 9px 9px;overflow:auto;max-width:100%}
.obs-doc .obs-mnote-json code{background:transparent;border:none;padding:0;font-size:10.5px;line-height:1.65;white-space:pre}
.obs-doc .obs-mnote-dmg{padding:6px 9px;color:var(--ob-bad,#fca5a5);font-weight:700}
.obs-doc pre.obs-mnote-raw{margin:0;padding:0 9px 9px;overflow:auto;max-width:100%}
/* ══ 投喂页：拖放区 / 待处理列表 / 可编辑识别表单（颜色全走 --ob-*） ══ */
.dsh-obs-drop{border:1.5px dashed var(--ob-line2);border-radius:11px;padding:14px 12px;text-align:center;font-size:11.5px;line-height:1.75;color:var(--ob-tx2);background:var(--ob-bg2);cursor:pointer;transition:border-color .15s,background .15s;margin-bottom:8px}
.dsh-obs-drop:hover{border-color:rgba(109,124,255,.55)}
.dsh-obs-drop.on{border-color:#6d7cff;background:rgba(109,124,255,.14);color:var(--ob-tx);box-shadow:inset 0 0 0 1px rgba(109,124,255,.35)}
.dsh-obs-drop b{display:block;font-size:12.5px;color:var(--ob-tx);margin-bottom:2px}
.dsh-obs-drop .hint{font-size:10px;color:var(--ob-tx3);margin-top:3px}
.dsh-obs-ing-sec{font-size:11px;font-weight:700;color:var(--ob-tx2);margin:8px 0 5px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsh-obs-item.on{border-color:rgba(109,124,255,.65);box-shadow:0 0 12px rgba(109,124,255,.16)}
.dsh-obs-ing-form{border:1px solid rgba(109,124,255,.42);border-radius:10px;padding:8px 9px;margin:5px 0 8px;background:var(--ob-bg2)}
.dsh-obs-ing-form .fr{display:flex;align-items:center;gap:6px;margin-bottom:5px}
.dsh-obs-ing-form .fr .lb{flex:0 0 54px;font-size:11px;color:var(--ob-tx2);text-align:right}
.dsh-obs-ing-form .fr .dsh-obs-in{flex:1;min-width:0}
.dsh-obs-ing-body{width:100%;box-sizing:border-box;height:154px;min-height:88px;resize:vertical;background:var(--ob-bg);color:var(--ob-tx);border:1px solid var(--ob-line2);border-radius:8px;padding:6px 8px;font:11.5px/1.6 Consolas,"Microsoft YaHei",monospace;white-space:pre-wrap;overflow:auto;outline:none}
.dsh-obs-ing-body:focus{border-color:#6d7cff}
.dsh-obs-ing-note{font-size:10.5px;color:var(--ob-chip-tx-hi);line-height:1.6;margin:4px 0}
/* ══ 投喂：「深度整理」进度（用户实测痛点：点了之后看不出做完没有）══
   状态来自 GET /api/ingest/list 的 deep 字段；步进器**复用进化页那一套**（.evo-steps / .evo-task-next），
   本处只补「深度整理：<状态>」一行与产出路径，视觉与任务队列同一口径。 */
.ing-deep{margin-top:4px;padding-top:4px;border-top:1px dashed var(--ob-line2)}
.ing-deep .ing-deep-lb{font-size:10px;color:var(--ob-tx3)}
.ing-deep .ing-deep-st{font-size:10px}
.ing-deep .ing-deep-st.none{color:var(--ob-tx3)}
.ing-deep .ing-deep-out{font-size:10px;color:var(--ob-link2);max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ing-deep .evo-steps{margin:3px 0 0}
.ing-deep .evo-task-next{margin:2px 0 2px}
.ing-deep-tip{color:var(--ob-tx3)}
/* ══ 投喂：暂存孤儿对账（只读提示条 + 回收区）══
   口径：孤儿 = 既没被任何笔记引用、也不在投喂待处理列表里的暂存件（含其派生图）。
   提示条只在**只读对账**发现孤儿时出现（可点，绝不自动移文件 ✗）；
   回收区默认收起，展开后逐条可恢复；「彻底清理」是唯一真删入口，必须二次确认。 */
.ing-orphan{font-size:11px;color:var(--ob-chip-tx-hi);background:rgba(109,124,255,.10);border:1px solid rgba(109,124,255,.35);
  border-radius:8px;padding:5px 7px;margin:4px 0;display:flex;align-items:center;gap:6px;flex-wrap:wrap;line-height:1.6}
.ing-orphan .sp{flex:1}
.ing-trash{margin:4px 0 8px}
.ing-trash .tg-dir{font-size:10.5px;color:var(--ob-tx3);margin:5px 0 2px}
.ing-trash .tg-f{display:flex;align-items:center;gap:6px;font-size:11px;padding:2px 0;border-bottom:1px dashed var(--ob-line2)}
.ing-trash .tg-f .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ing-trash .tg-f .sz{color:var(--ob-tx3);font-size:10px}
.dsh-obs-ing-done{border:1px solid rgba(52,211,153,.55);border-radius:10px;padding:8px 9px;margin:5px 0 8px;font-size:11px;line-height:1.6;color:var(--ob-ok2,#a7f3d0);background:rgba(52,211,153,.08);word-break:break-all}
/* ══ 投喂：识别结果里的「内嵌图片」只读展示（缩略图网格 + 跳过清单 + 点击放大） ══
   缩略图走服务端只读接口 GET /api/ingest/thumb?path=<.dsh/inbox/files/ 内的派生图>；
   面板只负责显示，**没有任何编辑/删除图片的入口** ✗。 */
.dsh-obs-ing-imgs{margin:7px 0;border:1px solid var(--ob-line2);border-radius:9px;background:var(--ob-code);padding:7px 8px}
.dsh-obs-ing-imgs .ih{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;font-weight:700;color:var(--ob-tx);margin-bottom:6px}
.dsh-obs-ing-imgs .ih .hint{font-weight:400;font-size:10px;color:var(--ob-tx3)}
.ing-thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(98px,1fr));gap:6px}
.ing-thumb{border:1px solid var(--ob-line);border-radius:8px;background:var(--ob-bg2);padding:4px;cursor:zoom-in;min-width:0;overflow:hidden}
.ing-thumb:hover{border-color:rgba(109,124,255,.6);box-shadow:0 0 10px rgba(109,124,255,.16)}
.ing-thumb img{display:block;width:100%;height:64px;object-fit:cover;border-radius:5px;background:rgba(0,0,0,.25)}
.ing-thumb .fn{font-size:9.5px;line-height:1.45;color:var(--ob-tx2);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ing-thumb .mt{font-size:9px;line-height:1.45;color:var(--ob-tx3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ing-wm{display:inline-block;margin-top:2px;font-size:9px;color:var(--ob-bad,#fca5a5);background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.45);border-radius:6px;padding:0 4px}
.ing-skip{margin-top:6px;font-size:10.5px;color:var(--ob-tx2)}
.ing-skip .sk-h{display:flex;align-items:center;gap:6px;cursor:pointer;padding:2px 0}
.ing-skip .sk-h:hover{color:var(--ob-tx)}
.ing-skip .sk-h .hint{font-size:10px;color:var(--ob-tx3)}
.ing-skip ul{margin:4px 0 0;padding-left:18px}
.ing-skip li{font-size:10px;color:var(--ob-tx3);line-height:1.6}
/* 点击缩略图 → 面板内浮层看大图（只读；点任意处 / Esc / 「关闭」都收起） */
.ing-zoom{position:absolute;inset:0;z-index:50;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;background:rgba(8,10,18,.90);padding:16px;cursor:zoom-out}
.ing-zoom[hidden]{display:none}
.ing-zoom img{max-width:100%;max-height:74%;object-fit:contain;border:1px solid var(--ob-line2);border-radius:8px;background:#000}
.ing-zoom .zc{font-size:10.5px;color:var(--ob-on-dark-dim,#c3cadd);max-width:100%;text-align:center;word-break:break-all;line-height:1.6}
.ing-zoom .zb{font-family:inherit;font-size:11px;color:var(--ob-on-dark,#e8ebf4);background:rgba(109,124,255,.25);border:1px solid rgba(109,124,255,.6);border-radius:8px;padding:3px 12px;cursor:pointer}
/* 极薄提示（只在命中时渲染，不常驻）：醒目但不改主色调 */
.dsh-obs-ing-thin{border:1px solid rgba(248,113,113,.55);border-left-width:3px;border-radius:9px;padding:7px 9px;margin:5px 0 7px;background:rgba(248,113,113,.10)}
.dsh-obs-ing-thin .thin-t{font-size:11.5px;font-weight:700;color:var(--ob-bad,#fca5a5);line-height:1.7;white-space:pre-line}
.dsh-obs-ing-thin .thin-ev{font-size:10px;color:var(--ob-tx2);line-height:1.65;margin-top:3px}
/* ══ 会话右键菜单项「导出到 Obsidian」：样式对齐 DSH 原生菜单行（Menu.module.css 的 .item） ══ */
.dsh-obs-mi-wrap{position:relative}
.dsh-obs-mi{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md,8px);background:transparent;cursor:pointer;font-family:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,var(--ob-tx));text-align:left}
.dsh-obs-mi:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(148,163,215,.14))}
.dsh-obs-mi:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(148,163,215,.14));outline:none}
.dsh-obs-mi[disabled]{opacity:.4;cursor:not-allowed}
.dsh-obs-mi .dsh-obs-mi-ico{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center;font-size:12px;line-height:14px;color:var(--dsw-alias-menu-icon,currentColor)}
.dsh-obs-mi .dsh-obs-mi-lbl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 全局提示条：会话菜单可能在面板关闭时点击（面板内 toast 会静默），故自带一个浮层提示 */
.dsh-obs-gtoast{position:fixed;right:18px;bottom:42px;z-index:99999;max-width:min(460px,72vw);padding:9px 13px;border-radius:10px;font:12.5px/1.65 "Segoe UI","Microsoft YaHei",sans-serif;color:var(--ob-hi,#e8ebf4);background:rgba(20,24,38,.97);border:1px solid rgba(109,124,255,.45);box-shadow:var(--ob-shadow-pop);word-break:break-word}
/* 浮层提示条挂在 body 上（不在面板子树内）→ 取不到 --ob-chip-*，这里写同一套靛蓝的字面值 */
.dsh-obs-gtoast[data-kind="bad"]{border-color:rgba(109,124,255,.6);color:#dde1fc;background:rgba(20,24,38,.97)}
.dsh-obs-gtoast[hidden]{display:none}
/* ══ 笔记页内的「回收站视图」（就地切换，不新增页签） ══
   两个视图同挂在 [data-pane="notes"] 下：.dsh-obs-notesview = 原笔记列表，.dsh-obs-trashview = 回收站。
   两者都是 flex:1 的纵向列，切换只翻 hidden —— 与面板其余部分同一套排版与配色（靛蓝档）。 */
.dsh-obs-notesview,.dsh-obs-trashview{display:flex;flex-direction:column;flex:1;min-height:0}
.dsh-obs-notesview[hidden],.dsh-obs-trashview[hidden]{display:none}
.dsh-obs-tr-title{font-size:11.5px;font-weight:700;color:var(--ob-tx);margin:0}
.dsh-obs-tr-hint{font-size:10.5px;color:var(--ob-tx3);line-height:1.6;margin-bottom:6px;word-break:break-word}
.dsh-obs-tr-hint.bad{color:var(--ob-bad,#fca5a5)}
.dsh-obs-tr-name{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-obs-tr-meta{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:10px;color:var(--ob-tx3);margin-top:3px}
.dsh-obs-tr-restore{flex:0 0 auto;font-family:inherit;font-size:11px;line-height:1;font-weight:700;color:var(--ob-chip-tx-hi);background:var(--ob-chip-bg);border:1px solid var(--ob-chip-bd);border-radius:7px;padding:3px 9px;cursor:pointer;white-space:nowrap}
.dsh-obs-tr-restore:hover{background:rgba(109,124,255,.28);border-color:#6d7cff;color:var(--ob-tx)}
.dsh-obs-tr-restore:disabled{opacity:.55;cursor:default}
/* 单条「删除」＝永久删除（危险动作）：沿用面板已有的红系口径（#f87171 / #fca5a5 + 248,113,113 底），
   与靛蓝的「还原」形成区分；面板内**不引入黄/琥珀**。 */
.dsh-obs-tr-del{flex:0 0 auto;font-family:inherit;font-size:11px;line-height:1;font-weight:700;color:var(--ob-bad,#fca5a5);background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.5);border-radius:7px;padding:3px 9px;cursor:pointer;white-space:nowrap}
.dsh-obs-tr-del:hover{background:rgba(248,113,113,.24);border-color:var(--ob-bad2,#f87171);color:var(--ob-bad2,#f87171)}
.dsh-obs-tr-del:disabled{opacity:.55;cursor:default}
`;

  /* ── 工具函数 ── */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function relTime(ms) {
    if (!ms) return "";
    var d = Date.now() - ms; if (d < 0) d = 0;
    var m = Math.floor(d / 60000);
    if (m < 1) return "刚刚";
    if (m < 60) return m + " 分钟前";
    var hr = Math.floor(m / 60);
    if (hr < 24) return hr + " 小时前";
    var day = Math.floor(hr / 24);
    if (day < 30) return day + " 天前";
    try { return new Date(ms).toLocaleDateString("zh-CN"); } catch (e) { return day + " 天前"; }
  }
  function pane(name) {
    return panelEl ? panelEl.querySelector('.dsh-obs-pane[data-pane="' + name + '"]') : null;
  }
  function qs(sel) { return panelEl ? panelEl.querySelector(sel) : null; }

  /* 面板内提示条（替代 alert；成功/失败都可见） */
  function toast(msg, kind) {
    if (!panelEl) return;
    var el = qs(".dsh-obs-toast");
    if (!el) return;
    el.hidden = false;
    el.className = "dsh-obs-toast" + (kind ? " " + kind : "");
    el.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { if (el) el.hidden = true; }, kind === "bad" ? 5200 : 2800);
  }
  /* 覆盖确认条（HTTP 409 时用，不阻塞界面）；yesLabel 可换成「删除」等动作名，
     noLabel 可换成「再想想」等**否定动作名**（默认「取消」）—— 让两个选项都自解释。 */
  function askConfirm(msg, onYes, yesLabel, noLabel) {
    var cf = qs(".dsh-obs-cf");
    if (!cf) { if (window.confirm(msg)) onYes(); return; }
    pendingConfirm = onYes;
    cf.hidden = false;
    cf.innerHTML = '<span class="cfm">' + esc(msg) + '</span>' +
      '<button class="dsh-obs-btn danger" data-act="cf-yes">' + esc(yesLabel || "覆盖") + '</button>' +
      '<button class="dsh-obs-btn" data-act="cf-no">' + esc(noLabel || "取消") + '</button>';
  }
  function closeConfirm() {
    var cf = qs(".dsh-obs-cf");
    pendingConfirm = null;
    if (cf) { cf.hidden = true; cf.innerHTML = ""; }
  }

  /* ── 网络层：统一 no-store + 错误可见 ── */
  async function api(path, opts) {
    opts = opts || {};
    opts.cache = "no-store"; // 防止旧响应被缓存
    if (opts.body && typeof opts.body !== "string") {
      opts.body = JSON.stringify(opts.body);
      opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    }
    var r;
    try {
      r = await fetch(BASE + path, opts);
    } catch (e) {
      state.online = false; paintOnline();
      var off = new Error("桥接服务离线（127.0.0.1:8777 未启动）");
      off.offline = true;
      throw off;
    }
    var j = {};
    try { j = await r.json(); } catch (e) { j = {}; }
    if (!r.ok || j.ok === false) {
      var err = new Error(j.error || ("HTTP " + r.status));
      err.status = r.status;
      throw err;
    }
    state.online = true; paintOnline();
    return j;
  }
  async function get(path) { return api(path, { method: "GET" }); }
  async function post(path, body) { return api(path, { method: "POST", body: body || {} }); }
  async function put(path, body) { return api(path, { method: "PUT", body: body || {} }); }

  /* ── 主题 ── */
  function effectiveTheme() {
    if (state.theme === "auto") {
      var hr = new Date().getHours();
      return (hr >= 18 || hr < 8) ? "dark" : "light";
    }
    if (state.theme.indexOf("custom:") === 0) return "custom";
    return state.theme;
  }
  function applyTheme() {
    if (!panelEl) return;
    var eff = effectiveTheme();
    panelEl.setAttribute("data-theme", eff === "light" ? "light" : "dark");
    if (eff === "custom") {
      var c = state.theme.slice(7);
      panelEl.style.setProperty("--ob-bg", c);
      panelEl.style.setProperty("--ob-bg2", c);
    }
  }
  function setTheme(t) {
    state.theme = t;
    localStorage.setItem(LS.theme, t);
    applyTheme();
  }

  /* ── 在线状态 ── */
  async function checkOnline() {
    var ok = false;
    try {
      var r = await fetch(BASE + "/api/ping", { cache: "no-store" });
      var j = await r.json();
      ok = r.ok && j.ok !== false;
    } catch (e) { ok = false; }
    state.online = ok;
    paintOnline();
    return ok;
  }
  /* 底栏第 1 行那枚开关（左文字 + 右轨道）：开合态（轨道蓝底渐入 / 深灰底）与桥接在线点，
     两种变化都只走这一个出口 —— openPanel/closePanel/openNow/paintOnline 之后各调一次。
     aria-checked（role=switch）与 aria-pressed 同步写，保证开关状态对 AT 可读。 */
  function paintFootToggle() {
    if (!footBtn) return;
    if (state.open) footBtn.classList.add("on"); else footBtn.classList.remove("on");
    var b = footBtn.querySelector(".obsbtn");
    if (!b) return;
    if (state.open) b.classList.add("on"); else b.classList.remove("on");
    b.setAttribute("aria-checked", state.open ? "true" : "false");
    b.setAttribute("aria-pressed", state.open ? "true" : "false");
    b.setAttribute("title", (state.open ? "关闭" : "打开") + " Obsidian 面板");
    var dot = b.querySelector(".pulse");
    if (dot) {
      dot.className = "pulse" + (state.online ? "" : " bad");
      dot.setAttribute("title", state.online ? "桥接服务在线 · 127.0.0.1:8777" : "桥接服务离线（8777 未启动）");
    }
  }
  function paintOnline() {
    /* 侧栏入口的开合按钮 + 在线点：面板关着时也要更新，所以放在 early return 之前 */
    paintFootToggle();
    updateFootInbox();
    updateFootTrash();
    if (!panelEl) return;
    var dot = qs(".dsh-obs-status .dot");
    if (dot) dot.className = "dot" + (state.online ? "" : " bad");
    var lv = qs(".dsh-obs-live");
    if (lv) {
      lv.className = "dsh-obs-live" + (state.online ? " ok" : "");
      var b = lv.querySelector("b");
      if (b) b.textContent = state.online ? "在线" : "离线";
      lv.title = state.online ? "桥接服务在线 · 127.0.0.1:8777" : "桥接服务离线（8777 未启动）";
    }
    var txt = qs(".st-txt");
    if (txt) txt.textContent = state.online ? "桥接服务在线" : "桥接服务离线（8777 未启动）";
    /* 进化页状态条上的在线点（同一份状态，避免各画各的） */
    var sbDot = qs(".evo-sb .dot");
    if (sbDot) sbDot.className = "dot" + (state.online ? "" : " bad");
    var sbNet = qs(".evo-sb .evo-sb-net b");
    if (sbNet) sbNet.textContent = state.online ? "桥接在线" : "桥接离线";
  }
  async function fillInboxBadge() {
    if (!state.online) { updateFootInbox(); return; }
    try {
      var j = await get("/api/inbox");
      state.inbox = j;
      var el = panelEl ? qs(".dsh-obs-status .inbox") : null;
      if (el) el.textContent = String(j.count);
    } catch (e) {
      var el2 = panelEl ? qs(".dsh-obs-status .inbox") : null;
      if (el2) el2.textContent = "?";
    }
    updateFootInbox();
  }
  async function refreshStatus() {
    ensurePanelBehind();   // 兜底：弹窗开合没走到 MutationObserver（或观察器不可用）时，15 秒内也纠正一次层级
    await checkOnline();
    await fillInboxBadge();
    await fillTrashBadge();
    ensureSettings();   // 底栏那行：挂载时没读到设置（桥接刚起来/离线）就在状态轮询里补一次，读到即空操作
  }

  /* ══ 页签 1：笔记（读 / 搜） ══ */
  /* 骨架里并排放两个视图：正常笔记列表 + 回收站视图（默认 hidden）。
     两者同在一个 pane 内就地切换 —— 不新增页签，也不改变笔记页既有的 DOM 结构层次。 */
  function buildNotes() {
    var p = pane("notes");
    if (!p) return;
    p.innerHTML =
      '<div class="dsh-obs-notesview">' +
        '<div class="dsh-obs-tool">' +
          '<input class="dsh-obs-in q" placeholder="搜索标题 / 正文（300ms 防抖）" />' +
          '<select class="dsh-obs-in tagsel" title="按标签过滤"><option value="">全部标签</option></select>' +
          '<button class="dsh-obs-btn x" data-act="reload-notes" title="重新拉取索引">↻</button>' +
        '</div>' +
        '<div class="line cnt">载入中…</div>' +
        '<div class="dsh-obs-list"><div class="dsh-obs-empty">载入中…</div></div>' +
      '</div>' +
      '<div class="dsh-obs-trashview" hidden>' +
        '<div class="dsh-obs-tool">' +
          '<span class="dsh-obs-tr-title">回收站</span>' +
          '<span class="sp"></span>' +
          '<button class="dsh-obs-btn" data-act="trash-back" title="返回笔记列表">← 返回笔记</button>' +
          '<button class="dsh-obs-btn danger" data-act="trash-clear" title="清空回收站：永久删除，不可恢复">清空回收站</button>' +
        '</div>' +
        '<div class="line dsh-obs-tr-hint"></div>' +
        '<div class="dsh-obs-list tr-list"></div>' +
      '</div>';
    notesBuilt = true;
    if (state.trash.view) applyTrashView(true);   // 面板被重建（关→开）时仍停在回收站视图
  }
  function itemHtml(n, q) {
    var tags = (n.tags || []);
    var shown = tags.slice(0, 4).map(function (t) { return '<span class="tg">#' + esc(t) + '</span>'; }).join("");
    var more = tags.length > 4 ? '<span>+' + (tags.length - 4) + '</span>' : "";
    /* 两个按键都必须 stopPropagation（条目本身点击 = 打开笔记），见 bindNoteDelete / bindNoteHandoff */
    return '<div class="dsh-obs-item" data-act="open-note" data-path="' + esc(n.path) + '" title="点击载入编辑：' + esc(n.path) + '">' +
      '<div class="it itrow"><span class="itt">' + esc(n.title || n.path) + '</span>' +
        '<button class="dsh-obs-hand" data-act="hand-note" data-path="' + esc(n.path) + '" title="交给 DSH 处理">🧠</button>' +
        '<button class="dsh-obs-del" data-act="del-note" data-path="' + esc(n.path) + '" title="删除：移入回收站 .dsh/trash（可恢复）">🗑</button>' +
      '</div>' +
      '<div class="ip">' + esc(n.path) + '</div>' +
      '<div class="im">' + shown + more + '<span>' + esc(relTime(n.mtimeMs)) + '</span></div>' +
      (n.excerpt ? '<div class="ex">' + hl(n.excerpt, q) + '</div>' : "") +
      '</div>';
  }
  /* 关键词高亮：先按原文切片，再逐段转义，避免破坏 HTML */
  function hl(raw, q) {
    raw = String(raw == null ? "" : raw);
    if (!q) return esc(raw);
    var lower = raw.toLowerCase(), ql = q.toLowerCase(), out = "", i = 0;
    while (true) {
      var k = lower.indexOf(ql, i);
      if (k < 0) break;
      out += esc(raw.slice(i, k)) + "<mark>" + esc(raw.slice(k, k + ql.length)) + "</mark>";
      i = k + ql.length;
    }
    return out + esc(raw.slice(i));
  }
  function renderTagOptions() {
    if (!notesBuilt || !panelEl || !state.index) return;
    var sel = pane("notes").querySelector(".tagsel");
    if (!sel) return;
    var freq = {};
    state.index.notes.forEach(function (n) { (n.tags || []).forEach(function (t) { freq[t] = (freq[t] || 0) + 1; }); });
    var tags = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; }).slice(0, 60);
    sel.innerHTML = '<option value="">全部标签</option>' + tags.map(function (t) {
      return '<option value="' + esc(t) + '">#' + esc(t) + ' (' + freq[t] + ')</option>';
    }).join("");
    sel.value = state.tag || "";
  }
  function renderNotesList() {
    if (!notesBuilt || !panelEl || !state.index) return;
    var p = pane("notes"), list = p.querySelector(".dsh-obs-list"), cnt = p.querySelector(".cnt");
    if (!list || !cnt) return;
    cnt.textContent = "共 " + state.index.count + " 篇 · 目录 " + ((state.index.dirs || []).length) + " 个 · 更新 " + relTime(state.index.notes[0] && state.index.notes[0].mtimeMs);
    cnt.className = "line cnt";
    list.innerHTML = state.index.notes.length
      ? state.index.notes.map(function (n) { return itemHtml(n, ""); }).join("")
      : '<div class="dsh-obs-empty">知识库内暂无 .md 笔记</div>';
    bindNoteDelete();
    bindNoteHandoff();
  }

  /* ── 笔记列表的删除键 ──────────────────────────────────────────────────────
   * 为什么不用面板级事件委托：条目本身 data-act="open-note"，委托靠 closest 取到的是
   * **按钮**（这点没问题），但事件仍会冒泡穿过条目元素 —— 任何挂在条目上的点击处理
   * （宿主/未来改造）都会连带触发「打开笔记」。所以这里逐按钮挂监听，并在监听里
   * stopPropagation：点击删除键**绝不会**打开笔记。 */
  function bindNoteDelete() {
    if (!panelEl) return;
    var btns = panelEl.querySelectorAll('.dsh-obs-list [data-act="del-note"]');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].getAttribute("data-bound") === "1") continue;
      btns[i].setAttribute("data-bound", "1");
      btns[i].addEventListener("click", onDelNoteBtn);
    }
  }
  function onDelNoteBtn(e) {
    if (e && e.stopPropagation) e.stopPropagation();   // 关键：不让条目/面板的「打开笔记」接手
    if (e && e.preventDefault) e.preventDefault();
    deleteNote(this.getAttribute("data-path"));
  }
  /* 删除 = 移入 .dsh/trash（服务端不真删）；二次确认文案带文件名 */
  function deleteNote(path) {
    if (!path) return toast("删除失败：笔记路径缺失", "bad");
    var name = String(path).split("/").pop();
    askConfirm("删除笔记「" + name + "」？将移入回收站 .dsh/trash/（可恢复，不会真删）。", async function () {
      var wasCurrent = state.edit.path === path;
      try {
        var r = await post("/api/delete", { path: path });
        var msg = "已移入回收站：" + (r.trashed || path);
        if (wasCurrent) {
          state.edit = { path: "", text: "", tags: [], frontmatter: {}, missing: true };
          renderEdit(true);                   // 清空编辑区（含阅读视图）
          msg += " · 当前编辑的笔记已清空";
        }
        toast(msg, "ok");
        invalidateIndex();
        // 列表可能还在 DOM 里（用户先前切到别的页签）：立刻刷新，别等下次切回才更新
        if (notesBuilt && state.tab !== "notes") loadIndex(true);
      } catch (e) {
        if (e.status === 404 && /no route/i.test(String(e.message))) {
          toast("删除失败：桥接服务没有 /api/delete（服务版本较旧，请部署新版 server.mjs 并重启）", "bad");
        } else toast("删除失败：" + e.message, "bad");
      }
    }, "删除");
  }

  /* ── 笔记列表的「交给 DSH」键（知识库 → DSH 的反向通道）─────────────────────
   * 与删除键**同一套实现口径**：逐按钮挂监听、监听里 stopPropagation（点它绝不触发条目的
   * 「载入编辑」）、走 askConfirm 二次确认（文案写明去向与回流）、提交期间给按钮一个可见的
   * 进行中状态、成功/失败都 toast 可见。 */
  function bindNoteHandoff() {
    if (!panelEl) return;
    var btns = panelEl.querySelectorAll('.dsh-obs-list [data-act="hand-note"]');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].getAttribute("data-bound") === "1") continue;
      btns[i].setAttribute("data-bound", "1");
      btns[i].addEventListener("click", onHandNoteBtn);
    }
  }
  function onHandNoteBtn(e) {
    if (e && e.stopPropagation) e.stopPropagation();   // 关键：不让条目/面板的「打开笔记」接手
    if (e && e.preventDefault) e.preventDefault();
    handoffNote(this.getAttribute("data-path"), this);
  }
  /* 交给 DSH = 把任务文件推进 .dsh/inbox/（DSH 侧收件箱），DSH 下一轮读它 → 读原文 → 产出写回知识库 */
  function handoffNote(path, btn) {
    if (!path) return toast("交给 DSH 失败：笔记路径缺失", "bad");
    var name = String(path).split("/").pop();
    askConfirm("把笔记「" + name + "」交给 DSH 处理？会把这篇笔记推进 DSH 收件箱（.dsh/inbox/），" +
      "由 DSH 读它、做总结 / 提炼 / 补全并把产出写回知识库。", async function () {
      var label = btn && btn.textContent;
      if (btn) { btn.disabled = true; btn.textContent = "…"; }   // 进行中：与投喂「排队中…」同一口径的可见状态
      try {
        var r = await post("/api/handoff", { path: path });
        var file = String(r.task || path).split("/").pop();
        var cnt = (typeof r.inboxCount === "number") ? "（当前 " + r.inboxCount + "）" : "";
        toast("已交给 DSH：" + file + " · 收件箱 +1" + cnt, "ok");
        await fillInboxBadge();               // 立刻刷新收件箱徽标（底栏 + 状态条）
      } catch (e) {
        if (e.status === 404 && /no route/i.test(String(e.message))) {
          toast("交给 DSH 失败：桥接服务没有 /api/handoff（服务版本较旧，请部署新版 server.mjs 并重启）", "bad");
        } else toast("交给 DSH 失败：" + e.message, "bad");
      } finally {
        if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = label || "🧠"; }
      }
    }, "交给 DSH");
  }
  async function loadIndex(force) {
    // 注意：笔记页骨架可能被重建过（openPanel 会重置 notesBuilt），
    // 此时若直接 return，列表会永远停在骨架文案「载入中…」，所以这里要补渲染。
    if (state.index && !force) {
      if (notesBuilt) renderNotesList();
      return state.index;
    }
    var p = notesBuilt ? pane("notes") : null;
    if (p) {
      var list = p.querySelector(".dsh-obs-list");
      if (list) list.innerHTML = '<div class="dsh-obs-empty">载入索引中…</div>';
    }
    try {
      state.index = await get("/api/index");
      renderTagOptions();
      renderNotesList();
      return state.index;
    } catch (e) {
      state.index = null;
      if (p) {
        var l2 = p.querySelector(".dsh-obs-list");
        if (l2) l2.innerHTML = '<div class="dsh-obs-empty bad">索引载入失败：' + esc(e.message) + '</div>';
        var c2 = p.querySelector(".cnt");
        if (c2) { c2.textContent = "索引不可用"; c2.className = "line cnt bad"; }
      }
      toast("索引载入失败：" + e.message, "bad");
      return null;
    }
  }
  async function doSearch() {
    if (!notesBuilt || !panelEl) return;
    var p = pane("notes"), list = p.querySelector(".dsh-obs-list"), cnt = p.querySelector(".cnt");
    if (!list) return;
    var q = state.q.trim(), tag = state.tag;
    if (!q && !tag) { renderNotesList(); return; }
    list.innerHTML = '<div class="dsh-obs-empty">搜索中…</div>';
    try {
      var r = await get("/api/search?q=" + encodeURIComponent(q) + "&tag=" + encodeURIComponent(tag) + "&limit=50");
      cnt.className = "line cnt";
      cnt.textContent = "命中 " + r.total + " 篇" + (q ? ' · "' + q + '"' : "") + (tag ? " · #" + tag : "");
      list.innerHTML = r.hits.length
        ? r.hits.map(function (n) { return itemHtml(n, q); }).join("")
        : '<div class="dsh-obs-empty">无命中。可换关键词，或清空标签过滤。</div>';
      bindNoteDelete();
      bindNoteHandoff();
    } catch (e) {
      cnt.className = "line cnt bad";
      cnt.textContent = "搜索失败：" + e.message;
      list.innerHTML = '<div class="dsh-obs-empty bad">' + esc(e.message) + '</div>';
      toast("搜索失败：" + e.message, "bad");
    }
  }
  function invalidateIndex(force) {
    state.index = null;
    if (state.tab === "notes") loadIndex(true);
    else if (state.tab === "struct") loadStruct(force !== false);
  }

  /* ══ 回收站视图（笔记页内就地切换） ══════════════════════════════════════════════
     入口：面板底部状态条「♻ 回收站 N」（就在「📥 收件箱 N」旁边）。
     数据：GET /api/trash（每条含 originalName / deletedAt / bytes）；
           POST /api/trash/restore 还原；POST /api/trash/purge 删单条 / 清空。
     清空必须走 askConfirm 二次确认（文案写明不可恢复），绝不静默删。 */
  function fmtTime(ms) {
    if (!ms) return "未知时间";
    try { return new Date(ms).toLocaleString("zh-CN", { hour12: false }); }
    catch (e) { return relTime(ms) || "未知时间"; }
  }
  function trashItemHtml(it) {
    var name = it.originalName || it.name;
    return '<div class="dsh-obs-item">' +
      '<div class="it itrow"><span class="itt dsh-obs-tr-name" title="' + esc(name) + '">' + esc(name) + '</span>' +
        '<button class="dsh-obs-tr-restore" data-act="trash-restore" data-name="' + esc(it.name) + '"' +
          ' title="还原到知识库（同名自动 -2/-3，不覆盖）">还原</button>' +
        // 单条永久删除（危险色）：只删这一条，绝不能退化成「清空」
        '<button class="dsh-obs-tr-del" data-act="trash-del" data-name="' + esc(it.name) + '"' +
          ' title="永久删除这一条（不可恢复；不影响回收站里的其它条目）">删除</button>' +
      '</div>' +
      '<div class="ip">' + esc(it.name) + '</div>' +
      '<div class="dsh-obs-tr-meta"><span>删除于 ' + esc(fmtTime(it.deletedAt)) + '</span>' +
        '<span>' + esc(ingSize(it.bytes)) + '</span></div>' +
      '</div>';
  }
  function renderTrash() {
    if (!notesBuilt || !panelEl) return;
    var p = pane("notes");
    var tv = p && p.querySelector(".dsh-obs-trashview");
    if (!tv) return;
    var title = tv.querySelector(".dsh-obs-tr-title"), hint = tv.querySelector(".dsh-obs-tr-hint"), list = tv.querySelector(".tr-list");
    if (title) title.textContent = "回收站 · " + (state.trash.count || 0) + " 项";
    if (hint) {
      if (state.trash.err) { hint.className = "line dsh-obs-tr-hint bad"; hint.textContent = "回收站读取失败：" + state.trash.err; }
      else { hint.className = "line dsh-obs-tr-hint"; hint.textContent = "删除的笔记移到这里（.dsh/trash/），可随时还原；还原不会覆盖同名笔记（自动加 -2 / -3）。"; }
    }
    if (!list) return;
    if (state.trash.err) { list.innerHTML = '<div class="dsh-obs-empty bad">' + esc(state.trash.err) + '</div>'; return; }
    if (state.trash.items === null) { list.innerHTML = '<div class="dsh-obs-empty">载入中…</div>'; return; }
    list.innerHTML = state.trash.items.length
      ? state.trash.items.map(trashItemHtml).join("")
      : '<div class="dsh-obs-empty">回收站是空的</div>';
  }
  async function loadTrash(force) {
    if (state.trash.items && !force) { if (state.trash.view) renderTrash(); return state.trash.items; }
    try {
      var r = await get("/api/trash?limit=200");
      state.trash.items = r.items || [];
      state.trash.count = Number(r.count) || 0;
      state.trash.err = "";
    } catch (e) {
      state.trash.items = null;
      state.trash.err = e.message;
      if (!e.offline) toast("回收站载入失败：" + e.message, "bad");
    }
    updateFootTrash();
    if (state.trash.view) renderTrash();
    return state.trash.items;
  }
  /* 底部徽标只需计数：拉 1 条即可拿到 count（省掉整个清单的 stat） */
  async function fillTrashBadge() {
    if (!state.online) { updateFootTrash(); return; }
    try {
      var j = await get("/api/trash?limit=1");
      var n = Number(j.count) || 0;
      if (n !== state.trash.count) {
        state.trash.count = n;
        state.trash.items = null;                    // 计数变了 → 列表下次进入重新拉
        if (state.trash.view) loadTrash(true);
      }
      state.trash.err = "";
    } catch (e) { /* 徽标保持旧值：回收站不是主流程，不打扰用户 */ }
    updateFootTrash();
  }
  function updateFootTrash() {
    var el = panelEl ? qs(".dsh-obs-status .trashn") : null;
    if (el) el.textContent = String(state.trash.count || 0);
  }
  /** 切换笔记页内的两个视图；on=true 进回收站（进入即强制刷新清单） */
  function applyTrashView(on) {
    state.trash.view = !!on;
    if (!notesBuilt || !panelEl) return;
    var p = pane("notes");
    if (!p) return;
    var nv = p.querySelector(".dsh-obs-notesview"), tv = p.querySelector(".dsh-obs-trashview");
    if (nv) nv.hidden = !!on;
    if (tv) tv.hidden = !on;
    if (on) { renderTrash(); loadTrash(true); }
    else if (state.index) renderNotesList();
  }
  function openTrashView() {
    if (!state.open) openNow();
    /* 新建态里点底栏「♻ 回收站」= 离开新建态：同样先过守卫（取消则连视图都不切） */
    if (state.newNote && !guardLeaveNewNote(function () { openTrashView(); })) return;
    if (state.tab !== "notes") setTab("notes");
    if (!notesBuilt) buildNotes();
    applyTrashView(true);
  }
  async function restoreTrash(name, btn) {
    if (!name) return toast("还原失败：回收站条目名缺失", "bad");
    if (btn) { btn.disabled = true; btn.textContent = "还原中…"; }
    try {
      var r = await post("/api/trash/restore", { name: name });
      toast("已还原到：" + (r.path || "（服务未返回路径）"), "ok");
      state.trash.items = null;
      await loadTrash(true);            // 列表刷新（该条已消失）
      invalidateIndex();                // 笔记索引同步刷新：还原的文件立刻回到笔记列表
    } catch (e) {
      toast("还原失败：" + e.message, "bad");
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "还原"; }
    }
  }
  /* 取「给人看的名字」：优先原文件名（回收站里的盘上名可能已带时间戳/后缀）。
     items 不可用时退回盘上名 —— 确认文案里必须有名字，绝不出现「删除「」」。 */
  function trashShownName(name) {
    var items = state.trash.items || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i] && items[i].name === name) return items[i].originalName || items[i].name || name;
    }
    return name;
  }
  /* 删单条（永久）：与「清空回收站」同一套 askConfirm 二次确认口径 —— 文案含**原文件名** +
     明写「永久删除、不可恢复」；取消则一个请求都不发、列表条目数不变。
     请求体只带 {name}：服务端给 name 就只删这一条（不给 name 才是清空，见 clearTrash）。 */
  function delTrashItem(name, btn) {
    if (!name) return toast("删除失败：回收站条目名缺失", "bad");
    var shown = trashShownName(name);
    askConfirm("永久删除「" + shown + "」？只删这一条，将彻底移出回收站、不可恢复" +
      "（不影响回收站里的其它条目，也不影响知识库里的文件）。", async function () {
      if (btn) { btn.disabled = true; btn.textContent = "删除中…"; }
      try {
        var r = await post("/api/trash/purge", { name: name });
        toast("已永久删除：" + shown + (((r && r.removed) || 0) ? "（移除 " + r.removed + " 项）" : ""), "ok");
        state.trash.items = null;
        await loadTrash(true);            // 列表刷新（该条已消失）
        updateFootTrash();                // 徽标同步（loadTrash 已刷，这里兜一次）
      } catch (e) {
        toast("删除失败：" + e.message, "bad");
        if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "删除"; }
      }
    }, "删除");
  }
  function clearTrash() {
    var n = state.trash.count || 0;
    askConfirm("清空回收站？将永久删除回收站里的 " + n + " 个条目，删掉后不可恢复" +
      "（只清 .dsh/trash/，不影响知识库里的其它文件）。", async function () {
      try {
        var r = await post("/api/trash/purge", {});
        toast("回收站已清空：移除 " + ((r && r.removed) || 0) + " 项", "ok");
        state.trash.items = null;
        await loadTrash(true);
      } catch (e) {
        toast("清空回收站失败：" + e.message, "bad");
      }
    }, "清空");
  }

  /* ══ 页签 2：编辑（读 / 写 / 新建） ══ */
  function fmSummary() {
    var ed = state.edit;
    var keys = Object.keys(ed.frontmatter || {});
    var parts = keys.map(function (k) { return '<span class="k">' + esc(k) + '</span>: ' + esc(ed.frontmatter[k]); });
    if ((ed.tags || []).length) parts.push("标签 " + ed.tags.map(function (t) { return '<span class="k">#' + esc(t) + '</span>'; }).join(" "));
    if (!parts.length) return "（无 frontmatter / 标签）";
    return parts.join(" · ");
  }
  /* 编辑页两种状态（互斥，同一个 pane）：
     · 常规态 = 模式切换 + 路径/载入 + frontmatter + 原文编辑框/阅读视图 + 保存行；
     · 新建态（state.newNote）= 整个编辑区换成「新建笔记」表单（标题→描述→标签→日期→目标目录→正文→创建/取消）。
       新建态**不渲染**旧笔记内容与原编辑框 —— 否则用户会以为「得先写内容再写标题」（实机反馈）。
       两态切换只需 renderEdit(true)：常规态的内容一直存在 state.edit 里（外加 nfSnap 兜住未保存的输入）。 */
  function renderEdit(force) {
    var p = pane("edit");
    if (!p) return;
    var nn = !!state.newNote;
    if (p.getAttribute("data-built") === "1" && !force) {
      /* 已建结构与当前状态一致 → 原地增量刷新就够了；不一致（例如刚从新建态退出/进入）
         必须整体重建，绝不把「新建表单残留成常规编辑态」（页签来回切也不残留）。 */
      if ((p.getAttribute("data-new") === "1") === nn) {
        var fm0 = nn ? null : p.querySelector(".fmv");
        if (nn || fm0) {
          if (fm0) fm0.innerHTML = fmSummary();   // 常规态：就地刷新 frontmatter 摘要
          return;
        }
      }
    }
    p.setAttribute("data-built", "1");
    p.setAttribute("data-new", nn ? "1" : "0");
    var ed = state.edit;
    /* 工具栏：新建态下「新建笔记」带 .on（与「✎ 编辑 / 👁 阅读」选中态同一条 CSS 声明）；
       该状态不再显示模式切换/路径行，避免与「先写内容」的错觉撞车。 */
    var html =
      '<div class="dsh-obs-tool">' +
        (nn ? "" :
          '<span class="dsh-obs-mode" title="阅读视图：把当前 markdown 渲染成 Obsidian 风格只读页面">' +
            modeBtn("edit", "✎ 编辑") + modeBtn("read", "👁 阅读") +
          '</span>') +
        // 新建笔记：编辑页工具栏（唯一入口；原「新建」按钮已移除）
        '<button class="dsh-obs-btn' + (nn ? " on" : "") + '" data-act="note-new" aria-pressed="' + (nn ? "true" : "false") +
          '" title="按表单新建笔记（日期自动填今天，同名自动 -2/-3）">新建笔记</button>' +
        '<span class="sp"></span>' +
        '<span class="line rmode" style="margin:0"></span>' +
      '</div>';
    if (nn) {
      html += newNoteFormHtml();
    } else {
      html +=
        '<div class="dsh-obs-tool">' +
          '<input class="dsh-obs-in epath" placeholder="笔记相对路径，如 ' + esc(newNoteDir()) + '/新笔记.md" value="' + esc(ed.path) + '" />' +
          '<button class="dsh-obs-btn" data-act="edit-load">载入</button>' +
        '</div>' +
        '<div class="dsh-obs-fm"><span class="fmv">' + fmSummary() + '</span></div>' +
        /* 投喂附件护栏提示条（默认 hidden；载入笔记后由 checkIngestManifest 只读判定是否显示） */
        '<div class="ing-mani" hidden></div>' +
        '<textarea class="dsh-obs-ta" spellcheck="false" placeholder="（尚未载入笔记；点上方「新建笔记」按表单新建）">' + esc(ed.text) + '</textarea>' +
        '<div class="dsh-obs-read" hidden></div>' +
        '<div class="dsh-obs-tool" style="margin-top:6px">' +
          '<button class="dsh-obs-btn primary" data-act="edit-save">保存</button>' +
          '<button class="dsh-obs-btn" data-act="edit-obsidian" title="生成 obsidian:// 链接并打开">在 Obsidian 打开</button>' +
          '<span class="sp"></span>' +
          '<span class="line" style="margin:0">' + (ed.missing ? "未载入" : "Ctrl+S 保存") + '</span>' +
        '</div>';
    }
    p.innerHTML = html;
    var rm = p.querySelector(".rmode");
    if (rm) rm.textContent = nn
      ? "新建笔记 · 未保存"
      : (state.editMode === "read" ? "只读渲染 · 以编辑框内容为准" : "原文编辑");
    if (nn) fillNewNoteForm();     // 日期默认今天、目录默认值、标题聚焦
    else applyEditMode(true);
  }
  async function loadNote(path, switchTab) {
    /* 显式载入某篇笔记（列表 / [[wiki]] / 缺口 / 投喂入库）→ 退出新建状态，别让新建表单盖住刚载入的内容。
       新建态里标题/正文已填 → 与切页签同一套守卫：先确认，取消则**不载入**、仍留在新建态。
       （原实现直接丢弃 nfSnap，会把进入新建态前未保存的正文一起吞掉。） */
    if (state.newNote && !guardLeaveNewNote(function () { loadNote(path, switchTab); })) return;
    try {
      var j = await get("/api/note?path=" + encodeURIComponent(path));
      state.edit = { path: j.path, text: j.text, tags: j.tags || [], frontmatter: j.frontmatter || {}, missing: false };
    } catch (e) {
      state.edit = { path: path, text: "", tags: [], frontmatter: {}, missing: true };
      toast("载入失败：" + e.message, "bad");
    }
    if (switchTab !== false) setTab("edit");
    renderEdit(true);
    checkIngestManifest(state.edit.path || path);   // 只读护栏提示（不写任何文件；missing>0 才显示）
  }
  async function saveEdit() {
    var p = pane("edit");
    if (!p) return;
    var pathEl = p.querySelector(".epath"), ta = p.querySelector(".dsh-obs-ta");
    if (!pathEl || !ta) return;                 // 新建状态：编辑区里没有旧内容编辑框，Ctrl+S 不误触发
    var path = pathEl.value.trim();
    var text = ta.value;
    if (!path) return toast("请先填写笔记路径", "bad");
    if (!/\.md$/i.test(path)) return toast("路径需以 .md 结尾", "bad");
    try {
      var r = await api("/api/note", { method: "PUT", body: { path: path, text: text } });
      toast("已保存 " + r.path, "ok");
      await loadNote(r.path, false); // 回读以刷新 frontmatter / 标签展示（原文无损）
      invalidateIndex();
    } catch (e) { toast("保存失败：" + e.message, "bad"); }
  }
  /* ── 新建笔记（表单化 · 编辑区整体切换）──────────────────────────────────────
   * 入口：编辑页工具栏「新建笔记」→ state.newNote = true → renderEdit(true)
   *       把**整个编辑区**换成表单（不再是叠在旧内容下面的浮层，也不会先让你写正文）。
   * 字段（自上而下）：标题（必填）/ 描述 / 标签 / 日期（默认今天）/ 目标目录（默认 = 服务端 effective.archive_folder）
   *       / 正文（多行 textarea，占表单主要高度，可滚动；空则只写标题行）；
   *       创建 / 取消 两个按钮固定在**所有字段之后**（正文框也在按钮之前）。
   * 退出：取消 / 点其它页签 / 换载笔记 —— 标题或正文非空时先确认「放弃未保存的新笔记？」
   *       （见 guardLeaveNewNote），确认后还原进入前载入的笔记内容；创建成功则载入新笔记。
   * 提交：组装 frontmatter → 标题行 `# <标题>` → 正文原文（保留换行）
   *       → POST /api/note → 同名自动 -2 / -3（绝不覆盖）→ toast + 载入新笔记。 */
  /* ── 生效目录：一律以**服务端 /api/settings 的 effective** 为准 ────────────────────
     为什么不在面板里写死目录名：那些是**用户库里的真实目录名**，写死在插件源码里就会随发布树公开
     （违反「发布树不带任何个人数据」）。所以这里只留**通用兜底值**，真实名字来自用户自己的
     .dsh/settings.json（服务端解析后经 effective 回传）。 */
  function effDir(key, fallback) {
    var e = state.effective || {};
    var v = String(e[key] || "").trim();
    return v || fallback;
  }
  function newNoteDir() { return effDir("archive_folder", "dsh-archive"); }
  function ingestDefaultDir() { return effDir("ingest_default_dir", "ingest-archive"); }
  function skillMirrorFolder() { return effDir("skill_mirror_folder", "dsh-skills"); }
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function todayYMD() {
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  /* YAML 标量：能裸写就裸写（与 server.mjs 的 yamlScalar 同约定），否则 JSON 双引号 */
  var YAML_BARE = /^[\p{L}\p{N}_][\p{L}\p{N}_\- .()（）〔〕【】《》「」『』，。、；：！？·]*$/u;
  function yamlVal(v) {
    var s = String(v == null ? "" : v);
    if (!s) return '""';
    return (s === s.trim() && YAML_BARE.test(s)) ? s : JSON.stringify(s);
  }
  /* 标题 → 安全文件名（Windows 非法字符 / 控制字符 / 首尾点与空格 / 长度） */
  function safeNoteStem(title) {
    var t = String(title == null ? "" : title)
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-")
      .replace(/\s+/g, " ").replace(/-{2,}/g, "-")
      .replace(/^[.\s-]+|[.\s-]+$/g, "").trim();
    return t.slice(0, 60) || "未命名";
  }
  function splitTags(raw) {
    var out = [], seen = {};
    String(raw == null ? "" : raw).split(/[,，;；\s]+/).forEach(function (t) {
      var s = t.replace(/^#+/, "").trim();
      if (!s || seen[s.toLowerCase()]) return;
      seen[s.toLowerCase()] = 1; out.push(s);
    });
    return out;
  }
  /* 新建表单的 HTML（渲染进编辑页 pane，.nfin = 非浮层的「状态」形态）。
     字段顺序就是提交顺序：标题 → 描述 → 标签 → 日期 → 目标目录 → **正文** → 创建/取消。
     正文框在字段之后、创建/取消之前，多行可滚动、占表单主要高度（实机反馈：原来没地方写正文）。 */
  function newNoteFormHtml() {
    return '<div class="dsh-obs-nf nfin">' +
      '<div class="nfh">🆕 新建笔记<span class="sp"></span><span class="nfsub">同名自动 -2/-3 · 绝不覆盖</span></div>' +
      '<div class="nfr"><span class="lb">标题</span><input class="dsh-obs-in nf-title" placeholder="必填，用作文件名" /></div>' +
      '<div class="nfr"><span class="lb">描述</span><input class="dsh-obs-in nf-desc" placeholder="可空（写进 frontmatter.description）" /></div>' +
      '<div class="nfr"><span class="lb">标签</span><input class="dsh-obs-in nf-tags" placeholder="逗号或空格分隔，如 dsh, 知识管理" /></div>' +
      '<div class="nfr"><span class="lb">日期</span><input class="dsh-obs-in nf-date" type="date" /></div>' +
      '<div class="nfr"><span class="lb">目标目录</span><input class="dsh-obs-in nf-dir" value="' + esc(newNoteDir()) + '" placeholder="vault 内相对目录" /></div>' +
      '<div class="nfr nfr-body"><span class="lb">正文</span><textarea class="nf-body" spellcheck="false" placeholder="正文原文（可空 · 保留换行；空则只写标题行）"></textarea></div>' +
      '<div class="nferr" hidden></div>' +
      '<div class="nf-foot">' +
        '<button class="dsh-obs-btn primary" data-act="note-new-submit">创建</button>' +
        '<button class="dsh-obs-btn" data-act="note-new-cancel">取消</button>' +
        '<span class="sp"></span>' +
        '<span class="line" style="margin:0">Esc 取消</span>' +
      '</div>' +
    '</div>';
  }
  /* 表单根节点（新建状态下来自编辑页 pane；老浮层形态也认） */
  function nfRoot() {
    var p = pane("edit");
    var f = p ? p.querySelector(".dsh-obs-nf") : null;
    return f || qs(".dsh-obs-nf");
  }
  /* 渲染后填默认值：日期=今天（可改）、目录为空时补默认目录、光标落在标题 */
  function fillNewNoteForm() {
    var f = nfRoot();
    if (!f) return;
    var d = f.querySelector(".nf-date");
    if (d && !d.value) d.value = todayYMD();
    var dir = f.querySelector(".nf-dir");
    if (dir && !dir.value) dir.value = newNoteDir();
    var t = f.querySelector(".nf-title");
    if (t) { try { t.focus(); } catch (e) {} }
  }
  function openNewNoteForm() {
    var p = pane("edit");
    if (!p) return;
    if (state.newNote) {   // 已在新建状态：只把光标送回标题，不重置已填内容
      var t0 = p.querySelector(".nf-title");
      if (t0) { try { t0.focus(); } catch (e0) {} }
      return;
    }
    /* 进入新建状态前先快照编辑区（含未保存的原文）——取消时原样还原，用户不丢东西 */
    var ta = p.querySelector(".dsh-obs-ta"), ep = p.querySelector(".epath");
    state.nfSnap = { path: ep ? ep.value : state.edit.path, text: ta ? ta.value : state.edit.text };
    state.newNote = true;
    renderEdit(true);
  }
  /* 新建态是否已填了东西（标题或正文任一非空）→ 决定「离开」时要不要二次确认。
     表单不在 DOM 里（面板刚重建）时视为「无可保护输入」，直接放行，避免卡死在新建态。 */
  function nfDirty() {
    if (!state.newNote) return false;
    var f = nfRoot();
    if (!f) return false;
    var t = f.querySelector(".nf-title"), b = f.querySelector(".nf-body");
    return !!((t && String(t.value).trim()) || (b && String(b.value).trim()));
  }
  /* 真正退出新建态（不询问）：还原进入前的快照并**立刻重建**编辑区 ——
     否则 pane 里还留着旧表单 DOM，renderEdit(false) 的增量分支会把「新建态」残留到常规态。 */
  function exitNewNote() {
    if (!state.newNote) return false;
    state.newNote = false;
    var snap = state.nfSnap;
    state.nfSnap = null;
    if (snap) { state.edit.path = snap.path; state.edit.text = snap.text; }   // 还原此前载入（或未保存）的内容
    if (pane("edit")) renderEdit(true);
    return true;
  }
  /* 离开新建态的**统一守卫**（切页签 / 换笔记 / 进回收站都走它）：
     · 没填东西 → 立即退出，返回 true（调用方照常继续）；
     · 填了东西 → 弹「放弃未保存的新笔记？」；确认 → 退出 + 执行 resume()；取消 → 什么都不做。
     返回 false = 调用方必须中止本次导航，用户仍留在新建态（内容一字不丢）。 */
  function guardLeaveNewNote(resume) {
    if (!state.newNote) return true;
    if (nfDirty()) {
      askConfirm("放弃未保存的新笔记？", function () {
        exitNewNote();
        if (typeof resume === "function") resume();
      }, "放弃");
      return false;
    }
    exitNewNote();
    return true;
  }
  /* 显式「取消」按钮 / Esc / 关面板：用户已经明确要放弃 → 不再二次确认 */
  function closeNewNoteForm() {
    exitNewNote();
  }
  /* 表单内错误：进入新建状态后浮层不存在，错误直接写在表单里 + toast 双可见，绝不静默 */
  function nfError(msg) {
    var f = nfRoot();
    var e = f ? f.querySelector(".nferr") : null;
    if (e) { e.hidden = false; e.textContent = msg; }
    toast(msg, "bad");
  }
  async function submitNewNote() {
    var f = nfRoot();
    if (!f) return;
    var title = (f.querySelector(".nf-title").value || "").trim();
    var desc = (f.querySelector(".nf-desc").value || "").trim();
    var tags = splitTags(f.querySelector(".nf-tags").value);
    var date = (f.querySelector(".nf-date").value || "").trim() || todayYMD();
    var dir = String(f.querySelector(".nf-dir").value || "").replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/").trim();
    /* 正文框：取原文（CRLF 归一成 LF，保住用户敲的每一处换行）；缺元素时按空处理，不炸 */
    var bodyEl = f.querySelector(".nf-body");
    var body = String(bodyEl ? bodyEl.value : "").replace(/\r\n?/g, "\n");
    if (!title) return nfError("请填写标题（必填）");
    var lines = ["---", "title: " + yamlVal(title), "created: " + yamlVal(date)];
    if (desc) lines.push("description: " + yamlVal(desc));   // 描述为空 → 整行省略
    lines.push("tags: [" + tags.map(yamlVal).join(", ") + "]", "---", "", "# " + title, "");
    var text = lines.join("\n");
    /* 正文接在 `# 标题` 之下：中间空一行，末尾补一个换行；正文为空（含纯空白）→ 只留标题行（与旧行为逐字一致） */
    if (body.trim()) text += "\n" + body.replace(/\s+$/, "") + "\n";
    var basePath = (dir ? dir + "/" : "") + safeNoteStem(title) + ".md";
    var created = "";
    for (var i = 0; i < 50 && !created; i++) {
      var cand = i === 0 ? basePath : basePath.replace(/\.md$/i, "") + "-" + (i + 1) + ".md";
      try {
        // unique:true → 由服务端挑不冲突的路径；老服务不认该字段会回 409，这里自增兜底
        var r = await post("/api/note", { path: cand, text: text, content: text, unique: i === 0 });
        created = r.path || cand;
      } catch (e) {
        if (e.status === 409) continue;                    // 同名 → 自动 -2 / -3 …
        return nfError("新建失败：" + e.message);
      }
    }
    if (!created) return nfError("新建失败：同名文件过多（已试到 -50）");
    state.newNote = false;          // 创建成功 → 退出新建状态（旧快照丢弃，不还原）
    state.nfSnap = null;
    toast("已新建 " + created, "ok");
    invalidateIndex();
    await loadNote(created, true);                          // 切到编辑页并载入新笔记
  }
  async function openInObsidian() {
    var p = pane("edit");
    var ep = p ? p.querySelector(".epath") : null;
    var path = ep ? ep.value.trim() : "";
    if (!path) path = state.edit.path;
    if (!path) return toast("请先填写路径", "bad");
    try {
      var r = await get("/api/obsidian/uri?path=" + encodeURIComponent(path));
      window.open(r.uri);
      toast("已交给 Obsidian 打开：" + r.uri, "ok");
    } catch (e) { toast("生成 obsidian:// 链接失败：" + e.message, "bad"); }
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * 阅读视图：自实现 Markdown 渲染 + 白名单清洗（零依赖、零 CDN）
   * 数据流：textarea 原文 → renderMarkdown() → sanitizeHtml() → innerHTML
   * 渲染器只产出「转义后的文本 + 自己生成的标签」；笔记里的原始 HTML 先在
   * protectHtml 阶段抽成占位符（不参与转义），最后与全部产物一起过 sanitizeHtml。
   * 因此 sanitizeHtml 是唯一放行任意 HTML 的关口，必须自洽且严格。
   * ══════════════════════════════════════════════════════════════════════════ */
  var READ_TIMERS = [], readIndexKicked = false;

  /* ── 白名单清洗 ────────────────────────────────────────────────────────────
   * 策略（独立函数，不依赖 DOM 解析，浏览器/自检环境行为一致）：
   *  1. 整块删除「原始文本型」元素及其内容（script/style/title/textarea/noscript/
   *     xmp/plaintext/template）——只删标签会把脚本代码当正文显示出来；
   *  2. 删除 HTML 注释；
   *  3. 逐标签判定：标签名不在白名单 → 整条丢弃（保留其内部文字）；
   *     属性逐条判定：只保留该标签的白名单属性；on* 一律剔除；
   *     href/src/poster 命中 javascript: / vbscript: / data:text/html → 该属性丢弃；
   *     src 起始的协议相对 URL（//player.bilibili.com/… 这种 B 站写法）补成 https:；
   *     带 src 的 iframe 只接受 http(s)；<input> 只保留 type=checkbox + disabled/checked；
   *     没有 src 的 iframe 直接丢弃（否则只剩一个空框）；
   *  4. 兜底：全文再扫一遍残留 on* 属性与 javascript: URL；
   *  5. 白名单表用 Object.create(null) 建，避免 constructor / __proto__ 这类名字绕过。
   * ──────────────────────────────────────────────────────────────────────── */
  var SAN_SPEC = {
    p: "class", div: "class", span: "class data-act data-tag data-wiki", section: "class", blockquote: "class",
    h1: "class", h2: "class", h3: "class", h4: "class", h5: "class", h6: "class",
    ul: "class", ol: "class", li: "class",
    pre: "class", code: "class",
    strong: "", em: "", del: "class", mark: "class", kbd: "", sup: "", sub: "",
    br: "", hr: "class",
    table: "class", thead: "class", tbody: "class", tr: "class", th: "class", td: "class",
    img: "src alt title width height class loading",
    a: "href title target rel class data-act data-wiki data-tag",
    input: "type checked disabled",
    details: "class open", summary: "class",
    video: "src controls width height poster class preload loop muted playsinline",
    audio: "src controls class preload loop",
    iframe: "src width height allow allowfullscreen frameborder title class loading"
  };
  var SAN_ALLOW = Object.create(null);
  Object.keys(SAN_SPEC).forEach(function (t) {
    var set = Object.create(null);
    String(SAN_SPEC[t]).split(" ").filter(Boolean).forEach(function (a) { set[a] = true; });
    SAN_ALLOW[t] = set;
  });
  var SAN_BOOL = Object.create(null);   // 合法布尔属性（无值也保留）
  "controls allowfullscreen open loop muted playsinline checked disabled".split(" ").forEach(function (a) { SAN_BOOL[a] = true; });
  var SAN_URL_ATTR = Object.create(null); // 需要做协议校验的属性
  "href src poster".split(" ").forEach(function (a) { SAN_URL_ATTR[a] = true; });

  function sanitizeHtml(html) {
    var s = String(html == null ? "" : html);
    /* 1) 危险的原始文本元素：连同内容整块删除 */
    s = s.replace(/<\s*(script|style|title|textarea|noscript|xmp|plaintext|template)\b[\s\S]*?(<\s*\/\s*\1\s*>|$)/gi, "");
    /* 2) 注释删除 */
    s = s.replace(/<!--[\s\S]*?-->/g, "");
    /* 3) 逐标签过白名单 */
    s = s.replace(/<\s*\/?\s*([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^<>"'])*)\/?\s*>/g, function (m, rawName, rawAttrs) {
      var name = rawName.toLowerCase();
      var allow = SAN_ALLOW[name];
      if (!allow) return "";                                  // 标签不在白名单 → 丢弃
      if (/^<\s*\//.test(m)) return "</" + name + ">";
      var attrs = "", hasSrc = false, isCheckbox = false;
      var re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g, mm;
      while ((mm = re.exec(rawAttrs)) !== null) {
        var an = mm[1].toLowerCase();
        if (/^on/.test(an)) continue;                          // on* 事件属性一律剔除
        if (!allow[an]) continue;                              // 不在该标签白名单 → 剔除
        var av = mm[2] !== undefined ? mm[2] : (mm[3] !== undefined ? mm[3] : mm[4]);
        if (SAN_URL_ATTR[an]) {
          var v = unent(String(av == null ? "" : av)).replace(/[\u0000-\u0020]+/g, "");
          if (!v) continue;
          if (/^(javascript|vbscript|data:text\/html)/i.test(v)) continue;
          if (v.indexOf("//") === 0) v = "https:" + v;         // B 站 embed 的协议相对 URL
          if (an === "src" && name === "iframe" && !/^https?:\/\//i.test(v)) continue;
          av = v;
        }
        if (an === "type" && name === "input") {
          if (String(av).toLowerCase() !== "checkbox") continue;   // 只放行复选框
          isCheckbox = true;
        }
        if (an === "src") hasSrc = true;
        if (av === undefined || av === "") { if (SAN_BOOL[an]) attrs += " " + an; continue; }
        attrs += " " + an + '="' + esc(av) + '"';
      }
      if (name === "input") {
        if (!isCheckbox) return "";                                // 笔记里的其它 input 一律丢弃
        attrs = ' type="checkbox" disabled' + (/checked/.test(attrs) ? " checked" : "");
      }
      if (name === "iframe" && !hasSrc) return "";              // 没有 src 的 iframe 只会剩空框
      return "<" + name + attrs + ">";
    });
    /* 4) 兜底：残留 on* 属性 / 危险协议再清一次 */
    s = s.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    s = s.replace(/(href|src|poster)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, function (m) {
      return /javascript:|vbscript:|data:text\/html/i.test(m) ? "" : m;
    });
    return s;
  }

  /* ── 文本小工具 ── */
  function unent(s) {
    return String(s == null ? "" : s)
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  }
  function indentWidth(s) { return String(s || "").replace(/\t/g, "    ").length; }
  function extOf(name) {
    var m = /\.([a-z0-9]{1,5})\s*$/i.exec(String(name || "").trim());
    return m ? m[1].toLowerCase() : "";
  }
  var VIDEO_EXT = { mp4: 1, webm: 1, mov: 1, m4v: 1, ogv: 1 };
  var AUDIO_EXT = { mp3: 1, wav: 1, ogg: 1, m4a: 1, flac: 1, aac: 1 };

  /* ── 资源解析：Obsidian 式「先按文件名匹配索引，再退化为原路径丢给 /api/raw」 ── */
  function ctxDir(ctx) {
    var p = String((ctx && ctx.path) || state.edit.path || "").replace(/\\/g, "/");
    var i = p.lastIndexOf("/");
    return i < 0 ? "" : p.slice(0, i);
  }
  function pickNearest(paths, dir) {
    if (dir) for (var i = 0; i < paths.length; i++) if (paths[i].indexOf(dir + "/") === 0) return paths[i];
    return paths[0];
  }
  /** 把图片/附件/笔记名解析成 vault 相对路径；解析不到返回 null */
  function resolveAssetPath(target, ctx) {
    var t = unent(String(target || "").trim()).replace(/^<|>$/g, "");
    if (!t || /^(https?:)?\/\//i.test(t) || /^data:/i.test(t)) return null;
    var clean = t.replace(/^\.\//, "").replace(/^[/\\]+/, "").replace(/\\/g, "/");
    var idx = state.index || {}, atts = idx.attachments || [], notes = idx.notes || [];
    var dir = ctxDir(ctx), lower = clean.toLowerCase(), base = lower.split("/").pop(), i, p;
    for (i = 0; i < atts.length; i++) if (String(atts[i].path).toLowerCase() === lower) return atts[i].path;   // 1) 本就是 vault 相对路径
    if (dir) {                                                                                                  // 2) 当前笔记同目录
      p = (dir + "/" + clean).toLowerCase();
      for (i = 0; i < atts.length; i++) if (String(atts[i].path).toLowerCase() === p) return atts[i].path;
    }
    var hits = [];                                                                                              // 3) 全库同名（同目录优先）
    for (i = 0; i < atts.length; i++) if (String(atts[i].name).toLowerCase() === base) hits.push(atts[i].path);
    if (hits.length) return pickNearest(hits, dir);
    var nb = base.replace(/\.md$/, ""), nhits = [];                                                             // 4) 也允许解析到笔记
    for (i = 0; i < notes.length; i++) {
      var np = String(notes[i].path), nlow = np.toLowerCase();
      if (nlow === lower || nlow === lower + ".md" || nlow.split("/").pop().replace(/\.md$/, "") === nb) nhits.push(np);
    }
    if (nhits.length) return pickNearest(nhits, dir);
    return null;
  }
  /** 资源最终 URL：外链原样，本地一律走 /api/raw（中文/空格交给 encodeURIComponent） */
  function mediaSrc(target, ctx) {
    var t = unent(String(target || "").trim()).replace(/^<|>$/g, "");
    if (/^https?:\/\//i.test(t)) return esc(t);
    if (/^data:image\//i.test(t)) return esc(t);
    var rel = resolveAssetPath(t, ctx) || t.replace(/^\.\//, "").replace(/^[/\\]+/, "").replace(/\\/g, "/");
    return esc(BASE + "/api/raw?path=" + encodeURIComponent(rel));
  }
  /* 注意：inlineMd 的捕获组来自「已转义文本」，直接使用即可（再 esc 会双重转义）；
     由索引/自己拼出来的字符串必须 esc。 */
  function embedTag(target, ctx) {
    var t = String(target || "").trim();
    if (!t) return "";
    var src = mediaSrc(t, ctx), ext = extOf(t);
    if (VIDEO_EXT[ext] === 1) return '<video class="obs-video" controls preload="metadata" src="' + src + '"></video>';
    if (AUDIO_EXT[ext] === 1) return '<audio class="obs-audio" controls preload="metadata" src="' + src + '"></audio>';
    if (ext === "pdf") return '<a class="obs-file" href="' + src + '" target="_blank" rel="noreferrer noopener">📄 ' + esc(t) + "</a>";
    return '<img class="obs-img" src="' + src + '" alt="' + esc(t) + '" loading="lazy">';
  }
  function imageTag(alt, url, ctx) {
    var u = String(url == null ? "" : url).trim();
    if (!u) return String(alt || "");
    if (/^https?:\/\//i.test(unent(u)) || /^data:image\//i.test(unent(u))) {
      return '<img class="obs-img" src="' + esc(unent(u)) + '" alt="' + alt + '" loading="lazy">';
    }
    return '<img class="obs-img" src="' + mediaSrc(u, ctx) + '" alt="' + alt + '" loading="lazy">';
  }
  function linkTag(text, url) {
    var u = String(url == null ? "" : url).trim();
    if (!u) return String(text || "");
    if (/^\s*(javascript|vbscript|data:text\/html)/i.test(unent(u))) return String(text || "");
    return '<a href="' + u + '" target="_blank" rel="noreferrer noopener">' + (String(text || "") || u) + "</a>";
  }
  function wikiLink(target, alias, ctx) {
    var t = String(target || "").trim();
    var label = String(alias == null ? "" : alias).trim() || t;
    var tgt = t.split("#")[0].trim();
    var rel = resolveAssetPath(tgt, ctx);
    return '<a class="obs-wikilink" data-act="wiki-open" data-wiki="' + esc(rel || tgt) + '" title="' +
      esc(rel ? "打开笔记：" + rel : "索引中未找到，尝试按原路径载入：" + tgt) + '">' + label + "</a>";
  }

  /* ── 行内渲染：单趟扫描（replacement 的输出不会被再次匹配，
   *    否则裸 URL 规则会吃掉刚生成的 href/src 属性） ── */
  var INLINE_RE = /(`+)([\s\S]*?)\1|!\[\[([^\]\n]+)\]\]|!\[([^\]]*)\]\(([^)\n]+)\)|\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]|\[([^\]]*)\]\(([^)\n]+)\)|(https?:\/\/[^\s<>"'`）)】]+)|(==[^=\n]+==|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*)|((?:^|[\s(（>])#([\p{L}\p{N}_\u4e00-\u9fa5/\-]{1,40}))/gu;

  function splitTarget(raw) {
    var s = String(raw == null ? "" : raw).trim();
    var m = /^(.*?)\s+["'][^"']*["']$/.exec(s);   // 去掉可选 title
    if (m) s = m[1].trim();
    if (s.charAt(0) === "<" && s.charAt(s.length - 1) === ">") s = s.slice(1, -1).trim();
    return s;
  }
  function inlineMd(text, ctx) {
    var src = String(text == null ? "" : text).replace(/\u0000/g, "");
    var stash = [];
    var put = function (html) { stash.push(html); return "\uE000" + (stash.length - 1) + "\uE001"; };
    /* 1) 行内代码：先抽走，内部符号不再当语法 */
    src = src.replace(/(`+)([\s\S]*?)\1/g, function (m, ticks, code) { return put("<code>" + esc(code.replace(/^\s+|\s+$/g, "")) + "</code>"); });
    /* 2) 原始 HTML：抽成占位符（不参与转义），最终由 sanitizeHtml 过白名单 */
    src = src.replace(/<!--[\s\S]*?-->/g, function () { return put(""); });
    src = src.replace(/<\/?[a-zA-Z][^<>]*>/g, function (m) { return put(m); });
    /* 3) 其余文本一律转义 */
    src = esc(src);
    /* 4) 单趟扫描行内语法 */
    src = src.replace(INLINE_RE, function (m, g1, g2, g3, g4, g5, g6, g7, g8, g9, g10, g11, g12, g13) {
      if (g3 !== undefined) return embedTag(g3, ctx);                       // ![[x.png]]
      if (g5 !== undefined) return imageTag(g4, splitTarget(g5), ctx);      // ![alt](path)
      if (g6 !== undefined) return wikiLink(g6, g7, ctx);                   // [[笔记|别名]]
      if (g9 !== undefined) return linkTag(g8, splitTarget(g9));            // [文字](url)
      if (g10) return linkTag(g10, g10);                                    // 裸 URL 自动链接
      if (g11) {                                                            // 强调 / 高亮 / 删除线
        var t = g11;
        if (t.slice(0, 2) === "==") return "<mark>" + t.slice(2, -2) + "</mark>";
        if (t.slice(0, 2) === "**" || t.slice(0, 2) === "__") return "<strong>" + t.slice(2, -2) + "</strong>";
        if (t.slice(0, 2) === "~~") return "<del>" + t.slice(2, -2) + "</del>";
        return "<em>" + t.slice(1, -1) + "</em>";
      }
      if (g13) {                                                            // #标签（g12 含前置空白/括号）
        var ii = m.indexOf("#");
        return m.slice(0, ii) + '<a class="obs-tag" data-act="wiki-tag" data-tag="' + g13 + '">#' + g13 + "</a>";
      }
      return m;
    });
    /* 5) 软换行 → <br>（先于占位符还原，避免把换行插进原始 HTML 标签里） */
    src = src.replace(/\n/g, "<br>");
    src = src.replace(/\uE000(\d+)\uE001/g, function (m, i) { return stash[Number(i)] || ""; });
    return src;
  }

  /* ══ 机器注释（DSH-IMAGE-DESC）→ 只读卡片 ══
     投喂流程把「电脑看图」的结果按
       <!-- DSH-IMAGE-DESC v1 {…JSON（可跨多行）…} -->
     写进笔记正文。它**是给机器读的结构**，但用户也要看得见、看得懂：
       · 渲染成灰底 / 边框 / 等宽的**只读卡片**，与正文明显区分；
       · 卡内**不出现任何编辑 / 保存 / 删除入口**（连一个 button 都没有）✗；
       · 字段按标签排版（不是一坨 JSON）；末行给可折叠的「原始 JSON」便于核对；
       · 注释原文**始终原样留在笔记文件里**（这里只渲染、绝不回写）✗。
     降级：JSON 解析失败 → 「⚠️ 机器注释损坏（无法解析）」+ 原文，绝不抛异常。 */
  var MNOTE_RE = /^\s*<!--\s*DSH-IMAGE-DESC\b/;
  var MNOTE_KIND = Object.create(null);
  MNOTE_KIND.kline = "图表 / 走势图"; MNOTE_KIND.intraday = "盘中图"; MNOTE_KIND.table = "表格";
  MNOTE_KIND.text = "文字图"; MNOTE_KIND.decorative = "装饰图"; MNOTE_KIND.unknown = "未知类型";
  var MNOTE_CONF = Object.create(null);
  MNOTE_CONF["self-read"] = "已看清（self-read）";
  MNOTE_CONF.uncertain = "不确定（uncertain）";
  MNOTE_CONF["barely-legible"] = "勉强可辨（barely-legible）";
  var MNOTE_CONF_CLS = Object.create(null);
  MNOTE_CONF_CLS["self-read"] = "ok"; MNOTE_CONF_CLS.uncertain = "warn"; MNOTE_CONF_CLS["barely-legible"] = "bad";
  var MNOTE_WARN_T = "⚠️ 电脑理解信息 · DSH 自动生成 · 【请勿手动改动】";
  var MNOTE_WARN_S = "改动会破坏机器可读结构，影响检索与提炼。";
  /** 取映射值时防 `constructor` / `__proto__` 这类名字（机器注释里的 kind 不可信） */
  function mnoteMap(map, k, dflt) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : dflt; }
  /** 标量 → 可读一行（布尔 / 数字 / null 都要看得见，不显示 [object Object]） */
  function mnoteVal(v) {
    if (v === null || v === undefined) return "（空）";
    if (typeof v === "boolean") return v ? "是" : "否";
    if (typeof v === "number") return String(v);
    var s = String(v);
    return s.trim() ? s : "（空）";
  }
  /** data 字段 → 键值对结构化展开（嵌套对象/数组缩进；不是一坨 JSON） */
  function mnoteData(v, depth) {
    if (v === null || typeof v !== "object") return '<span class="obs-mnote-sv">' + esc(mnoteVal(v)) + "</span>";
    if (Object.prototype.toString.call(v) === "[object Array]") {
      if (!v.length) return '<span class="obs-mnote-sv">（空数组）</span>';
      return '<ul class="obs-mnote-sub">' + v.map(function (x) {
        return "<li>" + (x !== null && typeof x === "object"
          ? mnoteData(x, depth + 1)
          : '<span class="obs-mnote-sv">' + esc(mnoteVal(x)) + "</span>") + "</li>";
      }).join("") + "</ul>";
    }
    var keys = Object.keys(v);
    if (!keys.length) return '<span class="obs-mnote-sv">（空对象）</span>';
    return '<div class="obs-mnote-kv' + (depth ? " sub" : "") + '">' + keys.map(function (k) {
      return '<div class="obs-mnote-pair"><span class="obs-mnote-pk">' + esc(k) + '</span><span class="obs-mnote-pv">' +
        mnoteData(v[k], depth + 1) + "</span></div>";
    }).join("") + "</div>";
  }
  /** source 字段：pdf / page / img（有 provided_by / file 也一并显示） */
  function mnoteSource(src) {
    if (src === null || src === undefined) return '<span class="obs-mnote-sv">（无）</span>';
    if (typeof src !== "object") return '<span class="obs-mnote-sv">' + esc(mnoteVal(src)) + "</span>";
    var keys = Object.keys(src);
    if (!keys.length) return '<span class="obs-mnote-sv">（无）</span>';
    return '<div class="obs-mnote-kv">' + keys.map(function (k) {
      return '<div class="obs-mnote-pair"><span class="obs-mnote-pk">' + esc(k) + '</span><span class="obs-mnote-pv">' +
        esc(mnoteVal(src[k])) + "</span></div>";
    }).join("") + "</div>";
  }
  function mnoteWarn() {
    return '<div class="obs-mnote-warn">' +
      '<div class="obs-mnote-warn-t">' + esc(MNOTE_WARN_T) + "</div>" +
      '<div class="obs-mnote-warn-s">' + esc(MNOTE_WARN_S) + "</div></div>";
  }
  /** 一段 `<!-- DSH-IMAGE-DESC … -->` 原文 → 只读卡片 HTML（解析失败 → 降级卡片） */
  function mnoteCard(raw) {
    var body = String(raw == null ? "" : raw).replace(/^\s*<!--/, "").replace(/-->\s*$/, "").trim();
    var ver = "v1", json = body;
    var m = /^DSH-IMAGE-DESC\s*([^\s{]*)\s*([\s\S]*)$/.exec(body);
    if (m) { ver = String(m[1] || "v1").trim() || "v1"; json = m[2] || ""; }
    var j = null, why = "";
    try { j = JSON.parse(json.trim() || "null"); } catch (e) { why = e && e.message ? String(e.message) : String(e); }
    if (!j || typeof j !== "object" || Object.prototype.toString.call(j) === "[object Array]") {
      if (!why) why = "顶层不是对象";
      return '<div class="obs-mnote bad">' + mnoteWarn() +
        '<div class="obs-mnote-dmg">⚠️ 机器注释损坏（无法解析）：' + esc(why) + "</div>" +
        '<pre class="obs-mnote-raw"><code>' + esc(body) + "</code></pre></div>";
    }
    var kind = String(j.kind == null ? "unknown" : j.kind);
    var rows = "";
    var row = function (k, v) {
      rows += '<div class="obs-mnote-row"><span class="obs-mnote-k">' + esc(k) + '</span><div class="obs-mnote-v">' + v + "</div></div>";
    };
    var ti = Array.isArray(j.text_in_image) ? j.text_in_image : [];
    row("图内文字" + (ti.length ? "（" + ti.length + " 条）" : ""), ti.length
      ? '<ul class="obs-mnote-list">' + ti.map(function (s) { return "<li>" + esc(mnoteVal(s)) + "</li>"; }).join("") + "</ul>"
      : '<span class="obs-mnote-sv">（无）</span>');
    if (j.data !== undefined) row("结构化数据", mnoteData(j.data, 0));
    var sc = Array.isArray(j.searchable) ? j.searchable : [];
    row("可检索关键词" + (sc.length ? "（" + sc.length + "）" : ""), sc.length
      ? '<span class="obs-mnote-tags">' + sc.map(function (s) {
          return '<span class="obs-mnote-tag">' + esc(mnoteVal(s)) + "</span>";
        }).join("") + "</span>"
      : '<span class="obs-mnote-sv">（无）</span>');
    row("来源 source", mnoteSource(j.source));
    var conf = j.confidence == null ? "" : String(j.confidence);
    row("置信度", '<span class="obs-mnote-conf ' + esc(mnoteMap(MNOTE_CONF_CLS, conf, "")) + '">' +
      esc(conf ? mnoteMap(MNOTE_CONF, conf, conf) : "未标注") + "</span>");
    if (j.notes !== undefined && String(mnoteVal(j.notes)) !== "（空）") {
      row("备注", '<span class="obs-mnote-notes">' + esc(mnoteVal(j.notes)) + "</span>");
    }
    return '<div class="obs-mnote">' + mnoteWarn() +
      '<div class="obs-mnote-hd"><span class="obs-mnote-ver">DSH-IMAGE-DESC ' + esc(ver) + "</span>" +
        '<span class="obs-mnote-kind">' + esc(mnoteMap(MNOTE_KIND, kind, kind)) + "</span>" +
        '<span class="obs-mnote-t">' + esc(j.title ? mnoteVal(j.title) : "（无标题）") + "</span></div>" +
      '<div class="obs-mnote-bd">' + rows + "</div>" +
      '<details class="obs-mnote-json"><summary>原始 JSON（点击展开核对）</summary>' +
        "<pre><code>" + esc(json.trim()) + "</code></pre></details>" +
      "</div>";
  }

  /* ── 块级渲染 ── */
  var LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  var FENCE_RE = /^\s*(```+|~~~+)\s*([^\s`]*)\s*$/;
  var HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  var HEAD_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
  var QUOTE_RE = /^\s{0,3}>/;
  var HTML_LINE_RE = /^\s*<\/?[a-zA-Z][^<>]*>/;
  var CALLOUT_MAP = {
    note: "note", info: "info", tip: "tip", hint: "tip", success: "tip", check: "tip", done: "tip",
    question: "info", help: "info", faq: "info", todo: "info", abstract: "note", summary: "note", quote: "note", example: "note",
    warning: "warning", caution: "warning", attention: "warning", important: "warning",
    danger: "danger", error: "danger", bug: "danger", failure: "danger", fail: "danger", missing: "danger"
  };
  var CALLOUT_TITLE = { note: "Note", tip: "Tip", warning: "Warning", danger: "Danger", info: "Info" };

  function isTableStart(lines, i) {
    return i + 1 < lines.length && String(lines[i]).indexOf("|") >= 0 &&
      /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].indexOf("-") >= 0;
  }
  function isBlockStart(lines, i) {
    var ln = lines[i];
    if (!ln.trim()) return true;
    return FENCE_RE.test(ln) || HR_RE.test(ln) || HEAD_RE.test(ln) || QUOTE_RE.test(ln) ||
      LIST_RE.test(ln) || HTML_LINE_RE.test(ln) || MNOTE_RE.test(ln);
  }
  /* frontmatter → 属性区块（仿 Obsidian Properties；不显示 --- 分隔线） */
  function propsBlock(lines) {
    var rows = "";
    lines.forEach(function (ln) {
      var m = /^([^:#][^:]*):\s*(.*)$/.exec(ln);
      if (!m) return;
      var k = m[1].trim(), v = m[2].trim();
      if (!k) return;
      var isTags = /^(tags?|标签)$/i.test(k), vals = [];
      if (/^\[.*\]$/.test(v)) vals = v.slice(1, -1).split(",");
      else if (isTags) vals = v.split(/[,\s]+/);
      var body;
      if (isTags) body = vals.map(function (x) { return x.trim().replace(/^#/, "").replace(/^["']|["']$/g, ""); })
        .filter(Boolean).map(function (t) { return '<span class="pill" data-act="wiki-tag" data-tag="' + esc(t) + '">#' + esc(t) + "</span>"; }).join("");
      else if (vals.length && vals.every(function (x) { return /^#?[\p{L}\p{N}_\u4e00-\u9fa5/.-]+$/u.test(x.trim()); }))
        body = vals.map(function (x) { return x.trim().replace(/^#/, ""); })
          .map(function (t) { return '<span class="pill" data-act="wiki-tag" data-tag="' + esc(t) + '">#' + esc(t) + "</span>"; }).join("");
      else body = esc(v.replace(/^["']|["']$/g, ""));
      rows += '<div class="obs-prop"><span class="k">' + esc(k) + '</span><span class="v">' + (body || "—") + "</span></div>";
    });
    return rows ? '<div class="obs-props">' + rows + "</div>" : "";
  }
  function listBlock(lines, i, ctx) {
    var first = LIST_RE.exec(lines[i]);
    var ordered = /^\d/.test(first[2]);
    var indent = indentWidth(first[1]), items = [];
    while (i < lines.length) {
      var m = LIST_RE.exec(lines[i]);
      if (!m) break;
      var ind = indentWidth(m[1]);
      if (ind < indent) break;
      if (ind === indent && /^\d/.test(m[2]) !== ordered) break;  // 同层有序/无序混排 → 拆成两个列表
      if (ind > indent) {                                   // 更深缩进 = 子列表，挂到上一个条目里
        var sub = listBlock(lines, i, ctx);
        if (items.length) items[items.length - 1].kids.push(sub.html);
        i = sub.next;
        continue;
      }
      var item = { text: m[3], kids: [] };
      items.push(item);
      i++;
      while (i < lines.length && lines[i].trim() && !LIST_RE.test(lines[i]) && !isBlockStart(lines, i) &&
             indentWidth(/^(\s*)/.exec(lines[i])[1]) > indent) {   // 续行
        item.text += " " + lines[i].trim();
        i++;
      }
    }
    var tag = ordered ? "ol" : "ul", html = "<" + tag + ">";
    items.forEach(function (it) {
      var task = /^\[([ xX])\]\s*([\s\S]*)$/.exec(it.text.trim());
      if (task) {   // 任务列表 → 只读复选框
        html += '<li class="obs-task"><input type="checkbox" disabled' + (task[1].toLowerCase() === "x" ? " checked" : "") +
          "><span>" + inlineMd(task[2], ctx) + "</span>";
      } else {
        html += "<li>" + inlineMd(it.text, ctx);
      }
      html += it.kids.join("") + "</li>";
    });
    return { html: html + "</" + tag + ">", next: i };
  }
  function tableBlock(lines, i, ctx) {
    var parseRow = function (l) {
      return String(l).trim().replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map(function (c) { return c.trim(); });
    };
    var head = parseRow(lines[i]);
    var align = parseRow(lines[i + 1]).map(function (c) {
      var l = c.charAt(0) === ":", r = c.charAt(c.length - 1) === ":";
      return l && r ? "al-center" : r ? "al-right" : l ? "al-left" : "";
    });
    i += 2;
    var rows = [];
    while (i < lines.length && lines[i].trim() && String(lines[i]).indexOf("|") >= 0) { rows.push(parseRow(lines[i])); i++; }
    var h = "<thead><tr>" + head.map(function (c, k) {
      return '<th class="' + (align[k] || "") + '">' + inlineMd(c, ctx) + "</th>";
    }).join("") + "</tr></thead><tbody>";
    h += rows.map(function (r) {
      var tds = "";
      for (var k = 0; k < Math.max(r.length, head.length); k++) {
        var cls = align[k] || "";
        var cell = r[k] === undefined ? "" : r[k];
        if (k === 0 && !cell) { /* 首列为空也照常输出，保持列数对齐 */ }
        tds += '<td class="' + cls + '">' + inlineMd(cell, ctx) + "</td>";
      }
      return "<tr>" + tds + "</tr>";
    }).join("");
    return { html: '<div class="obs-tablewrap"><table class="obs-table">' + h + "</tbody></table></div>", next: i };
  }
  function quoteBlock(lines, i, ctx) {
    var buf = [];
    while (i < lines.length && QUOTE_RE.test(lines[i])) { buf.push(lines[i].replace(/^\s{0,3}>\s?/, "")); i++; }
    var cm = /^\s*\[!([A-Za-z]+)\]([+-])?\s*([\s\S]*)$/.exec(buf[0] || "");
    if (cm) {   // Obsidian callout
      var kind = CALLOUT_MAP[cm[1].toLowerCase()] || "note";
      var title = String(cm[3] || "").trim() || CALLOUT_TITLE[kind] || cm[1];
      return {
        html: '<div class="obs-callout ' + kind + '"><div class="obs-callout-t">' + inlineMd(title, ctx) +
          '</div><div class="obs-callout-b">' + renderBlocks(buf.slice(1), ctx) + "</div></div>",
        next: i
      };
    }
    return { html: '<div class="obs-quote">' + renderBlocks(buf, ctx) + "</div>", next: i };
  }
  function renderBlocks(lines, ctx) {
    var out = [], i = 0;
    while (i < lines.length) {
      var ln = lines[i];
      if (!ln.trim()) { i++; continue; }
      /* 机器注释块（可跨多行）→ 只读卡片；**必须排在最前**：它既不是段落也不是原始 HTML。
         找不到结束标记 `-->` 时不吞掉整篇（按普通文本走下面的段落分支）。 */
      if (MNOTE_RE.test(ln)) {
        var mEnd = -1;
        for (var mj = i; mj < lines.length && mj < i + 500; mj++) { if (lines[mj].indexOf("-->") >= 0) { mEnd = mj; break; } }
        if (mEnd >= 0) { out.push(mnoteCard(lines.slice(i, mEnd + 1).join("\n"))); i = mEnd + 1; continue; }
      }
      var fence = FENCE_RE.exec(ln);
      if (fence) {                                   // 围栏代码块（内容原样转义，不做语法高亮）
        var lang = fence[2] || "", buf = [];
        i++;
        while (i < lines.length && !/^\s*(```+|~~~+)\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push('<div class="obs-code"><span class="obs-code-lang">' + esc(lang || "text") + "</span><pre><code>" +
          esc(buf.join("\n")) + "</code></pre></div>");
        continue;
      }
      if (HR_RE.test(ln)) { out.push('<hr class="obs-hr">'); i++; continue; }
      var hm = HEAD_RE.exec(ln);
      if (hm) {                                      // 标题 h1–h6
        var lv = hm[1].length;
        out.push("<h" + lv + ' class="obs-h">' + inlineMd(hm[2], ctx) + "</h" + lv + ">");
        i++; continue;
      }
      if (QUOTE_RE.test(ln)) { var q = quoteBlock(lines, i, ctx); out.push(q.html); i = q.next; continue; }
      if (isTableStart(lines, i)) { var tb = tableBlock(lines, i, ctx); out.push(tb.html); i = tb.next; continue; }
      if (LIST_RE.test(ln)) { var lb = listBlock(lines, i, ctx); out.push(lb.html); i = lb.next; continue; }
      if (HTML_LINE_RE.test(ln)) {                   // 原始 HTML 块（iframe/video/details/div …）整段透传
        var hb = [];
        while (i < lines.length && lines[i].trim()) { hb.push(lines[i]); i++; }
        out.push(hb.join("\n"));
        continue;
      }
      var para = [];                                 // 段落
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines, i) && !isTableStart(lines, i)) {
        para.push(lines[i].trim()); i++;
      }
      out.push('<p class="obs-p">' + inlineMd(para.join("\n"), ctx) + "</p>");
    }
    return out.join("");
  }
  /** markdown → HTML（未清洗；调用方必须再过 sanitizeHtml 才能插入 DOM） */
  function renderMarkdown(md, ctx) {
    var lines = String(md == null ? "" : md).replace(/\r\n?/g, "\n").split("\n");
    var props = "", i = 0;
    if (/^---\s*$/.test(lines[0] || "")) {
      var end = -1;
      for (var k = 1; k < lines.length; k++) if (/^(---|\.\.\.)\s*$/.test(lines[k])) { end = k; break; }
      if (end > 0) { props = propsBlock(lines.slice(1, end)); i = end + 1; }
    }
    return '<div class="obs-doc">' + props + renderBlocks(lines.slice(i), ctx) + "</div>";
  }

  /* ── 阅读视图：切换 / 渲染 / 嵌入降级提示 ── */
  function clearReadTimers() {
    READ_TIMERS.forEach(function (t) { clearTimeout(t); });
    READ_TIMERS = [];
  }
  /* iframe 的「可见降级」：无法可靠探测宿主 CSP，所以无条件给出来源地址 + 新窗口打开，
     再用 load 事件做启发式判断（3.5s 未 load 就显式提示可能被拦截）。注意：只插入兄弟节点，
     绝不搬动 iframe 本身（移动 DOM 节点会强制重新加载）。 */
  function decorateEmbeds(box) {
    var frames = box.querySelectorAll("iframe");
    for (var i = 0; i < frames.length; i++) {
      (function (fr) {
        var src = fr.getAttribute("src") || "";
        var bar = document.createElement("div");
        bar.className = "obs-embed-bar";
        bar.innerHTML = '<span class="obs-embed-url" title="' + esc(src) + '">' + esc(src) + "</span>" +
          '<a class="obs-embed-open" href="' + esc(src) + '" target="_blank" rel="noreferrer noopener">新窗口打开 ↗</a>';
        var tip = document.createElement("div");
        tip.className = "obs-embed-tip";
        tip.hidden = true;
        tip.textContent = "嵌入内容未在 3.5 秒内加载：宿主窗口的 CSP（frame-src）可能拦截了外部 iframe。可点上方「新窗口打开」用浏览器观看。";
        fr.parentNode.insertBefore(bar, fr);
        fr.parentNode.insertBefore(tip, fr.nextSibling);
        var loaded = false;
        fr.addEventListener("load", function () { loaded = true; });
        READ_TIMERS.push(setTimeout(function () {
          if (!loaded && tip.isConnected) tip.hidden = false;
        }, 3500));
      })(frames[i]);
    }
  }
  function renderReading(text, path) {
    var p = pane("edit");
    if (!p) return;
    var box = p.querySelector(".dsh-obs-read");
    if (!box) return;
    clearReadTimers();
    var html;
    try { html = renderMarkdown(text, { path: path || state.edit.path || "" }); }
    catch (e) { html = '<div class="obs-doc"><p class="obs-p">渲染失败：' + esc(e.message) + "</p></div>"; }
    box.innerHTML = sanitizeHtml(html);   // 清洗后才插入 DOM
    decorateEmbeds(box);
    if (!state.index && !readIndexKicked) {   // 附件索引没载入 → 补一次并重渲染（失败不重试，避免自激）
      readIndexKicked = true;
      loadIndex(false).then(function () {
        if (!state.index) return;
        readIndexKicked = false;
        if (state.editMode !== "read") return;
        var pp = pane("edit");
        if (!pp) return;
        var ta = pp.querySelector(".dsh-obs-ta"), ep = pp.querySelector(".epath");
        renderReading(ta ? ta.value : "", ep ? ep.value.trim() : "");
      });
    }
  }
  /* ── 投喂附件护栏（**只读提示**，绝不自动改文件 ✗）──────────────────────────────
     背景：投喂入库时图被复制到 `attachments/`，但当时它们没有被别的笔记引用 → 用户的
     「清理未使用附件」会把它们一起清掉（实测已发生过）。服务端已在 `.dsh/ingest-manifest.jsonl`
     记下「这篇笔记本该有哪些附件」；这里**只读**比对：有 missing 就在笔记查看器里出一条提示，
     告诉用户可从暂存区重抽 / 或从 git 恢复。**不写文件、不自动补齐、不改笔记** ✓。 */
  var maniSeq = 0;
  function showIngestManifestTip(j) {
    var p = pane("edit");
    if (!p) return;
    var box = p.querySelector(".ing-mani");
    if (!box) return;
    var n = j ? Number(j.missing || 0) : 0;
    if (!n) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML = "";
    box.appendChild(document.createTextNode("⚠️ 本笔记有 " + n + " 张附件已被清理（可从暂存区重抽/或从 git 恢复）"));
    var miss = (j && j.missingList) || [];
    if (miss.length) {
      var s = document.createElement("div");
      s.style.cssText = "margin-top:3px;color:var(--ob-tx2);font-size:10.5px";
      s.textContent = "缺失：" + miss.join("、");
      box.appendChild(s);
    }
  }
  async function checkIngestManifest(path) {
    var my = ++maniSeq;
    showIngestManifestTip(null);                     // 先收起上一条笔记的提示（绝不留别人的）
    if (!path) return;
    try {
      var j = await get("/api/ingest/manifest?note=" + encodeURIComponent(String(path)));
      if (my !== maniSeq) return;                    // 期间又载入了别的笔记 → 丢弃（防串台）
      if (!j || !j.ok) return;
      showIngestManifestTip(j);
    } catch (e) { /* 护栏提示失败**静默**：这不是功能主链，不打扰用户、不弹错、不重试 */ }
  }
  function modeBtn(mode, label) {
    return '<button class="dsh-obs-mb' + (state.editMode === mode ? " on" : "") + '" data-act="edit-mode" data-mode="' +
      mode + '">' + label + "</button>";
  }
  function applyEditMode(rerender) {
    var p = pane("edit");
    if (!p) return;
    p.setAttribute("data-mode", state.editMode);
    var btns = p.querySelectorAll(".dsh-obs-mb");
    for (var i = 0; i < btns.length; i++) {
      btns[i].className = "dsh-obs-mb" + (btns[i].getAttribute("data-mode") === state.editMode ? " on" : "");
    }
    var box = p.querySelector(".dsh-obs-read");
    if (box) box.hidden = state.editMode !== "read";
    if (state.editMode === "read" && rerender !== false) {
      var ta = p.querySelector(".dsh-obs-ta"), ep = p.querySelector(".epath");
      renderReading(ta ? ta.value : "", ep ? ep.value.trim() : state.edit.path);   // 以 textarea 当前内容为准（未保存也能看）
    } else {
      clearReadTimers();
    }
  }
  function setEditMode(mode) {
    state.editMode = mode === "read" ? "read" : "edit";
    try { localStorage.setItem(LS.editmode, state.editMode); } catch (e) {}
    applyEditMode(true);
  }

  /* [[笔记]] → 切「编辑」页载入；#标签 → 切「笔记」页按标签过滤（复用既有 state.tag / 搜索） */
  async function openWiki(target) {
    var t = String(target || "").trim();
    if (!t) return;
    if (!state.index) { try { await loadIndex(false); } catch (e) {} }
    var path = t, notes = (state.index && state.index.notes) || [], lower = t.toLowerCase();
    if (!/\.md$/i.test(t)) {
      for (var i = 0; i < notes.length; i++) {
        var np = String(notes[i].path), nlow = np.toLowerCase();
        if (nlow === lower + ".md" || nlow.split("/").pop().replace(/\.md$/, "") === lower) { path = np; break; }
      }
      if (path === t) toast("索引中未找到「" + t + "」，尝试按原路径载入", "bad");
    }
    await loadNote(path, true);
  }
  function openTag(tag) {
    var t = String(tag || "").replace(/^#/, "").trim();
    if (!t) return;
    state.tag = t; state.q = "";
    setTab("notes");
    loadIndex(false).then(function () {
      renderTagOptions();
      var sel = qs(".dsh-obs-pane[data-pane='notes'] .tagsel");
      if (sel) sel.value = state.tag;
      var qi = qs(".dsh-obs-pane[data-pane='notes'] .q");
      if (qi) qi.value = "";
      doSearch();
    });
  }

  /* ══ 页签 3：结构（目录 / 移动 / 标签） ══ */
  function treeOf(dirs) {
    var root = { children: {} };
    (dirs || []).forEach(function (d) {
      var node = root;
      d.split("/").forEach(function (seg) {
        if (!node.children[seg]) node.children[seg] = { children: {} };
        node = node.children[seg];
      });
    });
    return root;
  }
  function noteCount(dirPath) {
    if (!state.index) return 0;
    var pre = dirPath + "/";
    return state.index.notes.filter(function (n) { return n.path.indexOf(pre) === 0; }).length;
  }
  function treeHtml(node, prefix, depth) {
    var keys = Object.keys(node.children).sort();
    var out = "";
    keys.forEach(function (k) {
      var full = prefix ? prefix + "/" + k : k;
      var kids = Object.keys(node.children[k].children).length;
      var open = state.treeOpen[full] === undefined ? depth === 0 : state.treeOpen[full] === true;
      var n = noteCount(full);
      out += '<div class="tnode" data-act="tgl" data-dir="' + esc(full) + '" style="padding-left:' + (depth * 11 + 4) + 'px">' +
        '<span class="tgl">' + (kids ? (open ? "▾" : "▸") : "·") + '</span>' +
        '<span class="tdir">' + esc(k) + '</span>' +
        (n ? '<span class="tcnt">' + n + '</span>' : "") +
        /* 目录「移动」入口：与整行的展开/收起（data-act="tgl"）同一行、同一层级；
           closest("[data-act]") 从点击目标向上找，会先命中这里，故点它不会误触展开。 */
        '<span class="tmv" data-act="dir-move" data-dir="' + esc(full) + '" title="移动 / 重命名该目录">移动</span>' +
        '</div>';
      if (kids && open) out += treeHtml(node.children[k], full, depth + 1);
    });
    return out;
  }
  function renderStruct() {
    var p = pane("struct");
    if (!p) return;
    closeDirMove();     // 结构页重绘（刷新 / 移动成功 / 新建目录）时把「移动」浮层一并收掉（幂等）
    var dirs = (state.index && state.index.dirs) || [];
    var tree = treeOf(dirs);
    var htmlTree = Object.keys(tree.children).length ? treeHtml(tree, "", 0) : '<div class="dsh-obs-empty">（暂无子目录）</div>';
    var cur = state.edit.path || "";
    p.innerHTML =
      '<div class="dsh-obs-sec"><div class="sh">📁 目录树 <span class="sp"></span>' +
        '<button class="dsh-obs-btn x" data-act="reload-struct" title="刷新">↻</button></div>' +
        '<div class="tree">' + htmlTree + '</div></div>' +
      '<div class="dsh-obs-sec"><div class="sh">➕ 新建目录</div>' +
        '<div class="dsh-obs-tool"><input class="dsh-obs-in mk" placeholder="相对目录，如 20-notes/新主题" />' +
        '<button class="dsh-obs-btn" data-act="mkdir">创建</button></div></div>' +
      '<div class="dsh-obs-sec"><div class="sh">🔀 移动 / 重命名</div>' +
        '<div class="dsh-obs-tool"><input class="dsh-obs-in mv-from" placeholder="源路径 .md" value="' + esc(cur) + '" /></div>' +
        '<div class="dsh-obs-tool"><input class="dsh-obs-in mv-to" placeholder="目标路径 .md" />' +
        '<button class="dsh-obs-btn" data-act="move">执行</button></div></div>' +
      '<div class="dsh-obs-sec"><div class="sh">🏷 打标签</div>' +
        '<div class="dsh-obs-tool"><input class="dsh-obs-in tg-path" placeholder="笔记相对路径 .md" value="' + esc(cur) + '" /></div>' +
        '<div class="dsh-obs-tool"><input class="dsh-obs-in tg-tags" placeholder="标签，逗号分隔" />' +
        '<select class="dsh-obs-in tg-mode"><option value="add">添加</option><option value="remove">移除</option></select>' +
        '<button class="dsh-obs-btn" data-act="tag">应用</button></div></div>';
  }
  async function loadStruct(force) {
    var p = pane("struct");
    if (p && !state.index) p.innerHTML = '<div class="dsh-obs-empty">载入目录中…</div>';
    await loadIndex(force);
    renderStruct();
  }
  async function doMkdir() {
    var p = pane("struct"); if (!p) return;
    var dir = p.querySelector(".mk").value.trim();
    if (!dir) return toast("请填写目录路径", "bad");
    try {
      var r = await post("/api/mkdir", { dir: dir });
      toast("目录已就绪：" + r.dir, "ok");
      p.querySelector(".mk").value = "";
      invalidateIndex(true);
    } catch (e) { toast("新建目录失败：" + e.message, "bad"); }
  }
  async function doMove() {
    var p = pane("struct"); if (!p) return;
    var from = p.querySelector(".mv-from").value.trim(), to = p.querySelector(".mv-to").value.trim();
    if (!from || !to) return toast("请填写源路径与目标路径", "bad");
    try {
      var r = await post("/api/move", { from: from, to: to });
      toast("已移动：" + r.from + " → " + r.to, "ok");
      if (state.edit.path === r.from) state.edit.path = r.to;
      invalidateIndex(true);
    } catch (e) {
      if (e.status === 409) {
        askConfirm("目标已存在：" + to + "，覆盖？", async function () {
          try {
            var r2 = await post("/api/move", { from: from, to: to, force: true });
            toast("已覆盖移动：" + r2.from + " → " + r2.to, "ok");
            if (state.edit.path === r2.from) state.edit.path = r2.to;
            invalidateIndex(true);
          } catch (e2) { toast("覆盖移动失败：" + e2.message, "bad"); }
        });
      } else toast("移动失败：" + e.message, "bad");
    }
  }
  /* ── 目录「移动」浮层（结构页目录树节点上的「移动」入口）──────────────────────────
     入口：每个目录节点行尾的「移动」（.tmv[data-act="dir-move"]，与整行的展开/收起同一层级）。
     浮层：挂在 panelEl 上（面板 fixed → absolute 子节点即相对面板），位置/视觉与既有
           .dsh-obs-pop / toast / 确认条同一口径，不跨页签、不跨重绘残留。
     提交：POST /api/move-dir {from,to}，to 为 vault 相对路径「目标父目录/新名字」，
           一个输入框同时覆盖「移动」与「重命名」；成功后 toast 报新路径 + invalidateIndex(true)
           （刷新结构树 + 笔记索引，与既有「移动 / 重命名」「打标签」同一条刷新路径）。
     失败：toast + 浮层内就地显示服务端 error（绝不静默）。 */
  function dirMoveEl() { return panelEl ? panelEl.querySelector(".dsh-obs-dmv") : null; }
  function closeDirMove() {
    var el = dirMoveEl();
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }
  function openDirMove(dir) {
    if (!panelEl || !dir) return;
    closeDirMove();
    var box = document.createElement("div");
    box.className = "dsh-obs-dmv";
    box.setAttribute("data-from", dir);
    box.innerHTML =
      '<div class="dmv-h">✥ 移动目录<span class="sp"></span>' +
        '<button class="dsh-obs-btn x" data-act="dir-move-cancel" title="取消">✕</button></div>' +
      '<div class="dmv-cur">当前：<b>' + esc(dir) + '</b></div>' +
      '<div class="dsh-obs-tool"><input class="dsh-obs-in dmv-to" placeholder="目标父目录/新名字" /></div>' +
      '<div class="dsh-obs-tool"><span class="dmv-tip">相对 vault 根 · 父目录不存在会自动创建</span><span class="sp"></span>' +
        '<button class="dsh-obs-btn" data-act="dir-move-cancel">取消</button>' +
        '<button class="dsh-obs-btn" data-act="dir-move-ok">确定</button></div>';
    var inp = box.querySelector(".dmv-to");
    if (inp) inp.value = dir;                 // 默认原名：改末段即重命名，改前缀即搬目录
    panelEl.appendChild(box);
    if (inp) {
      try {
        inp.focus();
        var cut = dir.lastIndexOf("/");
        inp.setSelectionRange(cut + 1, dir.length);   // 选中名字部分，直接输入即替换
      } catch (eF) {}
    }
  }
  async function doMoveDir() {
    var box = dirMoveEl();
    if (!box) return;
    var from = box.getAttribute("data-from") || "";
    var inp = box.querySelector(".dmv-to");
    var to = inp ? inp.value.trim() : "";
    if (!from || !to) return toast("请填写目标路径（形如 目标父目录/新名字）", "bad");
    var btn = box.querySelector('[data-act="dir-move-ok"]');
    if (btn) btn.disabled = true;
    try {
      var r = await post("/api/move-dir", { from: from, to: to });
      toast("目录已移动：" + r.from + " → " + r.to + "（" + (r.files || 0) + " 篇笔记）", "ok");
      closeDirMove();
      invalidateIndex(true);          // 刷新结构树 + 笔记索引
    } catch (e) {
      toast("移动目录失败：" + e.message, "bad");
      var err = box.querySelector(".dmv-err");     // 服务端 error 就地可见
      if (!err) {
        err = document.createElement("div");
        err.className = "dmv-err";
        box.appendChild(err);
      }
      err.textContent = "✕ " + e.message;
      if (btn) btn.disabled = false;
    }
  }
  async function doTag() {
    var p = pane("struct"); if (!p) return;
    var path = p.querySelector(".tg-path").value.trim();
    var raw = p.querySelector(".tg-tags").value;
    var mode = p.querySelector(".tg-mode").value;
    var tags = String(raw || "").split(/[,，\s]+/).map(function (s) { return s.replace(/^#/, "").trim(); }).filter(Boolean);
    if (!path) return toast("请填写笔记路径", "bad");
    if (!tags.length) return toast("请填写标签（逗号分隔）", "bad");
    try {
      var r = await post("/api/tag", { path: path, tags: tags, mode: mode });
      toast((mode === "remove" ? "已移除标签，现为：" : "已添加标签，现为：") + (r.tags.join(", ") || "（空）"), "ok");
      p.querySelector(".tg-tags").value = "";
      if (state.edit.path === r.path) loadNote(r.path, false);
      invalidateIndex(true);
    } catch (e) { toast("打标签失败：" + e.message, "bad"); }
  }

  /* ══ 页签 4：进化（知识自进化控制台 M3-B） ══
   * 分区自上而下：状态条 · 一键触发 · 扫描知识库 · 生成报告 · 技能库 · 任务队列 · 日志/缺口 · 收件箱
   * 后端契约（M3-B）未就绪的接口按区分级降级为「面板内可见提示」，绝不静默、不白屏。
   */
  /* 时间字段可能是毫秒数或 ISO 字符串 */
  function evoToMs(v) {
    if (!v) return 0;
    if (typeof v === "number") return v;
    var t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  /* 取第一个可用数字（stats 字段名在各接口间略有差异，做兜底） */
  function evoNum() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (typeof v === "number" && !isNaN(v)) return v;
      if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) return Number(v);
    }
    return null;
  }
  function evoFmtNum(v) { return v == null ? "—" : String(v); }
  /* 任务主题：旧后端只给文件名，从时间戳前缀里剥出主题 */
  function evoTaskTopic(t) {
    if (t && t.topic) return t.topic;
    var base = String((t && (t.name || t.path)) || "").replace(/\.md$/i, "").split("/").pop();
    return base.replace(/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-?/, "").replace(/_/g, " ") || "auto";
  }
  function evoStatusCls(s) {
    s = String(s || "");
    if (/完成|done|success|finished/i.test(s)) return "done";
    if (/执行中|进行|running|doing|active/i.test(s)) return "run";
    return "wait";
  }
  /* 兼容新旧后端：tasks 旧版是文件名数组，新版是对象数组 */
  function evoNormTasks(list) {
    return (list || []).map(function (t) {
      if (typeof t === "string") {
        return { name: t, path: ".dsh/evolution/tasks/" + t, topic: evoTaskTopic({ name: t }), status: "待执行" };
      }
      var nm = t.name || String(t.path || "").split("/").pop();
      return {
        name: nm,
        path: t.path || (".dsh/evolution/tasks/" + nm),
        topic: evoTaskTopic({ topic: t.topic, name: nm }),
        status: t.status || "待执行"
      };
    });
  }
  /* 技能来源：local = `.dsh/skills/*.md`（桥写的，可删）；vault = vault 内 `<名>/SKILL.md`（**只读**）。
     后端没给 source 时按路径兜底推断（老后端只列本地技能 → 默认 local，行为与改动前一致）。 */
  function evoSkillSource(s) {
    var src = String((s && s.source) || "").toLowerCase();
    if (src === "vault" || src === "local") return src;
    var p = String((s && s.path) || "").replace(/\\/g, "/");
    return (!p || /^\.dsh\/skills\//.test(p)) ? "local" : "vault";
  }
  function evoNormSkills(j) {
    return ((j && (j.items || j.skills || j.list)) || []).map(function (s) {
      if (typeof s === "string") return { name: s.replace(/\.md$/i, ""), description: "", tags: [], path: "", mtimeMs: 0, source: "local", enabled: true, editable: true, mirrored: false, stats: evoZeroStats() };
      var src = evoSkillSource(s);
      var st = (s && s.stats) || {};
      return {
        name: s.name || String(s.path || "").split("/").pop().replace(/\.md$/i, ""),
        description: s.description || s.desc || "",
        tags: s.tags || [],
        path: s.path || "",
        mtimeMs: s.mtimeMs || 0,
        source: src,
        /* 新增四项：**缺省值必须是"老后端也安全"的那一侧** ——
           停用默认 false（enabled 缺省 = 启用）、库内恒不可编辑、未导出默认 false、无记录 stats 全 0。 */
        enabled: !(s && s.enabled === false),
        editable: src === "vault" ? false : !(s && s.editable === false),
        mirrored: !!(s && s.mirrored === true),
        stats: {
          used: evoNum(st.used) || 0, success: evoNum(st.success) || 0, rework: evoNum(st.rework) || 0,
          fail: evoNum(st.fail) || 0, score: evoNum(st.score) || 0,
          record: String(st.record || (evoNum(st.used) ? "insufficient" : "none")),
          lastTs: evoNum(st.lastTs) || 0
        }
      };
    });
  }
  function evoZeroStats() { return { used: 0, success: 0, rework: 0, fail: 0, score: 0, record: "none", lastTs: 0 }; }
  /* 度量文案：`用过 N 次 · 成功 M · 最近 X`；无记录 → 「尚未使用」（不编造 0 次成功当成绩） */
  function evoSkillStatsText(s) {
    var st = (s && s.stats) || evoZeroStats();
    var used = evoNum(st.used) || 0;
    if (!used) return "尚未使用";
    var ts = evoNum(st.lastTs) || 0;
    return "用过 " + used + " 次 · 成功 " + (evoNum(st.success) || 0) + " · 最近 " + (ts ? relTime(ts) : "未知");
  }
  /* 技能列表默认排序键：**用量高的在前** = stats.score + used（同分再按名称）；
     无账本时全部为 0 → 退化成「按名称」，不会打乱老后端的行为。 */
  function evoSkillRank(s) {
    var st = (s && s.stats) || {};
    return (evoNum(st.score) || 0) + (evoNum(st.used) || 0);
  }
  /* 「待提炼候选」归一化：GET /api/skills/candidates 的 items（默认只含 kind=topic）。
     老后端没有该接口 / 没有 kind 字段时**不猜**：没有 kind 就按 topic 收下（与后端新默认一致），
     真正的可用性由 loadCandidates 的 try/catch 决定（失败 → 分区内可见提示）。 */
  function evoNormCandidates(j) {
    return ((j && j.items) || []).map(function (c) {
      return {
        topic: String((c && c.topic) || "").trim(),
        score: evoNum(c && c.score),
        kind: String((c && c.kind) || "topic"),
        evidence: ((c && c.evidence) || []).filter(function (e) { return String(e || "").trim() !== ""; }).map(String),
        handoff: evoNormHandoff(c && c.handoff)
      };
    }).filter(function (c) { return !!c.topic; });
  }
  /* 交接状态（服务端 handoff 字段，**只读**）：没交给 DSH / 老后端没这个字段 → null。
     null 的含义很明确 = 保持原样（只有「交给 DSH 提炼」按钮，不画步进器）——**不猜、不编状态**。
     status 只认三态，其余一律落「待执行」（与后端 handoffIndex 同一把尺）。 */
  function evoNormHandoff(h) {
    if (!h || !h.exists) return null;
    var s = String(h.status || "").trim();
    return {
      path: String(h.path || ""),
      status: /已完成/.test(s) ? "已完成" : (/执行中/.test(s) ? "执行中" : "待执行"),
      createdTs: evoNum(h.createdTs) || 0,
      mtimeMs: evoNum(h.mtimeMs) || 0
    };
  }
  /* 「已完成 / 失败」是**终态**（相位 2）：终态不再需要自动刷新（无需再盯）。
     判据逐字沿用 evoTaskPhase —— 两处必须同一把尺，否则会出现「卡片画成终态、轮询还在跑」。 */
  function evoPhaseTerminal(ph) { return ph >= 2; }
  /* handoff → 相位（与任务队列 evoTaskPhase 同口径：0/1/2），步进器与说明句共用它。
     没有 handoff（尚未交给 DSH）= 相位 0 且 evoPhaseTerminal=false → 仍算「进行中」；
     但 evoPollNeeded 里**特意把 handoff=null 排除**（还没交给 DSH 的候选不会自己变），见那里的注释。 */
  function candHandoffPhase(ho) { return ho ? evoTaskPhase({ status: ho.status }) : 0; }
  /* 技能分项计数：**以列表为准现数**（source 字段）—— 标题里的数字与下面列出的条目由同一个数组算出，
     结构上不可能再出现「计数 10 / 列表 0」。列表还没到（载入中 / 接口失败）时才退回
     /api/evolution 的 skillsLocal / skillsVault 分项。 */
  function evoSkillCounts(list) {
    if (list) {
      var l = 0, v = 0;
      list.forEach(function (s) { if (s.source === "vault") v++; else l++; });
      return { local: l, vault: v, total: l + v };
    }
    var evo = state.evo || {};
    var el = evoNum(evo.skillsLocal), ev = evoNum(evo.skillsVault);
    return { local: el == null ? 0 : el, vault: ev == null ? 0 : ev, total: (el == null ? 0 : el) + (ev == null ? 0 : ev) };
  }
  /* 多行文本 → 条目数组，每行一条，支持「名称 | 说明」 */
  function evoLines(raw, key) {
    var out = [];
    String(raw || "").split(/\r?\n/).forEach(function (ln) {
      var s = ln.trim();
      if (!s) return;
      var i = s.indexOf("|");
      var o = {};
      if (i < 0) o.name = s;
      else { o.name = s.slice(0, i).trim(); o[key] = s.slice(i + 1).trim(); }
      if (o.name) out.push(o);
    });
    return out;
  }

  /* 骨架只建一次（刷新各分区时保留用户正在输入的表单内容） */
  function buildEvo() {
    var p = pane("evo");
    if (!p) return;
    if (p.getAttribute("data-built") === "1") { evoBuilt = true; return; }
    p.setAttribute("data-built", "1");
    p.innerHTML =
      /* 1) 状态条 */
      '<div class="evo-sb">' +
        '<span class="evo-sb-net"><span class="dot"></span><b>探测中</b></span>' +
        '<span>最近扫描 <b class="sb-scan">—</b></span>' +
        '<span>笔记 <b class="sb-notes">—</b> 篇</span>' +
        '<span>技能 <b class="sb-skills">—</b> 个</span>' +
        '<span class="sp"></span>' +
        '<button class="dsh-obs-btn x" data-act="evo-refresh" title="刷新本页全部数据">↻</button>' +
      '</div>' +
      /* 2) 一键触发全网自进化 */
      '<div class="dsh-obs-sec"><div class="sh">🧬 一键触发全网自进化</div>' +
        '<div class="dsh-obs-tool"><input class="dsh-obs-in evo-topic" placeholder="学习主题（留空 = auto 自动分析薄弱点）" />' +
        '<button class="dsh-obs-btn primary" data-act="evo-run">触发</button></div>' +
        '<div class="line">触发即写入 .dsh/evolution/tasks/，由 DSH 后台执行；完成后可在下方任务队列领取。</div></div>' +
      /* 3) 扫描知识库 */
      '<div class="dsh-obs-sec"><div class="sh">🔍 扫描知识库 <span class="sp"></span>' +
        '<button class="dsh-obs-btn" data-act="evo-scan">扫描知识库</button></div>' +
        '<div class="line scan-stat">尚未扫描。扫描后列出可进化主题与知识缺口。</div>' +
        '<div class="evo-topics"></div>' +
        '<div class="evo-gaps-h"></div>' +
        '<div class="evo-scan-gaps"></div></div>' +
      /* 4) 生成报告（内联表单） */
      '<div class="dsh-obs-sec"><div class="sh">🧾 生成报告 <span class="sp"></span>' +
        '<button class="dsh-obs-btn" data-act="evo-report-toggle">生成报告</button></div>' +
        '<div class="evo-report" hidden>' +
          '<input class="dsh-obs-in rp-topic" placeholder="主题（如 关键词；留空 = auto）" />' +
          '<textarea class="evo-rpta rp-summary" placeholder="摘要（多行）"></textarea>' +
          '<textarea class="evo-rpta rp-new" placeholder="新发现条目，每行一条：名称 | 说明"></textarea>' +
          '<textarea class="evo-rpta rp-gaps" placeholder="缺口条目，每行一条：名称 | 原因"></textarea>' +
          '<div class="dsh-obs-tool" style="margin:0">' +
            '<button class="dsh-obs-btn primary" data-act="evo-report-submit">提交报告</button>' +
            '<button class="dsh-obs-btn" data-act="evo-report-cancel">取消</button>' +
            '<span class="line" style="margin:0">提交后写入日志与缺口清单</span></div>' +
        '</div></div>' +
      /* 4b) 待提炼候选（**技能区上方**：先「待提炼」→ 再「已有技能」，符合工作流）。
             数据 = GET /api/skills/candidates（默认只给 kind=topic 的真主题；容器型候选不计入）。
             本区**只有**一个动作：把某条主题交给 DSH（POST /api/skills/distill → **进化任务队列**
             `.dsh/evolution/tasks/`，与下方「任务队列」**同一个任务、同一份状态**），
             **没有任何删除 / 移动 / 编辑入口**（提炼永远由 DSH 做，面板不生成技能卡）。 */
      '<div class="dsh-obs-sec" data-sec="cands"><div class="sh">🧪 DSH Skill 待提炼候选 · 来自你库里反复出现的主题 <span class="sp"></span>' +
        '<span class="evo-cand-n line" style="margin:0"></span>' +
        '<button class="dsh-obs-btn x" data-act="evo-cands-reload" title="重新拉取候选（GET /api/skills/candidates）">↻</button>' +
        '<button class="dsh-obs-btn x" data-act="evo-cands-tgl" title="展开 / 收起本区">收起</button></div>' +
        '<div class="evo-cand-body">' +
          '<div class="line evo-cand-tip">候选来自库内标签 / 目录 / 归档 / 记账（机器标签与剪藏容器已过滤）。' +
            '点「交给 DSH 提炼」→ 写一条**进化任务**（落 .dsh/evolution/tasks/，与下方「任务队列」同一个任务、同一份状态，' +
            '可在队列里领取 / 完成），由 DSH 提炼成技能卡（本区不生成、不删除任何技能）。</div>' +
          '<div class="evo-cands"></div>' +
        '</div></div>' +
      /* 5) 技能库 */
      '<div class="dsh-obs-sec"><div class="sh">🛠 技能库 <span class="sp"></span>' +
        '<span class="evo-skill-n line" style="margin:0"></span>' +
        '<button class="dsh-obs-btn x" data-act="evo-skills-reload" title="重新拉取技能列表">↻</button>' +
        '<button class="dsh-obs-btn x" data-act="evo-skills-mirror" title="导出到知识库：把本地技能卡单向导出成「知识库/<技能镜像目录>/<名>.md」只读副本（Obsidian 与其它工具都能看到）。只写知识库，不改 .dsh/skills/ 里的源文件；内容没变的再次导出会跳过">导出到知识库</button>' +
        '<button class="dsh-obs-btn" data-act="evo-skill-new" title="新建一张本地技能卡（落 .dsh/skills/<名称>.md）">新建技能</button></div>' +
        '<div class="evo-skill-form" hidden>' +
          '<div class="line sk-mode">新建技能 → 落盘 .dsh/skills/&lt;名称&gt;.md</div>' +
          '<div class="dsh-obs-tool"><input class="dsh-obs-in sk-name" placeholder="技能名称（如 kb-search，落盘 .dsh/skills/<名称>.md）" /></div>' +
          '<div class="dsh-obs-tool"><input class="dsh-obs-in sk-desc" placeholder="一句话描述（供 DSH 选择技能用）" /></div>' +
          '<textarea class="evo-rpta sk-content" placeholder="技能正文（markdown）"></textarea>' +
          '<div class="dsh-obs-tool" style="margin:0">' +
            '<button class="dsh-obs-btn primary" data-act="evo-skill-create" title="创建：写 .dsh/skills/<名称>.md；同名已存在会先把旧正文存进 .dsh/skills/.history/（只增不删）">创建</button>' +
            '<button class="dsh-obs-btn" data-act="evo-skill-cancel" title="取消：关闭表单，不写任何文件">取消</button></div>' +
        '</div>' +
        /* 来源筛选：默认「本地」——库内常驻十几条 copilot 自带技能，全列会把本地沉淀淹掉。
           计数由 renderEvoSkills 每次按 state.skills 现数写入（与列表同源，不会自相矛盾）。 */
        '<div class="evo-sk-f" role="tablist" aria-label="技能来源筛选">' +
          '<button class="evo-sk-t" data-act="evo-skill-filter" data-filter="local" role="tab" aria-selected="false">本地 <b class="n">0</b></button>' +
          '<button class="evo-sk-t" data-act="evo-skill-filter" data-filter="vault" role="tab" aria-selected="false">库内 <b class="n">0</b></button>' +
          '<button class="evo-sk-t" data-act="evo-skill-filter" data-filter="all" role="tab" aria-selected="false">全部 <b class="n">0</b></button>' +
        '</div>' +
        '<div class="evo-skills"></div></div>' +
      /* 5b) 提示词 / 模板 / 检查清单（**第四类进化对象**，与技能库并列）
             数据 = GET /api/prompts（当前版本清单）+ GET /api/prompts/candidates（上游候选）。
             本区是这四类对象里第四类**唯一的用户可达入口**（此前只有后端 4 个路由、前端零入口）。
             写路径只有两条，都走服务端接口：
               新建 / 编辑 → POST /api/prompts/save（追加式版本化：上一版逐字节进 .history/）
               删除        → DELETE /api/prompts?name=（只删当前版本，.history/ 保留）
             另有两个**只读**接口：GET /api/prompts/history（历史版本）、GET /api/note（读正文给编辑用）。 */
      '<div class="dsh-obs-sec" data-sec="prompts"><div class="sh">📝 提示词 / 模板 / 检查清单 ' +
        '<span class="evo-qm" title="' + esc(PROMPT_TIP) + '">?</span> <span class="sp"></span>' +
        '<span class="evo-prompt-n line" style="margin:0"></span>' +
        '<button class="dsh-obs-btn x" data-act="evo-prompts-reload" title="重新拉取提示词清单（GET /api/prompts）">↻</button>' +
        '<button class="dsh-obs-btn" data-act="evo-prompt-new" title="新建一条提示词 / 模板 / 检查清单（落 .dsh/prompts/<名称>.md）">新建</button></div>' +
        '<div class="evo-prompt-form" hidden>' +
          '<div class="line pr-mode">新建 → 落盘 .dsh/prompts/&lt;名称&gt;.md</div>' +
          '<div class="dsh-obs-tool">' +
            '<input class="dsh-obs-in pr-name" placeholder="名称（落盘 .dsh/prompts/<名称>.md）" />' +
            '<select class="dsh-obs-in dsh-obs-sel pr-kind" title="类型：提示词 / 模板 / 检查清单（写进 frontmatter 的 kind）">' +
              '<option value="prompt">提示词</option>' +
              '<option value="template">模板</option>' +
              '<option value="checklist">检查清单</option>' +
            '</select></div>' +
          '<div class="dsh-obs-tool"><input class="dsh-obs-in pr-desc" placeholder="一句话描述（这套问法解决什么问题）" /></div>' +
          '<div class="dsh-obs-tool"><input class="dsh-obs-in pr-usedfor" placeholder="适用场景（如：开工检索 / 投喂入库 / 代码评审）" /></div>' +
          '<textarea class="evo-rpta pr-content" placeholder="正文（markdown）—— 服务端只负责落盘与版本化，内容由你定稿"></textarea>' +
          '<div class="dsh-obs-tool" style="margin:0">' +
            '<button class="dsh-obs-btn primary" data-act="evo-prompt-create" title="创建：写 .dsh/prompts/<名称>.md；同名已存在会先把旧正文逐字节存进 .dsh/prompts/.history/（只增不删）">创建</button>' +
            '<button class="dsh-obs-btn" data-act="evo-prompt-cancel" title="取消：关闭表单，不写任何文件">取消</button></div>' +
        '</div>' +
        /* 类型筛选：计数按 state.prompts 现数（与下面列出的条目同一个数组，结构上不可能对不上）。 */
        '<div class="evo-pr-f" role="tablist" aria-label="提示词类型筛选">' +
          '<button class="evo-sk-t" data-act="evo-prompt-filter" data-filter="all" role="tab" aria-selected="false">全部 <b class="n">0</b></button>' +
          '<button class="evo-sk-t" data-act="evo-prompt-filter" data-filter="prompt" role="tab" aria-selected="false">提示词 <b class="n">0</b></button>' +
          '<button class="evo-sk-t" data-act="evo-prompt-filter" data-filter="template" role="tab" aria-selected="false">模板 <b class="n">0</b></button>' +
          '<button class="evo-sk-t" data-act="evo-prompt-filter" data-filter="checklist" role="tab" aria-selected="false">清单 <b class="n">0</b></button>' +
        '</div>' +
        /* 候选子区（上游）：默认展开、可收起。**只有一个动作**「据此新建」——只把名称/建议类型填进表单，
           不生成正文、不写文件（与技能候选「交给 DSH 提炼」的分工差异见文件上方 PROMPT_CAND_TIP 注释）。 */
        '<div class="evo-pr-cands">' +
          '<div class="sh" style="margin:6px 0 3px">🧪 待固化候选 <span class="sp"></span>' +
            '<span class="evo-pcand-n line" style="margin:0"></span>' +
            '<button class="dsh-obs-btn x" data-act="evo-prompt-cands-reload" title="重新拉取候选（GET /api/prompts/candidates）">↻</button>' +
            '<button class="dsh-obs-btn x" data-act="evo-prompt-cands-tgl" title="展开 / 收起候选区">收起</button></div>' +
          '<div class="evo-pcand-body">' +
            '<div class="line evo-pcand-tip">' + esc(PROMPT_CAND_TIP) + '</div>' +
            '<div class="evo-pcands"></div>' +
          '</div>' +
        '</div>' +
        '<div class="evo-prompts"></div></div>' +
      /* 6) 任务队列（完成后自动归档；右上角「已完成 N」进只读归档视图）
         自解释口径：标题旁 ? 收「固定长说明」；每张卡内自带「状态步进器 + 一行下一步提示」，
         所以队列上方**不再有**没人读的常驻长文。 */
      '<div class="dsh-obs-sec" data-sec="tasks"><div class="sh">📋 任务队列 ' +
        '<span class="evo-qm" title="' + esc(TASK_QUEUE_TIP) + '">?</span> <span class="sp"></span>' +
        '<span class="evo-task-n line" style="margin:0"></span>' +
        '<button class="dsh-obs-btn x" data-act="evo-arch-open" title="查看已归档（已完成 / 失败）的任务">已完成 <b class="evo-arch-n">0</b></button></div>' +
        '<div class="evo-queue">' +
          '<div class="evo-tasks"></div>' +
        '</div>' +
        '<div class="evo-archive" hidden>' +
          '<div class="line evo-arch-stat">已完成归档（只读，最近 50 条）</div>' +
          '<div class="evo-arch-list"></div>' +
          '<div class="dsh-obs-tool" style="margin:0">' +
            '<button class="dsh-obs-btn" data-act="evo-arch-back">← 返回队列</button></div>' +
        '</div></div>' +
      /* 7) 日志 / 缺口清单 */
      '<div class="dsh-obs-sec"><div class="sh">📝 日志 <span class="sp"></span>' +
        '<span class="evo-log-n line" style="margin:0"></span></div>' +
        '<div class="evo-logs"></div></div>' +
      '<div class="dsh-obs-sec"><div class="sh">🕳 缺口清单 <span class="sp"></span>' +
        '<span class="evo-gap-n line" style="margin:0"></span></div>' +
        '<div class="evo-gaps"></div></div>' +
      /* 8) 收件箱 */
      '<div class="dsh-obs-sec" data-sec="inbox"><div class="sh">📥 收件箱 <span class="sp"></span>' +
        '<span class="evo-inbox-n line" style="margin:0"></span></div>' +
        '<div class="evo-inbox"></div></div>' +
      /* 8b) 自动导出开关（收件箱区块正下方；文案后 ? 悬停说明，右侧小开关） */
      '<div class="dsh-obs-sec" data-sec="auto-export">' +
        '<div class="evo-sw-row">' +
          '<span class="lb">自动导出</span>' +
          '<span class="evo-qm" title="' + AUTO_EXPORT_TIP + '">?</span>' +
          '<span class="sp"></span>' +
          '<span class="evo-sw" data-act="evo-autoexport" role="switch" tabindex="0" aria-checked="false" ' +
            'title="开关：' + AUTO_EXPORT_TIP + '"><i></i></span>' +
        '</div>' +
        '<div class="line auto-export-stat">读取中…</div></div>' +
      /* 内容查看器（任务正文 / 技能正文 / .dsh 文件）：**只读**，正文走笔记页同一套 markdown 渲染。
         标题区 = 名称 + 来源徽标；右上角唯一的操作是关闭（没有保存 / 编辑 / 删除）。 */
      '<div class="dsh-obs-sec evo-view" hidden><div class="sh">👁 内容 ' +
        '<span class="evo-view-t line" style="margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>' +
        '<span class="evo-view-b"></span>' +
        '<span class="sp"></span><button class="dsh-obs-btn x" data-act="evo-close-view">✕</button></div>' +
        '<div class="evo-doc obs-doc"></div></div>';
    evoBuilt = true;
  }

  /* 内容查看器（统一出口，避免三处各写一遍）。
     **只读**：正文复用笔记页同一套渲染器（renderMarkdown → sanitizeHtml），所以标题 / 加粗 / 列表 /
     引用 / 代码块 / 双链与「frontmatter → 属性区块」的口径和阅读视图完全一致，不会再把 --- 原文糊在脸上。
     opts = { path, badge, badgeKind }：path 供双链解析与附件命中；badge 是标题区的来源徽标（本地 / 库内）。
     这里只写 DOM，不挂任何保存 / 编辑 / 删除入口。 */
  function showEvoView(title, text, opts) {
    var p = pane("evo"); if (!p) return;
    var v = p.querySelector(".evo-view"), doc = p.querySelector(".evo-doc"), t = p.querySelector(".evo-view-t");
    if (!v || !doc) return;
    opts = opts || {};
    v.hidden = false;
    if (t) t.textContent = title || "";
    var bd = p.querySelector(".evo-view-b");
    if (bd) bd.innerHTML = opts.badge
      ? '<span class="evo-badge ' + (opts.badgeKind === "vault" ? "vault" : "local") + '">' + esc(opts.badge) + "</span>"
      : "";
    var html;
    try { html = renderMarkdown(text, { path: opts.path || "" }); }
    catch (e) { html = '<div class="obs-doc"><p class="obs-p">渲染失败：' + esc(e.message) + "</p></div>"; }
    doc.innerHTML = sanitizeHtml(html);   // 与阅读视图同一条清洗管线，清洗后才插入 DOM
    doc.scrollTop = 0;
  }

  /* ── 分区渲染 ── */
  function renderEvoStatus(p) {
    var evo = state.evo || {}, st = evo.state || {}, scan = state.scan || {}, ss = scan.stats || {};
    var last = evoToMs(st.lastScanAt) || evoToMs(scan.generatedAt) || evoToMs(ss.generatedAt);
    var notes = evoNum(st.notes, ss.notes, state.index && state.index.count);
    var skills = evoNum(evo.skills, state.skills && state.skills.length);
    var set = function (sel, txt) { var el = p.querySelector(sel); if (el) el.textContent = txt; };
    set(".sb-scan", last ? relTime(last) : "未扫描");
    set(".sb-notes", evoFmtNum(notes));
    set(".sb-skills", evoFmtNum(skills));
    var dot = p.querySelector(".evo-sb .dot"), net = p.querySelector(".evo-sb .evo-sb-net b");
    if (dot) dot.className = "dot" + (state.online ? "" : " bad");
    if (net) net.textContent = state.online ? "桥接在线" : "桥接离线";
  }
  function renderEvoScan(p) {
    var stat = p.querySelector(".scan-stat"), box = p.querySelector(".evo-topics");
    var gh = p.querySelector(".evo-gaps-h"), gb = p.querySelector(".evo-scan-gaps");
    if (!stat || !box) return;
    var scan = state.scan, err = state.evoErr.scan;
    if (!scan) {
      stat.className = "line scan-stat" + (err ? " bad" : "");
      stat.textContent = err
        ? "扫描接口不可用：" + err + "（契约 GET /api/evolution/scan，后端交付后自动生效）"
        : "尚未扫描。扫描后列出可进化主题与知识缺口。";
      box.innerHTML = "";
      if (gh) gh.innerHTML = "";
      if (gb) gb.innerHTML = "";
      return;
    }
    var ss = scan.stats || {}, gm = evoToMs(scan.generatedAt);
    stat.className = "line scan-stat";
    stat.textContent = "扫描于 " + (gm ? relTime(gm) : "刚刚") +
      " · 笔记 " + evoFmtNum(evoNum(ss.notes)) + " 篇 · 目录 " + evoFmtNum(evoNum(ss.dirs)) +
      " 个 · 标签 " + evoFmtNum(evoNum(ss.tags)) + " 个";
    var topics = scan.topics || [];
    box.innerHTML = topics.length
      ? '<div class="sh">可进化主题 ' + topics.length + ' 个 <span class="sp"></span>' +
          '<span class="line" style="margin:0">点主题即填入上方输入框</span></div>' +
        topics.slice(0, 40).map(function (t) {
          var kind = t.kind === "tag" ? "tag" : "dir";
          return '<div class="efile" data-act="evo-topic-fill" data-topic="' + esc(t.name) + '" title="点击填入主题：' + esc(t.name) + '">' +
            '<span class="evo-badge ' + kind + '">' + (kind === "tag" ? "标签" : "目录") + '</span>' +
            '<span>' + esc(t.name) + '</span><b>' + evoFmtNum(evoNum(t.noteCount)) + ' 篇</b></div>';
        }).join("")
      : '<div class="dsh-obs-empty">未发现可进化主题（知识库为空或结构过浅）</div>';
    var gaps = scan.gaps || [];
    if (gh) gh.innerHTML = gaps.length
      ? '<div class="efile" data-act="evo-scan-gaps-tgl" title="展开 / 收起缺口清单">' +
          '<span>' + (state.scanGapsOpen ? "▾" : "▸") + ' 知识缺口 ' + gaps.length + ' 条</span>' +
          '<b>' + (state.scanGapsOpen ? "收起" : "展开") + '</b></div>'
      : '<div class="dsh-obs-empty">本次扫描未发现缺口</div>';
    if (gb) gb.innerHTML = (gaps.length && state.scanGapsOpen)
      ? gaps.slice(0, 60).map(function (g) {
          var path = g.path || "";
          return '<div class="dsh-obs-item" data-act="evo-gap-open" data-path="' + esc(path) + '" title="点击跳到「编辑」页载入该笔记">' +
            '<div class="it">' + esc(g.title || path || "(未命名)") + '</div>' +
            '<div class="ip">' + esc(path) + '</div>' +
            '<div class="im"><span class="evo-badge wait">' + esc(g.kind || "缺口") + '</span></div>' +
            (g.snippet ? '<div class="ex">' + esc(g.snippet) + '</div>' : "") +
            '</div>';
        }).join("")
      : "";
  }
  /* 技能来源标签：本地（可删）/ 库内（只读，绝不提供删除入口） */
  function evoSkillBadge(s) {
    return s.source === "vault"
      ? '<span class="evo-badge vault" title="vault 内 <名>/SKILL.md（你自己的文件）· 只读，不提供删除">库内</span>'
      : '<span class="evo-badge local" title="桥写入的 .dsh/skills/<名>.md · 可删除">本地</span>';
  }
  /* ── 技能区来源筛选（local 默认 / vault / all） ──
     口径：local = 桥写的 .dsh/skills/*.md（我们自己沉淀的，可删）；
           vault = vault 内 <名>/SKILL.md（多为 copilot 插件自带，**只读**）。
     默认 local 的原因：库内常驻十几条，全列会把本地那 1~2 条淹掉（用户原话「筛选，这样太长了」）。 */
  function evoNormFilter(f) { return (f === "vault" || f === "all") ? f : "local"; }
  function evoSkillInFilter(s, f) {
    if (f === "all") return true;
    return (s.source === "vault") === (f === "vault");
  }
  function setSkillFilter(f) {
    f = evoNormFilter(f);
    state.skillFilter = f;
    /* 持久化：面板重开 / 插件热重载后仍停在同一个筛选（写失败也不影响本次会话） */
    try { localStorage.setItem(LS.skillFilter, f); } catch (e) {}
    renderEvoSkills(pane("evo"));
  }
  /* 空态：三种筛选各有各的话说 —— 本地为空是最要紧的一种（说明还没沉淀出技能） */
  function evoSkillEmpty(f, vaultN) {
    if (f === "local") return '<div class="dsh-obs-empty">本地暂无技能 —— DSH 会从候选发现里提炼（技能卡落 .dsh/skills/）' +
      (vaultN ? '<br>库内已有 ' + vaultN + ' 条，点上方「库内」查看（只读）。' : '') + '</div>';
    if (f === "vault") return '<div class="dsh-obs-empty">库内暂无技能 —— vault 内 &lt;名&gt;/SKILL.md 会自动列在这里（只读，无删除入口）。</div>';
    return '<div class="dsh-obs-empty">还没有技能。可从知识库提炼后在此新建；vault 里 &lt;名&gt;/SKILL.md 也会列在这里（只读）。</div>';
  }
  /* ── DSH Skill 待提炼候选（技能区上方）──
     渲染：标题带计数「DSH Skill 待提炼候选 · N 个」+ 每条 = 主题 / score / 证据小字 +
       「交给 DSH 提炼」按钮；**已交给 DSH 的**条目在**同一张卡内**改画它自己的提炼流程
       （步进器 + 一行说明 + 一句「同一任务也在任务队列里」的锚点，复用任务队列的 .evo-steps / .evo-task-next 视觉）。
       相位与文案只来自服务端 handoff（loadCandidates → evoNormHandoff）—— 而服务端读的就是
       `.dsh/evolution/tasks/`（+ 归档），所以候选卡与下方「任务队列」那张卡**状态逐态一致**（同源，前端不编）。
     红线：**本区不出现任何删除/编辑按钮**（也刻意不做整条可点，避免误开查看器）。
     空态 / 载入态 / 失败态三者都可见（失败不静默：接口 404 = 老后端，也要说清）。 */
  function renderEvoCandidates(p) {
    if (!p) return;
    var box = p.querySelector(".evo-cands"), n = p.querySelector(".evo-cand-n");
    var body = p.querySelector(".evo-cand-body"), tg = p.querySelector('[data-act="evo-cands-tgl"]');
    if (!box) return;
    var open = state.evoCandOpen !== false;              // 默认展开
    if (body) body.hidden = !open;
    if (tg) tg.textContent = open ? "收起" : "展开";
    var list = state.candidates, err = state.evoErr.candidates;
    /* 计数行：有数据就报数；**有旧数据但这次读取失败**时额外挂 .bad + 「读取失败」——
       旧内容留在屏上（非破坏式），但"这次没读到"对用户必须是**可见**的（不静默）。
       注：轮询失败走静默路径（evoPollFetch 不写 evoErr），所以这行不会因为后台轮询抖动而变红。 */
    if (n) {
      n.textContent = list
        ? ("· " + list.length + " 个" + (state.candContainers ? "（已滤掉 " + state.candContainers + " 个容器型）" : "") +
           (err ? " · 读取失败（显示上次结果）" : ""))
        : (err ? "不可用" : "—");
      n.className = "evo-cand-n line" + (err ? " bad" : "");
      if (err) n.setAttribute("title", "候选接口读取失败：" + err); else n.removeAttribute("title");
    }
    if (!list) {
      box.innerHTML = err
        ? '<div class="dsh-obs-empty bad">候选接口不可用：' + esc(err) +
          '<br>（契约：GET /api/skills/candidates；老服务端没有该接口时会显示在这里）</div>'
        : '<div class="dsh-obs-empty">载入中…</div>';
      return;
    }
    if (!list.length) {
      box.innerHTML = '<div class="dsh-obs-empty">暂无待提炼候选 —— 库内主题都已沉淀为技能 ✓</div>';
      return;
    }
    box.innerHTML = list.map(function (c) {
      var ev = (c.evidence || []);
      var shownEv = ev.slice(0, 4).join("；");
      if (ev.length > 4) shownEv += "；…等 " + ev.length + " 条";
      /* 证据：小字逐条列出（长文本由 CSS 折行；完整内容在 title 里可悬停查看） */
      var evHtml = ev.length
        ? '<div class="evo-cand-ev" title="' + esc(ev.join("\n")) + '">证据：' + esc(shownEv) + '</div>'
        : '<div class="evo-cand-ev">（无证据：建议先自行取证再提炼）</div>';
      /* 交接状态：ho = null（还没交给 DSH / 老后端）→ 原样，只有一个按钮；
         ho 存在 → 同一张卡内画它自己的流程（步进器 + 随状态变化的一句 + 「这也是队列里那条」锚点），
         按钮换成只读绿标（**仍然零删除/零编辑按钮**，重复点也无从点起）。
         ⚠️ 状态**就是**下方任务队列里那条任务的状态（服务端两者读同一批文件），前端只画不编。 */
      var ho = c.handoff, hp = candHandoffPhase(ho);
      var flowHtml = ho
        ? evoTaskStepper(hp) + '<div class="evo-task-next">' + esc(CAND_HANDOFF_NEXT[hp]) + '</div>' +
          '<div class="evo-cand-same">↔ 同一任务也在下方「任务队列」里（可在那儿领取 / 完成，两处状态同步）</div>'
        : "";
      var actHtml = ho
        ? '<span class="evo-cand-sent" title="提炼任务（进化任务队列）：' + esc(ho.path || ".dsh/evolution/tasks/") + '">✓ 已交给 DSH</span>'
        : '<button class="dsh-obs-btn" data-act="evo-cand-distill" data-topic="' + esc(c.topic) + '" ' +
            'title="推到进化任务队列（下方「任务队列」），DSH 下次开工时提炼成技能卡" style="padding:2px 7px">交给 DSH 提炼</button>';
      return '<div class="dsh-obs-item evo-cand" data-topic="' + esc(c.topic) + '"' +
          (ho ? ' data-handoff="' + hp + '"' : "") + '>' +
        '<div class="it">' + esc(c.topic) + '</div>' +
        '<div class="im"><span class="evo-cand-score">score ' + esc(c.score == null ? "—" : String(c.score)) + '</span>' +
          (c.kind === "container" ? '<span class="evo-badge dir">容器</span>' : "") +
          '<span class="sp" style="flex:1"></span>' + actHtml +
        '</div>' + flowHtml + evHtml +
        '</div>';
    }).join("");
  }
  /* 载入候选（**非破坏式刷新**：先拉、拿到才替换；失败保留旧列表，绝不闪现空态/载入态）。
     自动轮询与 ↻ 都走这里：宁可短暂显示旧数据，也不让正在看的卡片消失一下再回来。 */
  async function loadCandidates() {
    var p = pane("evo"); if (!p) return;
    try {
      var j = await get("/api/skills/candidates?limit=20");
      state.candidates = evoNormCandidates(j);
      state.candContainers = evoNum(j && j.containerCount) || 0;
      state.evoErr.candidates = "";
    } catch (e) {
      /* 失败：**保留旧列表**（有旧数据就继续显示它），错误在标题计数与 .evo-cands 内可见，不静默也不清空 */
      state.evoErr.candidates = e.message;
    }
    renderEvoCandidates(p);
  }
  function toggleEvoCands() {
    state.evoCandOpen = state.evoCandOpen === false;
    renderEvoCandidates(pane("evo"));
  }
  /* 交给 DSH 提炼：POST /api/skills/distill {topic, score, evidence} → 成功轻提示（指向**任务队列**），
     失败给**可见错误**（toast 是面板内提示条，不静默）。本函数**只发这一个请求**，不写技能卡。
     落点 = `.dsh/evolution/tasks/`（进化任务队列）—— 所以成功后要刷**两处**：这张候选卡（handoff 步进器）
     与下方「任务队列」（同一条任务），否则又会出现「候选卡有、队列里没有」的错位（用户实测的缺陷）。
     重拉**非破坏式**（失败不动 state.candidates，绿标还在，下次刷新补齐真实流程）。 */
  async function distillCandidate(topic, btn) {
    var t = String(topic || "").trim();
    if (!t) return toast("该候选没有主题，无法提交", "bad");
    var c = (state.candidates || []).filter(function (x) { return x.topic === t; })[0] || { topic: t, evidence: [] };
    if (btn) { btn.disabled = true; btn.textContent = "提交中…"; }
    try {
      var r = await post("/api/skills/distill", {
        topic: c.topic,
        score: typeof c.score === "number" ? c.score : undefined,   // 拿不到分数就不带该字段（别写一个假的 0）
        evidence: c.evidence || []
      });
      toast("已交给 DSH · 见下方「任务队列」（DSH 会去认领）：" + (r.path || ".dsh/evolution/tasks/"), "ok");
      /* 状态化反馈：按钮**就地**变成绿标（写清「下一步由谁做」），顺带杜绝重复点 */
      if (btn && btn.isConnected && btn.parentNode) {
        var sent = document.createElement("span");
        sent.className = "evo-cand-sent";
        sent.textContent = "✓ 已交给 DSH · 见任务队列";
        sent.title = "已推到 " + (r.path || ".dsh/evolution/tasks/") + "（进化任务队列），与下方「任务队列」同一条";
        btn.parentNode.replaceChild(sent, btn);
      }
      /* 立刻用**服务端真实数据**把这张卡切成流程视图（绿标随即被步进器取代，衔接自然）。
         ⚠️ 不在这里往 state 里塞任何假状态：拿到什么画什么。 */
      try {
        var j2 = await get("/api/skills/candidates?limit=20");
        state.candidates = evoNormCandidates(j2);
        state.candContainers = evoNum(j2 && j2.containerCount) || 0;
        state.evoErr.candidates = "";
        renderEvoCandidates(pane("evo"));
      } catch (e3) {}
      /* 同一条任务也在「任务队列」里 → 顺手把队列一起刷新（缺了这句就是用户实测的「两处不同步」） */
      try {
        state.evo = await get("/api/evolution");
        state.evoErr.main = "";
        renderEvo(pane("evo"));
      } catch (e2) {}
    } catch (e) {
      toast("交给 DSH 提炼失败：" + e.message, "bad");
    } finally {
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "交给 DSH 提炼"; }
    }
  }
  function renderEvoSkills(p) {
    if (!p) return;
    var box = p.querySelector(".evo-skills"), n = p.querySelector(".evo-skill-n");
    if (!box) return;
    var err = state.evoErr.skills, list = state.skills;
    var c = evoSkillCounts(list), f = evoNormFilter(state.skillFilter);
    /* 标题分项：与列表同源（local 在前、vault 在后），不再出现「计数 10 / 列表 0」的自相矛盾 */
    if (n) n.textContent = list ? ("技能 · 本地 " + c.local + " / 库内 " + c.vault) : (err ? "不可用" : "—");
    /* 筛选条：计数 + 选中态。**放在 list 空值分支之前** —— 载入中 / 接口失败时筛选条也要摆对，
       否则用户会以为筛选坏了。计数与列表同一个数组算出，结构上不可能对不上。 */
    var fbtns = p.querySelectorAll(".evo-sk-f .evo-sk-t");
    for (var i = 0; i < fbtns.length; i++) {
      var key = fbtns[i].getAttribute("data-filter");
      fbtns[i].className = "evo-sk-t" + (key === f ? " on" : "");
      fbtns[i].setAttribute("aria-selected", key === f ? "true" : "false");
      var nb = fbtns[i].querySelector(".n");
      if (nb) nb.textContent = String(key === "local" ? c.local : key === "vault" ? c.vault : c.total);
    }
    if (!list) {
      box.innerHTML = err
        ? '<div class="dsh-obs-empty bad">技能库接口不可用：' + esc(err) +
          '<br>（契约：GET /api/skills；后端交付后此处自动生效）</div>'
        : '<div class="dsh-obs-empty">载入中…</div>';
      return;
    }
    /* 排序：**用量高的在前** = stats.score + used，同分按名称（`localeCompare("zh")` 稳定 →
       无账本时退化成「按名称」，老后端列表不会乱）。来源筛选在排序**之后**过滤，三档语义不变。 */
    var items = list.slice().sort(function (a, b) {
      var d = evoSkillRank(b) - evoSkillRank(a);
      if (d) return d;
      return String(a.name).localeCompare(String(b.name), "zh");
    }).filter(function (s) { return evoSkillInFilter(s, f); });
    box.innerHTML = items.length ? items.map(function (s) {
      var tags = (s.tags || []).slice(0, 4).map(function (t) { return '<span class="tg">#' + esc(t) + '</span>'; }).join("");
      var vault = s.source === "vault";
      var off = s.enabled === false;
      var nm = esc(s.name), pth = esc(s.path || "");
      var acts = [];
      /* 每条都有的两个只读/排队动作：查看（只读）+ 用这张卡（只写收件箱，不改技能卡）。
         刻意**不给按钮挂 data-source**（那是"卡片级"来源标记，按钮挂上会让 [data-source] 选择器
         把按钮也当成一张卡）；openSkill 会按 path 自行判断本地 / 库内。 */
      acts.push('<button class="dsh-obs-btn x" data-act="evo-skill-view" data-name="' + nm + '" data-path="' + pth +
        '" title="只读查看技能正文：只发 GET，不改任何文件" style="padding:2px 7px">查看</button>');
      acts.push('<button class="dsh-obs-btn x" data-act="evo-skill-use" data-name="' + nm +
        '" title="用这张卡：在收件箱（.dsh/inbox/）写一条任务「用技能卡执行」，DSH 下次开工会按这张卡执行并说明是否命中其已知边界。不改技能卡本身" style="padding:2px 7px">用这张卡</button>');
      if (!vault) {
        /* 本地专属三件：编辑（走 /api/skills/save，追加式版本化）/ 停用·启用（只改 frontmatter）/ 删除 */
        acts.push('<button class="dsh-obs-btn x" data-act="evo-skill-edit" data-name="' + nm + '" data-path="' + pth +
          '" title="编辑：在面板内改正文并保存（走 POST /api/skills/save）。保存前会把旧正文原样存进 .dsh/skills/.history/（只增不删，可回溯）" style="padding:2px 7px">编辑</button>');
        acts.push('<button class="dsh-obs-btn x" data-act="evo-skill-toggle" data-name="' + nm + '" data-enabled="' + (off ? "true" : "false") +
          '" title="' + (off
            ? "启用：写回 enabled: true（只改 frontmatter 这一行，正文不动）→ 开工检索会重新带上这张卡"
            : "停用：写 enabled: false（只改 frontmatter 这一行，正文逐字节不动）→ 开工检索会跳过这张卡，面板里它显示为灰色") +
          '" style="padding:2px 7px">' + (off ? "启用" : "停用") + '</button>');
        acts.push('<button class="dsh-obs-btn x danger" data-act="evo-skill-del" data-name="' + nm + '" data-source="local" title="删除：把这张本地技能卡移出 .dsh/skills/（库内技能没有这个按钮）" style="padding:2px 7px">删除</button>');
      }
      var badges = evoSkillBadge(s) + tags;
      badges += s.mirrored
        ? '<span class="evo-badge mirror" title="已导出：知识库 /' + esc(skillMirrorFolder()) + '/' + nm + '.md 存在（单向只读副本；改技能请回本面板「编辑」）">已导出</span>'
        : '<span class="evo-badge nomirror" title="未导出：知识库 /' + esc(skillMirrorFolder()) + '/' + nm + '.md 还不存在 —— 点本区右上「导出到知识库」生成只读副本' + (vault ? "（库内技能不参与导出）" : "") + '">未导出</span>';
      if (off) badges += '<span class="evo-badge off" title="已停用：frontmatter enabled: false —— 开工检索（/api/recall）会跳过它；点「启用」恢复">已停用（开工检索会跳过）</span>';
      return '<div class="dsh-obs-item' + (off ? " off" : "") + '" data-act="evo-skill-open" data-name="' + nm + '"' +
        ' data-path="' + pth + '" data-source="' + (vault ? "vault" : "local") + '"' +
        ' title="' + (vault ? "库内技能（只读）：点卡片主体查看 SKILL.md 正文" : "本地技能：点卡片主体查看内容；用右侧按钮编辑 / 停用 / 用这张卡") + '">' +
        '<div class="it">' + esc(s.name) + '</div>' +
        (vault && s.path ? '<div class="ip">' + esc(s.path) + '</div>' : "") +
        (s.description ? '<div class="ex">' + esc(s.description) + '</div>' : "") +
        '<div class="evo-sk-m" title="来自 /api/score 记账（按技能名聚合）：用过 / 成功 / 最近一次">' + esc(evoSkillStatsText(s)) + '</div>' +
        '<div class="im">' + badges + '<span class="sp" style="flex:1"></span>' +
        '<span class="evo-sk-acts">' + acts.join("") + '</span>' +
        (vault ? '<span class="evo-ro" title="库内技能是知识库里的文件（&lt;名&gt;/SKILL.md）· 只读：只有「查看」与「用这张卡」，没有编辑/停用/删除">只读</span>' : "") +
        '</div></div>';
    }).join("") : evoSkillEmpty(f, c.vault);
  }
  /* ── 5b) 提示词 / 模板 / 检查清单（第四类进化对象）──
     归一化：老后端没有 /api/prompts 时 → state.prompts 保持 null（→ 载入中 / 失败态），不假装空列表。
     kind 不在三态内的一律按 prompt 收下：服务端已把 kind 非法的文件算坏文件（skipped）挡在外面，
     这里兜的是「将来多一种 kind」的情形 —— 宁可显示成「提示词」，也不让用户写的文件凭空消失。 */
  function evoPromptKind(k) {
    var s = String(k || "").toLowerCase();
    return PROMPT_KINDS.indexOf(s) >= 0 ? s : "prompt";
  }
  function evoPromptKindLabel(k) { return PROMPT_KIND_LABEL[evoPromptKind(k)]; }
  function evoNormPrompts(j) {
    return ((j && (j.items || j.prompts || j.list)) || []).map(function (x) {
      if (typeof x === "string") {
        return { name: x.replace(/\.md$/i, ""), kind: "prompt", description: "", used_for: "", path: "", mtimeMs: 0, size: 0 };
      }
      return {
        name: String((x && x.name) || "").trim() ||
          String((x && x.path) || "").split("/").pop().replace(/\.md$/i, ""),
        kind: evoPromptKind(x && x.kind),
        description: String((x && (x.description || x.desc)) || ""),
        used_for: String((x && (x.used_for || x.usedFor)) || ""),
        path: String((x && x.path) || ""),
        mtimeMs: evoNum(x && x.mtimeMs) || 0,
        size: evoNum(x && x.size) || 0
      };
    }).filter(function (x) { return !!x.name; });
  }
  function evoNormPromptCands(j) {
    return ((j && j.items) || []).map(function (c) {
      return {
        topic: String((c && c.topic) || "").trim(),
        score: evoNum(c && c.score),
        suggest: evoPromptKind(c && c.suggest),
        evidence: ((c && c.evidence) || []).filter(function (e) { return String(e || "").trim() !== ""; }).map(String)
      };
    }).filter(function (c) { return !!c.topic; });
  }
  /* 类型计数：与列表**同源现数** —— 结构上不可能出现「计数 3 / 列表 0」 */
  function evoPromptCounts(list) {
    var by = { all: 0, prompt: 0, template: 0, checklist: 0 };
    (list || []).forEach(function (x) { by.all++; by[evoPromptKind(x.kind)]++; });
    return by;
  }
  /* 渲染提示词清单。载入 / 空 / 失败三态都可见（失败不静默，且保留旧列表不闪空）。 */
  function renderEvoPrompts(p) {
    if (!p) return;
    var box = p.querySelector(".evo-prompts"), n = p.querySelector(".evo-prompt-n");
    if (!box) return;
    var err = state.evoErr.prompts, list = state.prompts, f = state.promptFilter || "all";
    var c = evoPromptCounts(list);
    if (n) {
      n.textContent = list
        ? ("· " + c.all + " 条" + (err ? " · 读取失败（显示上次结果）" : ""))
        : (err ? "不可用" : "—");
      n.className = "evo-prompt-n line" + (err ? " bad" : "");
      if (err) n.setAttribute("title", "提示词接口读取失败：" + err); else n.removeAttribute("title");
    }
    var fbtns = p.querySelectorAll(".evo-pr-f .evo-sk-t");
    for (var i = 0; i < fbtns.length; i++) {
      var key = fbtns[i].getAttribute("data-filter") || "all";
      fbtns[i].className = "evo-sk-t" + (key === f ? " on" : "");
      fbtns[i].setAttribute("aria-selected", key === f ? "true" : "false");
      var nb = fbtns[i].querySelector(".n");
      if (nb) nb.textContent = String(c[key] == null ? 0 : c[key]);
    }
    if (!list) {
      box.innerHTML = err
        ? '<div class="dsh-obs-empty bad">提示词接口不可用：' + esc(err) +
          '<br>（契约：GET /api/prompts；老服务端没有该接口时会显示在这里）</div>'
        : '<div class="dsh-obs-empty">载入中…</div>';
      return;
    }
    var items = list.filter(function (x) { return f === "all" || evoPromptKind(x.kind) === f; });
    box.innerHTML = items.length ? items.map(function (x) {
      var nm = esc(x.name), pth = esc(x.path || ""), k = evoPromptKind(x.kind);
      /* 四个动作的口径都写在 title 里：点下去发生什么、能不能撤回（与技能卡同一自解释口径） */
      var acts =
        '<button class="dsh-obs-btn x" data-act="evo-prompt-view" data-name="' + nm + '" data-path="' + pth + '" data-kind="' + esc(k) +
          '" title="只读查看正文：只发 GET，不改任何文件" style="padding:2px 7px">查看</button>' +
        '<button class="dsh-obs-btn x" data-act="evo-prompt-edit" data-name="' + nm + '" data-path="' + pth +
          '" title="编辑：在面板内改正文与描述并保存（走 POST /api/prompts/save）。保存前把旧正文逐字节存进 .dsh/prompts/.history/（只增不删）" style="padding:2px 7px">编辑</button>' +
        '<button class="dsh-obs-btn x" data-act="evo-prompt-history" data-name="' + nm +
          '" title="历史版本：列出 .dsh/prompts/.history/<名称>/ 里的每一版（只读）" style="padding:2px 7px">历史</button>' +
        '<button class="dsh-obs-btn x danger" data-act="evo-prompt-del" data-name="' + nm +
          '" title="删除：移除当前版本 .dsh/prompts/<名称>.md。历史版本**保留**（历史只增不删）——删掉再建同名时版本号会从旧历史接着涨" style="padding:2px 7px">删除</button>';
      var badges = '<span class="evo-badge ' + esc(PROMPT_KIND_BADGE[k]) + '" title="frontmatter kind: ' + esc(k) + '">' +
        esc(evoPromptKindLabel(k)) + '</span>';
      if (x.used_for) badges += '<span class="evo-badge" title="适用场景（frontmatter used_for）">' + esc(x.used_for) + '</span>';
      var meta = (x.mtimeMs ? "更新 " + relTime(evoToMs(x.mtimeMs)) : "更新时间未知") +
        (x.size ? " · " + x.size + " 字节" : "") + (x.path ? " · " + x.path : "");
      return '<div class="dsh-obs-item" data-act="evo-prompt-open" data-name="' + nm + '" data-path="' + pth +
        '" data-kind="' + esc(k) + '" title="点卡片主体只读查看正文；右侧按钮编辑 / 历史 / 删除">' +
        '<div class="it">' + esc(x.name) + '</div>' +
        (x.description ? '<div class="ex">' + esc(x.description) + '</div>' : '') +
        '<div class="evo-sk-m" title="' + esc(meta) + '">' + esc(meta) + '</div>' +
        '<div class="im">' + badges + '<span class="sp" style="flex:1"></span>' +
        '<span class="evo-sk-acts">' + acts + '</span></div></div>';
    }).join("") : '<div class="dsh-obs-empty">' +
      (c.all
        ? "当前筛选（" + esc(f === "all" ? "全部" : PROMPT_KIND_LABEL[f]) + "）下没有条目 —— 点上方其它类型页签看看。"
        : "还没有提示词 / 模板 / 检查清单 —— 点右上「新建」写第一条，或从下方候选「据此新建」。") +
      '</div>';
  }
  /* 渲染候选子区（上游）。与技能候选同一条红线：**不生成一句正文**、不写任何文件。 */
  function renderEvoPromptCands(p) {
    if (!p) return;
    var box = p.querySelector(".evo-pcands"), n = p.querySelector(".evo-pcand-n");
    var body = p.querySelector(".evo-pcand-body"), tg = p.querySelector('[data-act="evo-prompt-cands-tgl"]');
    if (!box) return;
    var open = state.promptCandsOpen !== false;              // 默认展开
    if (body) body.hidden = !open;
    if (tg) tg.textContent = open ? "收起" : "展开";
    var list = state.promptCands, err = state.evoErr.promptCands;
    if (n) {
      n.textContent = list
        ? ("· 显示 " + list.length + (state.promptCandTotal > list.length ? " / 共 " + state.promptCandTotal : "") + " 个" +
           (err ? " · 读取失败（显示上次结果）" : ""))
        : (err ? "不可用" : "—");
      n.className = "evo-pcand-n line" + (err ? " bad" : "");
      if (err) n.setAttribute("title", "候选接口读取失败：" + err); else n.removeAttribute("title");
    }
    if (!list) {
      box.innerHTML = err
        ? '<div class="dsh-obs-empty bad">候选接口不可用：' + esc(err) +
          '<br>（契约：GET /api/prompts/candidates；老服务端没有该接口时会显示在这里）</div>'
        : '<div class="dsh-obs-empty">载入中…</div>';
      return;
    }
    if (!list.length) {
      box.innerHTML = '<div class="dsh-obs-empty">暂无待固化候选 —— 库内还没有反复出现的模式 ✓</div>';
      return;
    }
    box.innerHTML = list.map(function (c) {
      var ev = c.evidence || [];
      var shownEv = ev.slice(0, 4).join("；");
      if (ev.length > 4) shownEv += "；…等 " + ev.length + " 条";
      var evHtml = ev.length
        ? '<div class="evo-cand-ev" title="' + esc(ev.join("\n")) + '">证据：' + esc(shownEv) + '</div>'
        : '<div class="evo-cand-ev">（无证据：建议先自行取证再固化）</div>';
      return '<div class="dsh-obs-item evo-cand">' +
        '<div class="it">' + esc(c.topic) + '</div>' +
        '<div class="im"><span class="evo-cand-score">score ' + esc(c.score == null ? "—" : String(c.score)) + '</span>' +
          '<span class="evo-badge dir" title="服务端按库内信号机械给出的建议类型（只是建议，表单里可改）">建议 ' +
            esc(evoPromptKindLabel(c.suggest)) + '</span>' +
          '<span class="sp" style="flex:1"></span>' +
          '<button class="dsh-obs-btn" data-act="evo-prompt-cand-new" data-topic="' + esc(c.topic) +
            '" data-suggest="' + esc(evoPromptKind(c.suggest)) + '"' +
            ' title="据此新建：把名称与建议类型填进上方表单（**不生成正文、不写任何文件**）；正文由你定稿后点「创建」才落盘" style="padding:2px 7px">据此新建</button>' +
        '</div>' + evHtml + '</div>';
    }).join("");
  }
  /* 载入提示词清单 / 候选（**非破坏式**：拿到新的才替换，失败保留旧列表，绝不闪现空态） */
  async function loadPrompts() {
    var p = pane("evo"); if (!p) return;
    try {
      state.prompts = evoNormPrompts(await get("/api/prompts"));
      state.evoErr.prompts = "";
    } catch (e) {
      state.evoErr.prompts = e.message;
    }
    renderEvoPrompts(p);
  }
  async function loadPromptCands() {
    var p = pane("evo"); if (!p) return;
    try {
      var j = await get("/api/prompts/candidates?limit=20");
      state.promptCands = evoNormPromptCands(j);
      state.promptCandTotal = evoNum(j && j.total) || state.promptCands.length;
      state.evoErr.promptCands = "";
    } catch (e) {
      state.evoErr.promptCands = e.message;
    }
    renderEvoPromptCands(p);
  }
  function setPromptFilter(f) {
    state.promptFilter = (f === "prompt" || f === "template" || f === "checklist") ? f : "all";
    renderEvoPrompts(pane("evo"));
  }
  function togglePromptCands() {
    state.promptCandsOpen = state.promptCandsOpen === false;
    renderEvoPromptCands(pane("evo"));
  }
  /* 表单两态：create（新建）/ edit（编辑既有条目）。
     edit 时**名称只读** —— 改名 = 新建 + 删旧，绝不做静默重命名（与技能区同一口径）。 */
  function setPromptFormMode(mode, name, kind) {
    var p = pane("evo"); if (!p) return;
    var f = p.querySelector(".evo-prompt-form"); if (!f) return;
    var edit = mode === "edit";
    f.setAttribute("data-mode", edit ? "edit" : "create");
    f.setAttribute("data-orig-name", edit ? String(name || "") : "");
    var tip = f.querySelector(".pr-mode");
    if (tip) tip.textContent = edit
      ? "编辑「" + String(name || "") + "」→ 保存写回 .dsh/prompts/" + String(name || "") + ".md（旧正文逐字节存进 .history/）"
      : "新建 → 落盘 .dsh/prompts/<名称>.md";
    var ni = f.querySelector(".pr-name");
    if (ni) {
      if (edit) ni.value = String(name || "");
      ni.readOnly = edit;
      ni.title = edit ? "名称不可改（要改名请新建一条，再删掉旧的）" : "名称：决定落盘文件名 .dsh/prompts/<名称>.md";
    }
    var ks = f.querySelector(".pr-kind");
    if (ks && kind && PROMPT_KINDS.indexOf(String(kind)) >= 0) ks.value = String(kind);
    var btn = f.querySelector('[data-act="evo-prompt-create"], [data-act="evo-prompt-save"]');
    if (btn) {
      btn.setAttribute("data-act", edit ? "evo-prompt-save" : "evo-prompt-create");
      btn.textContent = edit ? "保存修改" : "创建";
      btn.title = edit
        ? "保存修改：写回 .dsh/prompts/" + String(name || "") + ".md；旧正文先逐字节存进 .history/（只增不删）"
        : "创建：写 .dsh/prompts/<名称>.md；同名已存在会先把旧正文存进 .history/（只增不删）";
    }
  }
  /* show 省略 = 开关语义；prefill = 从候选带进来的 {name,kind,description}（只填字段，不写文件） */
  function togglePromptForm(show, prefill) {
    var p = pane("evo"); if (!p) return;
    var f = p.querySelector(".evo-prompt-form"); if (!f) return;
    var want = typeof show === "boolean" ? show : !!f.hidden;
    f.hidden = !want;
    if (want) {
      if (prefill) {
        setPromptFormMode("create", "", prefill.kind);
        var pi = f.querySelector(".pr-name"); if (pi) pi.value = String(prefill.name || "");
        var pd = f.querySelector(".pr-desc"); if (pd && prefill.description) pd.value = String(prefill.description);
      } else if (f.getAttribute("data-mode") !== "edit") {
        setPromptFormMode("create");
      }
      var fo = f.querySelector(".pr-name"); if (fo) { try { fo.focus(); } catch (e) {} }
    } else {
      setPromptFormMode("create");     // 关闭 = 回到新建模式，避免下次「新建」带着上一条的名字
      ["pr-name", "pr-desc", "pr-usedfor", "pr-content"].forEach(function (cls) {
        var el = f.querySelector("." + cls); if (el) el.value = "";
      });
    }
  }
  /* 读表单（edit 态以 data-orig-name 为准：名称只读，但表单值可能被浏览器自动补全改掉） */
  function promptFormValues() {
    var p = pane("evo"); if (!p) return null;
    var f = p.querySelector(".evo-prompt-form"); if (!f) return null;
    var q = function (cls) { var el = f.querySelector("." + cls); return el ? (el.value || "") : ""; };
    var edit = f.getAttribute("data-mode") === "edit";
    var ks = f.querySelector(".pr-kind");
    return {
      form: f, edit: edit,
      name: String(edit ? (f.getAttribute("data-orig-name") || q("pr-name")) : q("pr-name")).trim(),
      kind: String((ks && ks.value) || "prompt"),
      description: q("pr-desc").trim(),
      used_for: q("pr-usedfor").trim(),
      content: q("pr-content")
    };
  }
  async function savePromptFromForm() {
    var v = promptFormValues();
    if (!v) return;
    if (!v.name) return toast("请填写名称（决定落盘文件名 .dsh/prompts/<名称>.md）", "bad");
    if (!v.content.trim()) return toast("正文不能为空 —— 服务端只落盘、不生成内容，空正文会存成一条没有意义的条目", "bad");
    var btn = v.form.querySelector('[data-act="evo-prompt-create"], [data-act="evo-prompt-save"]');
    if (btn) { btn.disabled = true; btn.textContent = v.edit ? "保存中…" : "创建中…"; }
    try {
      var r = await post("/api/prompts/save", {
        name: v.name, kind: v.kind, description: v.description, used_for: v.used_for,
        content: v.content, note: v.edit ? "面板「编辑」保存" : "面板「新建」创建"
      });
      toast((v.edit ? "已保存「" : "已创建「") + v.name + "」版本 " + (r.version || 1) +
        (r.historyPath ? "（旧版已存进 " + r.historyPath + "）" : "（首次保存，无历史版本）"), "ok");
      togglePromptForm(false);
      await loadPrompts();
    } catch (e) {
      toast((v.edit ? "保存" : "创建") + "失败：" + e.message, "bad");
    } finally {
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = v.edit ? "保存修改" : "创建"; }
    }
  }
  /* 编辑：正文从 GET /api/note 读（.dsh/prompts/ 在 vault 内，safeNotePath 放行，与技能「编辑」同一条路径）；
     描述 / 适用场景 / 类型直接从列表条目回填（列表已带这些字段，不必再解析一遍 frontmatter）。 */
  async function startEditPrompt(name, relPath) {
    var p = pane("evo"); if (!p) return;
    var f = p.querySelector(".evo-prompt-form"); if (!f) return;
    var it = (state.prompts || []).filter(function (x) { return x.name === name; })[0] || {};
    var rel = String(relPath || it.path || (".dsh/prompts/" + name + ".md"));
    togglePromptForm(true);
    setPromptFormMode("edit", name, it.kind);
    var de = f.querySelector(".pr-desc"); if (de) de.value = it.description || "";
    var uf = f.querySelector(".pr-usedfor"); if (uf) uf.value = it.used_for || "";
    var ci = f.querySelector(".pr-content"); if (ci) ci.value = "载入中…";
    try {
      var j = await get("/api/note?path=" + encodeURIComponent(rel));
      if (ci && f.getAttribute("data-orig-name") === name) ci.value = j.text || "";
      toast("已载入「" + name + "」正文；改完点「保存修改」（旧版会存进 .history/）", "ok");
    } catch (e) {
      if (ci) ci.value = "";
      toast("读取正文失败：" + e.message + "（保存会覆盖为空白，请先取消）", "bad");
    }
  }
  /* 只读查看：复用统一查看器（与技能 / 任务正文同一个 markdown 渲染管线） */
  async function openPrompt(name, relPath, kind) {
    var rel = String(relPath || "").replace(/\\/g, "/") || (name ? ".dsh/prompts/" + name + ".md" : "");
    if (!rel) return;
    var k = evoPromptKind(kind || ((state.prompts || []).filter(function (x) { return x.name === name; })[0] || {}).kind);
    var label = "提示词 · " + (name || rel.split("/").pop()) + "（" + evoPromptKindLabel(k) + "）";
    var view = { path: rel, badge: evoPromptKindLabel(k), badgeKind: "local" };
    showEvoView(label, "载入中… " + rel, view);
    try {
      var j = await get("/api/note?path=" + encodeURIComponent(rel));
      showEvoView(label + " · " + (j.path || rel) + " · 只读查看（改内容点卡片上的「编辑」）", j.text || "（空文件）", view);
    } catch (e) {
      showEvoView(label + "（正文不可读）", "无法读取正文：" + e.message + "\n路径：" + rel, view);
    }
  }
  /* 历史版本（GET /api/prompts/history?name=，只读）：逐版列出时间 / 字节数。
     这里必须写清「删除不清历史」—— 否则用户会以为删掉就等于清干净了。 */
  async function showPromptHistory(name) {
    if (!name) return;
    var label = "历史版本 · " + name;
    var view = { path: ".dsh/prompts/" + name + ".md", badge: "历史", badgeKind: "local" };
    showEvoView(label, "载入中…", view);
    try {
      var j = await get("/api/prompts/history?name=" + encodeURIComponent(name));
      var vs = (j && j.versions) || [];
      var cur = j && j.current;
      var lines = [];
      lines.push("当前版本：" + (cur
        ? "存在（第 " + (cur.version == null ? "?" : cur.version) + " 版 · " + (cur.size || 0) + " 字节 · 更新 " +
          (cur.mtimeMs ? relTime(evoToMs(cur.mtimeMs)) : "未知") + "）"
        : "**不存在**（已被删除，或从未保存过）"));
      lines.push("");
      lines.push("历史版本 " + vs.length + " 个（只增不删；删除当前版本不会清掉它们）：");
      if (!vs.length) lines.push("- （无）");
      vs.forEach(function (v, i) {
        lines.push("- 第 " + (vs.length - i) + " 版 · " + (v.ts ? relTime(v.ts) : "时间未知") +
          " · " + (v.size || 0) + " 字节 · `" + (v.path || v.name) + "`");
      });
      lines.push("");
      lines.push("> 每一版都是原文件逐字节拷贝，可在 Obsidian / 资源管理器里直接打开对比。");
      showEvoView(label + " · 共 " + vs.length + " 版" + (cur ? "（另含当前版本）" : ""), lines.join("\n"), view);
    } catch (e) {
      showEvoView(label + "（读取失败）",
        "无法读取历史版本：" + e.message + "\n（契约：GET /api/prompts/history?name=）", view);
    }
  }
  /* 删除：**只删当前版本**，历史保留 —— 确认文案把这件事写死，与技能删除同一个面板内确认条。 */
  function deletePrompt(name) {
    if (!name) return;
    askConfirm("删除「" + name + "」的当前版本？\n\n" +
      "将移除 .dsh/prompts/" + name + ".md；\n" +
      ".dsh/prompts/.history/" + name + "/ 里的历史版本**保留**（历史只增不删）。\n" +
      "删掉之后重建同名，版本号会从旧历史接着涨。",
      async function () {
        try {
          var r = await api("/api/prompts?name=" + encodeURIComponent(name), { method: "DELETE" });
          toast("已删除「" + name + "」当前版本" +
            (r && r.historyKept ? "（历史 " + r.historyKept + " 版仍保留在 .history/）" : "（没有历史版本）"), "ok");
          await loadPrompts();
        } catch (e) {
          toast("删除失败：" + e.message, "bad");
        }
      }, "删除");
  }
  /* 候选 → 表单：**只填字段**（名称 + 建议类型 + 首条证据当描述草稿），不写任何文件、不生成正文 */
  function prefillPromptFromCand(topic, suggest) {
    if (!topic) return;
    var it = (state.promptCands || []).filter(function (c) { return c.topic === topic; })[0] || {};
    var desc = (it.evidence && it.evidence.length) ? String(it.evidence[0]).slice(0, 160) : "";
    togglePromptForm(true, { name: topic, kind: suggest, description: desc });
    toast("已填入表单（名称 + 建议类型" + (desc ? " + 首条证据作描述草稿" : "") + "）；正文请自行定稿后点「创建」", "ok");
  }
  /* ── 任务卡「自解释」三件套（相位 / 步进器 / 按钮分级）──
     相位：0 待执行 / 1 执行中 / 2 终态（已完成 / 失败）。终态卡**没有主按钮**（只读）。
     于是任何一张卡上「下一步点哪」都是唯一的：主按钮只有一个，且文案写清了做完的后果。 */
  function evoTaskPhase(t) {
    var s = String((t && t.status) || "");
    if (/失败|fail|error/i.test(s)) return 2;         // 失败 = 终态（会被归档，正常不该留在队列里）
    var cls = evoStatusCls(s);
    return cls === "done" ? 2 : (cls === "run" ? 1 : 0);
  }
  /* 状态步进器：待执行 → 执行中 → 已完成。走过的打勾（✓）、当前步高亮；
     终态时三步全打勾、最后一步额外高亮 —— 生命周期自己讲清楚，不靠外挂说明。 */
  function evoTaskStepper(ph) {
    var last = EVO_STEPS.length - 1;
    var h = '<div class="evo-steps" role="list" aria-label="任务生命周期：待执行 → 执行中 → 已完成">';
    for (var i = 0; i < EVO_STEPS.length; i++) {
      var walked = i < ph || (i === last && ph === last);
      var cls = walked ? "done" : (i === ph ? "on" : "");
      if (walked && i === ph) cls += " on";
      h += (i ? '<span class="evo-step-ar">→</span>' : "") +
        '<span class="evo-step ' + cls + '" role="listitem" data-step="' + i + '">' +
        '<span class="n">' + (walked ? "✓" : String(i + 1)) + '</span>' + EVO_STEPS[i] + '</span>';
    }
    return h + '</div>';
  }
  /* 卡片动作区：**每个状态只有一个 .primary**，其余一律扁平次级；终态无主按钮。 */
  function evoTaskActions(t, ph) {
    var path = esc(t.path);
    var view = '<button class="dsh-obs-btn x" data-act="evo-task-view" data-path="' + path + '"' +
      ' title="只读查看任务正文，不改状态" style="padding:2px 7px">' + (ph === 2 ? "查看" : "查看正文") + '</button>';
    if (ph === 2) {
      return '<span class="evo-task-ro" title="终态只读：该任务已归档，不在队列里了">已归档 · 只读</span>' + view;
    }
    if (ph === 1) {
      return '<button class="dsh-obs-btn primary x" data-act="evo-task-done" data-path="' + path + '"' +
          ' title="标记完成并移动到「已完成」" style="padding:2px 9px">✓ 标为完成</button>' + view +
        '<button class="dsh-obs-btn x" data-act="evo-task-reset" data-path="' + path + '"' +
          ' title="状态退回「待执行」，之后可以重新领取" style="padding:2px 7px">退回待执行</button>';
    }
    return '<button class="dsh-obs-btn primary x" data-act="evo-task-claim" data-path="' + path + '"' +
        ' title="开始处理，状态变为「执行中」" style="padding:2px 9px">领取任务</button>' + view;
  }
  function renderEvoTasks(p) {
    var box = p.querySelector(".evo-tasks"), n = p.querySelector(".evo-task-n");
    if (!box) return;
    var err = state.evoErr.main;
    if (!state.evo) {
      if (n) n.textContent = "—";
      box.innerHTML = '<div class="dsh-obs-empty' + (err ? " bad" : "") + '">' +
        (err ? "进化数据载入失败：" + esc(err) : "载入中…") + '</div>';
      return;
    }
    var tasks = evoNormTasks(state.evo.tasks);
    if (n) n.textContent = tasks.length + " 个";
    box.innerHTML = tasks.length ? tasks.map(function (t) {
      var ph = evoTaskPhase(t), st = String(t.status || "待执行");
      return '<div class="dsh-obs-item evo-task" data-phase="' + ph + '">' +
        '<div class="it">' + esc(t.topic || t.name) + '</div>' +
        '<div class="ip">' + esc(t.path) + '</div>' +
        evoTaskStepper(ph) +
        '<div class="evo-task-next">' + esc(EVO_TASK_NEXT[ph]) + '</div>' +
        '<div class="im"><span class="evo-badge ' + evoStatusCls(st) + '">' + esc(st) + '</span>' +
          '<span class="evo-qm" title="' + esc(TASK_LEGEND) + '">?</span>' +
          '<span class="sp" style="flex:1"></span>' + evoTaskActions(t, ph) +
        '</div></div>';
    }).join("") : '<div class="dsh-obs-empty">任务队列为空。可用上方「触发」创建。</div>';
  }
  /* 已完成归档（只读）：主题 / 状态 / 完成时间 / 结果；与队列视图互斥显示 */
  function renderEvoArchive(p) {
    if (!p) return;
    var sec = p.querySelector(".evo-archive"), q = p.querySelector(".evo-queue");
    if (!sec) return;
    var open = !!state.evoArchOpen;
    sec.hidden = !open;
    if (q) q.hidden = open;                       // 「返回队列」后队列原样回来
    var a = state.evoArch, err = state.evoErr.arch;
    var bn = p.querySelector(".evo-arch-n");      // 「已完成 N」：N 来自 archive 接口
    if (bn) bn.textContent = a ? String(a.count || 0) : (err ? "!" : "…");
    if (!open) return;
    var list = p.querySelector(".evo-arch-list"), stat = p.querySelector(".evo-arch-stat");
    if (!a) {
      if (stat) stat.textContent = "已完成归档（只读）";
      if (list) list.innerHTML = '<div class="dsh-obs-empty' + (err ? " bad" : "") + '">' +
        (err ? "归档读取失败：" + esc(err) : "载入中…") + '</div>';
      return;
    }
    var items = a.items || [], total = Number(a.count) || items.length;
    if (stat) stat.textContent = "已完成归档（只读）· 共 " + total + " 条" +
      (items.length < total ? "，显示最近 " + items.length + " 条" : "");
    if (!list) return;
    list.innerHTML = items.length ? items.map(function (t) {
      return '<div class="dsh-obs-item">' +
        '<div class="it">' + esc(t.topic || t.name || "") + '</div>' +
        '<div class="ip">' + esc(t.finishedAt ? "完成：" + t.finishedAt : "（无完成时间）") + '</div>' +
        (t.result ? '<div class="evo-arch-res">结果：' + esc(t.result) + '</div>' : '') +
        '<div class="im"><span class="evo-badge ' + evoStatusCls(t.status) + '">' + esc(t.status || "已完成") + '</span></div>' +
        '</div>';
    }).join("") : '<div class="dsh-obs-empty">还没有已归档的任务。在队列里点「完成」后，任务会移到这里。</div>';
  }
  function evoList(files, dir) {
    if (!files || !files.length) return '<div class="dsh-obs-empty">（暂无）</div>';
    return files.map(function (f) {
      var full = ".dsh/evolution/" + dir + "/" + f;
      return '<div class="efile" data-act="evo-open" data-path="' + esc(full) + '" title="' + esc(full) + '">' +
        '<span>' + esc(f) + '</span><b>查看</b></div>';
    }).join("");
  }
  function renderEvoFiles(p) {
    var evo = state.evo, err = state.evoErr.main;
    var ln = p.querySelector(".evo-log-n"), gn = p.querySelector(".evo-gap-n");
    var lb = p.querySelector(".evo-logs"), gb = p.querySelector(".evo-gaps");
    if (!evo) {
      if (ln) ln.textContent = "—";
      if (gn) gn.textContent = "—";
      var tip = '<div class="dsh-obs-empty' + (err ? " bad" : "") + '">' +
        (err ? "进化数据载入失败：" + esc(err) : "载入中…") + '</div>';
      if (lb) lb.innerHTML = tip;
      if (gb) gb.innerHTML = tip;
      return;
    }
    if (ln) ln.textContent = (evo.logs || []).length + " 个";
    if (gn) gn.textContent = (evo.gaps || []).length + " 个";
    if (lb) lb.innerHTML = evoList(evo.logs, "logs");
    if (gb) gb.innerHTML = evoList(evo.gaps, "gaps");
  }
  function renderEvoInbox(p) {
    var n = p.querySelector(".evo-inbox-n"), box = p.querySelector(".evo-inbox"), inbox = state.inbox;
    if (!box) return;
    if (n) n.textContent = inbox ? ("共 " + (inbox.count || 0) + " 篇待处理") : "—";
    box.innerHTML = !inbox
      ? '<div class="dsh-obs-empty">载入中…</div>'
      : ((inbox.files || []).length
          ? (inbox.files || []).map(function (f) {
              var full = ".dsh/inbox/" + f;
              return '<div class="efile" data-act="evo-open" data-path="' + esc(full) + '" title="' + esc(full) + '"><span>' + esc(f) + '</span><b>查看</b></div>';
            }).join("")
          : '<div class="dsh-obs-empty">（收件箱为空）</div>');
  }
  /* 自动导出开关（收件箱下方）：状态来自 GET /api/settings 的 auto_export_sessions */
  function renderEvoAutoExport(p) {
    renderFootAutoExport();   // 面板与侧栏底栏同一个 state.settings：这里一变，底栏那行跟着变
    var sw = p.querySelector(".evo-sw"), st = p.querySelector(".auto-export-stat");
    if (!sw) return;
    var s = state.settings, err = state.evoErr.settings;
    var on = !!(s && s.auto_export_sessions === true);
    sw.className = "evo-sw" + (on ? " on" : "");
    sw.setAttribute("aria-checked", on ? "true" : "false");
    if (!st) return;
    st.className = "line auto-export-stat" + (err ? " bad" : "");
    st.textContent = err
      ? "设置接口不可用：" + err + "（契约 GET / PUT /api/settings）"
      : (!s ? "读取中…"
        : (on ? "已开启：服务每 12 小时扫描一次，静置 ≥ 2 天且未自动导出过的对话 → 导出到知识库。"
              : "已关闭：服务不扫描会话目录，不产生任何文件。"));
  }
  /* 点开关 → PUT /api/settings → 成功 toast；失败面板内可见（并把开关恢复成服务端真实状态）
     读写走 saveAutoExport（与侧栏底栏那行共用），两边永远同一个来源 */
  async function toggleAutoExport() {
    var p = pane("evo"); if (!p) return;
    var sw = p.querySelector(".evo-sw");
    if (!sw || sw.getAttribute("data-busy") === "1") return;
    var want = !autoExportOn();
    sw.setAttribute("data-busy", "1");
    try {
      await saveAutoExport(want);
      toast("自动导出已" + (want ? "开启：服务每 12 小时扫描一次（静置 ≥ 2 天且未导出过的对话）" : "关闭：服务不再扫描会话目录"), "ok");
    } catch (e) {
      state.evoErr.settings = e.message;
      toast("自动导出开关保存失败：" + e.message, "bad");
    } finally {
      if (sw.isConnected) sw.removeAttribute("data-busy");
      syncAutoExportUI();
    }
  }
  function renderEvo() {
    if (!panelEl) return;
    var p = pane("evo");
    if (!p || p.getAttribute("data-built") !== "1") return;
    renderEvoStatus(p);
    renderEvoScan(p);
    renderEvoCandidates(p);   // 技能区**上方**：先「待提炼」→ 再「已有技能」
    renderEvoSkills(p);
    renderEvoPrompts(p);      // 第四类进化对象：提示词 / 模板 / 检查清单（与技能库并列）
    renderEvoPromptCands(p);  // 提示词候选（上游：候选 → 固化成提示词）
    renderEvoTasks(p);
    renderEvoArchive(p);
    renderEvoFiles(p);
    renderEvoInbox(p);
    renderEvoAutoExport(p);
  }

  /* ── 数据加载（每个接口独立 try/catch：一个失败不影响其它分区） ── */
  /* 载入技能（**非破坏式**）：拿到新列表才替换；失败保留旧列表，绝不闪现空态 */
  async function loadSkills() {
    var p = pane("evo"); if (!p) return;
    try {
      state.skills = evoNormSkills(await get("/api/skills"));
      state.evoErr.skills = "";
    } catch (e) {
      state.evoErr.skills = e.message;   // 失败保留旧列表（错误在技能区标题/空态里可见）
    }
    renderEvoSkills(p);
  }
  /* 载入「已完成」归档（只读）：**非破坏式** —— 失败保留旧计数与旧条目，避免归档视图闪成载入态 */
  async function loadArch() {
    try {
      state.evoArch = await get("/api/evolution/archive?limit=50");
      state.evoErr.arch = "";
    } catch (e5) {
      state.evoErr.arch = e5.message;
    }
  }
  /* 载入进化页整页数据（进入页签 / 手动 ↻ 都走这里）。
     **非破坏式**：所有 fetch 都先拿结果、拿到才覆盖 state；失败保留旧值。
     于是刷新期间**旧内容一直挂在屏幕上**（滚动位置、展开态、筛选、归档视图开关都不被动），
     新数据到位后 renderEvo() 一次性替换 —— 全程不会闪现空态 / 载入态（首次加载除外，那时本来就没内容）。 */
  async function loadEvo() {
    buildEvo();
    var p = pane("evo");
    if (!p) return;
    var errs = [];
    try { state.evo = await get("/api/evolution"); state.evoErr.main = ""; }
    catch (e) { state.evoErr.main = e.message; errs.push("进化数据 " + e.message); }   // 失败保留旧 state.evo
    /* 契约里另有 GET /api/state：进化接口没带 state 时用它兜底（失败静默，不影响主流程） */
    if (!(state.evo && state.evo.state)) {
      try {
        var sj = await get("/api/state");
        if (sj && sj.state) state.evo = Object.assign({}, state.evo || {}, { state: sj.state });
      } catch (e2) {}
    }
    try { state.inbox = await get("/api/inbox"); }
    catch (e3) { errs.push("收件箱 " + e3.message); }
    /* 自动导出开关的状态（失败不阻塞整页，只在开关下方显示可见提示）
       注意：接口回的是 {ok, settings}，这里只存 settings 本体，渲染时才读得到 auto_export_sessions */
    try {
      var sj = await get("/api/settings");
      state.settings = (sj && sj.settings) || null;
      state.effective = (sj && sj.effective) || null;
      state.evoErr.settings = "";
    } catch (e4) { state.evoErr.settings = e4.message; }
    await loadCandidates();       // 候选（技能的上游）先拉：失败只在候选区内可见提示，不影响其余分区
    await loadSkills();
    await loadPrompts();          // 第四类进化对象（提示词 / 模板 / 检查清单）+ 其候选：各自独立 try/catch，互不影响
    await loadPromptCands();
    await loadArch();             // 已完成归档（只读）：计数徽标「已完成 N」与归档列表都来自这个接口
    renderEvo();
    var el = qs(".dsh-obs-status .inbox");
    if (el) el.textContent = String((state.inbox && state.inbox.count) || 0);
    /* 状态条要显示笔记篇数：索引尚未载入时后台补一次（结果只用于本页数字） */
    if (!state.index && state.online) loadIndex(false).then(function () { if (pane("evo")) renderEvoStatus(pane("evo")); });
    if (errs.length) toast("部分数据不可用：" + errs.join("；"), "bad");
    /* 数据已到位 → 按**服务端真实状态**决定是否开自动刷新（无进行中项时不挂计时器 = 不常驻轮询） */
    evoPollSync();
  }

  /* ══ 进化页「短轮询」自动刷新（2026-10-08 用户实测缺陷）══
     缺陷原话精神：候选卡还写着「待执行」，可服务端 `handoff` 早已是「已完成」、任务也归档了 ——
     面板不知道后台干完了，用户必须手点右上角 ↻ 才更新。期望：**「我在看它干活」时面板自己变**。

     规则（逐条对应验收）：
      ① 触发条件：候选（handoff 存在且 status ∈ {待执行, 执行中}）**或**任务队列里
         有 status ∈ {待执行, 执行中} 的项 → 开 10s 轮询；**一旦全部到终态立即停**（不常驻）。
         ⚠️ handoff=null（还没交给 DSH 的候选）**不算**进行中：它不会自己变，盯它等于常驻轮询。
      ② 暂停：页面不可见（document.visibilityState=hidden）/ 切到别的页签（state.tab ≠ "evo"）/
         面板关闭（state.open=false）→ **不挂计时器**（连定时器都不存在，不是空转）。
      ③ 恢复可见 / 切回本页签 / 重新打开面板 → `loadEvo()` 立刻补拉一次，再按新状态决定是否续跑。
      ④ 失败：轮询自己失败**静默重试**（不刷红、不写 evoErr.main、不动任何卡片）；
         连续失败 3 次 → 停轮询 + **恰好一次**轻提示「自动刷新已暂停…点 ↻」。
      ⑤ 非破坏式：每轮只更新 state + renderEvo()（重画内容，不重建骨架）——
         滚动位置、候选区展开态、技能区筛选、归档视图开关、左移内边距全都不受影响。 */
  var EVO_POLL_MS = 10000;      // 短轮询间隔（用户口径：每 10 秒）
  var EVO_POLL_MAX_FAILS = 3;   // 连续失败上限 → 停轮询并给一次轻提示
  var evoPollTimer = null, evoPollBusy = false, evoPollFails = 0, evoPollSeq = 0, evoPollWarned = false;

  /* 单次轮询：只重拉**候选**与**任务队列**两份数据（不重跑 loadEvo —— 那会连技能/收件箱/归档一起拉，太重）。
     返回 { candOk, evoOk }（null=该腿没跑），供调用方累计连续失败；**绝不写 state.evoErr**（静默）。 */
  async function evoPollFetch(seq) {
    var tab = state.tab || "notes";
    var p = pane(tab === "ingest" ? "ingest" : "evo");
    if (!p) return null;
    var r = { candOk: null, evoOk: null, ingOk: null };
    /* 投喂页：只重拉**暂存清单**（深度整理状态随 GET /api/ingest/list 的 deep 字段一起回来）。
       非破坏式：先拿到新数据才替换 state，再整块重画列表；失败保留旧 state（绝不闪空态）。 */
    if (tab === "ingest") {
      try {
        var jI = await get("/api/ingest/list");
        if (seq !== evoPollSeq) return null;                 // 期间已被停/重启：丢弃这批结果
        state.ingest.list = jI.items || [];
        state.ingest.err = "";
        r.ingOk = true;
        renderIngestList();
      } catch (eI) { r.ingOk = false; }
      return r;
    }
    try {
      var j = await get("/api/skills/candidates?limit=20");
      if (seq !== evoPollSeq) return null;                 // 期间已被停/重启：丢弃这批结果
      state.candidates = evoNormCandidates(j);
      state.candContainers = evoNum(j && j.containerCount) || 0;
      state.evoErr.candidates = "";
      r.candOk = true;
      renderEvoCandidates(p);                              // 整块 innerHTML 替换（原子，不闪中间态）
    } catch (eC) { r.candOk = false; }
    try {
      var j2 = await get("/api/evolution");
      if (seq !== evoPollSeq) return null;
      state.evo = j2;
      state.evoErr.main = "";                              // 只清主数据错误；轮询失败=静默，不写错误
      r.evoOk = true;
      renderEvoTasks(p);
    } catch (eE) { r.evoOk = false; }
    return r;
  }
  /* 一轮：静默重试；连续 3 次失败 → 停 + 一次轻提示。成功后**立刻**按新数据判定是否已到终态（停轮询）。 */
  async function evoPollTick() {
    if (evoPollBusy) return;
    if (!evoPollShouldRun()) { evoPollStop(); return; }    // 面板关了 / 切走了 / 页面不可见
    evoPollBusy = true;
    var seq = evoPollSeq;
    try {
      var r = await evoPollFetch(seq);
      if (seq !== evoPollSeq) return;
      if (!r) { evoPollStop(); return; }                   // 面板已销毁
      if (r.candOk === false || r.evoOk === false || r.ingOk === false) {
        evoPollFails++;
        if (evoPollFails >= EVO_POLL_MAX_FAILS) {
          evoPollStop();
          if (!evoPollWarned) { evoPollWarned = true; toast("自动刷新已暂停（连续 " + EVO_POLL_MAX_FAILS + " 次读取失败），可点右上角 ↻ 手动刷新", "bad"); }
        }
        return;                                            // 判据没变 → 计时器留着，下一轮静默重试
      }
      evoPollFails = 0;
      evoPollWarned = false;
      if (!evoPollNeeded()) evoPollStop();                 // ⭐ 全部到终态 → 立刻停，不再重拉
    } finally { evoPollBusy = false; }
  }
  /* 是否需要自动刷新：只看**服务端给的状态**（前端不编）。 */
  function evoPollNeeded() {
    var i, c;
    /* 投喂页：只有「深度整理」还没到终态（待执行 / 执行中）时才需要盯 —— 到终态即停。
       判据与卡片绘制**共用同一把尺**（ingDeepPhase → evoTaskPhase），避免「卡片画成终态、轮询还在跑」；
       deep.exists=false（还没交给 DSH）**不算**进行中：它不会自己变，盯它等于常驻轮询。 */
    if ((state.tab || "notes") === "ingest") {
      var its = state.ingest.list || [];
      for (i = 0; i < its.length; i++) {
        var dp = ingDeepPhase(its[i] && its[i].deep);
        if (dp === 0 || dp === 1) return true;
      }
      return false;
    }
    var cs = state.candidates || [];
    for (i = 0; i < cs.length; i++) {
      c = cs[i];
      /* handoff=null = 还没交给 DSH → 不会自己变，不算进行中 */
      if (c && c.handoff && !evoPhaseTerminal(candHandoffPhase(c.handoff))) return true;
    }
    var ts = (state.evo && state.evo.tasks) || [];
    for (i = 0; i < ts.length; i++) if (!evoPhaseTerminal(evoTaskPhase(ts[i]))) return true;
    return false;
  }
  /* 暂停条件（任一成立即不轮询）。**只读**，不写任何状态。 */
  function evoPollShouldRun() {
    if (disposed || !state.open || !panelEl) return false;            // 面板关闭 → 停
    var tab = state.tab || "notes";
    /* 盯的页签只有两个：进化页（候选 / 任务队列）与投喂页（深度整理状态）；
       切到任何别的页签 → 停（切回时 loadEvo / loadIngest 会立刻补拉并按新状态续跑）。 */
    if (tab !== "evo" && tab !== "ingest") return false;
    try { if (document.visibilityState === "hidden") return false; } catch (eV) {}   // 页面不可见 → 停
    return !!pane(tab);
  }
  function evoPollStop() {
    evoPollSeq++;                                          // 让在途结果失效（防「停后又画一帧」）
    if (evoPollTimer) { try { clearInterval(evoPollTimer); } catch (e) {} evoPollTimer = null; }
  }
  /* 幂等启动：条件不满足 / 无进行中项 → 只是确保没计时器（不会新建）。
     ⚠️ 不因 evoPollBusy 而跳过：手动刷新期间正好有请求在途时也要能把计时器续上
     （在途那轮自己在 finally 里判终态，到终态会 evoPollStop()）。 */
  function evoPollStart() {
    if (evoPollTimer) return;                              // 已在跑 → 不叠第二个计时器
    if (!evoPollShouldRun() || !evoPollNeeded()) { evoPollStop(); return; }
    evoPollTimer = setInterval(evoPollTick, EVO_POLL_MS);
    evoPollSeq++;                                          // 新一轮的世代号（作废上一轮在途结果）
    /* 只读自检句柄（不含数据、不参与任何逻辑）：`window.__dshEvoPoll.running()` 一眼看出
       现在到底有没有在轮询 —— 回应「它是不是一直在偷偷拉接口」这类疑问时不用猜。 */
    if (!window.__dshEvoPoll) window.__dshEvoPoll = { intervalMs: EVO_POLL_MS, running: function () { return !!evoPollTimer; } };
  }
  /* 状态变化（载入完成 / 页签 / 可见性 / 开关面板）后调用：该跑就跑，该停就停。 */
  function evoPollSync() {
    if (!evoPollShouldRun() || !evoPollNeeded()) { evoPollStop(); return; }
    evoPollStart();
  }
  /* 页面不可见 / 恢复可见：不可见时**不打断在途请求**（打断反而会误记失败），只是不再起新轮；
     恢复可见 → 立刻补拉一次（loadEvo 非破坏式，顺手把停轮询期间的进展一次性补上）。 */
  function evoOnVisibility() {
    if (disposed) return;
    var vis = true;
    try { vis = document.visibilityState !== "hidden"; } catch (eV) {}
    var tab = state.tab || "notes";
    if (!vis || !state.open || (tab !== "evo" && tab !== "ingest") || !pane(tab)) { evoPollStop(); return; }
    evoPollFails = 0; evoPollWarned = false;
    /* 恢复可见 → 立刻补拉**当前页签那一份**（两者都是非破坏式），再按新状态决定是否续跑 */
    if (tab === "ingest") loadIngest(true).then(function () { evoPollSync(); });
    else loadEvo();
  }
  /* 手动 ↻：数据到手后重新裁决轮询（失败计数清零，用户手动动作不该被旧的失败计数拖住） */
  function evoManualRefresh() {
    evoPollFails = 0; evoPollWarned = false;
    return loadEvo();
  }

  /* ── 2) 一键触发 ── */
  async function runEvolution() {
    var p = pane("evo"); if (!p) return;
    var input = p.querySelector(".evo-topic"), btn = p.querySelector('[data-act="evo-run"]');
    var topic = input ? input.value.trim() : "";
    if (btn) { btn.disabled = true; btn.textContent = "触发中…"; }
    try {
      var r = await post("/api/evolution", { topic: topic || "auto" });
      if (input) input.value = "";
      toast("进化任务已创建：" + (r.task || "已入队") + "（DSH 后台执行）", "ok");
      await loadEvo();           // 非破坏式刷新本页（不置 null：保持旧内容，新数据到位再替换）
    } catch (e) {
      toast("触发失败：" + e.message, "bad");
    } finally {
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "触发"; }
    }
  }

  /* ── 3) 扫描知识库 ── */
  async function scanKB() {
    var p = pane("evo"); if (!p) return;
    var btn = p.querySelector('[data-act="evo-scan"]'), stat = p.querySelector(".scan-stat");
    if (btn) { btn.disabled = true; btn.textContent = "扫描中…"; }
    if (stat) { stat.className = "line scan-stat"; stat.textContent = "正在扫描知识库（目录 / 标签 / 缺口）…"; }
    try {
      state.scan = await get("/api/evolution/scan");
      state.evoErr.scan = "";
      renderEvoScan(p);
      renderEvoStatus(p);
      toast("扫描完成：主题 " + ((state.scan.topics || []).length) + " 个 · 缺口 " + ((state.scan.gaps || []).length) + " 条", "ok");
    } catch (e) {
      state.scan = null;
      state.evoErr.scan = e.message;
      renderEvoScan(p);
      toast("扫描失败：" + e.message, "bad");
    } finally {
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "扫描知识库"; }
    }
  }

  /* ── 4) 生成报告 ── */
  function toggleEvoReport(show) {
    var p = pane("evo"); if (!p) return;
    var f = p.querySelector(".evo-report"); if (!f) return;
    var want = typeof show === "boolean" ? show : !!f.hidden;
    f.hidden = !want;
    if (want) { var t = f.querySelector(".rp-topic"); if (t) { try { t.focus(); } catch (e) {} } }
  }
  async function submitEvoReport() {
    var p = pane("evo"); if (!p) return;
    var btn = p.querySelector('[data-act="evo-report-submit"]');
    var body = {
      topic: (p.querySelector(".rp-topic").value || "").trim() || "auto",
      summary: (p.querySelector(".rp-summary").value || "").trim(),
      newKnowledge: evoLines(p.querySelector(".rp-new").value, "note"),
      gaps: evoLines(p.querySelector(".rp-gaps").value, "reason")
    };
    if (btn) { btn.disabled = true; btn.textContent = "提交中…"; }
    try {
      var r = await post("/api/evolution/report", body);
      toast("报告已提交" + (r.log ? "：" + r.log : "") + (r.gap ? " · 缺口：" + r.gap : ""), "ok");
      p.querySelector(".rp-summary").value = "";
      p.querySelector(".rp-new").value = "";
      p.querySelector(".rp-gaps").value = "";
      toggleEvoReport(false);
      state.evo = null;
      await loadEvo(); // 刷新日志 / 缺口清单
    } catch (e) {
      toast("报告提交失败：" + e.message, "bad");
    } finally {
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "提交报告"; }
    }
  }

  /* ── 5) 技能库 ──
     自解释口径：每个按钮的**文案写清后果**，title 再补一句"点下去会发生什么、能不能撤回"。
     库内技能（vault 内 <名>/SKILL.md）**零写入口**：卡片上只有「查看」与「用这张卡」。 */
  /* 表单在两种模式间切换：create（新建）/ edit（编辑本地技能）。
     edit 时技能名只读（改名 = 新建 + 删旧，绝不做静默重命名），主按钮换成「保存修改」走 /api/skills/save。 */
  function setSkillFormMode(mode, name) {
    var p = pane("evo"); if (!p) return;
    var f = p.querySelector(".evo-skill-form"); if (!f) return;
    var edit = mode === "edit";
    f.setAttribute("data-mode", edit ? "edit" : "create");
    f.setAttribute("data-orig-name", edit ? String(name || "") : "");
    var tip = f.querySelector(".sk-mode");
    if (tip) tip.textContent = edit
      ? "编辑本地技能「" + String(name || "") + "」→ 保存写回 .dsh/skills/" + String(name || "") + ".md（旧正文自动存进 .history/）"
      : "新建技能 → 落盘 .dsh/skills/<名称>.md";
    var ni = f.querySelector(".sk-name");
    if (ni) {
      if (edit) ni.value = String(name || "");       // 编辑态必须**回填技能名**（且只读，改名=新建+删旧）
      ni.readOnly = edit;
      ni.title = edit ? "本地技能名不可改（要改名请新建一张卡，再删掉旧卡）" : "技能名称：决定落盘文件名 .dsh/skills/<名称>.md";
    }
    var btn = f.querySelector('[data-act="evo-skill-create"], [data-act="evo-skill-save"]');
    if (btn) {
      btn.setAttribute("data-act", edit ? "evo-skill-save" : "evo-skill-create");
      btn.textContent = edit ? "保存修改" : "创建";
      btn.title = edit
        ? "保存修改：写回 .dsh/skills/" + String(name || "") + ".md；旧正文先逐字节存进 .dsh/skills/.history/（只增不删）"
        : "创建：写 .dsh/skills/<名称>.md；同名已存在会先把旧正文存进 .dsh/skills/.history/（只增不删）";
    }
  }
  function toggleSkillForm(show) {
    var p = pane("evo"); if (!p) return;
    var f = p.querySelector(".evo-skill-form"); if (!f) return;
    var want = typeof show === "boolean" ? show : !!f.hidden;
    f.hidden = !want;
    if (want) {
      if (f.getAttribute("data-mode") !== "edit") setSkillFormMode("create");
      var n = f.querySelector(".sk-name"); if (n) { try { n.focus(); } catch (e) {} }
    } else {
      setSkillFormMode("create");        // 关闭 = 回到新建模式，避免下次「新建技能」带着上一张卡的名字
      var nm = f.querySelector(".sk-name"); if (nm) nm.value = "";
      var de = f.querySelector(".sk-desc"); if (de) de.value = "";
      var ct = f.querySelector(".sk-content"); if (ct) ct.value = "";
    }
  }
  async function createSkill() {
    var p = pane("evo"); if (!p) return;
    var name = (p.querySelector(".sk-name").value || "").trim();
    var description = (p.querySelector(".sk-desc").value || "").trim();
    var content = p.querySelector(".sk-content").value || "";
    if (!name) return toast("请填写技能名称", "bad");
    var btn = p.querySelector('[data-act="evo-skill-create"]');
    if (btn) { btn.disabled = true; btn.textContent = "创建中…"; }
    try {
      /* 走 /api/skills/save（追加式版本化）：同名时旧正文进 .history/，比旧 POST /api/skills 更安全 */
      var r = await post("/api/skills/save", { name: name, description: description, content: content, note: "面板「新建技能」创建" });
      toast("技能已创建：" + (r.path || name) + "（版本 " + (r.version || 1) + "）", "ok");
      p.querySelector(".sk-name").value = "";
      p.querySelector(".sk-desc").value = "";
      p.querySelector(".sk-content").value = "";
      toggleSkillForm(false);
      await loadSkills(true);
    } catch (e) {
      toast("创建技能失败：" + e.message, "bad");
    } finally {
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "创建"; }
    }
  }
  /* 本地技能 → 「编辑」：在**本面板**里改正文（复用新建表单的 textarea），正文从 GET /api/note 读。
     刻意不跳「编辑」页：那里是通用笔记编辑（有路径/标签/双链等），技能卡只需要正文 + 描述。
     库内技能没有任何入口走到这里；这里再兜一道（source=vault / editable=false → 直接拒绝）。 */
  async function startEditSkill(name, relPath) {
    var p = pane("evo"); if (!p) return;
    var f = p.querySelector(".evo-skill-form"); if (!f) return;
    var sk = (state.skills || []).filter(function (x) { return x.name === name; })[0] || {};
    if (sk.source === "vault" || sk.editable === false) return toast("库内技能只读，不支持编辑（改动请在 Obsidian 里做）", "bad");
    var rel = String(relPath || sk.path || ("".concat(".dsh/skills/", name, ".md")));
    toggleSkillForm(true);
    setSkillFormMode("edit", name);
    var di = f.querySelector(".sk-desc"); if (di) di.value = sk.description || "";
    var ci = f.querySelector(".sk-content"); if (ci) ci.value = "载入中…";
    try {
      var j = await get("/api/note?path=" + encodeURIComponent(rel));
      if (ci && f.getAttribute("data-orig-name") === name) ci.value = j.text || "";
      toast("已载入「" + name + "」正文；改完点「保存修改」（旧正文会存进 .history/）", "ok");
    } catch (e) {
      if (ci) ci.value = "";
      toast("读取技能正文失败：" + e.message + "（保存会覆盖为空白，请先取消）", "bad");
    }
  }
  async function saveEditedSkill() {
    var p = pane("evo"); if (!p) return;
    var f = p.querySelector(".evo-skill-form"); if (!f) return;
    if (f.getAttribute("data-mode") !== "edit") return createSkill();
    var name = String(f.getAttribute("data-orig-name") || (p.querySelector(".sk-name").value || "")).trim();
    var description = (p.querySelector(".sk-desc").value || "").trim();
    var content = p.querySelector(".sk-content").value || "";
    if (!name) return toast("缺少技能名，无法保存", "bad");
    var btn = p.querySelector('[data-act="evo-skill-save"]');
    if (btn) { btn.disabled = true; btn.textContent = "保存中…"; }
    try {
      var r = await post("/api/skills/save", { name: name, description: description, content: content, note: "面板「编辑」保存" });
      toast("已保存「" + name + "」版本 " + (r.version || 1) +
        (r.historyPath ? "（旧正文已存进 " + r.historyPath + "）" : "（首次保存，无历史）"), "ok");
      toggleSkillForm(false);
      await loadSkills(true);
    } catch (e) {
      toast("保存技能失败：" + e.message, "bad");
    } finally {
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "保存修改"; }
    }
  }
  /* 「用这张卡」：只写收件箱任务，**不改技能卡**。确认文案写清"下次开工会按它执行"。 */
  async function useSkillFromCard(name, btn) {
    if (!name) return toast("该技能没有名字，无法排入收件箱", "bad");
    if (btn) { btn.disabled = true; btn.textContent = "排入中…"; }
    try {
      var r = await post("/api/skills/use", { name: name });
      toast("已排入收件箱 · DSH 下次开工会按这张卡执行" + (r.path ? "（" + r.path + "）" : ""), "ok");
    } catch (e) {
      toast("排入收件箱失败：" + e.message, "bad");
    } finally {
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "用这张卡"; }
    }
  }
  /* 「停用 / 启用」：只改 frontmatter 的 enabled:（正文逐字节不动）→ 影响开工检索是否带上这张卡 */
  async function toggleSkillEnabled(name, nextEnabled, btn) {
    if (!name) return;
    var want = nextEnabled === true || nextEnabled === "true";
    if (btn) { btn.disabled = true; btn.textContent = want ? "启用中…" : "停用中…"; }
    try {
      await post("/api/skills/toggle", { name: name, enabled: want });
      toast(want
        ? "已启用「" + name + "」· 开工检索会重新带上这张卡"
        : "已停用「" + name + "」· frontmatter enabled: false（正文没动），开工检索会跳过它", "ok");
      await loadSkills(true);
    } catch (e) {
      toast((want ? "启用" : "停用") + "失败：" + e.message, "bad");
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = want ? "启用" : "停用"; }
    }
  }
  /* 「导出到知识库」（区级）：单向导出**全部本地技能**到 <vault>/<skill_mirror_folder>/；内容没变的会被跳过（幂等）。
     只在知识库里**新建/更新副本**，绝不改 .dsh/skills/ 源文件，也绝不碰库内技能。 */
  async function mirrorSkillsToVault(btn) {
    if (btn) { btn.disabled = true; btn.textContent = "导出中…"; }
    try {
      var r = await post("/api/skills/mirror", {});
      var m = (r.mirrored || []).length, s = (r.skipped || []).length;
      toast("导出到知识库：" + (r.dir || skillMirrorFolder()) + " 新写/更新 " + m + " 张" +
        (s ? " · 内容没变跳过 " + s + " 张" : "") + "（单向只读副本；改技能请回本面板「编辑」）", "ok");
      await loadSkills(true);
    } catch (e) {
      toast("导出到知识库失败：" + e.message, "bad");
    } finally {
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "导出到知识库"; }
    }
  }
  /* 删除：走面板内确认条（不用 window.confirm）。
     **只对本地技能生效** —— 库内技能（vault 内 <名>/SKILL.md）界面上没有入口，
     这里再兜一道：来源是 vault 直接拒绝，绝不把用户自己的文件发去删。 */
  function deleteSkill(name, source) {
    if (!name) return;
    if (source === "vault") return toast("库内技能只读，不支持删除", "bad");
    askConfirm('删除技能「' + name + '」？将移除 .dsh/skills/' + name + '.md', async function () {
      try {
        var r = await api("/api/skills?name=" + encodeURIComponent(name), { method: "DELETE" });
        toast("已删除技能：" + name + (r && r.deleted != null ? "（" + r.deleted + "）" : ""), "ok");
        await loadSkills(true);
      } catch (e) {
        toast("删除技能失败：" + e.message, "bad");
      }
    }, "删除");
  }
  /* 打开技能正文（面板内**只读查看器**，复用笔记页 markdown 渲染 → 标题/列表/代码块/双链 +
     frontmatter 属性区块，不再显示 --- 原文）。库内技能不在 .dsh/skills/ 下 → 用后端给的 path 读；
     刻意不塞进「编辑」页（那里有保存按钮，误点会覆盖用户自己的 SKILL.md），查看器里也没有任何写入口。 */
  async function openSkill(name, relPath, source) {
    var rel = String(relPath || "").replace(/\\/g, "/") || (name ? ".dsh/skills/" + name + ".md" : "");
    if (!rel) return;
    var isVault = source ? source === "vault" : !/^\.dsh\/skills\//.test(rel);
    var label = "技能 · " + (name || rel.split("/").pop()) + (isVault ? "（库内 · 只读）" : "（本地）");
    var view = { path: rel, badge: isVault ? "库内" : "本地", badgeKind: isVault ? "vault" : "local" };
    showEvoView(label, "载入中… " + rel, view);
    try {
      var j = await get("/api/note?path=" + encodeURIComponent(rel));
      showEvoView(label + " · " + (j.path || rel) + (isVault ? " · 只读查看（库内技能，不提供删除 / 保存）" : " · 只读查看（不提供保存 / 编辑）"),
        j.text || "（空文件）", view);
    } catch (e) {
      var s = (state.skills || []).filter(function (x) { return x.name === name; })[0] || {};
      var meta = "技能：" + (name || "(未命名)") +
        "\n描述：" + (s.description || "（无）") +
        "\n标签：" + ((s.tags || []).length ? s.tags.join(", ") : "（无）") +
        "\n路径：" + (s.path || rel) +
        (s.mtimeMs ? "\n更新：" + relTime(evoToMs(s.mtimeMs)) : "");
      showEvoView(label + "（正文不可读）",
        "无法读取技能正文：" + e.message +
        "\n（GET /api/note 未放行该路径时，仅显示技能元信息）\n\n" + meta, view);
    }
  }

  /* ── 6) 任务队列：领取 / 标为完成（带轻确认）/ 退回待执行 ──
     三个动作的口径都落在按钮文案与 title 上：点下去会发生什么、能不能撤回，一眼可见。 */
  async function claimTask(btnArg) {
    var p = pane("evo"); if (!p) return;
    var btn = btnArg || p.querySelector('[data-act="evo-task-claim"]');
    if (btn) { btn.disabled = true; btn.textContent = "领取中…"; }
    try {
      var r = await post("/api/evolution/claim", {});
      var t = r.task || {};
      showEvoView("任务正文 · " + (t.topic || t.path || ""), t.content || "（任务正文为空）");
      toast("已领取：" + (t.topic || t.path || "") + " · 状态已变「执行中」，做完点「标为完成」", "ok");
      state.evo = null;
      await loadEvo(); // 领取后状态可能变为「执行中」
    } catch (e) {
      toast(e.status === 404 ? "当前没有可领取的任务" : ("领取失败：" + e.message), "bad");
    } finally {
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "领取任务"; }
    }
  }
  /* 轻确认：先把「归档 ≠ 删除」讲清楚再让用户按下去（面板内一行确认条，不是拦路弹窗） */
  function askDoneTask(path, btn) {
    if (!path) return toast("该任务没有可用路径，无法标记完成", "bad");
    askConfirm("确认已完成？归档后不再出现在队列，可在「已完成」里查看",
      function () { doneTask(path, btn); }, "确认归档", "再想想");
  }
  async function doneTask(path, btn) {
    if (!path) return toast("该任务没有可用路径，无法标记完成", "bad");
    if (btn) { btn.disabled = true; btn.textContent = "归档中…"; }
    try {
      var r = await post("/api/evolution/done", { path: path, ok: true });
      toast("已归档：" + (r.archivedTo || r.path || path) + " · 可在「已完成」里查看", "ok");
      state.evo = null;                 // 完成后该任务已移出队列 → 重新拉取队列与归档
      await loadEvo();
    } catch (e) {
      toast("标记完成失败：" + e.message, "bad");
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "✓ 标为完成"; }
    }
  }
  /* 退回待执行（「执行中」卡片的次级动作）：状态回「待执行」，并清掉「开始」行 */
  async function resetTask(path, btn) {
    if (!path) return toast("该任务没有可用路径，无法退回", "bad");
    if (btn) { btn.disabled = true; btn.textContent = "退回中…"; }
    try {
      await post("/api/evolution/reset", { path: path });
      toast("已退回「待执行」：" + path + "（可以重新领取）", "ok");
      state.evo = null;
      await loadEvo();
    } catch (e) {
      toast("退回失败：" + e.message, "bad");
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "退回待执行"; }
    }
  }
  /* 「已完成 N」入口 / 「← 返回队列」：归档视图与队列视图互斥；首次打开时补拉归档数据 */
  async function toggleEvoArchive(show) {
    var p = pane("evo");
    state.evoArchOpen = show === undefined ? !state.evoArchOpen : !!show;
    renderEvoArchive(p);
    if (!p || !state.evoArchOpen || state.evoArch) return;
    try {
      state.evoArch = await get("/api/evolution/archive?limit=50");
      state.evoErr.arch = "";
    } catch (e) { state.evoErr.arch = e.message; }
    renderEvoArchive(pane("evo"));
  }

  /* 载入 .dsh/ 下文件内容（服务端只放行 vault 内 .md；失败则只保留清单并说明） */
  async function evoOpen(path) {
    showEvoView(path, "载入中… " + path, { path: path });
    try {
      var j = await get("/api/note?path=" + encodeURIComponent(path));
      showEvoView(path, j.text || "（空文件）", { path: path });
    } catch (e) {
      showEvoView(path, "无法读取该文件内容：" + e.message + "\n（该路径不在可读范围内，仅能列出文件名）", { path: path });
    }
  }

  /* ══ 页签 5：投喂（文件 → 知识库） ══
   * 数据流：拖放/选择 → POST /api/ingest（原件落 .dsh/inbox/files/ + extract.py 提取）
   *   → 可编辑识别表单 → POST /api/ingest/save 入库；或 POST /api/ingest/queue 交 DSH 深度整理。
   * 刷新/打开本页用 GET /api/ingest/list 恢复未处理的暂存件；移除用 POST /api/ingest/discard。
   */
  var ING_MAX_MB = 40;   // 客户端预检：超过直接提示「文件过大」，不做无谓的 base64 放大与传输
  /* 投喂入库的**默认**目标目录 = 长期保留区。⚠️ 默认**不是** `00-inbox`：那是用户的暂存区，
     他会定期清理 + 点「清理未使用附件」→ 投喂产出的笔记连同附件被一起清掉（实测已发生过）。
     只是**默认值**：输入框可编辑，用户仍能改成任何库内目录 ✓（绝不只读 ✗）。 */
  /* 投喂默认落点：同样以服务端 effective.ingest_default_dir 为准（见上方 effDir）；仓库不写死目录名 */
  /* 表单旁的小字说明（**逐字**口径，别改标点/空格）。 */
  function ingDirTip() {
    return "默认写入 " + ingestDefaultDir() + "/（长期保留区）；不要写到暂存目录（如 00-inbox）—— 那里会被定期清理";
  }
  /* 投喂可选扩展名（input[accept]）：**它只能限制、不能放行** —— 所以必须与后端
     server.mjs 的 KIND_BY_EXT / extract.py 的支持表**逐项对齐**：漏一项 = 把用户本来
     选得到的文件变成选不到。老格式 .doc/.xls/.ppt/.rtf 在此**显式包含**（后端会自动转换）。
     注意：accept 只约束「点击选择」对话框；**拖放不受它限制**（拖放仍走 stageFiles 原样上传）。 */
  var ING_ACCEPT = [
    ".pdf", ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls", ".xlsm", ".rtf",
    ".png", ".jpg", ".jpeg", ".jfif", ".gif", ".webp", ".bmp", ".svg", ".avif", ".ico", ".tif", ".tiff", ".heic",
    ".mp4", ".webm", ".mov", ".m4v", ".ogv", ".mkv", ".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac",
    ".md", ".markdown", ".txt", ".csv", ".tsv", ".json", ".log", ".yml", ".yaml", ".html", ".htm", ".xml", ".ini", ".cfg"
  ].join(",");
  function ingSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }
  /* kind 徽标复用进化页样式族：pdf 蓝 / 图片绿 / 文本青 / 其它黄 */
  function ingKindCls(kind) {
    if (kind === "image") return "tag";
    if (kind === "pdf") return "run";
    if (kind === "text") return "done";
    if (kind === "docx" || kind === "pptx" || kind === "xlsx") return "dir";
    return "wait";
  }
  /* ── 「深度整理」进度（用户实测痛点：「识别」看得出结果，可点了深度整理**看不出做完没有**）──
     deep 来自 GET /api/ingest/list 每项新增的字段（服务端读 `.dsh/inbox/*-ingest-*.md` 的 `- 状态：`）。
     前端**只画不编**：无任务 → 无；有三态 → 待执行 / 执行中 / 已完成。
     相位判据 evoTaskPhase **同一把尺**（0/1/2），步进器直接复用 evoTaskStepper（进化页那一套样式与文案口径）。 */
  function ingDeepPhase(d) {
    if (!d || !d.exists) return -1;                      // -1 = 还没交给 DSH（「无」）
    var s = String(d.status || "");
    return evoTaskPhase({ status: s });                  // 0 待执行 / 1 执行中 / 2 已完成
  }
  /* 状态说明一句（**口径同任务队列**：谁在做、下一步是什么），与步进器配套 */
  var ING_DEEP_NEXT = [
    "已排队，DSH 下次开工会处理",
    "DSH 正在整理…",
    "已完成 ✓"
  ];
  var ING_DEEP_LABEL = ["待执行", "执行中", "已完成"];
  function ingDeepHtml(it) {
    var d = it && it.deep;
    var ph = ingDeepPhase(d);
    var out = (d && d.output) ? String(d.output) : "";
    if (ph < 0) {
      /* 未深度整理：也给入口（按钮在下方动作区，本来就一直有）——这里说明它意味着什么 */
      return '<div class="ing-deep" data-deep="none">' +
        '<div class="im"><span class="ing-deep-lb">深度整理：</span><span class="ing-deep-st none">无</span></div>' +
        '<div class="evo-task-next">还没交给 DSH —— 点下面【让 DSH 深度整理】排队</div>' +
        '</div>';
    }
    var cls = ph === 2 ? "done" : (ph === 1 ? "run" : "wait");
    var path = out || (d && d.taskPath) || "";
    var openBtn = path
      ? '<button class="dsh-obs-btn x" data-act="ing-deep-open" data-path="' + esc(path) + '" data-kind="' + (out ? "output" : "task") + '"' +
        ' style="padding:2px 7px" title="' + esc(out ? ("打开产出笔记：" + out) : ("只读查看任务文件：" + path)) + '">' +
        (out ? "查看产出" : "查看任务") + '</button>'
      : "";
    return '<div class="ing-deep" data-deep="' + ph + '">' +
      '<div class="im"><span class="ing-deep-lb">深度整理：</span>' +
        '<span class="ing-deep-st evo-badge ' + cls + '">' + ING_DEEP_LABEL[ph] + '</span>' +
        (out ? '<span class="ing-deep-out" title="' + esc(out) + '">产出：' + esc(out) + '</span>' : "") +
        '<span class="sp" style="flex:1"></span>' + openBtn +
      '</div>' +
      evoTaskStepper(ph) +
      '<div class="evo-task-next">' + esc(ING_DEEP_NEXT[ph]) + '</div>' +
      '</div>';
  }
  function parseTagList(raw) {
    return String(raw || "").split(/[,，、;；\s]+/).map(function (s) { return s.replace(/^#/, "").trim(); }).filter(Boolean);
  }

  /* 骨架只建一次：拖放监听挂在元素上，重建会丢监听 */
  function buildIngest() {
    var p = pane("ingest");
    if (!p) return;
    if (p.getAttribute("data-built") === "1") { ingestBuilt = true; return; }
    p.setAttribute("data-built", "1");
    p.innerHTML =
      '<div class="dsh-obs-drop" data-act="ing-pick" title="松手即上传识别">' +
        '<b>📥 投喂入库</b>' +
        '拖入 PDF / PPT / 图片 / Office 文件，或点击选择' +
        '<div class="hint">单文件 ≤ ' + ING_MAX_MB + 'MB · 图片不抽文本（可交 DSH 多模态识别）</div>' +
        '<div class="hint">老格式（.doc / .xls / .ppt / .rtf）会自动先转换后识别；转换失败会在识别结果里写明原因</div>' +
        '<div class="hint ing-deep-tip">深度整理由 DSH 执行：点后先排队，DSH 下次开工处理；本页会自动刷新状态</div>' +
      '</div>' +
      '<input class="ing-file" type="file" multiple hidden accept="' + ING_ACCEPT + '" />' +
      '<div class="dsh-obs-ing-sec">📦 待处理 ' +
        '<span class="ing-n line" style="margin:0"></span><span class="sp" style="flex:1"></span>' +
        '<button class="dsh-obs-btn x" data-act="ing-refresh" title="重新拉取 .dsh/inbox/files/ 清单">↻</button>' +
      '</div>' +
      '<div class="line ing-stat">载入中…</div>' +
      /* 统计 + 孤儿清理入口：统计「暂存 N 个 · 回收区 M 个」；清理按钮**先只读对账再确认**，绝不直接动手 */
      '<div class="dsh-obs-tool" style="margin:2px 0 4px">' +
        '<span class="ing-stat2 line" style="margin:0;font-size:10.5px">暂存 — 个 · 回收区 — 个</span>' +
        '<span class="sp" style="flex:1"></span>' +
        '<button class="dsh-obs-btn x" data-act="ing-reconcile" title="只读对账：找出既没被笔记引用、也不在投喂待处理列表里的暂存件（含派生图），确认后才移入回收区">🧹 清理孤儿暂存</button>' +
      '</div>' +
      '<div class="line ing-orphan" hidden></div>' +
      '<div class="ing-list"><div class="dsh-obs-empty">载入中…</div></div>' +
      '<div class="ing-formbox"></div>' +
      '<div class="dsh-obs-ing-sec">🗑️ 回收区 ' +
        '<span class="ing-tn line" style="margin:0"></span><span class="sp" style="flex:1"></span>' +
        '<button class="dsh-obs-btn x" data-act="ing-trash-tgl" title="展开 / 收起回收区">▸</button>' +
      '</div>' +
      '<div class="ing-trash" hidden></div>';
    ingestBuilt = true;
    var input = p.querySelector(".ing-file");
    if (input) input.addEventListener("change", function () {
      var fl = input.files;
      if (fl && fl.length) stageFiles(fl);
      input.value = "";
    });
  }

  function renderIngestList() {
    if (!ingestBuilt || !panelEl) return;
    var p = pane("ingest");
    if (!p) return;
    var list = p.querySelector(".ing-list"), n = p.querySelector(".ing-n"), stat = p.querySelector(".ing-stat");
    if (!list) return;
    var items = state.ingest.list || [];
    if (n) n.textContent = items.length ? items.length + " 个" : "";
    if (stat) {
      if (state.ingest.err) {
        stat.className = "line ing-stat bad";
        stat.textContent = "暂存清单载入失败：" + state.ingest.err + "（可点 ↻ 重试）";
      } else if (state.ingest.stat) {
        stat.className = "line ing-stat";
        stat.textContent = state.ingest.stat;
      } else {
        stat.className = "line ing-stat";
        stat.textContent = items.length
          ? "共 " + items.length + " 个暂存原件（.dsh/inbox/files/）。点【识别】生成可编辑表单，或直接交 DSH 深度整理。"
          : "暂无待处理文件。拖入 PDF / PPT / 图片 / Office 文件开始。";
      }
    }
    list.innerHTML = items.length ? items.map(function (it) {
      var res = state.ingest.res[it.id];
      var kind = (res && res.kind) || it.kind || "unknown";
      var cur = state.ingest.cur === it.id;
      /* 图片数**只来自** /api/ingest 的 images（识别过才有）；取不到就不显示 ✗ 不编 */
      var imgN = res && Array.isArray(res.images) ? res.images.length : 0;
      return '<div class="dsh-obs-item' + (cur ? " on" : "") + '">' +
        '<div class="it">' + esc(it.name) + '</div>' +
        '<div class="ip">' + esc(it.id) + '</div>' +
        '<div class="im">' +
          '<span class="evo-badge ' + ingKindCls(kind) + '">' + esc(kind) + '</span>' +
          '<span>' + esc(ingSize(it.bytes)) + '</span>' +
          (imgN ? '<span title="识别到 ' + imgN + ' 张内嵌图片（点「识别」可在下方看缩略图）">' + imgN + ' 张图</span>' : "") +
          '<span>' + esc(relTime(it.mtimeMs)) + '</span>' +
          (res && res.error ? '<span class="evo-badge wait" title="' + esc(res.error) + '">提取失败</span>' : "") +
          '<span style="flex:1"></span>' +
          '<button class="dsh-obs-btn x" data-act="ing-recognize" data-id="' + esc(it.id) + '" style="padding:2px 7px" title="即时打底：提取文本 + 猜标题/标签">识别</button>' +
          '<button class="dsh-obs-btn x" data-act="ing-queue" data-id="' + esc(it.id) + '" style="padding:2px 7px" title="写入 .dsh/inbox/ 交 DSH 异步深度整理">让 DSH 深度整理</button>' +
          '<button class="dsh-obs-btn x danger" data-act="ing-discard" data-id="' + esc(it.id) + '" style="padding:2px 7px">移除</button>' +
        '</div>' + ingDeepHtml(it) + '</div>';
    }).join("") : '<div class="dsh-obs-empty">暂无待处理文件（.dsh/inbox/files/ 为空）</div>';
    renderIngestStats(); renderIngestOrphan(); renderIngestTrash();   // 统计 / 孤儿提示条 / 回收区 随清单一起刷新
  }

  /* ── 识别结果里的「内嵌图片」只读展示 + 「文字层极薄」提醒 ──
     缩略图字节走服务端只读接口 GET /api/ingest/thumb?path=<.dsh/inbox/files/ 内的派生图>；
     这里只显示与放大，**没有任何编辑 / 删除图片的入口** ✗。 */
  /* ── 缩略图路径口径（**用户实测教训**）──
     ① **URL 必须是绝对地址**（`BASE + "/api/ingest/thumb?…"`）：
        面板 DOM 的文档源不是桥接服务（DSH 渲染端是 `dsh-app://`，Web GUI 下是 DSH 自己的 http 源），
        写成裸相对路径 `/api/ingest/thumb?…` 会被解析到**文档源**上（不是 127.0.0.1:8777）→
        `<img>` 全是坏图，而卡片上的文件名/页码/字节数照样显示 —— 用户看到的就是
        「**图片在文件夹里看得到，缩略图里只有路径**」✗。fetch 走的是 `BASE + path`，
        图片 URL 也必须一样（本文件里 `mediaSrc` 的 `/api/raw` 就是这么写的，照抄它 ✓）。
     ② extract.py 的 `images[].file` 是**绝对路径**（如 `X:\<vault>\.dsh\inbox\files\<原名>__img02.jpg`）；
        服务端 thumb 接口按「**解析后必须落在暂存目录内**」放行，绝对 / 相对**两种都收**。
     ③ 前端**优先用 `rel`**（服务端新增：相对暂存目录，如 `课件__img02.jpg`）——URL 里不带盘符 / 用户名，
        换 vault 盘符也不失效；老后端 / 老数据没有 rel 时**退回 file**（绝对路径），照样能取到图 ✓（向前兼容）。 */
  function ingImgPath(im) {
    if (im && typeof im === "object") return String(im.rel || im.file || "");
    return String(im == null ? "" : im);
  }
  function ingImgName(im) {
    return ingImgPath(im).replace(/\\/g, "/").split("/").pop() || "";
  }
  function ingThumbUrl(im) { return BASE + "/api/ingest/thumb?path=" + encodeURIComponent(ingImgPath(im)); }
  /* 「文字层极薄」判据（**命中才提示，不命中不常驻**）：
       pages = 总页数（PDF 才有）；chars = 正文非空白字符数；sN = 疑似扫描页数
       A) 疑似扫描页 ≥ 总页数一半（sN*2 >= pages）—— 逐页扫描的最直接证据
       B) 平均每页非空白字符 < 40（含 0）—— 整篇没有可读文字层
     两条任一命中即提示；阈值 40 的依据：正常正文页是数百~数千字/页，
     40 远低于"任何正常页"，只落在扫描件/图片页的噪声区间（页码 / 页眉）。
     页数拿不到时（非 PDF / 提取失败）→ **不显示**（不猜 ✗）。 */
  var ING_THIN_CHARS_PER_PAGE = 40;
  var ING_THIN_TEXT = "⚠️ 本文件文字层极薄（知识应在图片里）→ 建议点【让 DSH 深度整理】；\n" +
    "直接「加入知识库」会得到一篇近乎空的笔记。";
  function ingThin(r) {
    if (!r || r.error || r.kind === "image") return null;   // 图片另有专门提示，不重复
    var pages = Number((r.meta && r.meta.pages) || 0);
    if (!(pages > 0)) return null;
    /* 疑似扫描页：优先用顶层 suspectScan；老后端只回 meta.suspectScanPages 时兜底（两处同源） */
    var sus = Array.isArray(r.suspectScan) ? r.suspectScan
      : (r.meta && Array.isArray(r.meta.suspectScanPages) ? r.meta.suspectScanPages : []);
    var sN = sus.length;
    var chars = String(r.text || "").replace(/\s+/g, "").length;
    var byScan = sN > 0 && sN * 2 >= pages;
    var byChars = chars / pages < ING_THIN_CHARS_PER_PAGE;
    if (!byScan && !byChars) return null;
    return { pages: pages, chars: chars, sN: sN, per: Math.round((chars / pages) * 10) / 10, byScan: byScan, byChars: byChars };
  }
  function ingThinHtml(r) {
    var t = ingThin(r);
    if (!t) return "";
    var ev = "判据：" + (t.byScan ? "疑似扫描页 " + t.sN + "/" + t.pages + " 页（≥ 一半）" : "") +
      (t.byScan && t.byChars ? "；" : "") +
      (t.byChars ? "正文非空白字符 " + t.chars + "（" + t.per + " 字/页，阈值 < " + ING_THIN_CHARS_PER_PAGE + "）" : "");
    return '<div class="dsh-obs-ing-thin">' +
      '<div class="thin-t">' + esc(ING_THIN_TEXT) + "</div>" +
      '<div class="thin-ev">' + esc(ev) + "</div></div>";
  }
  function ingImageSection(r) {
    var imgs = Array.isArray(r.images) ? r.images : [];
    var sk = Array.isArray(r.imagesSkipped) ? r.imagesSkipped : [];
    if (!imgs.length && !sk.length) return "";
    var html = '<div class="dsh-obs-ing-imgs">' +
      '<div class="ih">📷 内嵌图片（共 ' + imgs.length + ' 张）' +
      (imgs.length ? '<span class="hint">点缩略图看大图 · 只读展示（原字节直出，未重编码）</span>' : "") + "</div>";
    if (imgs.length) {
      html += '<div class="ing-thumbs">' + imgs.map(function (im) {
        var nm = ingImgName(im) || "（文件名缺失）";
        var pg = im && im.page != null ? im.page : "?";
        var dim = im && im.w != null && im.h != null ? im.w + "×" + im.h : "尺寸未知";
        var by = im && im.bytes != null ? ingSize(im.bytes) : "字节数未知";
        var cap = nm + " · 第 " + pg + " 页 · " + dim + " · " + by;
        return '<div class="ing-thumb" data-act="ing-img-zoom" data-src="' + esc(ingThumbUrl(im)) +
          '" data-cap="' + esc(cap) + '" title="' + esc(cap + "（点击放大）") + '">' +
          '<img src="' + esc(ingThumbUrl(im)) + '" alt="' + esc(nm) + '" loading="lazy" />' +
          '<div class="fn">' + esc(nm) + "</div>" +
          '<div class="mt">第 ' + esc(pg) + " 页 · " + esc(dim) + " · " + esc(by) + "</div>" +
          (im && im.likelyWatermark
            ? '<span class="ing-wm" title="疑似水印：每页重复 logo/印章 或面积过小；只标记，不删除">⚠️likelyWatermark</span>' : "") +
          "</div>";
      }).join("") + "</div>";
    }
    if (sk.length) html += ingSkipHtml(r);
    return html + "</div>";
  }
  /* 「跳过 N 个图像流」清单（可展开）：单独成函数，是为了展开/收起时**只换这一块**，
     不重画整个表单 —— 否则用户已经改过的标题 / 标签 / 正文会被 r.* 覆盖回去 ✗ */
  function ingSkipHtml(r) {
    var sk = r && Array.isArray(r.imagesSkipped) ? r.imagesSkipped : [];
    if (!sk.length) return "";
    return '<div class="ing-skip">' +
      '<div class="sk-h" data-act="ing-skip-tgl" title="展开 / 收起被跳过的图像流（页号 + 类型 + 原因）">' +
        "<span>" + (state.ingest.skipOpen ? "▾" : "▸") + "</span>" +
        "<span>跳过 " + sk.length + " 个图像流（未抽出）</span>" +
        '<span class="hint">' + (state.ingest.skipOpen ? "收起" : "展开看页号 / 原因") + "</span></div>" +
      (state.ingest.skipOpen
        ? "<ul>" + sk.map(function (s) {
            return "<li>第 " + esc(s && s.page != null ? s.page : "?") + " 页 · " +
              esc((s && s.kind) || "未知类型") + " · " + esc((s && s.reason) || "（未给原因）") + "</li>";
          }).join("") + "</ul>"
        : "") +
      "</div>";
  }
  /* 点缩略图 → 面板内浮层看大图（只读；点任意处 / Esc / 「关闭」收起） */
  function renderIngestZoom() {
    if (!panelEl) return;
    var el = panelEl.querySelector(".ing-zoom");
    var src = state.ingest.zoomSrc;
    if (!src) { if (el) el.hidden = true; return; }
    if (!el) {
      el = document.createElement("div");
      el.className = "ing-zoom";
      el.setAttribute("data-act", "ing-img-close");
      el.innerHTML = '<div class="zc"></div><img alt="" />' +
        '<button class="zb" data-act="ing-img-close">关闭 ✕</button>';
      panelEl.appendChild(el);
    }
    var img = el.querySelector("img"), cap = el.querySelector(".zc");
    if (img) { img.setAttribute("src", src); img.setAttribute("alt", state.ingest.zoomCap || "内嵌图片"); }
    if (cap) cap.textContent = state.ingest.zoomCap || "";
    el.hidden = false;
  }
  function closeIngestZoom() {
    state.ingest.zoomSrc = "";
    state.ingest.zoomCap = "";
    renderIngestZoom();
  }

  /* 识别结果 → 可编辑表单（标题/标签/摘要/目录/正文；图片不显示正文框） */
  function renderIngestForm(r) {
    if (!ingestBuilt || !panelEl) return;
    var p = pane("ingest");
    if (!p) return;
    var box = p.querySelector(".ing-formbox");
    if (!box) return;
    closeIngestZoom();   // 每次重画识别结果都把「看大图」浮层收起来（不留上一份文件的图）
    if (state.ingest.lastNote) {
      box.innerHTML = '<div class="dsh-obs-ing-done">✅ 已加入知识库：' + esc(state.ingest.lastNote) +
        '<div class="dsh-obs-tool" style="margin:6px 0 0">' +
          '<button class="dsh-obs-btn primary" data-act="ing-open-note" data-path="' + esc(state.ingest.lastNote) + '">打开该笔记</button>' +
          '<button class="dsh-obs-btn" data-act="ing-form-close">继续投喂</button>' +
        '</div></div>';
      return;
    }
    if (!r) { box.innerHTML = ""; return; }
    var g = r.guess || {};
    var isImg = r.kind === "image";
    box.innerHTML =
      '<div class="dsh-obs-ing-form">' +
        '<div class="line" style="margin:0 0 6px">识别结果：<b>' + esc(r.name) + '</b> · ' + esc(r.kind || "unknown") +
          ' · ' + esc(ingSize(r.bytes)) + (r.truncated ? ' · 已截断' : "") + '</div>' +
        ingThinHtml(r) +
        (r.convertedFrom
          ? '<div class="dsh-obs-ing-note">老格式已自动转换：.' + esc(r.convertedFrom) + ' → ' + esc(r.kind || "?") +
            ' · ' + esc((r.convert && r.convert.tool) || "libreoffice") +
            (r.convert && r.convert.ms ? ' · ' + Math.round(r.convert.ms) + ' ms' : "") +
            '。原文件未改动（转换只在临时目录里做）。</div>'
          : "") +
        (r.error ? '<div class="dsh-obs-ing-note">提取失败：' + esc(r.error) + '（仍可手填标题/正文后入库，或点【让 DSH 深度整理】交给 DSH）</div>' : "") +
        '<div class="fr"><span class="lb">标题</span><input class="dsh-obs-in ing-title" value="' + esc(g.title || "") + '" /></div>' +
        '<div class="fr"><span class="lb">标签</span><input class="dsh-obs-in ing-tags" placeholder="逗号分隔，如 金融, 关键词" value="' + esc((g.tags || []).join(", ")) + '" /></div>' +
        '<div class="fr"><span class="lb">摘要</span><input class="dsh-obs-in ing-sum" placeholder="可空；填写后写入正文引文块" /></div>' +
        '<div class="fr"><span class="lb">目标目录</span><input class="dsh-obs-in ing-folder" value="' + esc(ingestDefaultDir()) + '" /></div>' +
        '<div class="dsh-obs-ing-note ing-dir-tip">' + esc(ingDirTip()) + '</div>' +
        (isImg
          ? '<div class="dsh-obs-ing-note">图片不抽文本 —— 建议点【让 DSH 深度整理】，由 DSH 多模态识别后入库。</div>'
          : '<textarea class="dsh-obs-ing-body" spellcheck="false" placeholder="正文（预填提取文本，可自由编辑）"></textarea>' +
            (r.truncated ? '<div class="dsh-obs-ing-note">内容过长已截断，原文件已归档。</div>' : "")) +
        ingImageSection(r) +
        '<div class="dsh-obs-tool" style="margin:6px 0 0">' +
          '<button class="dsh-obs-btn primary" data-act="ing-save">加入知识库</button>' +
          '<button class="dsh-obs-btn" data-act="ing-form-close">取消</button>' +
          '<span class="sp" style="flex:1"></span>' +
          '<button class="dsh-obs-btn" data-act="ing-queue" data-id="' + esc(state.ingest.cur) + '" title="不即时入库，交 DSH 深度整理">让 DSH 深度整理</button>' +
        '</div>' +
      '</div>';
    var ta = box.querySelector(".dsh-obs-ing-body");
    if (ta) ta.value = r.text || "";   // 用 value 赋值：正文不进 HTML，避免转义/注入问题
    renderIngestZoom();                 // 缩略图浮层（上面 closeIngestZoom 已收起上一份；这里是同一函数，幂等）
  }

  function openIngestForm(id) {
    state.ingest.cur = id || "";
    state.ingest.lastNote = "";
    renderIngestForm(id ? state.ingest.res[id] : null);
    renderIngestList();
  }
  function closeIngestForm() {
    state.ingest.cur = "";
    state.ingest.lastNote = "";
    renderIngestForm(null);
    renderIngestList();
  }

  async function loadIngest(force) {
    buildIngest();
    var p = pane("ingest");
    if (!p) return;
    if (state.ingest.list && !force) { renderIngestList(); return; }
    try {
      var j = await get("/api/ingest/list");
      state.ingest.list = j.items || [];
      state.ingest.err = "";
    } catch (e) {
      state.ingest.err = e.message;
      if (state.ingest.list === null) state.ingest.list = [];
    }
    renderIngestList();
    loadIngestTrash();      // 回收区 + 统计（只读 GET /api/ingest/trash/list）
    autoReconcile();        // 打开投喂页自动**只读**对账（GET + dry=1；绝不自动移文件 ✗）
  }

  /* ── 上传：FileReader → base64（去掉 data: 前缀）→ POST /api/ingest ── */
  function readFileB64(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var s = String(fr.result || ""), i = s.indexOf(",");
        resolve(i < 0 ? s : s.slice(i + 1));
      };
      fr.onerror = function () { reject(new Error("读取文件失败")); };
      fr.readAsDataURL(file);
    });
  }
  async function stageFiles(files) {
    var arr = [], i;
    for (i = 0; i < (files ? files.length : 0); i++) arr.push(files[i]);
    if (!arr.length) return;
    if (state.tab !== "ingest") setTab("ingest");
    var okN = 0, badN = 0;
    for (i = 0; i < arr.length; i++) {
      var f = arr[i];
      var name = f.name || ("file-" + (i + 1));
      if (f.size > ING_MAX_MB * 1024 * 1024) {
        badN++;
        toast("文件过大：" + name + "（" + ingSize(f.size) + "，上限 " + ING_MAX_MB + "MB）——可拆小，或用【让 DSH 深度整理】绕过面板直传", "bad");
        continue;
      }
      state.ingest.stat = "上传识别中 " + (i + 1) + "/" + arr.length + "：" + name;
      renderIngestList();
      try {
        var b64 = await readFileB64(f);
        var r = await post("/api/ingest", { name: name, dataB64: b64 });
        state.ingest.res[r.id] = r;
        state.ingest.cur = r.id;
        state.ingest.lastNote = "";
        okN++;
      } catch (e) {
        badN++;
        toast("上传失败：" + name + " —— " + e.message, "bad");
      }
    }
    state.ingest.stat = "";
    await loadIngest(true);
    if (okN) {
      renderIngestForm(state.ingest.res[state.ingest.cur]);
      toast("已识别 " + okN + " 个文件" + (badN ? "（" + badN + " 个失败）" : "") + "，核对下方表单后点【加入知识库】", "ok");
    }
  }

  /* ── 【识别】：有结果直接用；刷新过的暂存件用 {id} 让服务端重新提取（不重复落盘） ── */
  async function recognizeIngest(id, btn) {
    if (!id) return;
    if (state.ingest.res[id]) return openIngestForm(id);
    if (btn) { btn.disabled = true; btn.textContent = "识别中…"; }
    try {
      var r = await post("/api/ingest", { id: id });
      state.ingest.res[r.id] = r;
      openIngestForm(r.id);
    } catch (e) {
      toast("识别失败：" + e.message, "bad");
    } finally {
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "识别"; }
    }
  }

  /* ── 【加入知识库】 ── */
  async function saveIngest() {
    var p = pane("ingest");
    if (!p) return;
    var id = state.ingest.cur, r = id ? state.ingest.res[id] : null;
    if (!id || !r) return toast("请先点【识别】生成表单", "bad");
    var title = (p.querySelector(".ing-title").value || "").trim();
    if (!title) return toast("请填写标题", "bad");
    var ta = p.querySelector(".dsh-obs-ing-body");
    var body = {
      id: id,
      title: title,
      tags: parseTagList(p.querySelector(".ing-tags").value),
      summary: (p.querySelector(".ing-sum").value || "").trim(),
      /* 用户没填就用同一个默认（与表单预填**同一把尺**，且绝不是暂存目录） */
      folder: (p.querySelector(".ing-folder").value || "").trim() || ingestDefaultDir(),
      body: r.kind === "image" ? "" : (ta ? ta.value : ""),   // 图片不抽正文，仅归档原件
      linkOriginal: true
    };
    var btn = p.querySelector('[data-act="ing-save"]');
    if (btn) { btn.disabled = true; btn.textContent = "入库中…"; }
    try {
      var res = await post("/api/ingest/save", body);
      state.ingest.lastNote = res.note || "";
      delete state.ingest.res[id];
      state.ingest.cur = "";
      /* 图片带入的**一句轻提示**（不做弹窗、不打断）：带了几张 / 跳过几张 / 有没有没复制成功的。
         数量来自后端 imagesCopied / imagesSkippedWatermark / imagesFailed；
         复制失败的**逐张原因**后端已写进笔记附录 —— 这里如实提示，不静默 ✗ */
      var nC = Number(res.imagesCopied || 0), nW = Number(res.imagesSkippedWatermark || 0), nF = Number(res.imagesFailed || 0);
      var imgMsg = "";
      if (nC) imgMsg = " · 已带入 " + nC + " 张图的引用" + (nW ? "（另有 " + nW + " 张水印/装饰已跳过）" : "");
      else if (nW) imgMsg = " · 未带入图片（" + nW + " 张水印/装饰已跳过）";
      if (nF) imgMsg += " · ⚠️ " + nF + " 张没复制成功（原因见笔记附录）";
      toast("已加入知识库：" + (res.note || "") + (res.attachment ? " · 原件归档 " + res.attachment : "") + imgMsg, nF ? "bad" : "ok");
      renderIngestForm(null);
      invalidateIndex();          // 让笔记页/阅读视图认到新笔记与附件
      await loadIngest(true);
    } catch (e) {
      toast("入库失败：" + e.message, "bad");
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "加入知识库"; }
    }
  }

  /* ── 【让 DSH 深度整理】：写任务文件到 .dsh/inbox/ ── */
  async function queueIngest(id, btn) {
    if (!id) return;
    if (btn) { btn.disabled = true; btn.textContent = "排队中…"; }
    try {
      var p = pane("ingest"), note = "";
      if (p && state.ingest.cur === id) {          // 表单里的摘要顺带作为用户备注
        var s = p.querySelector(".ing-sum");
        if (s) note = (s.value || "").trim();
      }
      var r = await post("/api/ingest/queue", { id: id, note: note });
      toast("已排入 .dsh/inbox/，DSH 处理后会写入知识库（任务：" + r.task + "）", "ok");
      /* 状态化反馈：立刻重拉清单（该项的 deep 变「待执行」并出现步进器）——
         非破坏式（成功才替换 state），随后按新状态决定是否开 10s 轮询（复用 evoPoll 那一套）。 */
      await loadIngest(true);
      evoPollSync();
    } catch (e) {
      toast("排入失败：" + e.message, "bad");
    } finally {
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "让 DSH 深度整理"; }
    }
  }

  /* ── 【移除】暂存原件（面板内确认条，不用 window.confirm） ── */
  function discardIngest(id) {
    if (!id) return;
    askConfirm("移除暂存原件「" + id + "」？（只删 .dsh/inbox/files/ 里的这份，不影响已入库笔记）", async function () {
      try {
        var r = await api("/api/ingest/discard", { method: "POST", body: { id: id } });
        delete state.ingest.res[id];
        if (state.ingest.cur === id) closeIngestForm();
        toast("已移除：" + (r.deleted || id), "ok");
        await loadIngest(true);
      } catch (e) {
        toast("移除失败：" + e.message, "bad");
      }
    }, "移除");
  }

  /* ── 暂存孤儿对账 + 回收区 ──
     用户原话：「在笔记里删除了这个文件，就把存在 .dsh/inbox/files 里的相关文件都删了」——
     后端只做**对账**：孤儿（原件 + 它的派生图）rename 进 .dsh/inbox/trash/<日期>/，绝不硬删；
     真删只有「彻底清理」一个入口且必须二次确认。前端三态：
       ① 打开投喂页 → **GET** /api/ingest/reconcile?dry=1（只读，绝不自动清理 ✗）→ 有孤儿才出提示条；
       ② 点【清理孤儿暂存】→ **先再跑一次 dry** → askConfirm（列数量 + 理由摘要）→ 确认后才 POST 真清理；
       ③ 回收区展开 → 逐条【恢复】/ 整体【彻底清理(>30天)】（后者二次确认）。 */
  function ingReconSummary(j) {
    var n = (j && j.orphans ? j.orphans.length : 0);
    var no = (j && j.orphans ? j.orphans : []).filter(function (o) { return o.kind === "original"; }).length;
    if (!n) return "没发现孤儿暂存（扫描 " + ((j && j.scanned) || 0) + " 个：原件 " + ((j && j.originals) || 0) +
      " / 派生图 " + ((j && j.derived) || 0) + "）";
    return "发现 " + n + " 个孤儿暂存（原件 " + no + " + 派生图 " + (n - no) + "）：都没被笔记引用、也不在投喂待处理列表里";
  }
  function renderIngestOrphan() {
    var p = pane("ingest"); if (!p) return;
    var el = p.querySelector(".ing-orphan"); if (!el) return;
    if (state.ingest.reconErr) {
      el.hidden = false;
      el.innerHTML = '<span>⚠️ 只读对账失败：' + esc(state.ingest.reconErr) + '（不影响投喂，可重试）</span><span class="sp"></span>' +
        '<button class="dsh-obs-btn x" data-act="ing-reconcile">重试</button>';
      return;
    }
    var o = state.ingest.orphan;
    if (!o || !(o.orphans || []).length) { el.hidden = true; el.innerHTML = ""; return; }   // 没孤儿 → 提示条不常驻
    el.hidden = false;
    el.innerHTML = '<span>' + esc(ingReconSummary(o)) + '</span><span class="sp"></span>' +
      '<button class="dsh-obs-btn x" data-act="ing-reconcile" title="先只读对账、再弹确认，确认后才移入回收区">一键清理</button>';
  }
  /* 统计一行：暂存 N 个（= /api/ingest/list 的原件数）· 回收区 M 个（= 回收区文件数） */
  function renderIngestStats() {
    var p = pane("ingest"); if (!p) return;
    var el = p.querySelector(".ing-stat2"); if (!el) return;
    var nStaged = (state.ingest.list || []).length;
    var t = state.ingest.trash;
    el.textContent = "暂存 " + nStaged + " 个 · 回收区 " + (t ? Number(t.count || 0) : "—") + " 个";
  }
  function renderIngestTrash() {
    var p = pane("ingest"); if (!p) return;
    var box = p.querySelector(".ing-trash"), tn = p.querySelector(".ing-tn");
    if (!box) return;
    var t = state.ingest.trash;
    var n = t ? Number(t.count || 0) : 0;
    if (tn) tn.textContent = t ? (n ? "共 " + n + " 个文件 · " + (t.dirCount || 0) + " 个日期目录" : "空") : "";
    var tgl = p.querySelector('[data-act="ing-trash-tgl"]');
    if (tgl) tgl.textContent = state.ingest.trashOpen ? "▾" : "▸";
    box.hidden = !state.ingest.trashOpen;
    if (!state.ingest.trashOpen) { box.innerHTML = ""; return; }
    if (!t) { box.innerHTML = '<div class="dsh-obs-empty">回收区载入中…</div>'; return; }
    if (!n) { box.innerHTML = '<div class="dsh-obs-empty">回收区是空的（清理孤儿后的文件先放这里，可恢复、不真删）</div>'; return; }
    var keep = t.keepDays || 30;
    var html = '<div class="dsh-obs-tool">' +
      '<span class="line" style="margin:0;font-size:10.5px">保留 ' + keep + ' 天；【彻底清理】只删已过期的日期目录（唯一真删入口）</span>' +
      '<span class="sp" style="flex:1"></span>' +
      '<button class="dsh-obs-btn x danger" data-act="ing-trash-purge">彻底清理(&gt;' + keep + '天)</button>' +
      '</div>';
    html += (t.dirs || []).map(function (d) {
      return '<div class="tg-dir">' + esc(d.date) + ' · ' + d.count + ' 个 · ' + esc(ingSize(d.bytes)) +
        (d.report ? ' · 有对账报告' : '') + (d.purgeDefault ? ' · <span class="evo-badge wait">已过期</span>' : '') + '</div>' +
        (d.files || []).map(function (f) {
          return '<div class="tg-f"><span class="nm" title="' + esc(f.name) + '">' + esc(f.name) + '</span>' +
            '<span class="sz">' + esc(ingSize(f.bytes)) + '</span>' +
            '<button class="dsh-obs-btn x" data-act="ing-trash-restore" data-dir="' + esc(d.date) + '" data-file="' + esc(f.name) + '">恢复</button></div>';
        }).join("");
    }).join("");
    box.innerHTML = html;
  }
  async function loadIngestTrash() {
    try { state.ingest.trash = await get("/api/ingest/trash/list"); }
    catch (e) { /* 回收区读不到不影响暂存清单：统计显示「—」，展开时也如实说明 */ }
    renderIngestStats(); renderIngestTrash();
  }
  /* 打开投喂页的**只读**对账：GET + dry=1（GET 天然不可能移文件）。绝不自动清理 ✗ */
  async function autoReconcile() {
    if (state.ingest.reconRunning) return;
    state.ingest.reconRunning = true;
    try {
      state.ingest.orphan = await get("/api/ingest/reconcile?dry=1");
      state.ingest.reconErr = "";
    } catch (e) { state.ingest.reconErr = e.message; }
    state.ingest.reconRunning = false;
    renderIngestOrphan();
  }
  /* 点【清理孤儿暂存】：先 dry 对账 → 轻确认 → 才真清理（顺序不可颠倒） */
  async function cleanOrphans(btn) {
    if (btn) { btn.disabled = true; btn.textContent = "对账中…"; }
    var j = null;
    try { j = await get("/api/ingest/reconcile?dry=1"); }
    catch (e) {
      toast("对账失败：" + e.message, "bad");
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "🧹 清理孤儿暂存"; }
      return;
    }
    state.ingest.orphan = j; state.ingest.reconErr = "";
    renderIngestOrphan();
    if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "🧹 清理孤儿暂存"; }
    var n = (j.orphans || []).length;
    if (!n) return toast(ingReconSummary(j), "ok");
    var sample = (j.orphans || []).slice(0, 3).map(function (o) { return o.file; }).join("、");
    askConfirm("清理 " + n + " 个孤儿暂存？" + ingReconSummary(j) + "。示例：" + sample + (n > 3 ? " 等" : "") +
      "。将移入 .dsh/inbox/trash/（可恢复，不会真删）", async function () {
      try {
        var r = await api("/api/ingest/reconcile", { method: "POST", body: { dry: false } });
        toast("已移入回收区 " + ((r.trashed || []).length) + " 个" + (r.reportPath ? "（对账报告：" + r.reportPath + "）" : ""), "ok");
        state.ingest.orphan = null;                 // 清完 → 重新拉清单时会再跑一次只读对账
        await loadIngest(true);
        await loadIngestTrash();
      } catch (e) { toast("清理失败：" + e.message, "bad"); }
    }, "清理");
  }
  async function restoreTrashFile(dir, file, btn) {
    if (!file) return;
    if (btn) { btn.disabled = true; btn.textContent = "恢复中…"; }
    try {
      var r = await post("/api/ingest/trash/restore", { file: (dir ? dir + "/" : "") + file });
      toast("已恢复 " + ((r.restored || []).length) + " 个到暂存目录（" + file + "）", "ok");
      await loadIngestTrash();
      await loadIngest(true);
    } catch (e) {
      toast("恢复失败：" + e.message, "bad");
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "恢复"; }
    }
  }
  function purgeIngestTrash() {
    var t = state.ingest.trash || {};
    var keep = t.keepDays || 30;
    askConfirm("彻底清理回收区？将**真删**回收区里超过 " + keep + " 天的日期目录（不可恢复）。" +
      "这是唯一真删入口，需要你明确确认。", async function () {
      try {
        var r = await api("/api/ingest/trash/purge", { method: "POST", body: { olderThanDays: keep } });
        toast("已彻底清理 " + (r.removedDirs || 0) + " 个目录 / " + (r.removedFiles || 0) + " 个文件", "ok");
        await loadIngestTrash();
      } catch (e) { toast("彻底清理失败：" + e.message, "bad"); }
    }, "彻底清理");
  }

  /* ── 面板内拖放：只接管「拖文件」，不干扰面板里的文本拖放 ── */
  function hasFileDrag(e) {
    var t = e && e.dataTransfer && e.dataTransfer.types;
    if (!t) return false;
    for (var i = 0; i < t.length; i++) if (String(t[i]) === "Files") return true;
    return false;
  }
  function ingestDropzone() {
    return state.tab === "ingest" ? qs(".dsh-obs-pane[data-pane='ingest'] .dsh-obs-drop") : null;
  }
  function onPanelDragOver(e) {
    if (!panelEl || !hasFileDrag(e)) return;      // 文本拖放交给浏览器默认行为
    e.preventDefault();                          // 必须 preventDefault，否则 Electron 会直接打开文件
    try { if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; } catch (err) {}
    var dz = ingestDropzone();
    if (dz) dz.classList.add("on");
  }
  function onPanelDragLeave(e) {
    var dz = ingestDropzone();
    if (!dz) return;
    if (e && e.relatedTarget && panelEl && panelEl.contains(e.relatedTarget)) return;   // 还在面板内部，不取消高亮
    dz.classList.remove("on");
  }
  function onPanelDrop(e) {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    var dz = ingestDropzone();
    if (dz) dz.classList.remove("on");
    var dt = e.dataTransfer, fl = dt ? dt.files : null;
    if (!fl || !fl.length) return;
    if (state.tab !== "ingest") setTab("ingest");
    stageFiles(fl);
  }

  /* ══ 页签切换 ══
     两条硬规则（实机反馈）：
      · 新建态下点任何页签（含点「编辑」页签本身）都算离开新建态 → 先过 guardLeaveNewNote：
        标题/正文已填则弹「放弃未保存的新笔记？」（取消 → 仍留在新建态，内容不丢）；没填则直接退出。
      · 「笔记」页签 = 笔记列表视图：从回收站视图切回来时自动退出回收站（不再必须点「← 返回笔记」）；
        「编辑」页签 = 常规编辑态（renderEdit 会按 data-new 判定是否重建，绝不残留新建表单）。 */
  function setTab(name) {
    if (state.newNote && !guardLeaveNewNote(function () { setTab(name); })) return;
    state.tab = name;
    if (!panelEl) return;
    if (name !== "evo" && name !== "ingest") evoPollStop();   // 切到别的页签 → 停自动刷新（切回时 loadEvo / loadIngest 会立刻补拉并按新状态续跑）
    closeDirMove();     // 结构页的「移动」浮层不跨页签残留
    var panes = panelEl.querySelectorAll(".dsh-obs-pane");
    for (var i = 0; i < panes.length; i++) panes[i].hidden = panes[i].getAttribute("data-pane") !== name;
    var tabs = panelEl.querySelectorAll(".dsh-obs-tab");
    for (var k = 0; k < tabs.length; k++) tabs[k].className = "dsh-obs-tab" + (tabs[k].getAttribute("data-tab") === name ? " on" : "");
    if (name === "notes") {
      if (!notesBuilt) buildNotes();
      if (state.trash.view) applyTrashView(false);   // 页签回「笔记」→ 一律落在列表（回收站视图退出）
      loadIndex(false);
    }
    else if (name === "edit") renderEdit(false);
    else if (name === "struct") loadStruct(false);
    else if (name === "evo") loadEvo();
    else if (name === "ingest") { buildIngest(); loadIngest(true).then(function () { if ((state.tab || "") === "ingest") evoPollSync(); }); }   // 打开即恢复未处理的暂存件，并按 deep 状态续跑自动刷新
  }

  /* ══ 模态弹窗让位：面板「下移一层」 ══
     宿主弹窗（设置 / 归档会话…）由 DSH 渲染在 document 里，层级低于本面板的 9990。
     这里只在「可见的模态弹窗」出现时挂 .behind(z-index:1)，消失即还原，绝不常驻。
     可见 = 有实际尺寸（display:none / 未挂载 → getBoundingClientRect 全 0）且 display/visibility 未隐藏。
     优先 [role="dialog"]，没有再退到 [aria-modal="true"]；面板自己内部的不算。 */
  function visibleModal() {
    try {
      var sel = ['[role="dialog"]', '[aria-modal="true"]'];
      for (var s = 0; s < sel.length; s++) {
        var cands = document.querySelectorAll(sel[s]);
        for (var i = 0; i < cands.length; i++) {
          var el = cands[i];
          if (el === panelEl || (panelEl && panelEl.contains(el))) continue;
          var r = el.getBoundingClientRect();
          if (!r || r.width <= 0 || r.height <= 0) continue;      // 未挂载 / display:none → 不算可见
          try {
            var c = window.getComputedStyle(el);
            if (c.display === "none" || c.visibility === "hidden") continue;
          } catch (eC) {}
          return el;
        }
      }
    } catch (e) {}
    return null;
  }
  /** 幂等：弹窗在 → 面板 .behind + z-index 1（原值存 panelZSaved）；弹窗没了 → 原值写回。 */
  function ensurePanelBehind() {
    if (!panelEl) return false;
    var want = !!visibleModal();
    var has = false;
    try { has = panelEl.classList.contains("behind"); } catch (eC) {}
    if (want === has) return undefined;                 // 状态没变：不重复采值、不重复写
    if (want) {
      if (panelZSaved === null) {
        var z = "";
        try { z = window.getComputedStyle(panelEl).zIndex || ""; } catch (eZ) {}
        if (!z || z === "auto") z = panelZFallback;     // 读不到计算值就退回常量
        panelZSaved = z;
      }
      try { panelEl.classList.add("behind"); } catch (eA) {}
      try { panelEl.style.zIndex = "1"; } catch (eA2) {}
    } else {
      try { panelEl.classList.remove("behind"); } catch (eR) {}
      var back = panelZSaved || panelZFallback;
      try { panelEl.style.zIndex = back; } catch (eR2) {}   // 显式还原关闭弹窗前的值
      panelZSaved = null;
    }
    return want;
  }

  /* ══ 面板开合 ══ */
  function tabBtn(id, label) {
    return '<button class="dsh-obs-tab' + (state.tab === id ? " on" : "") + '" data-act="tab" data-tab="' + id + '">' + label + '</button>';
  }
  function openPanel() {
    if (panelEl || disposed) return;
    notesBuilt = false; evoBuilt = false; ingestBuilt = false;
    panelEl = document.createElement("div");
    panelEl.className = "dsh-obs-panel";
    panelEl.innerHTML =
      '<div class="dsh-obs-grip" title="拖动调整宽度"></div>' +
      '<div class="dsh-obs-head">' +
        '<div class="logo">📚</div>' +
        '<div class="t">Obsidian 知识库<small>原生面板 v3</small></div>' +
        '<div class="sp"></div>' +
        '<button class="dsh-obs-btn evo" data-act="evo">🧬 自我进化</button>' +
        '<button class="dsh-obs-btn" data-act="theme">🎨</button>' +
        '<button class="dsh-obs-btn x" data-act="close">✕</button>' +
      '</div>' +
      '<div class="dsh-obs-tabs">' +
        tabBtn("notes", "笔记") + tabBtn("edit", "编辑") + tabBtn("struct", "结构") + tabBtn("evo", "进化") +
        tabBtn("ingest", "投喂") +
        '<span class="sp"></span>' +
        '<span class="dsh-obs-live" title="桥接服务状态"><i></i><b>离线</b></span>' +
      '</div>' +
      '<div class="dsh-obs-body">' +
        '<div class="dsh-obs-pane" data-pane="notes"></div>' +
        '<div class="dsh-obs-pane" data-pane="edit" hidden></div>' +
        '<div class="dsh-obs-pane" data-pane="struct" hidden></div>' +
        '<div class="dsh-obs-pane" data-pane="evo" hidden></div>' +
        '<div class="dsh-obs-pane" data-pane="ingest" hidden></div>' +
      '</div>' +
      '<div class="dsh-obs-toast" hidden></div>' +
      '<div class="dsh-obs-cf" hidden></div>' +
      // 新建笔记不再是浮层：表单由 renderEdit 渲染进「编辑」页 pane（见 .dsh-obs-nf.nfin）
      '<div class="dsh-obs-status">' +
        '<span><span class="dot"></span><span class="st-txt">…</span></span>' +
        '<span class="dsh-obs-inbox-link" data-act="inbox" title="点击直达收件箱">📥 收件箱 <span class="inbox">0</span></span>' +
        '<span class="dsh-obs-inbox-link" data-act="trash" title="回收站：已删除的笔记（可还原 / 可清空）">♻ 回收站 <span class="trashn">0</span></span>' +
      '</div>';
    panelEl.addEventListener("click", onClick);
    panelEl.addEventListener("input", onInput);
    panelEl.addEventListener("change", onChange);
    panelEl.addEventListener("keydown", onKeyDown);
    panelEl.addEventListener("dragover", onPanelDragOver);
    panelEl.addEventListener("dragleave", onPanelDragLeave);
    panelEl.addEventListener("drop", onPanelDrop);
    var savedW = parseInt(localStorage.getItem(LS.width) || "", 10);
    if (savedW >= 260) panelEl.style.width = savedW + "px";
    document.body.appendChild(panelEl);
    attachGrip();
    // 面板从「顶部工具条下方」开始：工具条不被盖住，它的按钮就都看得见、点得到
    try {
      var hb = headerBottom();
      panelEl.style.top = (hb !== null) ? (hb + "px") : "calc(var(--dsh-frame-top-clearance, 0px) + 52px)";
    } catch (eTop) {
      panelEl.style.top = "calc(var(--dsh-frame-top-clearance, 0px) + 52px)";
    }
    /* 先定主题再量宽度：--ob-line2 只声明在 .dsh-obs-panel[data-theme=...] 上，
       没定主题时 `border-left:1px solid var(--ob-line2)` 在计算值阶段失效 → 左侧 1px 边框
       不算进 offsetWidth（量到 470 而不是 471）。首次左移必须等于面板真实宽度，否则
       之后那 1px 的修正会被下面的宽度死区当成"抖动"吞掉。 */
    applyTheme();
    applyInset(panelEl.offsetWidth || 470);
    if (window.ResizeObserver) {
      try {
        insetRO = new window.ResizeObserver(function () {
          if (state.open && panelEl) applyInset(panelEl.offsetWidth);
        });
        insetRO.observe(panelEl);
      } catch (e) { insetRO = null; } // 观察器不可用：退化为只在开合时补位
    }
    /* 切页会重建会话视图 DOM，宽度不变也必须重算 → 结构观察器 */
    startInsetObserve();
    /* 面板刚挂上时可能正有弹窗开着（面板从侧栏重开）→ 立刻采一次原值并让位 */
    ensurePanelBehind();
    paintOnline();
    paintFootToggle();   // 面板已就位：把第 1 行按钮刷成「开」（蓝底白字）
    setTab(state.tab || "notes");
    refreshStatus();
  }
  function onClick(e) {
    var b = e.target.closest ? e.target.closest("[data-act]") : null;
    if (!b || !panelEl.contains(b)) {
      /* 阅读视图里的普通外链（无 data-act）：交给系统浏览器打开 */
      var al = e.target.closest ? e.target.closest("a[href]") : null;
      if (al && panelEl.contains(al)) {
        var href = al.getAttribute("href") || "";
        if (/^https?:/i.test(href)) { e.preventDefault(); try { window.open(href, "_blank", "noopener"); } catch (err) {} }
      }
      return;
    }
    var act = b.getAttribute("data-act");
    if (act === "close") return closePanel();
    if (act === "inbox") return openEvoInbox();
    /* 回收站（底部状态条入口 → 笔记页内的回收站视图） */
    if (act === "trash") return openTrashView();
    if (act === "trash-back") return applyTrashView(false);
    if (act === "trash-clear") return clearTrash();
    if (act === "trash-restore") return restoreTrash(b.getAttribute("data-name"), b);
    if (act === "trash-del") return delTrashItem(b.getAttribute("data-name"), b);
    if (act === "theme") return showThemePop();
    if (act === "tab") return setTab(b.getAttribute("data-tab"));
    if (act === "evo") { // 顶部「🧬 自我进化」：切到进化页并聚焦主题输入框
      setTab("evo");
      var inp = qs(".dsh-obs-pane[data-pane='evo'] .evo-topic") || qs(".evo-topic");
      if (inp) { try { inp.focus(); } catch (err) {} }
      return;
    }
    if (act === "cf-yes") { var yes = pendingConfirm; closeConfirm(); if (yes) yes(); return; }
    if (act === "cf-no") return closeConfirm();
    if (act === "reload-notes") {
      state.q = ""; state.tag = "";
      var qi = qs(".dsh-obs-pane[data-pane='notes'] .q"), ts = qs(".tagsel");
      if (qi) qi.value = ""; if (ts) ts.value = "";
      return loadIndex(true).then(function () { renderNotesList(); });
    }
    if (act === "open-note") return loadNote(b.getAttribute("data-path"), true);
    /* 删除键正常由 bindNoteDelete 的按钮级监听处理（已 stopPropagation，不会走到这里）；
       这里保留一条兜底：万一某处渲染出的删除键没绑上监听，也不会变成「打开笔记」。 */
    if (act === "del-note") { e.stopPropagation(); return deleteNote(b.getAttribute("data-path")); }
    /* 「交给 DSH」键同样由按钮级监听处理（已 stopPropagation）；兜底一行，避免漏绑时变成「打开笔记」 */
    if (act === "hand-note") { e.stopPropagation(); return handoffNote(b.getAttribute("data-path"), b); }
    if (act === "edit-load") {
      var ep = qs(".dsh-obs-pane[data-pane='edit'] .epath");
      var path = ep ? ep.value.trim() : "";
      if (!path) return toast("请先填写笔记路径", "bad");
      return loadNote(path, false);
    }
    if (act === "edit-save") return saveEdit();
    if (act === "note-new") return openNewNoteForm();
    if (act === "note-new-cancel") return closeNewNoteForm();
    if (act === "note-new-submit") return submitNewNote();
    if (act === "edit-obsidian") return openInObsidian();
    if (act === "edit-mode") return setEditMode(b.getAttribute("data-mode"));
    if (act === "wiki-open") return openWiki(b.getAttribute("data-wiki"));
    if (act === "wiki-tag") return openTag(b.getAttribute("data-tag"));
    if (act === "reload-struct") return loadStruct(true);
    if (act === "tgl") {
      var d = b.getAttribute("data-dir");
      var isOpen = state.treeOpen[d] === undefined ? (d.indexOf("/") < 0) : state.treeOpen[d] === true;
      state.treeOpen[d] = !isOpen;
      return renderStruct();
    }
    if (act === "mkdir") return doMkdir();
    if (act === "move") return doMove();
    /* 目录「移动」：入口在目录树节点上，浮层里确定/取消（浮层挂在 panelEl 上，故与页签同一套委托） */
    if (act === "dir-move") return openDirMove(b.getAttribute("data-dir"));
    if (act === "dir-move-ok") return doMoveDir();
    if (act === "dir-move-cancel") return closeDirMove();
    if (act === "tag") return doTag();
    if (act === "evo-run") return runEvolution();
    if (act === "evo-open") return evoOpen(b.getAttribute("data-path"));
    if (act === "evo-close-view") { var v = qs(".dsh-obs-pane[data-pane='evo'] .evo-view"); if (v) v.hidden = true; return; }
    if (act === "evo-refresh") return evoManualRefresh();
    if (act === "evo-scan") return scanKB();
    if (act === "evo-topic-fill") { // 点主题 → 填入上方输入框（便于一键触发）
      var eo = pane("evo"), tip = eo && eo.querySelector(".evo-topic");
      if (tip) { tip.value = b.getAttribute("data-topic") || ""; try { tip.focus(); } catch (e2) {} }
      return;
    }
    if (act === "evo-scan-gaps-tgl") { state.scanGapsOpen = !state.scanGapsOpen; return renderEvoScan(pane("evo")); }
    if (act === "evo-gap-open") { // 缺口 → 跳「编辑」页并载入该笔记
      var gp = b.getAttribute("data-path");
      if (!gp) return toast("该缺口条目没有可用路径", "bad");
      return loadNote(gp, true);
    }
    if (act === "evo-report-toggle") return toggleEvoReport();
    if (act === "evo-report-cancel") return toggleEvoReport(false);
    if (act === "evo-report-submit") return submitEvoReport();
    if (act === "evo-skills-reload") return loadSkills(true);
    /* 待提炼候选区（技能区上方）：重新拉取 / 展开收起 / 交给 DSH 提炼（唯一的写动作，且只写进化任务队列） */
    if (act === "evo-cands-reload") return loadCandidates(true);
    if (act === "evo-cands-tgl") return toggleEvoCands();
    if (act === "evo-cand-distill") return distillCandidate(b.getAttribute("data-topic"), b);
    if (act === "evo-skill-filter") return setSkillFilter(b.getAttribute("data-filter"));
    /* 「新建技能」：表单没开 → 以**新建模式**打开；已开着 → 收起（与旧行为一致的开关语义） */
    if (act === "evo-skill-new") {
      var skf = pane("evo") && pane("evo").querySelector(".evo-skill-form");
      if (skf && !skf.hidden) return toggleSkillForm(false);
      setSkillFormMode("create");
      return toggleSkillForm(true);
    }
    if (act === "evo-skill-cancel") return toggleSkillForm(false);
    if (act === "evo-skill-create") return createSkill();
    if (act === "evo-skill-save") return saveEditedSkill();     // 编辑模式的主按钮（走 /api/skills/save）
    /* 技能卡四件（写路径）：编辑 / 停用·启用 / 用这张卡 / 导出到知识库；查看是只读 */
    if (act === "evo-skill-view") return openSkill(b.getAttribute("data-name"), b.getAttribute("data-path"), b.getAttribute("data-source"));
    if (act === "evo-skill-edit") return startEditSkill(b.getAttribute("data-name"), b.getAttribute("data-path"));
    if (act === "evo-skill-toggle") return toggleSkillEnabled(b.getAttribute("data-name"), b.getAttribute("data-enabled"), b);
    if (act === "evo-skill-use") return useSkillFromCard(b.getAttribute("data-name"), b);
    if (act === "evo-skills-mirror") return mirrorSkillsToVault(b);
    if (act === "evo-skill-del") return deleteSkill(b.getAttribute("data-name"), b.getAttribute("data-source"));
    if (act === "evo-skill-open") return openSkill(b.getAttribute("data-name"), b.getAttribute("data-path"), b.getAttribute("data-source"));
    /* 提示词 / 模板 / 检查清单（第四类进化对象）：清单 ↻ / 类型筛选 / 候选 ↻ + 展开 / 据此新建 /
       表单（新建·取消·创建·保存）/ 卡片四件（查看·编辑·历史·删除）。
       写路径只有 /api/prompts/save（POST）与 /api/prompts（DELETE）两条，其余全是只读。 */
    if (act === "evo-prompts-reload") return loadPrompts(true);
    if (act === "evo-prompt-filter") return setPromptFilter(b.getAttribute("data-filter"));
    if (act === "evo-prompt-cands-reload") return loadPromptCands(true);
    if (act === "evo-prompt-cands-tgl") return togglePromptCands();
    if (act === "evo-prompt-cand-new") return prefillPromptFromCand(b.getAttribute("data-topic"), b.getAttribute("data-suggest"));
    /* 「新建」：表单没开 → 以**新建模式**打开；已开着 → 收起（与「新建技能」一致的开关语义） */
    if (act === "evo-prompt-new") {
      var ppf = pane("evo") && pane("evo").querySelector(".evo-prompt-form");
      if (ppf && !ppf.hidden) return togglePromptForm(false);
      setPromptFormMode("create");
      return togglePromptForm(true);
    }
    if (act === "evo-prompt-cancel") return togglePromptForm(false);
    if (act === "evo-prompt-create") return savePromptFromForm();
    if (act === "evo-prompt-save") return savePromptFromForm();   // 编辑模式的主按钮（同一函数按表单态分流）
    if (act === "evo-prompt-view") return openPrompt(b.getAttribute("data-name"), b.getAttribute("data-path"), b.getAttribute("data-kind"));
    if (act === "evo-prompt-edit") return startEditPrompt(b.getAttribute("data-name"), b.getAttribute("data-path"));
    if (act === "evo-prompt-history") return showPromptHistory(b.getAttribute("data-name"));
    if (act === "evo-prompt-del") return deletePrompt(b.getAttribute("data-name"));
    if (act === "evo-prompt-open") return openPrompt(b.getAttribute("data-name"), b.getAttribute("data-path"), b.getAttribute("data-kind"));
    /* 任务卡：主按钮（领取 / 标为完成）+ 次级（查看正文 / 退回待执行，后者由服务端 /api/evolution/reset 支撑） */
    if (act === "evo-task-claim") return claimTask(b);
    if (act === "evo-task-done") return askDoneTask(b.getAttribute("data-path"), b);
    if (act === "evo-task-view") return evoOpen(b.getAttribute("data-path"));
    if (act === "evo-task-reset") return resetTask(b.getAttribute("data-path"), b);
    if (act === "evo-arch-open") return toggleEvoArchive(true);
    if (act === "evo-arch-back") return toggleEvoArchive(false);
    if (act === "evo-autoexport") return toggleAutoExport();   // 收件箱下方的「自动导出」开关
    /* ── 投喂页 ── */
    if (act === "ing-pick") {
      var fi = qs(".dsh-obs-pane[data-pane='ingest'] .ing-file");
      if (fi) { try { fi.click(); } catch (e2) {} }
      return;
    }
    if (act === "ing-refresh") return loadIngest(true).then(function () { evoPollSync(); });   // 手动 ↻ 后按新状态重新裁决轮询（与进化页 ↻ 同一口径：失败停下后点 ↻ 能续上）
    if (act === "ing-recognize") return recognizeIngest(b.getAttribute("data-id"), b);
    if (act === "ing-save") return saveIngest();
    if (act === "ing-queue") return queueIngest(b.getAttribute("data-id"), b);
    if (act === "ing-discard") return discardIngest(b.getAttribute("data-id"));
    /* 暂存孤儿对账 / 回收区：清理按钮**先只读对账再确认**；回收区可展开、逐条恢复、整体彻底清理（真删，二次确认） */
    if (act === "ing-reconcile") return cleanOrphans(b);
    if (act === "ing-trash-tgl") {
      state.ingest.trashOpen = !state.ingest.trashOpen;
      renderIngestTrash();                       // 先用缓存的清单立刻画出来（不闪空）
      if (state.ingest.trashOpen) return loadIngestTrash();   // 每次展开都再拉一次只读清单（回收区可能被别处改过）
      return;
    }
    if (act === "ing-trash-restore") return restoreTrashFile(b.getAttribute("data-dir"), b.getAttribute("data-file"), b);
    if (act === "ing-trash-purge") return purgeIngestTrash();
    if (act === "ing-form-close") return closeIngestForm();
    /* 深度整理：查看产出（有 `- 产出：` 时）/ 查看任务文件。
       复用面板**既有**的笔记载入路径（loadNote → GET /api/note → 编辑页阅读视图），不另造查看器。 */
    if (act === "ing-deep-open") {
      var dp = b.getAttribute("data-path");
      if (!dp) return toast("该任务没有可读路径", "bad");
      return loadNote(dp, true);
    }
    /* 内嵌图片：点缩略图放大（只读浮层）/ 收起浮层 / 展开收起「跳过 N 个图像流」清单。
       展开只换 .ing-skip 这一块（不重画表单，避免把用户已改的标题/正文覆盖回去）。 */
    if (act === "ing-img-zoom") {
      state.ingest.zoomSrc = b.getAttribute("data-src") || "";
      state.ingest.zoomCap = b.getAttribute("data-cap") || "";
      return renderIngestZoom();
    }
    if (act === "ing-img-close") return closeIngestZoom();
    if (act === "ing-skip-tgl") {
      state.ingest.skipOpen = !state.ingest.skipOpen;
      var skw = qs(".dsh-obs-pane[data-pane='ingest'] .ing-skip");
      if (skw && skw.parentNode) {
        var skh = document.createElement("div");
        skh.innerHTML = ingSkipHtml(state.ingest.res[state.ingest.cur] || null);
        if (skh.firstChild) skw.parentNode.replaceChild(skh.firstChild, skw);
      }
      return;
    }
    if (act === "ing-open-note") {   // 切到「编辑」页并载入刚入库的笔记
      var np = b.getAttribute("data-path");
      if (!np) return toast("笔记路径缺失", "bad");
      return loadNote(np, true);
    }
  }
  function onInput(e) {
    var el = e.target;
    if (el && el.classList && el.classList.contains("q")) {
      state.q = el.value;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(doSearch, 300); // 300ms 防抖
    }
  }
  function onChange(e) {
    var el = e.target;
    if (el && el.classList && el.classList.contains("tagsel")) {
      state.tag = el.value || "";
      doSearch();
    }
  }
  function onKeyDown(e) {
    if (e.key === "Escape") {
      if (state.ingest.zoomSrc) { closeIngestZoom(); return; }   // 内嵌图片浮层：Esc 先收起
      var dmv = dirMoveEl();
      if (dmv) { closeDirMove(); return; }          // 目录「移动」浮层：Esc 关闭
      var cf = qs(".dsh-obs-cf");
      if (cf && !cf.hidden) { closeConfirm(); return; }
      var nf = qs(".dsh-obs-nf");
      if (state.newNote || (nf && !nf.hidden)) { closeNewNoteForm(); return; }
    }
    /* 目录「移动」浮层：在输入框里回车 = 确定（与既有表单的回车提交口径一致） */
    if (e.key === "Enter" && e.target && e.target.classList && e.target.classList.contains("dmv-to")) {
      e.preventDefault();
      doMoveDir();
      return;
    }
    /* 自动导出开关：键盘可达（role=switch + Tab 聚焦，Enter / Space 切换） */
    var sw = e.target && e.target.closest ? e.target.closest('[data-act="evo-autoexport"]') : null;
    if (sw && (e.key === "Enter" || e.key === " " || e.key === "Spacebar")) {
      e.preventDefault();
      toggleAutoExport();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S") && state.tab === "edit") {
      e.preventDefault();
      saveEdit();
    }
  }
  /* 左边缘拖拽调整宽度（与工作台一致的交互） */
  function attachGrip() {
    var grip = panelEl && panelEl.querySelector(".dsh-obs-grip");
    if (!grip) return;
    var startX = 0, startW = 0, dragging = false;
    grip.addEventListener("pointerdown", function (e) {
      dragging = true;
      startX = e.clientX;
      startW = panelEl.getBoundingClientRect().width;
      grip.classList.add("on");
      panelEl.classList.add("dsh-obs-dragging");
      try { grip.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });
    grip.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var w = startW - (e.clientX - startX);
      w = Math.max(260, Math.min(w, Math.round(window.innerWidth * 0.8)));
      panelEl.style.width = w + "px";
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      grip.classList.remove("on");
      panelEl.classList.remove("dsh-obs-dragging");
      try { grip.releasePointerCapture(e.pointerId); } catch (err) {}
      localStorage.setItem(LS.width, String(Math.round(panelEl.getBoundingClientRect().width)));
    }
    grip.addEventListener("pointerup", endDrag);
    grip.addEventListener("pointercancel", endDrag);
  }
  var popTimer = null;
  function showThemePop() {
    if (!panelEl) return;
    var old = panelEl.querySelector(".dsh-obs-pop");
    if (old) { old.remove(); return; }
    var pop = document.createElement("div");
    pop.className = "dsh-obs-pop";
    var opts = [
      ["dark", "深色", "默认 · 夜间友好", "linear-gradient(135deg,#141a2e 50%,#0a0d16 50%)"],
      ["light", "浅色", "明亮 · 白天阅读", "linear-gradient(135deg,#f4f6fb 50%,#e3e8f4 50%)"],
      ["auto", "随系统时间", "18–8 点深色 · 8–18 点浅色", "linear-gradient(105deg,#f4f6fb 0 46%,#141a2e 54%)"],
    ];
    pop.innerHTML = opts.map(function (o) {
      return '<div class="row' + (state.theme === o[0] ? " on" : "") + '" data-t="' + o[0] + '"><span class="thumb" style="background:' + o[3] + '"></span><span><b>' + o[1] + '</b><small>' + o[2] + '</small></span><span class="ck"></span></div>';
    }).join("");
    pop.addEventListener("click", function (e) {
      var row = e.target.closest("[data-t]");
      if (!row) return;
      setTheme(row.getAttribute("data-t"));
      pop.remove();
    });
    panelEl.appendChild(pop);
  }
  function closePanel() {
    state.open = false;
    localStorage.setItem(LS.open, "0");
    evoPollStop();       // 面板关闭 → 自动刷新立即停（不留幽灵轮询；重开时 loadEvo 会立刻补拉一次）
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
    closeConfirm();
    closeNewNoteForm();
    state.ingest.zoomSrc = "";   // 面板关了：缩略图浮层随 panelEl 一起销毁，状态也归零（重开不留残影）
    state.ingest.zoomCap = "";
    if (insetRO) { try { insetRO.disconnect(); } catch (e) {} insetRO = null; }
    stopInsetObserve();
    if (panelEl) { panelEl.remove(); panelEl = null; }
    panelZSaved = null;  // 面板连同 inline z-index 一起销毁；重开时重新采原值
    applyInset(0); // 面板已关：把聊天区还给原来的布局
    notesBuilt = false; evoBuilt = false; ingestBuilt = false;
    paintFootToggle();   // 面板已关：第 1 行按钮回到「关」（深灰底灰白字）
  }
  function openNow() {
    state.open = true;
    localStorage.setItem(LS.open, "1");
    paintFootToggle();
    openPanel();
  }

  /* ── 收件箱直达：面板底部徽标 / 侧栏入口共用同一条路径 ── */
  function flashSec(el) {
    if (!el || !el.classList) return;
    el.classList.add("dsh-obs-flash");
    setTimeout(function () { if (el && el.classList) el.classList.remove("dsh-obs-flash"); }, 1600);
  }
  function openEvoInbox() {
    try {
      if (!state.open) openNow();
      setTab("evo");
      var sec = qs(".dsh-obs-pane[data-pane='evo'] [data-sec='inbox']") || qs("[data-sec='inbox']");
      if (sec) {
        try { sec.scrollIntoView({ block: "start", behavior: "smooth" }); }
        catch (e) { try { sec.scrollIntoView(); } catch (e2) {} }
        flashSec(sec);
      }
    } catch (e3) {}
    refreshStatus();
  }
  /* 侧栏入口的收件箱入口：面板关着时它是唯一可见的提醒（纯文字，无图标） */
  function updateFootInbox() {
    if (!footInboxEl) return;
    var n = (state.inbox && state.inbox.count) || 0;
    if (n > 0) { footInboxEl.textContent = "收件箱 " + n; footInboxEl.className = "fin has"; }
    else { footInboxEl.textContent = "收件箱"; footInboxEl.className = "fin"; }
  }

  /* ── 面板打开时的「左移」 ──
     教训（真实回归）：早先把「应用根元素」整体缩窄，结果 DSH 顶部工具条所在容器变窄，
     而工具条是按**视口宽度**做响应式收缩的 → 容器变窄不触发重排 → 按钮溢出被截断。
     现在改为：① 绝不再碰应用根；② 只给「顶部工具条以外的兄弟节点」加右内边距。 */
  function hostRoot() {
    var root = null;
    try {
      var node = footBtn;
      while (node && node.parentElement && node.parentElement !== document.body) node = node.parentElement;
      if (node && node !== panelEl && node.parentElement === document.body) root = node;
      if (!root) {
        var fc = document.body.firstElementChild;
        if (fc && fc !== panelEl) root = fc;
      }
    } catch (e) { root = null; }
    return root;
  }
  /** 结构性地找 DSH 顶部工具条：近顶横条(距根顶 ≤90px)、高度 20–100px、宽度超根的一半，
      在候选里取**最低**的那条 —— DSH 顶部有两行（"应用/编辑"菜单行 + 真正带按钮的工具条行），
      取最低的才是我们要避让的工具条。
      ⚠️ `sc` = 当次的聊天滚动区：**必须把「聊天滚动区内部」的元素全部排除**。
      踩过的坑（2026-10-08 实测铁证）：上面的判据只有"宽 + 矮 + 靠顶"，没有结构性约束，于是聊天区里
      一个**宽 1014 × 高 21 的普通 div**（一条长消息/代码块/表格行）会被误判成工具条 —— 后果有两层：
        ① headerBottom() 把面板上沿贴到它底部（面板跳位）；
        ② applyInset 里 `if (hdr && parent.contains(hdr)) break;` 让目标爬升**提前中断**，
           padding 从外层容器（如 #h-body）退化成内层 wrap（如 #h-wrap）→ **聊天区左右跳**。
      因为"哪个元素算工具条"取决于聊天内容与布局，这个误判还会**自持摆动**（padding 换元素 → 布局变 →
      误判换目标 → …）。所以这里用 `sc.contains(el)` 一次性切断内容误判。 */
  function findHeader(root, sc) {
    try {
      if (!root) return null;
      var rr = root.getBoundingClientRect();
      if (!rr || rr.width < 200) return null;
      var best = null, bestBottom = -1;
      var all = root.querySelectorAll("*");
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el === panelEl) continue;
        if (sc && el !== sc && sc.contains(el)) continue;   // 聊天区**内部**的内容永远不是工具条
        var r = el.getBoundingClientRect();
        if (r.width < rr.width * 0.5) continue;
        if (r.height < 20 || r.height > 100) continue;
        if (r.top - rr.top > 90) continue;
        if (r.bottom > bestBottom) { bestBottom = r.bottom; best = el; }
      }
      return best;
    } catch (e) { return null; }
  }
  /** 面板上沿 = 顶部工具条底边（视口坐标）；取不到返回 null 由调用方兜底 */
  function headerBottom() {
    try {
      var root = hostRoot();
      var hdr = findHeader(root, root ? chatScrollHost(root) : null);
      if (hdr) {
        var r = hdr.getBoundingClientRect();
        if (r && r.height > 20) return Math.round(r.bottom);
      }
    } catch (e) {}
    return null;
  }
  var insetTargets = [];   // [{el, prevPadding}] 按元素记录原始内联值，避免只存一份
  /* ── 目标稳定化（迟滞）+ 宽度死区：修复「面板打开时聊天区一直左右移动（持续抖动）」 ──────
     症状有两个来源，必须分别处理：
     ① 目标来回切换：每次重算都重新挑「面积最大的可滚动元素」再取其最外层祖先。两个候选
        面积接近时（面板/侧栏滚动条出现消失、聊天内容变化引起的布局微变），候选会在两者
        之间反复切换 → 内边距一会儿写在这个元素、一会儿写在另一个 → 肉眼看到左右位移。
     ② 宽度抖动：applyInset(panelEl.offsetWidth) 的取值会有 ±1 的抖动，每次都写一个
        「新」值 → 聊天区跟着左右抖。
     对策：① 用 insetSticky 记住上次的目标：它只要仍挂在文档里、且仍包含当前的聊天滚动区
        （用 chatScrollHost 的结果判包含关系），就继续用它 —— 不因为这次重新挑选出别的候选
        而切换；只有它脱离文档、或不再包含聊天滚动区时才重新挑选（切页自愈因此不退化）。
     ② 宽度先 Math.round 取整，与「上次写入的取整值」相差在 INSET_DEAD_ZONE 以内即视为
        同一个值：不写、也不切换；目标本身变了则不受死区限制 —— 真替换必须落地。 */
  var insetSticky = null;                  // 上次选中的目标元素（迟滞用）
  var insetLastPx = 0;                     // 上次真正写入的取整宽度（死区比较用）
  var INSET_DEAD_ZONE = 2;                 // 死区半径：与上次写入值相差 ≤2px 视为同一个值

  /** 找聊天滚动区：根子树里面积最大的可滚动元素（聊天正文就在它里面）。
      ⚠️ 必须**排除整个落在面板那一列**的候选（左边缘 ≥ 面板左边缘）：面板是 fixed 覆盖在右侧的，
      它底下那根右栏（真机实测：与面板同宽、左边缘正好落在面板左边缘处）也是可滚动的，面积与聊天滚动区
      接近 → 冷启动时按"面积最大"挑会挑到它 → 目标爬升顺着它走到右栏 → 给它加 padding 对"把聊天让出来"
      毫无作用 → **面板盖住聊天**（2026-10-08 重启后实测踩到）。
      只在"筛完还有候选"时才用筛后的结果；全都在面板底下时退回不筛（宁可加错也不能不加）。 */
  function chatScrollHost(root) {
    try {
      if (!root) return null;
      var best = null, bestArea = 0;                 // 筛后最优
      var bestAny = null, bestAnyArea = 0;           // 不筛的最优（兜底）
      var pr = panelEl ? panelEl.getBoundingClientRect() : null;
      var all = root.querySelectorAll("*");
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el === panelEl) continue;
        var cs = window.getComputedStyle(el);
        if (cs.overflowY !== "auto" && cs.overflowY !== "scroll") continue;
        var r = el.getBoundingClientRect();
        if (r.width < 300 || r.height < 200) continue;
        var area = r.width * r.height;
        if (area > bestAnyArea) { bestAnyArea = area; bestAny = el; }
        if (pr && pr.width > 0 && r.left >= pr.left - 1) continue;   // 整个在面板那一列 → 不是聊天区
        if (area > bestArea) { bestArea = area; best = el; }
      }
      return best || bestAny;
    } catch (e) { return null; }
  }

  /** 目标是否整个躺在面板底下（左边缘 ≥ 面板左边缘）—— 见 applyInset 里「首挑偏好」的注释 */
  function targetUnderPanel(el) {
    try {
      if (!el || !panelEl) return false;
      var t = el.getBoundingClientRect(), p = panelEl.getBoundingClientRect();
      if (!t.width || !p.width) return false;
      return t.left >= p.left - 1;
    } catch (e) { return false; }
  }

  function applyInset(px) {
    try {
      /* ── 幂等：无谓写入为零（修复「流式输出时聊天区不贴底 / 点置底也到不了最新」）────────
         旧写法是「先还原旧目标 → 再重新定位 → 再写」。中间的"还原"让聊天区短暂回到未左移的
         宽度，而紧随其后的重新定位要读 getBoundingClientRect()/getComputedStyle()
         （见 findHeader / chatScrollHost）→ 这个中间态会被**强制排版**落地：文本按更宽的容器
         重新折行 → scrollHeight 变小 → scrollTop 被夹到新的最大值；宽度写回来后内容又变高，
         但被夹掉的滚动位置不会自己回来。180ms 的结构观察器让这个循环在流式输出期间反复发生。
         现在：每次都按当前 DOM 完整重新定位（切页自愈不变）；只有「新目标集合与上次完全相同」
         且「这些目标的内联值已经等于要写的值」→ 直接 return，一个样式都不写（也不先还原）。
         目标变了 / 目标值变了 / 旧目标已脱离文档，才走原来的"还原旧目标 → 写新目标"。
         （本轮追加：选出目标后先过「迟滞」——仍包含聊天滚动区就沿用、不切换；宽度先取整、
         再走 ±2px 死区。两者见上面 insetSticky / INSET_DEAD_ZONE 的注释。） */
      if (!(px > 0)) {
        /* px===0：保持原语义 —— 有目标就还原；没有目标则一个样式都不写 */
        for (var k0 = 0; k0 < insetTargets.length; k0++) {
          try {
            var p0 = insetTargets[k0];
            if (p0 && p0.el && p0.el.isConnected !== false) p0.el.style.paddingRight = p0.prevPadding;
          } catch (e0) {}
        }
        insetTargets = [];
        insetSticky = null;   // 面板已关/还原：迟滞记忆与死区基准一并清空，下次开面板重新采目标
        insetLastPx = 0;
        return;
      }
      var wantPx = Math.round(px);          // 取整：先抹掉宽度上的亚像素 / ±1 抖动
      if (wantPx < 1) wantPx = 1;           // px>0 却取整成 0 的极端值：保底 1px，避免退化成还原
      var want = wantPx + "px";
      /* 每次都按「当前」DOM 重新定位：切页后这里拿到的是重建出来的新节点 */
      var next = [];
      var root = hostRoot();
      if (root) {
        /* ══ 迟滞（目标锁定）：**只要记忆里的目标还活着，就直接用它，不再重挑** ═══════════
           真实机器实测（2026-10-08，用户机器上的诊断数字）：
             调用=9 速率=2.5/秒 写入=8 **快速跳过=0** **目标集合切换=8**，sticky=聊天主区容器
             [7][8][9] 的 next 全是 面板右侧栏容器，而矩形记录里 padding 在
             聊天主区容器（聊天所在主区，**正确**）与
             面板底下那根右栏容器（**错误**）之间来回落。
           为什么迟滞明明存着正确目标却没用上？因为它的启用条件多了一条 `sticky.contains(sc)`：
             而 sc（"面积最大的可滚动元素"）本身就在 聊天滚动区 与 右侧面板滚动区 之间跳
             （两个候选面积接近，本插件写进去的 padding 又是改变布局的）→ contains(sc) 时真时假
             → 迟滞被绕过 → 重新挑选 → 挑到**兄弟节点**（互不包含）→ 每调用一次就换一个目标写。
           结论：**迟滞的条件本身写错了**。它就该在"记忆里的目标还活着"时生效，与这次挑出的 sc 无关；
           sc 抖动恰恰是最需要迟滞的时刻。故这里把它提到最前面：活着就锁定，其余一概不重挑。
           不锁死的保底（三条）：
             ① 目标脱离文档（DSH 切页重建 DOM）/ 变成面板自身或包含面板；
             ② **锁定目标整个躺在面板底下**（左边缘 ≥ 面板左边缘）—— 那种目标加内边距对"把聊天让出来"
                毫无作用（2026-10-08 重启后实测就是它导致"面板盖住聊天"）；但只有在**确实能找到一个
                不在面板底下的更好候选**时才解锁，否则会在"重挑 → 还是它"之间空转、每次都写一次 padding
                （那就退化成抖动）；
             ③ 面板关闭时 applyInset(0) 会把 insetSticky 清空。 */
        var sticky = insetSticky;
        var stickyOk = !!(sticky && sticky.style && sticky.isConnected !== false &&
          sticky !== panelEl && !sticky.contains(panelEl));
        var sc = null, hdr = null, fresh = null, cands = [];
        /* 只有「粘不住」或「粘住的那个整个躺在面板底下」时才去算新鲜候选（算它要读布局，代价不低） */
        if (!stickyOk || targetUnderPanel(sticky)) {
          sc = chatScrollHost(root);
          hdr = findHeader(root, sc);            // 先有 sc 再找工具条：聊天区内部的内容不算工具条
          if (sc) {
            /* 关键：只给「最外层、且不含顶部工具条」的那个祖先加内边距。
               ① 只加一层 → 左移量不叠加；② 不含工具条 → 绝不会再挤坏宿主工具条。 */
            var target = sc, node = sc;
            while (node) {
              var parent = node.parentElement;
              if (!parent || parent === root || parent === document.body) break;
              if (hdr && parent.contains(hdr)) break;
              target = parent; node = parent;
            }
            fresh = target;
          } else {
          /* 兜底：连「聊天滚动区」都找不到（面板一开，聊天列可能就窄于 300×200 阈值，
             或它的 overflowY 不是 auto/scroll）→ 只能从工具条的兄弟节点里挑。
             原实现是**多目标**（每个兄弟各写一次 padding）且**不更新迟滞记忆** → 目标集合
             会随布局变化（哪个兄弟还在、谁面积最大）而变，每次换一批元素写 padding = 左右跳。
             现在改为：① 只挑**一个稳定目标**（面积最大的那个兄弟，排除工具条与面板）；
             ② 它也被写进迟滞记忆，于是迟滞 + ±2px 死区在兜底路径上同样生效；
             ③ 多个兄弟时**优先排除整个躺在面板底下的那个**（否则那条路也会挑到面板底下）。 */
          var host = hdr && hdr.parentElement;
          if (host) {
            var bestEl = null, bestA = -1;
            for (var i2 = 0; i2 < host.children.length; i2++) {
              var el2 = host.children[i2];
              if (el2 === hdr || el2 === panelEl) continue;
              var r2 = el2.getBoundingClientRect();
              var a2 = r2.width * r2.height;
              var score = (targetUnderPanel(el2) ? 0 : 1e12) + a2;   // 不在面板底下的永远优先，同类再比面积
              if (score > bestA) { bestA = score; bestEl = el2; }
            }
            if (bestEl) fresh = bestEl;
          }
          }
        }
        /* 用谁：**默认锁定**（那才是抖动根因的修复）；仅当「锁定目标在面板底下 **且** 确实存在一个
           不在面板底下的新鲜候选」时才换 —— 既治好"盖住聊天"，又不会在换不动的时候空转写入。 */
        if (stickyOk && (!targetUnderPanel(sticky) || !fresh || targetUnderPanel(fresh))) {
          cands.push(sticky);
        } else if (fresh) {
          cands.push(fresh);
        }
        for (var c = 0; c < cands.length; c++) {
          var tg = cands[c];
          // 目标校验：必须仍挂在文档里、且不是面板自身的元素，否则宁可不写（不能碰坏宿主布局）
          if (!tg || !tg.style || tg === panelEl) continue;
          if (tg.isConnected === false) continue;
          if (tg.contains(panelEl)) continue;
          next.push(tg);
        }
        /* 首挑偏好：目标**整个躺在面板底下**（左边缘 ≥ 面板左边缘）时，给它加内边距对「把聊天让出来」
           毫无作用 —— 它本来就被面板盖着。真实机器上那个会与正确目标来回抢的错误目标正是它
           （面板底下那根右栏容器：与面板同宽、左边缘正好落在面板左边缘处）。
           只在「有多个候选、且至少一个不在面板底下」时才筛：**宁可加错也不能不加**（不加 = 面板盖住聊天）。 */
        if (next.length > 1) {
          var pref = [];
          for (var pv = 0; pv < next.length; pv++) { if (!targetUnderPanel(next[pv])) pref.push(next[pv]); }
          if (pref.length) next = pref;
        }
        /* ── 目标稳定化（外层优先，第二道保险）────────────────────────────────────
           上面「目标锁定」已经解决真实机器上的抖动（迟滞被 contains(sc) 挡掉的根因）；
           这一道针对**换目标确有发生**的时刻（锁定失效 → 重新挑）再兜一次：
           目标爬升是**内容相关**的 —— 只要 findHeader 把聊天区里的某个"宽而矮"元素误判成工具条，
           `if (hdr && parent.contains(hdr)) break;` 就会提前中断，目标从外层容器退化成内层 wrap，
           padding 打到另一个元素上 = 肉眼看到的左右移动。上面 findHeader 的 `sc.contains(el)`
           已切断误判来源；这里再加一层不变量：**只要外层迟滞目标还在文档里、且仍然包含这次算出来的
           目标，就坚持用外层那个**。注意不锁死：真换容器时（聊天区搬到别处）insetSticky 不再包含
           新目标 → 正常接受新目标；兄弟节点之间互不包含，所以这道保险对"兄弟抢目标"无能为力 ——
           那种情况由上面的目标锁定负责。 */
        if (insetSticky && insetSticky.style && insetSticky.isConnected !== false &&
            insetSticky !== panelEl && !insetSticky.contains(panelEl) &&
            next.length === 1 && next[0] !== insetSticky && insetSticky.contains(next[0])) {
          next = [insetSticky];
        }
      }
      /* 快速路径（幂等零写入）：目标集合与上次完全相同，并且
         ① 内联值已经等于要写的值 → 一个样式都不写；或
         ② 要写的值与「上次写入值」之差在死区内 → 视为同一个值：不写、也不切换。
         两者都**不先还原** —— 还原会让聊天区短暂回到未左移的宽度并被强制排版落地
         （scrollTop 被夹掉的滚动位置不会自己回来）。
         ③ 例外：内联值被宿主清空/改写时（allHold=false）不吃死区，照旧写回去，
         否则左移会静默丢失。 */
      if (next.length === insetTargets.length && next.length > 0) {
        var same = true;
        for (var s = 0; s < next.length; s++) {
          var oldT = insetTargets[s];
          if (!oldT || oldT.el !== next[s] || oldT.el.isConnected === false) { same = false; break; }
        }
        if (same) {
          var allWant = true, allHold = true;
          for (var s2 = 0; s2 < next.length; s2++) {
            var curPad = next[s2].style.paddingRight;
            if (curPad !== want) allWant = false;
            if (!curPad) allHold = false;
          }
          if (allWant) return;
          if (allHold && Math.abs(wantPx - insetLastPx) <= INSET_DEAD_ZONE) return;
        }
      }
      /* 慢速路径：先撤掉「已不是目标」的旧目标（脱离文档的跳过），再写新目标。
         仍是目标的元素不还原 —— 它下面会直接被改成新值，还原只会多一次无谓写入 + 中途抖动。 */
      for (var k = 0; k < insetTargets.length; k++) {
        try {
          var prev = insetTargets[k];
          if (!prev || !prev.el || prev.el.isConnected === false) continue;
          var still = false;
          for (var q = 0; q < next.length; q++) { if (next[q] === prev.el) { still = true; break; } }
          if (still) continue;
          prev.el.style.paddingRight = prev.prevPadding;
        } catch (e1) {}
      }
      var kept = [];
      for (var w = 0; w < next.length; w++) {
        var tgt = next[w], prevPad = tgt.style.paddingRight;
        for (var r = 0; r < insetTargets.length; r++) {   // 沿用旧记录里的原始值，别把中间态当原始值
          if (insetTargets[r] && insetTargets[r].el === tgt) { prevPad = insetTargets[r].prevPadding; break; }
        }
        kept.push({ el: tgt, prevPadding: prevPad });
        tgt.style.paddingRight = want;
      }
      insetTargets = kept;
      insetLastPx = wantPx;
      /* 迟滞记忆：**单目标时一律记住**（含兜底路径）。
         原口径是"只在主路径（sc 找到）选出唯一目标时才记"，用意是别把一次猜测固化成稳定目标；
         但兜底路径原本是**多目标**，不记 + 多目标 = 每次都可能换一批元素写 padding（左右跳）。
         现在兜底路径已改成**单目标**（面积最大的那个兄弟），所以必须一起记 ——
         否则迟滞与 ±2px 死区在这条路上完全失效，而那正是窄窗口（聊天列低于阈值）下的默认路径。 */
      if (next.length === 1) insetSticky = next[0];
    } catch (e) { /* 结构变化时静默降级，绝不打断面板 */ }
  }

  /* ── 宿主结构观察：DSH 切页会卸载并重建会话视图 DOM，结构变稳后自动补上左移 ── */
  function stopInsetObserve() {
    if (insetMOTimer) { try { clearTimeout(insetMOTimer); } catch (e0) {} insetMOTimer = null; }
    if (insetMO) { try { insetMO.disconnect(); } catch (e1) {} insetMO = null; }
  }
  function startInsetObserve() {
    stopInsetObserve();
    if (!window.MutationObserver) return;
    /* 观察整份 body：① 宿主切页会重建会话视图 DOM；② 模态弹窗（设置 / 归档会话…）
       可能直挂在 body（也可能挂在应用根里）—— 只盯应用根会漏掉前一种。
       面板自身的刷新噪声由回调里的 panelEl.contains 过滤，重算本身有 180ms debounce + 幂等。 */
    var target = document.body || null;
    try { if (!target) target = hostRoot(); } catch (e) { target = null; }
    if (!target) return;
    try {
      insetMO = new window.MutationObserver(function (records) {
        if (!state.open || !panelEl) return;          // 面板关着：不动作、不写盘
        /* 弹窗的插入/移除（childList）或显形（role/aria-modal 属性）都会走到这次回调
           → 复用同一份回调重算面板层级，不新开观察器 */
        try { ensurePanelBehind(); } catch (eBehind) {}
        // 过滤自身噪声：变更目标全部落在面板内部 → 是面板内容在刷新，忽略
        var relevant = false;
        for (var i = 0; i < records.length; i++) {
          if (panelEl.contains(records[i].target)) continue;
          relevant = true;
          break;
        }
        if (!relevant) return;
        if (insetMOTimer) clearTimeout(insetMOTimer);
        insetMOTimer = setTimeout(function () {
          insetMOTimer = null;
          if (!state.open || !panelEl) return;
          try { applyInset(panelEl.offsetWidth || 470); } catch (e) {}
        }, INSET_MO_DELAY);
      });
      /* 只观察 childList/subtree + 两个白名单属性：
         ① childList：切页重建会话视图 DOM、弹窗插拔；
         ② attributes + attributeFilter(["role","aria-modal"])：宿主部分弹窗是「DOM 先挂好、
            再改 role/aria-modal 才显示」的（DSH 自己的模态观察器也同时盯这两个属性）。
         白名单之外一律不观察 —— applyInset 写的 style.paddingRight、.behind 的 class 都不会被
         自身写入唤醒，因此不会死循环。本文件的写入也不增删节点，故 childList 也不会自触发。 */
      insetMO.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ["role", "aria-modal"] });
    } catch (e2) { insetMO = null; }
  }

  /* ══ 自动导出：面板「进化」页那行 与 侧栏底栏那行 共用这一套读写（同一个 state.settings） ══ */
  function autoExportOn() { return !!(state.settings && state.settings.auto_export_sessions === true); }

  /* 面板没开时底栏也要显示正确的开关状态：挂载时补拉一次（失败允许下次再试，不静默） */
  function ensureSettings() {
    if (settingsAsked || state.settings) return;
    settingsAsked = true;
    (async function () {
      try {
        var sj = await get("/api/settings");
        state.settings = (sj && sj.settings) || null;
        state.effective = (sj && sj.effective) || null;
        state.evoErr.settings = "";
      } catch (e) {
        state.evoErr.settings = e.message;
        settingsAsked = false;
      }
      syncAutoExportUI();
    })();
  }

  /* 底栏小开关的外观：只读 state.settings，绝不自己留一份副本 */
  function renderFootAutoExport() {
    if (!footAutoSwEl) return;
    var on = autoExportOn();
    footAutoSwEl.className = "asw" + (on ? " on" : "");
    footAutoSwEl.setAttribute("aria-checked", on ? "true" : "false");
    footAutoSwEl.setAttribute("title", (on ? "已开启：" : "已关闭：") + AUTO_EXPORT_TIP);
  }

  /* 面板那行 + 底栏那行一起刷新（同一份 state.settings，天然同源） */
  function syncAutoExportUI() {
    renderFootAutoExport();
    var p = pane("evo");
    if (p && p.getAttribute("data-built") === "1") renderEvoAutoExport(p);
  }

  /* 读全量 → 改 auto_export_sessions → 整体写回（服务端是深合并，整体写回不丢字段） */
  async function saveAutoExport(want) {
    var full = state.settings;
    try {
      var cur = await get("/api/settings");
      full = (cur && cur.settings) || full;
    } catch (e) { /* 读不到就退回本地副本，避免把开关动作也卡死 */ }
    var next = Object.assign({}, full || {}, { auto_export_sessions: want === true });
    var r = await put("/api/settings", next);
    state.settings = (r && r.settings) || next;
    state.evoErr.settings = "";
    return state.settings;
  }

  /* 点底栏小开关：成功 toast/静默更新，失败必现（面板关着时走全局浮层 notify） */
  async function toggleAutoExportFromFoot() {
    var sw = footAutoSwEl;
    if (!sw || sw.getAttribute("data-busy") === "1") return;
    var want = !autoExportOn();
    sw.setAttribute("data-busy", "1");
    try {
      await saveAutoExport(want);
      notify("自动导出已" + (want ? "开启：服务每 12 小时扫描一次（静置 ≥ 2 天且未导出过的对话）" : "关闭：服务不再扫描会话目录"), "ok");
    } catch (e) {
      state.evoErr.settings = e.message;
      notify("自动导出开关保存失败：" + e.message, "bad");
    } finally {
      try { if (sw.isConnected) sw.removeAttribute("data-busy"); } catch (eB) {}
      syncAutoExportUI();
    }
  }

  function FooterRow() {
    return h("div", {
      className: "dsh-obs-foot" + (state.open ? " on" : ""),
      ref: function (el) { footBtn = el; if (el) paintFootToggle(); },
      onClick: function () { state.open ? closePanel() : openNow(); },
      title: "Obsidian 内嵌面板"
    },
      // 第 1 行：标准开关形态 —— 左「Obsidian」文字 + 右带滑块轨道（role=switch，整行可点）
      // 在线点（6px）留在文字左侧；点这里 stopPropagation，避免和卡片自身的 onClick 翻两次
      h("button", {
        type: "button",
        className: "obsbtn" + (state.open ? " on" : ""),
        role: "switch",
        "aria-checked": state.open ? "true" : "false",
        "aria-pressed": state.open ? "true" : "false",
        title: (state.open ? "关闭" : "打开") + " Obsidian 面板",
        onClick: function (e) {
          e.stopPropagation();
          state.open ? closePanel() : openNow();
        }
      },
        h("i", { className: "pulse", "aria-hidden": "true" }),
        h("span", { className: "obslbl" }, "Obsidian"),
        h("span", { className: "obssw", "aria-hidden": "true" }, h("i", null))
      ),
      // 第 2 行：收件箱入口（纯文字「收件箱 N」，无图标；仍然点击进入收件箱）
      h("div", { className: "row" },
        h("span", {
          className: "fin",
          title: "收件箱：Obsidian 送来的待处理笔记",
          ref: function (el) { footInboxEl = el; if (el) updateFootInbox(); },
          onClick: function (e) { e.stopPropagation(); openEvoInbox(); }
        }, "收件箱")
      ),
      // 第三行：自动导出（与面板「进化」页那行同一个 state.settings，读写共用一套）
      // 框=信息：靛蓝紫框里只放「标签 + ?」（与第 2 行同一个 .fin 口径）；框外=操作：开关留在框右侧
      h("div", { className: "row auto" },
        h("span", {
          className: "fin fauto",
          title: AUTO_EXPORT_TIP,
          onClick: function (e) { e.stopPropagation(); }   // 框是信息不是按钮：别把点击冒泡成面板开合
        },
          h("span", { className: "albl" }, "自动导出"),
          h("span", { className: "qm", title: AUTO_EXPORT_TIP, onClick: function (e) { e.stopPropagation(); } }, "?")
        ),
        h("span", {
          className: "asw" + (autoExportOn() ? " on" : ""),
          role: "switch",
          tabIndex: 0,
          "aria-checked": autoExportOn() ? "true" : "false",
          title: "开关：" + AUTO_EXPORT_TIP,
          ref: function (el) { footAutoSwEl = el || null; if (el) { renderFootAutoExport(); ensureSettings(); } },
          onClick: function (e) { e.stopPropagation(); toggleAutoExportFromFoot(); },
          onKeyDown: function (e) {
            if (e && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); e.stopPropagation(); toggleAutoExportFromFoot(); }
          }
        }, h("i", null))
      )
    );
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * 会话右键菜单：导出到 Obsidian（纪要档）
   * 插槽契约（app.asar → @deepseek-ai/dsh-client-ui-workspace/lib/client.js）：
   *   renderSlot("sidebar.workspaces.session.menu.item",
   *              { sessionId: node.id, displayTitle: row.title },
   *              { hookContext: menuOpenState })
   *   → 条目组件收到的 props：owner 侧的 { sessionId, displayTitle } + 该插槽声明的
   *     hooks.menuOpenState（工厂 `(_standard, state) => () => state`，即 useMenuOpenState()
   *     返回 [open, setOpen] 那一对）。条目就是一个普通函数组件，返回 role="menuitem"
   *     的按钮；点完自己 setMenuOpen(false) 关菜单。
   *   原生顺序 pin=100 / rename=200 / fork=300 / archive=400 —— 本项用 450 排在归档之后。
   * ══════════════════════════════════════════════════════════════════════════ */
  var gToastEl = null, gToastTimer = null, exportBusy = false, uiPrim = null, uiPrimWarned = false;

  /* 与面板无关的浮层提示：菜单项可能在面板关闭时被点击，面板内 toast() 那时是空操作 */
  function notify(msg, kind) {
    if (panelEl && qs(".dsh-obs-toast")) toast(msg, kind);
    else {
      try {
        if (!gToastEl || !gToastEl.parentNode) {
          gToastEl = document.createElement("div");
          gToastEl.className = "dsh-obs-gtoast";
          document.body.appendChild(gToastEl);
        }
        gToastEl.setAttribute("data-kind", kind || "ok");
        gToastEl.textContent = msg;
        gToastEl.hidden = false;
        if (gToastTimer) clearTimeout(gToastTimer);
        gToastTimer = setTimeout(function () { if (gToastEl) gToastEl.hidden = true; }, kind === "bad" ? 6500 : 3600);
      } catch (eT) { try { window.alert(msg); } catch (eT2) {} }   // 连浮层都建不出来时也不静默
    }
    try { console.log("[dsh-obsidian-panel] " + msg); } catch (eL) {}
  }

  /* DSH 原生菜单行组件（MenuItemButton）能 require 到就用它，保证与原生项像素级一致 */
  function uiPrimitives() {
    if (uiPrim) return uiPrim;
    try { uiPrim = require("@deepseek-ai/dsh-client-ui-primitives") || null; }
    catch (eP) {
      uiPrim = null;
      if (!uiPrimWarned) { uiPrimWarned = true; try { console.info("[dsh-obsidian-panel] 未取到 UI primitives，菜单项走内置样式：", eP && eP.message); } catch (eP2) {} }
    }
    return uiPrim;
  }

  /* 该插槽声明的 hook：返回 [open, setOpen]；拿不到就返回 null（只影响「点完自动关菜单」） */
  function menuCloser(props) {
    try {
      if (props && typeof props.useMenuOpenState === "function") {
        var pair = props.useMenuOpenState();
        if (pair && typeof pair[1] === "function") return pair[1];
      }
    } catch (eM) { try { console.warn("[dsh-obsidian-panel] useMenuOpenState 调用失败：", eM && eM.message); } catch (eM2) {} }
    return null;
  }

  /* 「导出到 Obsidian」菜单行 */
  function ExportSessionMenuRow(props) {
    var p = props || {};
    var sessionId = p.sessionId ? String(p.sessionId) : "";
    var displayTitle = p.displayTitle ? String(p.displayTitle) : "";
    var setMenuOpen = menuCloser(p);
    var onSelect = function () {
      if (setMenuOpen) { try { setMenuOpen(false); } catch (eC) {} }
      exportSession(sessionId, displayTitle);
    };
    var label = "导出到 Obsidian";
    var prims = uiPrimitives();
    if (prims && typeof prims.MenuItemButton === "function") {
      var icon = typeof prims.IconDownloadOutlineRegular === "function"
        ? h(prims.IconDownloadOutlineRegular, { size: 14 })
        : h("span", { className: "dsh-obs-mi-ico", "aria-hidden": "true" }, "📤");
      return h(prims.MenuItemButton, { icon: icon, onSelect: onSelect }, label);
    }
    return h("div", { className: "dsh-obs-mi-wrap" },
      h("button", { type: "button", role: "menuitem", className: "dsh-obs-mi", onClick: onSelect },
        h("span", { className: "dsh-obs-mi-ico", "aria-hidden": "true" }, "📤"),
        h("span", { className: "dsh-obs-mi-lbl" }, label)));
  }

  /* 点菜单项 → 调桥接服务落库 → 可见提示（失败必现，绝不静默） */
  function exportSession(sessionId, displayTitle) {
    if (exportBusy) { notify("上一次会话导出还在进行中，请稍候…", "bad"); return; }
    if (!sessionId) {
      notify("导出失败：菜单项没给出会话 ID（displayTitle=" + (displayTitle || "空") + "），无法定位会话文件", "bad");
      return;
    }
    exportBusy = true;
    notify("正在把会话导出成纪要…" + (displayTitle ? "（" + displayTitle + "）" : ""));
    post("/api/session/export", { sessionId: sessionId, title: displayTitle || undefined })
      .then(function (r) {
        exportBusy = false;
        if (!r || r.ok !== true) { notify("导出失败：" + ((r && r.error) || "服务未返回结果"), "bad"); return; }
        notify("已导出到 Obsidian：" + r.note + "（" + r.turns + " 轮 / " + r.chars + " 字）" +
          (r.truncated ? "（超长已截断）" : ""), "ok");
        // 面板正开着「笔记」页时刷新索引，让新笔记立刻可见
        try { if (panelEl && notesBuilt) loadIndex(true); } catch (eR) {}
      })
      .catch(function (e) {
        exportBusy = false;
        notify("导出失败：" + ((e && e.message) || e), "bad");
      });
  }

  var inject = ["slots", "locale"];
  function apply(ctx) {
    /* 插件重新激活时，上一个实例遗留的面板 DOM 不会被自动回收 → 会叠出多个面板，
       用户看到的是最旧那个（新改动全部被盖住）。激活时先清理干净。 */
    try {
      var stalePanels = document.querySelectorAll(".dsh-obs-panel");
      for (var si = 0; si < stalePanels.length; si++) {
        if (stalePanels[si].parentNode) stalePanels[si].parentNode.removeChild(stalePanels[si]);
      }
      applyInset(0);
    } catch (eStale) {}
    ctx.effect(function () {
      var style = document.createElement("style");
      style.setAttribute("data-dsh-plugin", "dsh-obsidian-panel");
      style.textContent = CSS;
      document.head.appendChild(style);
      return function () { style.remove(); };
    }, "dsh-obsidian-panel: styles");
    ctx.effect(function () {
      // 窗口尺寸变化时重新贴合（DSH 的响应式布局会改变容器宽度）
      var onResize = function () {
        try { if (state.open && panelEl) applyInset(panelEl.offsetWidth); else applyInset(0); } catch (eR) {}
      };
      window.addEventListener("resize", onResize);
      return function () { try { window.removeEventListener("resize", onResize); } catch (eR2) {} };
    }, "dsh-obsidian-panel: inset-follow");
    ctx.effect(function () {
      // 页面不可见（切走标签页 / 最小化 / 锁屏）→ 自动刷新暂停；恢复可见 → 立刻补拉一次
      var onVis = function () { evoOnVisibility(); };
      try { document.addEventListener("visibilitychange", onVis); } catch (eV) {}
      return function () { try { document.removeEventListener("visibilitychange", onVis); } catch (eV2) {} };
    }, "dsh-obsidian-panel: evo-autorefresh-visibility");
    ctx.effect(function () {
      // 卸载时必须把自动刷新计时器一并清掉（否则热重载会留下幽灵轮询，反复打接口）
      return function () { evoPollStop(); };
    }, "dsh-obsidian-panel: evo-autorefresh-timer");
    ctx.effect(function () {
      // 卸载时必须把面板与「左移」一并还原，否则重新激活会留下幽灵面板 / 宿主被撑变形
      return function () {
        try { if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl); } catch (e1) {}
        panelEl = null;
        notesBuilt = false; evoBuilt = false; ingestBuilt = false;
        try { applyInset(0); } catch (e2) {}
        try { if (insetRO) { insetRO.disconnect(); insetRO = null; } } catch (e3) {}
        try { stopInsetObserve(); } catch (e3b) {}
        // 会话菜单用的全局提示条也一并回收，避免重新激活后残留
        try { if (gToastTimer) { clearTimeout(gToastTimer); gToastTimer = null; } } catch (e4) {}
        try { if (gToastEl && gToastEl.parentNode) gToastEl.parentNode.removeChild(gToastEl); } catch (e5) {}
        gToastEl = null;
        // 自动刷新：停计时器 + 让在途结果作废（disposed 让 evoPollShouldRun 恒 false）
        disposed = true;
        try { evoPollStop(); } catch (e6) {}
      };
    }, "dsh-obsidian-panel: cleanup");
    ctx.slots.inject("sidebar.footer.action", function () {
      return ctx.slots.register({
        name: "sidebar.footer.action",
        id: "dsh-obsidian-panel",
        order: 15
      }, FooterRow);
    });
    /* 会话「…」菜单（开放插槽）：注册一行「导出到 Obsidian」（见本文件上方的契约注释） */
    ctx.slots.inject("sidebar.workspaces.session.menu.item", function () {
      return ctx.slots.register({
        name: "sidebar.workspaces.session.menu.item",
        id: "dsh-obsidian-export",
        order: 450
      }, ExportSessionMenuRow);
    });
    var t1 = setInterval(function () { applyTheme(); refreshStatus(); }, 15000);
    var t2 = setInterval(applyTheme, 60000); // 随时间主题分钟级检测
    ctx.effect(function () {
      return function () { clearInterval(t1); clearInterval(t2); };
    }, "dsh-obsidian-panel: timers");
    if (state.open) openNow();
  }
  module.exports = { apply: apply, inject: inject };
  return module.exports;
}});
