// DSH × Obsidian 知识库桥接服务（M1 + M3-A 知识自进化机制层）
// 定位：DSH 与 Obsidian 之间的数据/能力桥。DSH 面板靠它读、搜、写、管结构、看进化。
// 设计要点：
//   1. 零依赖（只用 node 内置 http/fs/path）—— 便于随插件分发，不受 pnpm/node_modules 影响。
//   2. 部署在 vault 内部的 .dsh/workbench/ 下，自动从自身位置推导 vault 根，无需硬编码。
//   3. 只碰 vault 内的 .md 与 .dsh/ 目录；所有路径做越界校验。
//      例外（有意为之）：进化任务的「已完成」归档落在 vault 内**可见**目录
//      （settings.evolution_log_folder）—— 归档本身就是知识库内容，
//      Obsidian 里能翻到、能搜、要删就在库里删；解析后的路径仍必须落在 vault 内，越界回退默认值。
//   4. 与 Obsidian 并存的写安全：写入走「临时文件 + 原子重命名」，Obsidian 会实时感知。
//   5. M3-A 只实现「机制 + 文件落盘」：设置/状态游标、技能库、项目沉淀归档、结构扫描、
//      进化报告与缺口清单、任务认领/完成。真正的思考、联网检索、模型调用由 DSH 侧完成。
// 启动：node server.mjs            （默认 127.0.0.1:8777）
//       DSH_OBSIDIAN_VAULT=<路径> node server.mjs   （显式指定 vault）
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DSH_OBSIDIAN_PORT || 8777);

// ── vault 定位：优先环境变量 → 其次 .dsh/settings.json → 最后从本文件位置推导 ──
function resolveVault() {
  if (process.env.DSH_OBSIDIAN_VAULT) return path.resolve(process.env.DSH_OBSIDIAN_VAULT);
  const guess = path.resolve(__dirname, "..", ".."); // .dsh/workbench → vault
  try {
    const s = JSON.parse(fs.readFileSync(path.join(guess, ".dsh", "settings.json"), "utf8"));
    if (s.vault) return path.resolve(s.vault);
  } catch {}
  return guess;
}
const VAULT = resolveVault();
const DSH_DIR = path.join(VAULT, ".dsh");
/** DSH 会话仓库根：%USERPROFILE%\.dsh\sessions（可用 DSH_OBSIDIAN_SESSIONS 覆盖，便于测试） */
const DSH_SESSIONS = process.env.DSH_OBSIDIAN_SESSIONS || path.join(os.homedir(), ".dsh", "sessions");
const SKIP_DIRS = new Set([".obsidian", ".git", ".trash", "node_modules", ".dsh"]);

/* ══════════════════════════════════════════════════════════════════════════
 * 投喂入库（交付 1）：文件 → .dsh/inbox/files/ 暂存 → extract.py 提取 → 知识库
 * 目录分工：
 *   .dsh/inbox/files/  暂存原件（id = 文件名，save/queue/discard 都用它定位）
 *   .dsh/inbox/*.md    【Obsidian → DSH】收件箱：queue 写的深度整理任务落这里，DSH 会来读
 *   <vault>/<attach_dir>/         入库时归档的原件（重名自动加后缀；配置项 attach_dir，默认 attachments）
 *   <vault>/<ingest_default_dir>/ 投喂入库的**默认**落点（长期保留区；配置项 ingest_default_dir，表单可改）
 *                        ⚠️ 默认值**不能**是暂存目录（如 `00-inbox`）：那里会被「清理未使用附件」定期清掉，
 *                        投喂出来的笔记连同附件会一起消失。
 * 提取统一走 workbench/extract.py（零依赖；.docx/.pptx/.xlsx/.pdf/文本 已实测；
 * 老格式 .doc/.xls/.ppt/.rtf 由 extract.py 调 DSH 自带 LibreOffice 无头转换后再抽）
 * ══════════════════════════════════════════════════════════════════════════ */
const INBOX_DIR = path.join(DSH_DIR, "inbox");
const INBOX_FILES = path.join(INBOX_DIR, "files");
/* 附件归档目录改为**配置项** attach_dir（见 attachDir()）：真实目录名由用户自己的 .dsh/settings.json 给，发布树只留通用默认值 */
/** 回收站：删除**不做真删**，只把笔记移到 .dsh/trash/<本地时间戳>__<原文件名>（可恢复） */
const TRASH_DIR = path.join(DSH_DIR, "trash");
/** 投喂暂存的**回收区**：孤儿对账只把文件 rename 到这里（.dsh/inbox/trash/<YYYY-MM-DD>/），绝不硬删 */
const INBOX_TRASH = path.join(INBOX_DIR, "trash");
/** 回收区保留天数（POST /api/ingest/trash/purge 默认值）：这是**唯一允许真删**的入口，且必须显式调用 */
const TRASH_KEEP_DAYS = 30;
/** 「投喂入库」的**默认**目标目录（配置项 ingest_default_dir）= 长期保留区。
 *  为什么默认值不能落在暂存目录：`00-inbox` 这类地方会被「清理未使用附件」定期清掉 →
 *  投喂出来的笔记连同附件会一起消失。它只是兜底：表单里用户仍可改成任何库内目录 ✓。
 *  ⚠️ 发布树只留通用默认值；用户的真实目录名放在他自己的 .dsh/settings.json（见 ingestDefaultDir()）。 */
/** 投喂清单（护栏）：每次入库追加一行 `{ts, note, images, original, source}` —— **只作恢复依据**
 *  （附件被误清理时能知道「本该有哪些」+ 从暂存区重抽 / 从 git 恢复）。
 *  红线：服务端**从不**据它自动补/改/删任何文件；GET /api/ingest/manifest 只做 present/missing 判断（只读）。 */
const ingestManifestFile = () => path.join(DSH_DIR, "ingest-manifest.jsonl");
const EXTRACT_PY = path.join(__dirname, "extract.py");
/** 请求体上限：上传走 base64（体积 ×1.33），故投喂路径单独放宽到 80MB（≈60MB 原始文件） */
const INGEST_BODY_LIMIT = 80 * 1024 * 1024;
const INGEST_MAX_BYTES = 60 * 1024 * 1024;
const EXTRACT_TIMEOUT_MS = 60000;
/**
 * 老格式（.doc/.xls/.ppt/.rtf）的提取超时：extract.py 要先经 LibreOffice 无头转换
 * （冷启动实测 ~16s，大文档更久，转换自身超时 120s）**再**抽取，故单独放宽到 180s；
 * 其余格式**行为不变**（仍 60s）。
 */
const EXTRACT_TIMEOUT_LEGACY_MS = 180000;
const LEGACY_EXT_SET = new Set([".doc", ".xls", ".ppt", ".rtf"]);
const extractTimeoutFor = (file) => (LEGACY_EXT_SET.has(path.extname(String(file || "")).toLowerCase())
  ? EXTRACT_TIMEOUT_LEGACY_MS : EXTRACT_TIMEOUT_MS);
/** PDF 抽图产物（`<原名>__imgNN.jpg` / `<原名>__page NN.png` / `<原名>__rasterNN.png`）：是派生件，不是待入库的暂存原件 */
const DERIVED_IMG_RE = /__(?:img\d{2,}|page \d{2,}|raster\d{2,})\.(?:jpe?g|png)$/i;

/**
 * 光栅转 PNG 开关（extract.py `--raster-png`）：**默认不传** —— 交付语义仍是「零依赖、
 * 只原字节直出 JPEG/PNG」。只有显式设置 DSH_INGEST_RASTER_PNG=1/true/on 才传给提取器：
 * 用 Pillow 把 FlateDecode/LZW 等原始光栅解码成 `<原名>__rasterNN.png`。
 * 代价（用户已知情）：① 依赖 Pillow（缺失时 extract.py 只报「不可用」并照常跳过，不崩）
 * ② **图片数量会明显增多**（50×50 渐变色块/图标这类以前被跳过的都会落盘），
 *    投喂任务文件的图片清单因此更长，主代理看图成本也随之上升。
 */
const INGEST_RASTER_PNG = /^(1|true|yes|on)$/i.test(String(process.env.DSH_INGEST_RASTER_PNG || "").trim());

/** extract.py 解释器：settings.python_path → 环境变量 → PATH 上的 python / python3。
 *  为什么走配置项：自带的 Python（已装 docx/pptx/openpyxl/pypdf）位置**因人而异**，
 *  把某个绝对路径写死在代码里会同时违反「零依赖可移植」与「发布树不带任何个人数据」两条。
 *  这里直接读 settings 文件（而非 readSettings）是为了避开模块初始化顺序（那个 const 此时还没定义）。
 *  取不到会在提取时明确报错，绝不静默降级。 */
/** 解释器来源说明（进 /api/settings 的 effective，便于排查"为什么没找到我的 python"） */
let PYTHON_SOURCE = "";
function resolvePython() {
  const tried = [];
  let fromSettings = "";
  try {
    const sf = path.join(DSH_DIR, "settings.json");
    const raw = readJsonFile(sf, {});
    fromSettings = raw && typeof raw.python_path === "string" ? raw.python_path.trim() : "";
    tried.push("settings.python_path=" + (fromSettings || "(空)") + "[文件" + (fs.existsSync(sf) ? "在" : "缺失") + "]");
  } catch (e) { tried.push("settings 读取异常:" + e.message); }
  const cands = [fromSettings, process.env.DSH_OBSIDIAN_PYTHON, process.env.DSH_PYTHON];
  for (const p of cands) {
    if (!p) continue;
    if (fs.existsSync(p)) { PYTHON_SOURCE = "命中 " + p + "  ← 尝试:" + tried.join("; "); return p; }
    tried.push("不存在:" + p);
  }
  PYTHON_SOURCE = "回落到 PATH 上的 python  ← 尝试:" + tried.join("; ");
  return process.platform === "win32" ? "python" : "python3";
}
const PYTHON = resolvePython();

/** 扩展名 → 粗略类型（GET /api/ingest/list 在未提取前也能给徽标） */
const KIND_BY_EXT = {
  ".pdf": "pdf", ".docx": "docx", ".pptx": "pptx", ".xlsx": "xlsx", ".xlsm": "xlsx",
  ".doc": "docx", ".ppt": "pptx", ".xls": "xlsx", ".rtf": "docx",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".jfif": "image", ".gif": "image", ".webp": "image",
  ".svg": "image", ".bmp": "image", ".avif": "image", ".ico": "image", ".tif": "image", ".tiff": "image", ".heic": "image",
  ".mp4": "media", ".webm": "media", ".mov": "media", ".m4v": "media", ".ogv": "media", ".mkv": "media",
  ".mp3": "media", ".wav": "media", ".ogg": "media", ".m4a": "media", ".flac": "media", ".aac": "media",
  ".md": "text", ".markdown": "text", ".txt": "text", ".csv": "text", ".tsv": "text", ".json": "text",
  ".log": "text", ".yml": "text", ".yaml": "text", ".html": "text", ".htm": "text", ".xml": "text",
  ".ini": "text", ".cfg": "text",
};
const kindOf = (name) => KIND_BY_EXT[extOf(name)] || "unknown";

/** 暂存/附件用的安全文件名：剥掉目录成分（防穿越）+ Windows 非法字符，保留扩展名 */
function safeFileBase(name, fallback = "file") {
  let base = path.basename(String(name || "").replace(/\\/g, "/"));
  base = base.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "_").replace(/\s+/g, " ").trim();
  base = base.replace(/^[.\s]+|[.\s]+$/g, "");   // 防「..」开头；结尾的点/空格会被 Windows 静默吃掉，先自己去掉
  if (!base) return fallback;
  const ext = path.extname(base).slice(0, 12);
  const stem = base.slice(0, base.length - ext.length).slice(0, 80).replace(/[.\s]+$/, "");
  return (stem || fallback) + ext;
}

/** 已存在则自动加 -2 / -3 …（绝不覆盖）；用尽返回 null */
function uniquePath(full) {
  if (!fs.existsSync(full)) return full;
  const dir = path.dirname(full), ext = path.extname(full), stem = path.basename(full, ext);
  for (let i = 2; i < 1000; i++) {
    const cand = path.join(dir, `${stem}-${i}${ext}`);
    if (!fs.existsSync(cand)) return cand;
  }
  return null;
}

/** 投喂提取结果内存缓存：同一份暂存文件不重复起 Python（识别 → queue 只跑一次） */
const extractCache = new Map(); // id -> { size, mtimeMs, result }

/** 调 extract.py：stdout 一行 JSON；失败/超时都转成可读错误（绝不抛到路由层） */
function runExtract(file) {
  return new Promise((resolve) => {
    let done = false, out = "", err = "", child = null, timer = null;
    const timeoutMs = extractTimeoutFor(file);
    const finish = (v) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(v);
    };
    try {
      const rasterArgs = INGEST_RASTER_PNG ? ["--raster-png"] : [];
      child = spawn(PYTHON, [EXTRACT_PY, file, ...rasterArgs], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return finish({ ok: false, error: `无法启动提取器（${PYTHON}）：${e.message}` });
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, error: `提取超时（${timeoutMs / 1000}s）：${path.basename(file)}` });
    }, timeoutMs);
    child.stdout.on("data", (c) => { out += c.toString("utf8"); if (out.length > 4_000_000) out = out.slice(-4_000_000); });
    child.stderr.on("data", (c) => { err += c.toString("utf8"); if (err.length > 4000) err = err.slice(-4000); });
    child.on("error", (e) => finish({ ok: false, error: `提取器启动失败：${e.message}（python=${PYTHON}）` }));
    child.on("close", (code) => {
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      let j = null;
      try { j = JSON.parse(lines[lines.length - 1] || ""); } catch {}
      if (j && j.ok) {
        return finish({
          ok: true, kind: String(j.kind || "unknown"), text: String(j.text || ""), truncated: !!j.truncated, meta: j.meta || {},
          // PDF 抽图（extract.py 新增字段）：原样透传，供投喂任务文件列出「图片清单」
          images: Array.isArray(j.images) ? j.images : [],
          imagesSkipped: Array.isArray(j.imagesSkipped) ? j.imagesSkipped : [],
          // 水印线索（extract.py 新增字段）：文字型水印已从正文剔除、在此留证；图片型只标记不删
          watermarkLines: Array.isArray(j.watermarkLines) ? j.watermarkLines : [],
          rasterPng: isPlainObject(j.rasterPng) ? j.rasterPng : null,
          pageRender: isPlainObject(j.pageRender) ? j.pageRender : null,
          suspectScan: Array.isArray(j.suspectScan) ? j.suspectScan : [],
          // 老格式转换（extract.py 新增字段，**纯新增**）：convertedFrom = 原扩展名（doc|xls|ppt|rtf），
          // convert = {tool:"soffice"|"libreoffice-kit", ms, ok}。非老格式一律为 null（前端据此只画不编）。
          convertedFrom: typeof j.convertedFrom === "string" ? j.convertedFrom : null,
          convert: isPlainObject(j.convert) ? j.convert : null,
        });
      }
      const tail = err.trim().split(/\r?\n/).filter(Boolean).pop() || "";
      finish({ ok: false, error: (j && j.error) || tail || `extract.py 退出码 ${code}` });
    });
  });
}
async function extractStaged(id, full) {
  let st = { size: 0, mtimeMs: 0 };
  try { const s = fs.statSync(full); st = { size: s.size, mtimeMs: s.mtimeMs }; } catch {}
  const hit = extractCache.get(id);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.result;
  const result = await runExtract(full);
  extractCache.set(id, { size: st.size, mtimeMs: st.mtimeMs, result });
  return result;
}

/** 投喂任务文件里的「内嵌图片清单」最大条数（防止 200 页扫描件把任务文件撑爆） */
const INGEST_IMG_LIST_MAX = 80;
/**
 * PDF 抽图结果 → 任务文件里的清单块（文件路径 + 页码 + 尺寸 + 疑似水印标记）。
 * 主代理据此**逐张用多模态看图**：图上的知识不在文字层里。
 * 无水印 / 无图 / 未跳过 / 无渲染时返回 []，任务文件保持原样（不破坏既有格式）。
 */
function ingestImageBlock(ex) {
  const imgs = Array.isArray(ex.images) ? ex.images : [];
  const skipped = Array.isArray(ex.imagesSkipped) ? ex.imagesSkipped : [];
  const wms = Array.isArray(ex.watermarkLines) ? ex.watermarkLines : [];
  const pr = isPlainObject(ex.pageRender) ? ex.pageRender : null;
  const suspect = Array.isArray(ex.suspectScan) ? ex.suspectScan
    : (ex.meta && Array.isArray(ex.meta.suspectScanPages) ? ex.meta.suspectScanPages : []);
  if (!imgs.length && !skipped.length && !suspect.length && !wms.length && !(pr && pr.available)) return [""];
  const out = ["", "## 内嵌图片清单（PDF 内嵌图已抽成独立文件；图上知识不在文字层里）", ""];
  if (wms.length) {
    // 文字型水印已从上方正文剔除 → 在这里留证，避免主代理把水印当成正文知识点
    out.push(`- 🏷️ 检测到 ${wms.length} 条**文字型水印**（跨页重复短行，已从正文剔除、**不是正文内容**；但水印常是版权/来源线索，故原样留证）：`, "");
    for (const w of wms.slice(0, 20)) {
      const pages = Array.isArray(w.pages) ? w.pages.join("、") : "";
      out.push(`- \`${w.text}\` · 出现 ${w.count == null ? "?" : w.count} 页（第 ${pages} 页）`);
    }
    if (wms.length > 20) out.push(`- （只列前 20 条，共 ${wms.length} 条）`);
    out.push("");
  }
  if (imgs.length) {
    const wmN = imgs.filter((im) => im && im.likelyWatermark).length;
    out.push(`- 已抽出 ${imgs.length} 张（${wmN ? `其中 **${wmN} 张疑似水印**（每页重复 logo/印章或面积 < 页面 2%，见条目末尾标记）；` : ""}**原字节直出、未重编码**，按页码排序）：`, "");
    for (const im of imgs.slice(0, INGEST_IMG_LIST_MAX)) {
      const tag = im.likelyWatermark ? " · ⚠️likelyWatermark（疑似水印，**不删**，先当来源/版权线索）" : "";
      const src = im.source === "raster" ? " · raster→PNG" : "";
      out.push(`- 第 ${im.page} 页 · ${im.w == null ? "?" : im.w}×${im.h == null ? "?" : im.h} · ${im.bytes}B · \`${im.file}\`${src}${tag}`);
    }
    if (imgs.length > INGEST_IMG_LIST_MAX) out.push(`- （只列前 ${INGEST_IMG_LIST_MAX} 张，其余见 extract.py 的 images 字段）`);
    out.push("");
  } else {
    out.push("- （本文件没有抽出任何 JPEG/PNG 内嵌图片）", "");
  }
  if (skipped.length) {
    const rasterOn = isPlainObject(ex.rasterPng) && ex.rasterPng.enabled;
    out.push(`- ⚠️ 另有 ${skipped.length} 个图像流**没抽出来**（编码不支持${rasterOn ? "，或光栅解码失败（已开 --raster-png）" : "，按零依赖原则不重编码"}）；若某页知识只在图里，需另想办法（让用户截图 / 由用户装 PyMuPDF${rasterOn ? "" : " / 或设 DSH_INGEST_RASTER_PNG=1 让服务用 Pillow 转 PNG"}）：`, "");
    for (const s of skipped.slice(0, 20)) out.push(`- 第 ${s.page == null ? "?" : s.page} 页 · ${s.kind} · ${s.reason}`);
    if (skipped.length > 20) out.push(`- （只列前 20 条，共 ${skipped.length} 条）`);
    out.push("");
  }
  if (suspect.length) out.push(`- ⚠️ 疑似**扫描页**（文字层极薄、知识大概率在图上）：第 ${suspect.join("、")} 页`, "");
  if (pr && pr.available && Array.isArray(pr.rendered) && pr.rendered.length) {
    out.push("- 扫描页已渲染为 PNG（可直接看图）：", "");
    for (const r of pr.rendered) out.push(`- 第 ${r.page} 页 · \`${r.file}\``);
    out.push("");
  } else if (suspect.length) {
    out.push(`- 扫描页渲染不可用：${(pr && pr.reason) || "PyMuPDF(fitz) 未安装"}`, "");
  }
  return out;
}

/** 投喂暂存件 → 「深度整理」任务状态索引（`GET /api/ingest/list` 每项**新增**的 deep 字段用）。
 *  痛点（用户实测）：「识别」看得出结果，可点了【让 DSH 深度整理】之后**看不出它到底做完没有**——
 *  真正的整理由 DSH 稍后做（任务文件写在 `.dsh/inbox/`，DSH 开工时改「执行中」、做完改「已完成」），
 *  故把**那份任务文件的状态**回读给面板，投喂页才能显示进度。
 *  数据源 = `.dsh/inbox/*-ingest-*.md`（POST /api/ingest/queue 写的那份；只扫这一层，不递归）。
 *  匹配口径（**与 handoffIndex 同一把尺**，不做模糊 / 包含匹配）：
 *    · 归一 = candKey（小写 + 去首部 # + 去所有空白）——「DSH 进化」与「DSH进化」视为同形；
 *    · 文件名侧：`<时间戳>-ingest-<安全化主干>` 去掉时间戳与前缀后的片段；
 *    · 正文侧：`- 暂存副本：` / `- 原始文件：` 两行的 basename（经 idToName 还原原名）与 H1 里的原名。
 *    两侧任一命中即算同一份暂存件（原文名含空格 / 全角括号 / 中文时文件名已变形，仍能靠正文匹配上）。
 *  同名多份任务（同名文件连点两次）→ 取 **mtimeMs 最新**（与 handoffIndex「同源取最新」同口径）。
 *  status：读 `- 状态：X`；无该字段（taskStatus 返回「未知」）→ 归一为「待执行」，只出三态。
 *  output：读 `- 产出：<vault 相对路径>`（DSH 完成时写；没有 → null，绝不编）。
 *  只读（红线）：不 mkdir、不写任何文件；无任务的文件不进索引，调用方给 exists:false。 */
function ingestDeepIndex() {
  const idx = new Map();                       // candKey(原名主干) → deep 条目
  let entries = [];
  try { entries = fs.readdirSync(INBOX_DIR, { withFileTypes: true }); } catch { return idx; }
  const stemOf = (name) => path.basename(String(name || ""), path.extname(String(name || "")));
  for (const e of entries) {
    if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
    const base = e.name.replace(/\.md$/i, "");
    const m = /-ingest-(.+)$/i.exec(base);
    if (!m) continue;                          // 只认投喂队列写的任务（蒸馏 / usaskill 任务不混进来）
    const full = path.join(INBOX_DIR, e.name);
    let text = "", st = null;
    try { text = fs.readFileSync(full, "utf8"); } catch { continue; }   // 读不到 = 不算存在（宁缺勿编）
    try { st = fs.statSync(full); } catch {}
    const raw = taskStatus(text);
    const entry = {
      exists: true,
      taskPath: toRel(full),
      status: /已完成/.test(raw) ? "已完成" : (/执行中/.test(raw) ? "执行中" : "待执行"),
      createdTs: Math.round((st && (st.birthtimeMs || st.ctimeMs)) || 0),
      mtimeMs: Math.round((st && st.mtimeMs) || 0),
      output: (/^\s*-\s*产出：\s*(.+)$/m.exec(text)?.[1] || "").trim() || null,
    };
    const keys = [m[1]];
    const staged = /^\s*-\s*暂存副本：\s*(.+)$/m.exec(text)?.[1];
    if (staged) keys.push(stemOf(idToName(path.basename(staged.trim()))));
    const orig = /^\s*-\s*原始文件：\s*(.+)$/m.exec(text)?.[1];
    if (orig) keys.push(stemOf(idToName(path.basename(orig.trim()))));
    const h1 = /^#\s+(.+)$/m.exec(text)?.[1];
    if (h1) keys.push(stemOf(h1.replace(/^\s*🤖\s*DSH\s*深度整理任务：\s*/, "").trim()));
    for (const k of keys) {
      const key = candKey(k);
      if (!key) continue;
      const prev = idx.get(key);
      if (prev && prev.mtimeMs >= entry.mtimeMs) continue;   // 同名多份 → 只留最新那份
      idx.set(key, entry);
    }
  }
  return idx;
}
/** 无深度整理任务时的空壳（字段与命中时**同形**，前端不必判 undefined） */
const INGEST_DEEP_NONE = { exists: false, taskPath: null, status: null, createdTs: 0, mtimeMs: 0, output: null };
/** 暂存件原名 → deep 条目（键与 ingestDeepIndex 写键**同一把尺**：原名主干 + 安全化主干各一份） */
function ingestDeepOf(idx, name) {
  const stem = path.basename(String(name || ""), path.extname(String(name || "")));
  const keys = [candKey(stem), candKey(safeName(stem, { fallback: "file", max: 30 }))];
  for (const k of keys) { const hit = k && idx.get(k); if (hit) return hit; }
  return INGEST_DEEP_NONE;
}

/** 读投喂清单里**某篇笔记**记录过的附件（只读；坏行 / 半行一律跳过，绝不打挂接口）。
 *  同一笔记可能有多条记录（多次入库 / 同名 -2 / 换目录重投）→ **合并去重**；
 *  返回该笔记「本该有」的附件相对路径（vault 相对，含 `attachments/` 里的归档原件），
 *  由调用方逐个判断 present / missing。**只读**：不 mkdir、不补文件、不改笔记。 */
function ingestManifestFor(rel) {
  const want = String(rel || "").replace(/\\/g, "/").trim().toLowerCase();
  const items = [], seen = new Set();
  let entries = 0, ts = 0;
  if (!want) return { items, entries, ts };
  let raw = "";
  try { raw = fs.readFileSync(ingestManifestFile(), "utf8"); } catch { return { items, entries, ts }; }
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o = null;
    try { o = JSON.parse(s); } catch { continue; }        // 半行 / 坏行：跳过（容忍外部写入与中途 kill）
    if (!o || typeof o !== "object") continue;
    if (String(o.note || "").replace(/\\/g, "/").toLowerCase() !== want) continue;
    entries++;
    if (Number(o.ts) > ts) ts = Number(o.ts) || 0;
    const arr = Array.isArray(o.images) ? o.images.concat([o.original]) : [o.original];
    for (const v of arr) {
      const r = String(v == null ? "" : v).replace(/\\/g, "/").trim();
      if (!r) continue;
      const k = r.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(r);
    }
  }
  return { items, entries, ts };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 暂存孤儿对账（投喂页「清理孤儿暂存」）：治理 `.dsh/inbox/files/` 只进不出
 *  用户原话：「在笔记里删除了这个文件，就把存在 .dsh/inbox/files 里的相关文件都删了」——
 *  投喂只落不清 → 暂存目录无限膨胀。这里做的是**对账**，不是硬删 ✗：
 *   · 判定单位 = **原件**（`<时间戳>__<原名>`）；派生图（`__imgNN` / `__page NN` / `__rasterNN`）**跟随原件**；
 *   · 原件「不是孤儿」⟺ ① 仍有**未完成的投喂任务**（`.dsh/inbox/*-ingest-*.md`，状态 ≠ 已完成）
 *                        ② 或**库内任一笔记**（排除 `.dsh/`）引用了它 / 它名下的派生图
 *                        ③ 或**刚投喂不久**（mtime 在宽限期内 —— 识别/抽图/交给 DSH 可能横跨很久）；
 *   · 孤儿（原件 + 它的派生图）→ `rename` 到 `.dsh/inbox/trash/<YYYY-MM-DD>/`（同盘移动，不删 ✗）+ 对账报告；
 *   · **真删只有唯一入口**：POST /api/ingest/trash/purge（必须显式调用，默认只清 >30 天的目录）。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 对账单篇笔记读取上限：超过就跳过（避免一次对账把超大文件读进内存；本库量级远用不到） */
const RECONCILE_NOTE_MAX_BYTES = 4 * 1024 * 1024;
/** 单个原件最多回传几条引用笔记（报告里同样封顶，避免响应/报告被长清单淹没） */
const RECONCILE_REF_CAP = 8;
/** 「刚投喂」宽限期（小时；0 = 关闭）：暂存件落在窗口内 → 视作**仍在投喂待处理**，不判孤儿。
 *  为什么必须有（真实库实测踩到）：投喂后的「识别 → 抽图 → 交 DSH」可能横跨数十分钟，此间文件既没有
 *  笔记引用、也还没有深度整理任务 —— 没有宽限期就会把**正在处理中**的那一批（原件 + 刚抽出来的派生图）
 *  整批列为待清理。用户要治的是**陈年堆积**，不是刚投的料；宽限期不动它，只让老孤儿可清。 */
const RECONCILE_GRACE_HOURS = 24;

/** 暂存文件名 → 原件主干（去时间戳前缀 + 去扩展名，截 80 —— 与 /api/ingest/discard 的 stemOf **同一把尺**） */
function stageStem(name) {
  const nm = idToName(String(name || ""));
  return path.basename(nm, path.extname(nm)).slice(0, 80);
}
/** 派生图 → 它归属的原件主干（`<stem>__imgNN.jpg` → `<stem>`）；不是派生件 → null */
function derivedOwnerStem(name) {
  const n = String(name || "");
  if (!DERIVED_IMG_RE.test(n)) return null;
  return n.replace(DERIVED_IMG_RE, "").replace(/__$/, "");
}
/** 扫 `.dsh/inbox/files/`（只扫这一层）：原件 / 派生图 两类；`.part` 与点开头一律不看 */
function scanStageFiles() {
  let entries = [];
  try { entries = fs.readdirSync(INBOX_FILES, { withFileTypes: true }); } catch { return { originals: [], derived: [], all: [] }; }
  const originals = [], derived = [], all = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.endsWith(".part") || e.name.startsWith(".")) continue;
    all.push(e.name);
    (DERIVED_IMG_RE.test(e.name) ? derived : originals).push(e.name);
  }
  originals.sort(); derived.sort(); all.sort();
  return { originals, derived, all };
}
/** 笔记引用索引：**一次**遍历 vault 读全部 .md 正文（排除 `.dsh/` 与 SKIP_DIRS）。
 *  为什么整篇留在内存：本库数百篇 / ≈2MB 量级，逐原件做「包含」匹配最直白也最不容易误判；
 *  删除的笔记进的是 `.dsh/trash/` → 被排除，于是「笔记删了就引用消失」自动成立 ✓。 */
function buildNoteRefIndex() {
  const notes = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;   // .dsh/（含 .dsh/trash）不进
        walk(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
        try {
          if (fs.statSync(full).size > RECONCILE_NOTE_MAX_BYTES) continue;
          notes.push({ rel: toRel(full), lower: fs.readFileSync(full, "utf8").toLowerCase() });
        } catch { /* 单篇读不到 → 跳过，不因此中断整次对账 */ }
      }
    }
  };
  walk(VAULT);
  return notes;
}
/** 单个原件的引用判据（任一命中即算「被引用」）：原件 id / 去时间戳原名 / 暂存相对路径 /
 *  绝对路径（正反斜杠两种写法）/ 它名下任一派生图文件名。大小写不敏感（Windows 盘符与扩展名大小写不一）。 */
function findStagedRefs(notes, id, derivedNames) {
  const tokens = [];
  const push = (s) => { const v = String(s || "").trim().toLowerCase(); if (v) tokens.push(v); };
  push(id);
  push(idToName(id));
  push(".dsh/inbox/files/" + id);
  const abs = path.join(INBOX_FILES, id);
  push(abs);
  push(abs.replace(/\\/g, "/"));
  for (const d of derivedNames || []) push(d);
  const out = [];
  for (const n of notes) {
    let hit = false;
    for (const t of tokens) { if (n.lower.indexOf(t) >= 0) { hit = true; break; } }
    if (hit) out.push(n.rel);
    if (out.length >= RECONCILE_REF_CAP) break;
  }
  return out;
}
/** 回收区目录名（`YYYY-MM-DD`）→ 当天 00:00 的时间戳；解析不出 → null */
function trashDirDay(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(name || ""));
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime();
  return Number.isFinite(t) ? t : null;
}
/** 对账主流程（`graceHours` 见 RECONCILE_GRACE_HOURS）。dryRun=true 时**零写盘**（不 mkdir、不 rename、不写报告）。
 *  返回 { scanned, originals, derived, graceHours, orphans, trashed, kept, reportPath } */
function reconcileStaged(dryRun, graceHours = RECONCILE_GRACE_HOURS) {
  const { originals, derived, all } = scanStageFiles();
  const notes = buildNoteRefIndex();
  const deepIdx = ingestDeepIndex();
  const derivedByStem = new Map();                 // 原件主干 → [派生图文件名]
  for (const d of derived) {
    const st = derivedOwnerStem(d);
    if (!st) continue;
    if (!derivedByStem.has(st)) derivedByStem.set(st, []);
    derivedByStem.get(st).push(d);
  }
  const day = localDay();
  const orphans = [], kept = [];
  const claimed = new Set();                       // 已被某个原件「认领」的派生图
  const wouldTrashTo = (f) => toRel(path.join(INBOX_TRASH, day, f));
  /* 「刚投喂」宽限：mtime 在窗口内 → 视作仍在投喂待处理（识别/抽图/交 DSH 可能还没走完），不判孤儿 */
  const graceMs = Math.max(0, Number(graceHours) || 0) * 3600000;
  const freshOf = (f) => {
    if (!(graceMs > 0)) return false;
    try { return Date.now() - fs.statSync(path.join(INBOX_FILES, f)).mtimeMs < graceMs; } catch { return false; }
  };
  for (const id of originals) {
    const myDerived = derivedByStem.get(stageStem(id)) || [];
    for (const d of myDerived) claimed.add(d);
    const deep = ingestDeepOf(deepIdx, idToName(id));
    const pending = !!(deep && deep.exists && deep.status !== "已完成");
    const refs = findStagedRefs(notes, id, myDerived);
    if (pending) {
      kept.push({ file: id, kind: "original", referencedBy: refs,
        reason: `仍在投喂待处理列表（深度整理任务 ${deep.taskPath || "?"}：${deep.status}）` });
      continue;
    }
    if (refs.length) {
      kept.push({ file: id, kind: "original", referencedBy: refs, reason: `被笔记引用：${refs[0]}` });
      continue;
    }
    if (freshOf(id)) {
      kept.push({ file: id, kind: "original", referencedBy: [], reason: `刚投喂（暂存 < ${graceHours} 小时，仍视作投喂待处理）` });
      continue;
    }
    orphans.push({ file: id, kind: "original", reason: "无引用（库内没有笔记引用它，也没有未完成的投喂任务）", wouldTrashTo: wouldTrashTo(id) });
    for (const d of myDerived) {
      orphans.push({ file: d, kind: "derived", reason: `跟随孤儿原件：${id}`, wouldTrashTo: wouldTrashTo(d) });
    }
  }
  for (const d of derived) {                       // 派生图没有对应原件（原件已被移除 / 改名）→ 同样是孤儿
    if (claimed.has(d)) continue;
    if (freshOf(d)) { kept.push({ file: d, kind: "derived", referencedBy: [], reason: `刚生成（暂存 < ${graceHours} 小时，仍视作投喂待处理）` }); continue; }
    orphans.push({ file: d, kind: "derived", reason: "无对应原件（暂存目录里已找不到它的原件）", wouldTrashTo: wouldTrashTo(d) });
  }
  const counts = { scanned: all.length, originals: originals.length, derived: derived.length,
    graceHours: Number(graceHours) || 0,
    orphans: orphans.length, orphansOriginal: orphans.filter((o) => o.kind === "original").length,
    orphansDerived: orphans.filter((o) => o.kind === "derived").length, kept: kept.length };
  if (dryRun) return { ...counts, orphans, trashed: [], kept, reportPath: null };
  if (!orphans.length) return { ...counts, orphans, trashed: [], kept, reportPath: null };

  const destDir = path.join(INBOX_TRASH, day);
  fs.mkdirSync(destDir, { recursive: true });
  const trashed = [], failed = [];
  for (const o of orphans) {
    const src = path.join(INBOX_FILES, o.file);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) { failed.push({ file: o.file, reason: "源文件已不在暂存目录" }); continue; }
    const dest = uniquePath(path.join(destDir, o.file));
    if (!dest) { failed.push({ file: o.file, reason: "回收区同名文件过多" }); continue; }
    try { fs.renameSync(src, dest); }
    catch (e) { failed.push({ file: o.file, reason: "移动失败：" + (e && e.message ? e.message : e) }); continue; }
    o.trashedTo = toRel(dest);
    trashed.push({ file: o.file, kind: o.kind, to: o.trashedTo });
  }
  /* 对账报告：写进同一天的回收区目录（**不删任何东西**，报告本身也是可追溯的凭证） */
  let reportPath = null;
  if (trashed.length) {
    const lines = [
      `# 暂存孤儿对账报告`, ``,
      `- 判定时间：${nowText()}`,
      `- 对账范围：\`.dsh/inbox/files/\`（原件 ${counts.originals} 个 / 派生图 ${counts.derived} 个，共 ${counts.scanned} 个）`,
      `- 本次移入回收区：${trashed.length} 个（原件 ${trashed.filter((t) => t.kind === "original").length} / 派生图 ${trashed.filter((t) => t.kind === "derived").length}）`,
      `- 保留（被引用或仍在投喂待处理列表）：${kept.length} 个`,
      `- 恢复方式：面板投喂页「回收区」里点【恢复】，或 POST /api/ingest/trash/restore {file:"<文件名>"}`,
      `- 真删入口（**唯一**）：POST /api/ingest/trash/purge（默认只清 >${TRASH_KEEP_DAYS} 天的目录）`,
      ``, `## 移入回收区`, ``,
    ];
    for (const t of trashed) {
      lines.push(`- [${t.kind === "original" ? "原件" : "派生图"}] \`${t.file}\``);
      lines.push(`  - 理由：${(orphans.find((o) => o.file === t.file) || {}).reason || ""}`);
      lines.push(`  - 去向：\`${t.to}\``);
    }
    if (failed.length) {
      lines.push(``, `## 移动失败（留在暂存目录，未动）`, ``);
      for (const f of failed) lines.push(`- \`${f.file}\` —— ${f.reason}`);
    }
    lines.push(``, `## 保留（未动）`, ``);
    if (kept.length) for (const k of kept) {
      lines.push(`- \`${k.file}\` —— ${k.reason}${k.referencedBy && k.referencedBy.length > 1 ? `（另有 ${k.referencedBy.length - 1} 篇引用）` : ""}`);
    } else lines.push(`- （无）`);
    lines.push(``);
    reportPath = path.join(destDir, "reconcile-report.md");
    try { fs.writeFileSync(reportPath, lines.join("\n"), "utf8"); reportPath = toRel(reportPath); }
    catch (e) { reportPath = null; }
  }
  return { ...counts, orphans, trashed, kept, failed, reportPath };
}

/** 首个 H1（`# 标题`）→ 其次原文件名（去扩展名） */
function guessTitle(text, name) {
  const m = /^[ \t]*#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(String(text || ""));
  if (m && m[1].trim()) return m[1].trim().slice(0, 120);
  const base = path.basename(String(name || ""), path.extname(String(name || "")));
  return base.trim() || "未命名";
}
/** 候选标签：文件名按 _ - 空格 切分（去纯数字 / 单字符，最多 3）+ 正文 #标签（最多 3），去重封顶 5 */
function guessTags(name, text) {
  const out = [];
  const push = (raw) => {
    if (out.length >= 5) return;
    const s = String(raw || "").replace(/^#+/, "").replace(/[.,;:!?、。，；：！？）)】\]]+$/, "").trim();
    if (!s || s.length > 40) return;
    if (!/[\p{L}\p{N}]/u.test(s)) return;             // 纯符号
    if (/^\d+$/.test(s)) return;                      // 纯数字
    if (out.some((x) => x.toLowerCase() === s.toLowerCase())) return;
    out.push(s);
  };
  const stem = path.basename(String(name || ""), path.extname(String(name || "")));
  for (const seg of stem.split(/[_\-.\s]+/)) {
    if (out.length >= 3) break;
    if (seg.trim().length > 1) push(seg);
  }
  const fromName = out.length;
  const cap = Math.min(5, fromName + 3);
  for (const m of String(text || "").matchAll(/(^|[\s(（>])#([^\s#\[\]()（）{}，。！？、;；:："'`]{1,40})/g)) {
    if (out.length >= cap) break;
    push(m[2]);
  }
  return out.slice(0, 5);
}
/** 从暂存 id 里还原原始文件名（`<时间戳>__<原名>`） */
const idToName = (id) => String(id || "").split("__").slice(1).join("__") || String(id || "");
/** 暂存件**绝对路径** → **相对暂存目录**的路径（不在 .dsh/inbox/files/ 内 → null）。
 *  用途：/api/ingest 的 `images[].rel`（前端缩略图优先用它：不泄露盘符/用户名，换盘符也不失效）。 */
function stageRel(file) {
  const full = String(file || "");
  if (!full) return null;
  const root = path.resolve(INBOX_FILES);
  const abs = path.resolve(full);
  if (!abs.toLowerCase().startsWith(root.toLowerCase() + path.sep)) return null;
  return path.relative(root, abs).split(path.sep).join("/");
}
/** 原件的 vault 相对路径（save 后写进 frontmatter.original） */
const ATTACH_INLINE = (ext) => {
  const mime = ATTACH_TYPES[ext] || "";
  return /^(image|video|audio)\//.test(mime) || mime === "application/pdf";
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}
// DSH 渲染端源是 dsh-app://，跨源 fetch 必须放行（原 iframe 方案不受 CORS 约束，改原生 DOM 后必需）
function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}
function fail(res, code, message) {
  json(res, code, { ok: false, error: message });
}

/* ══════════════════════════════════════════════════════════════════════════
 * 原始文件层（交付 1）：/api/raw 二进制直出 + /api/attachments 附件清单
 * 与 safeNotePath 同源的越界校验，但**不限定 .md**：只放行常见媒体/文档扩展名。
 * 用途：面板「阅读视图」渲染图片/音视频/PDF，以及后续「投喂」功能复用同一清单。
 * ══════════════════════════════════════════════════════════════════════════ */
const ATTACH_TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".jfif": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp",
  ".avif": "image/avif", ".ico": "image/x-icon",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/x-m4v", ".ogv": "video/ogg",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".flac": "audio/flac", ".aac": "audio/aac",
  ".pdf": "application/pdf",
};
/** /api/raw 额外放行纯文本类（笔记/文本文件也能直连取回，便于阅读视图兜底） */
const RAW_TYPES = {
  ...ATTACH_TYPES,
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};
const extOf = (p) => path.extname(String(p || "")).toLowerCase();

/** 仅做 vault 越界校验（不限扩展名）：越界返回 null */
function safeVaultPath(rel) {
  const clean = String(rel || "").replace(/^[/\\]+/, "").replace(/\\/g, "/");
  if (!clean) return null;
  const full = path.resolve(VAULT, clean);
  const root = path.resolve(VAULT) + path.sep;
  if (full !== path.resolve(VAULT) && !full.startsWith(root)) return null;
  return full;
}
/** /api/raw 用：vault 内 + 扩展名在白名单 → 返回绝对路径，否则 null */
function safeRawPath(rel) {
  const full = safeVaultPath(rel);
  if (!full || !RAW_TYPES[extOf(full)]) return null;
  return full;
}

/** 附件清单（图片/音视频/PDF）：mtime 倒序，最多 limit 条；/api/attachments 与 /api/index 复用 */
function listAttachments(limit = 200) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
        walk(full);
      } else if (e.isFile() && ATTACH_TYPES[extOf(e.name)]) {
        let st; try { st = fs.statSync(full); } catch { continue; }
        out.push({ path: toRel(full), name: e.name, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(VAULT);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}

/** 二进制响应：CORS 头已由 applyCors 预置；Content-Length 必须等于实际字节数 */
function sendRaw(res, full) {
  let buf;
  try { buf = fs.readFileSync(full); } catch { return fail(res, 404, "not found"); }
  res.writeHead(200, {
    "Content-Type": RAW_TYPES[extOf(full)] || "application/octet-stream",
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
  });
  res.end(buf);
}

/** 把外部相对路径安全解析到 vault 内，并限制为 .md */
function safeNotePath(rel, { mustBeMd = true } = {}) {
  const clean = String(rel || "").replace(/^[/\\]+/, "");
  const full = path.resolve(VAULT, clean);
  const root = path.resolve(VAULT) + path.sep;
  if (full !== path.resolve(VAULT) && !full.startsWith(root)) return null;
  if (mustBeMd && !full.toLowerCase().endsWith(".md")) return null;
  return full;
}
const toRel = (full) => path.relative(VAULT, full).split(path.sep).join("/");

/** 结构页「移动目录」用：把用户输入规范化成**严格的 vault 相对目录路径**。
 *  与 safeNotePath / safeVaultPath 的宽松口径（先剥前导斜杠、把 /x 当 vault 相对路径）**故意不同**：
 *  移动目录是破坏性操作，绝对路径不做「当相对路径使」的兜底 ——
 *  绝对路径（/x）、UNC（\\server\share）、盘符（C:\x）、空串、NUL、任何 `..` 段、
 *  任何以 `.` 开头的目录段（.dsh / .obsidian / .git 等系统目录）→ 一律非法，返回 null。 */
function normDirRel(rel) {
  let s = String(rel == null ? "" : rel).trim();
  if (!s || s.indexOf("\0") >= 0) return null;
  s = s.replace(/\\/g, "/");
  if (s.startsWith("/")) return null;                       // POSIX 绝对路径 / UNC(\\srv\share)
  if (/^[A-Za-z]:/.test(s)) return null;                    // 盘符绝对路径
  const segs = s.split("/").filter((x) => x !== "" && x !== ".");
  if (!segs.length) return null;
  if (segs.some((x) => x === "..")) return null;            // 越界
  if (segs.some((x) => x.startsWith("."))) return null;     // .dsh / .obsidian / .git / 任何点开头目录
  return segs.join("/");
}
/** 两个已存在路径是否指向同一个位置（仅大小写不同）——Windows 大小写不敏感，
 *  否则「把 20-notes 重命名成 20-Notes」会被误判成「目标已存在」。取不到真路径即视为不同。 */
function samePathCI(a, b) {
  try {
    const ra = fs.realpathSync.native(a), rb = fs.realpathSync.native(b);
    return ra.toLowerCase() === rb.toLowerCase();
  } catch { return false; }
}
/** 递归统计目录下的 .md 篇数（移动目录接口的 files 计数；先数后搬） */
function countMdFiles(dir) {
  let n = 0, entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (e.isDirectory()) n += countMdFiles(path.join(dir, e.name));
    else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) n++;
  }
  return n;
}

/** 极简 frontmatter 解析：只取顶层 key: value 与 tags，够面板用，不引 yaml 依赖 */
function parseFrontmatter(text) {
  const out = { frontmatter: {}, tags: [], body: text };
  if (!text.startsWith("---")) return out;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return out;
  const head = text.slice(3, end);
  out.body = text.slice(end + 4).replace(/^\s*\n/, "");
  for (const line of head.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let val = m[2].trim();
    if (key === "tags") {
      const list = val.replace(/^\[|\]$/g, "").split(/[,\s]+/).filter(Boolean);
      out.tags.push(...list.map((t) => t.replace(/^["']|["']$/g, "")));
    } else {
      out.frontmatter[key] = val.replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

/** inline #标签：先挖掉代码块/行内代码（否则 CSS 里的 #2d2415 会被当成标签），
 *  再按 Obsidian 规则剔除「以数字开头」的伪标签（干掉 2d2415 / 5fbfc2 这类色值） */
function inlineTags(body) {
  const set = new Set();
  const stripped = String(body == null ? "" : body)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ");
  for (const m of stripped.matchAll(/(^|[\s(（【\[])#([^\s#\[\]()，。！？、；;,：:]{1,40})/g)) {
    const t = m[2].replace(/[.,;:!?，。；：！？、)）"'"]+$/, "");
    if (!t) continue;
    if (/^[0-9]/.test(t)) continue;                 // Obsidian 标签不能以数字开头
    if (/^[0-9a-fA-F;:.\-\s]+$/.test(t)) continue;  // 纯十六进制/符号残留
    set.add(t);
  }
  return [...set];
}

/** 全库扫描（跳过隐藏目录与非 md）；结果做 mtime+size 缓存，避免每次全读 */
const cache = new Map(); // fullPath -> { mtimeMs, size, doc }
function scanVault() {
  const notes = [];
  const dirs = new Set();
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
        dirs.add(toRel(full));
        walk(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
        let st; try { st = fs.statSync(full); } catch { continue; }
        const hit = cache.get(full);
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) { notes.push({ ...hit.doc, path: toRel(full) }); continue; }
        let text = ""; try { text = fs.readFileSync(full, "utf8"); } catch {}
        const fm = parseFrontmatter(text);
        const doc = {
          path: toRel(full),
          title: (fm.frontmatter.title || fm.body.match(/^#\s+(.+)$/m)?.[1] || e.name.replace(/\.md$/i, "")).trim(),
          mtimeMs: st.mtimeMs,
          size: st.size,
          tags: [...new Set([...fm.tags, ...inlineTags(fm.body)])],
          frontmatter: fm.frontmatter,
        };
        cache.set(full, { mtimeMs: st.mtimeMs, size: st.size, doc });
        notes.push({ ...doc, path: toRel(full) });
      }
    }
  };
  walk(VAULT);
  notes.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { notes, dirs: [...dirs].sort() };
}

/** 索引缓存以 fullPath 为键：目录被整体移动后，把旧子树（含自身）的键全部剔除。
 *  新路径本来就不在缓存里 → 下一次 /api/index 会即时扫出新路径、不再出现旧路径；
 *  剔除旧键是为了不留脏数据（也顺带回收内存）。 */
function invalidateCacheUnder(dir) {
  const root = path.resolve(dir), prefix = root + path.sep;
  for (const k of [...cache.keys()]) {
    if (k === root || k.startsWith(prefix)) cache.delete(k);
  }
}

function readNote(full) {
  const text = fs.readFileSync(full, "utf8");
  const fm = parseFrontmatter(text);
  return { path: toRel(full), text, body: fm.body, frontmatter: fm.frontmatter, tags: [...new Set([...fm.tags, ...inlineTags(fm.body)])] };
}

/**
 * 查询分词（多词检索的基础）：
 *   按**空白 + 中英标点/符号**切词 —— \p{P}（标点）\p{S}（符号）已覆盖半角、全角与 CJK 标点，
 *   故「Hermes 自我进化」「Hermes，自我进化」「Hermes（自我进化）」切出来的词完全一致；
 *   小写化用于**匹配**，去重（同一词只算一次分、只算一次 AND 条件）；
 *   中文不强行再切（库以中文为主，先保持简单：切碎成单字会引入大量噪音命中）。
 * 例："Hermes 自我进化" → ["hermes","自我进化"]；"智能体" → ["智能体"]；"   " → []（退回旧行为）。
 */
function tokenizeQuery(q) {
  const out = [], seen = new Set();
  for (const t of String(q == null ? "" : q).toLowerCase().split(/[\s\p{P}\p{S}]+/u)) {
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** 多词命中计数（/api/recall 的 skills / archived / gaps 三段共用的匹配口径）：
 *  每个词**分别**在目标文本里做大小写不敏感子串匹配，返回命中词数；0 = 整条不入选。
 *  修复旧版「把整个查询当一串连续子串」→ 查询带空格时这三段静默 0 命中（与 notes 段同类 bug）。 */
function countTokenHits(tokens, text) {
  if (!tokens.length) return 0;
  const hay = String(text == null ? "" : text).toLowerCase();
  let n = 0;
  for (const t of tokens) if (hay.includes(t)) n++;
  return n;
}

/** 打分权重：标题 > 标签 > 正文；标题「整串」命中额外加权；正文出现次数轻微加权（封顶 5 次） */
const SCORE_TITLE = 10, SCORE_TAG = 6, SCORE_BODY = 3, SCORE_TITLE_PHRASE = 15, BODY_COUNT_CAP = 5;

/**
 * 检索核心（/api/search 与 /api/recall 共用同一套口径，两处不再各写一份）：
 *   命中规则（多词，修复「整串连续子串」导致的漏检）：
 *     先按 **AND**（查询的每个词都在标题/标签/正文里命中）取结果，matchMode="and"；
 *     若 AND 为空，再按 **OR** 兜底（至少命中 1 个词），matchMode="or"（弱匹配不与强匹配混在一起）。
 *     OR 兜底也要求 ≥1 个词命中 —— 库里确实没有的词仍返回 0 条，绝不"无词可依"地乱兜底。
 *   打分排序：标题每词 +10、标签每词 +6、正文每词 +3；标题整串命中再 +15；
 *     正文按出现次数 min(次数,5) 轻微加权。同分按 mtime 倒序（最新优先）。每条结果带 score。
 *   无检索词（q 为空/全是标点）：只按 tag 过滤、按 mtime 取前 limit 条（不读正文），与改动前一致。
 * withText=true 时把正文一并带出（供 /api/recall 自己截「正文前 80 字」，避免同一文件读两遍）；
 * /api/search 不传该选项，响应除新增 score / matchMode 外形状与改动前一致。
 * 代价（有意为之）：要按分数全局排序就不能"命中即收"，带词的查询会读全库笔记算分
 *   （无词的列举路径仍保持命中即收）。
 */
function searchNotesCore(q, { tag = "", limit = 50, withText = false } = {}) {
  const { notes } = scanVault();
  const tokens = tokenizeQuery(q);
  /** 整串（保留词间空格，只 trim+小写）—— 只用于标题「整串连续命中」的额外加权 */
  const phrase = String(q == null ? "" : q).trim().toLowerCase();
  /** 截断上限：非有限值（NaN）视为不截断，与改动前 `hits.length >= NaN` 永假的行为保持一致 */
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Number.POSITIVE_INFINITY;
  const cands = [];   // { note, score, matched, firstIdx, text }

  if (!tokens.length) {
    // 无检索词：只按 tag 过滤，mtime 倒序（scanVault 已排好），命中即收、不读正文
    for (const n of notes) {
      if (tag && !n.tags.includes(tag)) continue;
      cands.push({ note: n, score: 0, matched: 0, firstIdx: -1, text: "" });
      if (cands.length >= cap) break;
    }
  } else {
    for (const n of notes) {
      if (tag && !n.tags.includes(tag)) continue;
      let full = "";
      try { full = fs.readFileSync(path.join(VAULT, n.path), "utf8"); } catch {}
      const body = full.toLowerCase();
      const title = n.title.toLowerCase();
      const tags = n.tags.map((x) => String(x).toLowerCase());
      let score = 0, matched = 0, firstIdx = -1;
      for (const t of tokens) {
        const inTitle = title.includes(t);
        const inTag = tags.some((x) => x.includes(t));
        let cnt = 0;
        for (let i = body.indexOf(t); i >= 0; i = body.indexOf(t, i + t.length)) cnt++;
        if (!inTitle && !inTag && !cnt) continue;      // 该词三处都没有 → 不计分、不计命中
        matched++;
        if (inTitle) score += SCORE_TITLE;
        if (inTag) score += SCORE_TAG;
        if (cnt) {
          score += SCORE_BODY + Math.min(cnt, BODY_COUNT_CAP);
          const i = body.indexOf(t);
          if (i >= 0 && (firstIdx < 0 || i < firstIdx)) firstIdx = i;   // 摘要取最早一次正文命中处
        }
      }
      if (!matched) continue;
      if (phrase && title.includes(phrase)) score += SCORE_TITLE_PHRASE;
      cands.push({ note: n, score, matched, firstIdx, text: full });
    }
  }

  // AND 优先；AND 为空才 OR 兜底（"别让弱匹配悄悄混进强匹配里"）
  let pool = cands, matchMode = "and";
  if (tokens.length) {
    const strong = cands.filter((c) => c.matched === tokens.length);
    if (strong.length) {
      pool = strong;
    } else {
      pool = cands.filter((c) => c.matched > 0);       // 至少 1 个词命中；0 命中的笔记绝不入选
      matchMode = "or";
    }
  }
  pool.sort((a, b) => (b.score - a.score) || (b.note.mtimeMs - a.note.mtimeMs));
  const hits = pool.slice(0, cap).map((c) => ({
    ...c.note,
    excerpt: c.firstIdx >= 0 ? String(c.text).slice(Math.max(0, c.firstIdx - 60), c.firstIdx + 120).replace(/\s+/g, " ") : "",
    score: c.score,
    matchMode,
    ...(withText ? { text: c.text } : {}),
  }));
  // 本次检索用的模式（数组属性：JSON.stringify(hits) 不会带出，故 /api/recall 的 hits 形状不变；
  // 路由可用它给响应加顶层 matchMode）
  hits.matchMode = matchMode;
  hits.tokenized = tokens.length;
  return hits;
}

/** 原子写：避免 Obsidian 读到半截文件 */
function writeNote(full, text) {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const tmp = full + ".dsh-tmp";
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, full);
}

async function readBody(req, limit = 8 * 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) {
      const e = new Error(`body too large（上限 ${Math.round(limit / 1048576)}MB）`);
      e.status = 413;
      throw e;
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 访问 Obsidian Local REST API：自签证书 + 仅本机，故显式放宽证书校验 */
function httpsJson(url, headers = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, rejectUnauthorized: false, timeout: timeoutMs }, (r) => {
      let data = "";
      r.on("data", (c) => (data += c));
      r.on("end", () => {
        let body = {};
        try { body = JSON.parse(data); } catch {}
        resolve({ status: r.statusCode, body });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

// ── 进化目录（.dsh/evolution）：任务队列 / 日志 / 缺口清单 ──
const evoDir = (...p) => path.join(DSH_DIR, "evolution", ...p);
function listEvolution() {
  const read = (dir) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse(); } catch { return []; } };
  return { tasks: read(evoDir("tasks")), logs: read(evoDir("logs")), gaps: read(evoDir("gaps")) };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 缺口生命周期（.dsh/evolution/gaps/*.md 的条目状态）—— 解决「已解决的缺口仍被判成未解决的未知空白」
 *   条目勾选框：`- [ ] 文本` = 未解决 / `- [x] 文本` = 已解决（x 大小写均可）。
 *   兼容现状（硬规则）：**没有勾选框的旧条目一律视为「未解决」** —— 旧文件不会被误判成已解决。
 *   口径唯一来源 = parseGapItems()：/api/recall 的 gaps 段、/api/evolution 的计数、
 *   POST /api/evolution/gaps/resolve 三处共用，避免「一处按未解决、一处按全量」的分裂。
 *   边界（有意为之）：只认**条目行**（`-` / `*` 开头）；标题行、`- 生成时间：`、引用行、`（无）`
 *   占位都不算缺口条目 —— 保证出口里的每一项都是「可勾选、可解决」的真条目。
 *   ⚠️ /api/skills/candidates 的 openGaps 口径**冻结不动**（回归红线，见该段注释）：
 *   它仍按旧逻辑把归属上的条目全量计入，不受本机制影响。
 * ══════════════════════════════════════════════════════════════════════════ */
/** 条目行 = 缩进 + `-`/`*` + 可选 `[ ]`/`[x]` + 正文；分组 1 前缀、分组 2 勾选框、分组 3 正文 */
const GAP_ITEM_RE = /^(\s*[-*]\s+)(?:\[([ xX])\]\s*)?(.*)$/;

/** 解析缺口文件 → 条目数组 [{ line(1 起), text(去勾选框、trim), resolved }]；无勾选框 = 未解决 */
function parseGapItems(text) {
  const out = [];
  const lines = String(text == null ? "" : text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = GAP_ITEM_RE.exec(lines[i]);
    if (!m) continue;
    const t = String(m[3] || "").trim();
    if (!t || t === "（无）" || /^生成时间：/.test(t)) continue;   // 占位/元信息不算条目
    out.push({ line: i + 1, text: t, resolved: m[2] !== undefined && /[xX]/.test(m[2]) });
  }
  return out;
}

/** 缺口文件主题：标题 `缺口清单：<主题>` → 缺省用文件名（与 /api/evolution/report 的写出格式一致） */
function gapTopicOf(text, fileName) {
  return String(/缺口清单：\s*(.+)/.exec(String(text || ""))?.[1] || String(fileName || "").replace(/\.md$/i, "")).trim();
}

/** 缺口清单汇总（**只读**，不 mkdir 不写盘）：逐文件条目状态
 *  → [{ name, path, topic, total, openGaps, resolvedGaps, items }]（按文件名升序） */
function gapSummaries() {
  const dir = evoDir("gaps");
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md")).sort(); } catch { return []; }
  const out = [];
  for (const f of files) {
    const full = path.join(dir, f);
    let text = "";
    try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
    const items = parseGapItems(text);
    const resolvedGaps = items.filter((it) => it.resolved).length;
    out.push({
      name: f, path: toRel(full), topic: gapTopicOf(text, f),
      total: items.length, openGaps: items.length - resolvedGaps, resolvedGaps, items,
    });
  }
  return out;
}

/** 缺口计数（**全库口径**，供 /api/evolution 用）：{ openGaps, resolvedGaps } */
function gapTotals(list) {
  const arr = list || gapSummaries();
  return arr.reduce((a, g) => ({ openGaps: a.openGaps + g.openGaps, resolvedGaps: a.resolvedGaps + g.resolvedGaps }),
    { openGaps: 0, resolvedGaps: 0 });
}

/** 解决说明后缀（本地日期，只追加不改写）：`（已解决 2026-10-07：<note>）`；note 空则省略冒号段 */
function gapResolvedSuffix(note) {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const n = String(note == null ? "" : note).trim().replace(/\s*\n\s*/g, " ");
  return n ? `（已解决 ${day}：${n}）` : `（已解决 ${day}）`;
}

/** 把 body.file 解析成 `.dsh/evolution/gaps/` 内的绝对路径；越界/非法 → { error }（调用方一律 400）
 *  接受三种写法：`.dsh/evolution/gaps/x.md`（vault 相对） / `evolution/gaps/x.md` / 纯文件名 `x.md`。
 *  先归一化反斜杠与 `./`，再 path.resolve + 包含性校验：`..`、绝对路径、子目录、非 .md → 全部拒绝。 */
function resolveGapFilePath(raw) {
  const s = String(raw == null ? "" : raw).trim().replace(/\\/g, "/");
  if (!s) return { error: "file is required（缺口文件名，或 .dsh/evolution/gaps/ 内的 vault 相对路径）" };
  if (s.includes("\0")) return { error: "file 含非法字符" };
  const base = ".dsh/evolution/gaps";
  const rel = s.replace(/^\.\//, "");
  let name;
  if (rel.startsWith(base + "/")) name = rel.slice(base.length + 1);
  else if (rel.startsWith("evolution/gaps/")) name = rel.slice("evolution/gaps/".length);
  else if (!rel.includes("/")) name = rel;                       // 纯文件名：拼进 gaps 目录后仍做包含性校验
  else return { error: `file 越界：必须位于 ${base}/ 内（不接受绝对路径、.. 或子目录）` };
  if (!name || name === "." || name === ".." || name.includes("/")) return { error: `file 越界：必须位于 ${base}/ 内` };
  if (!/\.md$/i.test(name)) return { error: `file 必须是 ${base}/ 内的 .md 文件` };
  const dir = path.resolve(evoDir("gaps"));
  const full = path.resolve(dir, name);
  const inside = path.relative(dir, full);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside) || path.dirname(full) !== dir) {
    return { error: `file 越界：必须位于 ${base}/ 内` };
  }
  return { full, name, rel: `${base}/${name}` };
}

function createEvolutionTask(topic, kind = "auto") {
  const dir = evoDir("tasks");
  fs.mkdirSync(dir, { recursive: true });
  const ts = stamp();   // 本地时间戳（文件名给人看，用 UTC 会让本地凌晨的日期差一天）
  const safe = String(topic || "auto").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40);
  const file = path.join(dir, `${ts}-${safe}.md`);
  writeNote(file, [
    `# 🧬 自我进化任务`,
    `- 主题：${topic}`,
    `- 类型：${kind}`,
    `- 创建：${new Date().toLocaleString("zh-CN")}`,
    `- 状态：待执行`,
    ``,
    `DSH 执行步骤：`,
    `1. 联网检索主题相关知识`,
    `2. 对照库内相关笔记，找出可补充点`,
    `3. 提炼新笔记写入知识库（带 dsh-processed 标签）`,
    `4. 产出缺口清单 → .dsh/evolution/gaps/`,
    `5. 日志 → .dsh/evolution/logs/`,
    ``,
  ].join("\n"));
  return file;
}

// ══════════════════════════════════════════════════════════════════════════
// M3-A 知识自进化机制层
// 契约目录：.dsh/{settings.json, state.json, skills/, evolution/{tasks,logs,gaps}}
// 本层只做「机制 + 落盘」，不做思考/联网/模型调用（由 DSH 侧完成）。
// ══════════════════════════════════════════════════════════════════════════

/** settings.json 默认值：读取时与文件内容深度合并，缺字段一律用默认。
 *  ⚠️ 这里**只放通用默认值**：任何"用户自己的目录名 / 本机路径"都不写死在这里，
 *  一律由用户在 `<vault>/.dsh/settings.json` 里覆盖（那个文件在库里、永远不进公开仓库）。
 *  理由：发布树要求 0 命中"库名 / 目录名 / 本机盘符路径"（见 docs/PACKAGING.md 的 9 类扫描）。 */
const SETTINGS_DEFAULT = {
  auto_archive: true,
  /** 归档目录（笔记/会话纪要的落点） */
  archive_folder: "dsh-archive",
  /** 进化任务「已完成」归档目录（vault 内**可见**目录）：
   *  归档本身就是知识库内容 —— 在 Obsidian 里能翻到、能搜、要删直接在库里删。
   *  旧的隐藏目录 .dsh/evolution/tasks/archive/ 已弃用（启动时一次性迁移过来）。 */
  evolution_log_folder: "dsh-archive/evolution-log",
  /** 附件归档目录（投喂原件 / 内嵌图复制到 <vault>/<attach_dir>/） */
  attach_dir: "attachments",
  /** 投喂入库的**默认**目标目录（表单里可改） */
  ingest_default_dir: "ingest-archive",
  /** 技能卡单向导出（镜像）目录：<vault>/<skill_mirror_folder>/ */
  skill_mirror_folder: "dsh-skills",
  /** extract.py 解释器绝对路径（留空 = 走环境变量 / PATH）；自带 Python 的位置因人而异，故放这里 */
  python_path: "",
  processed_tag: "dsh-processed",
  evolution: { note_folder: "dsh-learning", sources: [], index_after_learn: true },
  /** 自动导出对话（面板「进化」页开关）：开启后服务每 12h 扫描会话目录，静置 ≥ 2 天且未导出过的会话自动导出；默认关 */
  auto_export_sessions: false,
};
/** state.json 默认值（进化状态游标）；exportedSessions = 已自动导出过的会话目录名（去重记录） */
const STATE_DEFAULT = { lastScanAt: null, processedCursor: null, archiveCount: 0, lastReport: null, exportedSessions: [] };

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** 文件名时间戳：**本地时间** YYYY-MM-DD-HH-mm-ss（文件名是给人看的，UTC 会让日期差一天） */
const stamp = () => {
  const p = (n) => String(n).padStart(2, "0");
  const d = new Date();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};
/** 人类可读时间（写进正文）：与既有任务文件保持一致 */
const nowText = () => new Date().toLocaleString("zh-CN");
/** 本地日期 YYYY-MM-DD（归档笔记名前缀；用本地时区，避免凌晨归档被记成前一天） */
function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** 人类可读的本地时间（纪要头部的时间范围用） */
function localTime(ms) {
  const p = (n) => String(n).padStart(2, "0");
  const d = new Date(ms);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 会话纪要（交付 2）：把 DSH 会话读成 markdown 纪要，走归档通路落进知识库
 * 数据源：%USERPROFILE%\.dsh\sessions\--<工作区slug>--\<会话目录>\session.v4.jsonl.zstd
 *   - zstd 压缩；DSH 是「一次追加写一帧」，整个文件是 N 个 zstd 帧首尾相接，
 *     而 zlib.zstdDecompressSync 只解第一帧 → 必须按魔数逐帧解（见 zstdDecompressAll）。
 *   - 每行一条 JSON 记录，字段以 type 区分（session / turn/start / user/message / assistant/message / …）。
 * 抽取规则（纪要档）：
 *   保留  user/message、assistant/message 里 type==="text" 的正文；
 *   丢弃  reasoning（思考）、tool-call（工具调用）、tool/result 与 tool 角色消息、
 *         system/message（系统提示）、request/*、step/*、session-log-*、subagent/* 等事件。
 *   消息没有纯文本内容时整条跳过（不写空块）。
 * ══════════════════════════════════════════════════════════════════════════ */
const SESSION_FILE = "session.v4.jsonl.zstd";
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** 会话纪要正文上限（与投喂提取同一档位：20 万字符） */
const SESSION_MEMO_LIMIT = 200000;

/** 逐帧解压：从每个 zstd 魔数处各解一帧（假魔数解不出来就被 try 吞掉），按偏移顺序拼接 */
function zstdDecompressAll(buf) {
  const parts = [];
  let i = buf.indexOf(ZSTD_MAGIC, 0);
  while (i >= 0) {
    try {
      const s = zlib.zstdDecompressSync(buf.subarray(i)).toString("utf8");
      if (s) parts.push(s.endsWith("\n") ? s : s + "\n");   // 保证帧与帧之间不粘行
    } catch {}
    i = buf.indexOf(ZSTD_MAGIC, i + 4);
  }
  return parts.join("");
}

/** 会话目录清单（按 mtime 倒序）；sessions 根不存在时返回空数组而不是报错 */
function listSessionDirs() {
  let slugs;
  try { slugs = fs.readdirSync(DSH_SESSIONS, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const s of slugs) {
    if (!s.isDirectory()) continue;
    const slugDir = path.join(DSH_SESSIONS, s.name);
    let kids;
    try { kids = fs.readdirSync(slugDir, { withFileTypes: true }); } catch { continue; }
    for (const k of kids) {
      if (!k.isDirectory()) continue;
      const dirFull = path.join(slugDir, k.name);
      const file = path.join(dirFull, SESSION_FILE);
      let st;
      try { st = fs.statSync(file); if (!st.isFile()) continue; } catch { continue; }
      out.push({
        workspace: s.name, name: k.name,
        dir: `${s.name}/${k.name}`,           // sessions 根下的相对路径（用于 dir 参数）
        full: dirFull, file,
        mtimeMs: st.mtimeMs, bytes: st.size,
      });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** 只读会话文件头部（≤256KB）解出第一条 session 记录，用于按内层 id 反查目录 */
function sessionHead(file) {
  try {
    const fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, 262144));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of zstdDecompressAll(buf).split(/\r?\n/)) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o && o.type === "session") return { id: o.id ? String(o.id) : "" };
    }
  } catch {}
  return null;
}

/** 定位一个会话目录：dir（相对路径或目录名，优先）→ sessionId（目录名比对 → 内层 id 反查） */
function locateSession({ dir, sessionId } = {}) {
  const all = listSessionDirs();
  const want = String(dir ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (want) {
    const hit = all.find((s) => s.dir === want)
      || all.find((s) => s.name === want || s.name === want.split("/").pop());
    if (hit) return hit;
  }
  const id = String(sessionId ?? "").trim();
  if (id) {
    const bare = id.replace(/^session-/, "");
    const byName = all.find((s) => s.name === id || s.name === bare || s.name === `session-${bare}`);
    if (byName) return byName;
    const byHead = all.find((s) => {
      const h = sessionHead(s.file);
      if (!h || !h.id) return false;
      const hb = h.id.replace(/^session-/, "");
      return h.id === id || h.id === bare || hb === bare || hb === id;
    });
    if (byHead) return byHead;
  }
  return null;
}

/** 一条消息里的纯文本：只认 content[].type === "text"，其余（reasoning/tool-call/image…）一律丢弃 */
function messageText(msg) {
  const content = msg && Array.isArray(msg.content) ? msg.content : [];
  const parts = [];
  for (const c of content) {
    if (!c || c.type !== "text") continue;
    const s = String(c.text ?? "").trim();
    if (s) parts.push(s);
  }
  return parts.join("\n\n").trim();
}

/** 抽取纪要：按时间顺序的用户/助手正文块 + 轮次 + 时间范围 + 会话标题 */
function extractSessionMemo(records) {
  const blocks = [];
  const turns = new Set();
  let title = "", first = 0, last = 0, skipped = 0, noise = 0;
  for (const o of records) {
    const t = o && o.type;
    const d = o && o.data;
    const time = Number(o && o.time) || 0;
    if (time) { if (!first || time < first) first = time; if (time > last) last = time; }
    if (t === "turn/start" && d && Number.isFinite(Number(d.turn))) turns.add(Number(d.turn));
    if (t === "session/title" && d && d.title && !title) title = String(d.title).trim();
    if (t !== "user/message" && t !== "assistant/message") continue;
    // 注意字段形状不同：user/message 的消息体就在 data 上，assistant/message 在 data.message 上
    const msg = t === "user/message" ? d : (d && d.message);
    if (!msg) continue;
    const role = String(msg.role || "");
    if (t === "user/message") {
      // 只留真人/上游 agent 直接发的；runtime-context、skill-catalog、goal、tool-jobs、
      // repeat-tool-reminder、compact-checkpoint 等注入的「伪用户消息」都算噪音
      const kind = msg.source && msg.source.kind ? String(msg.source.kind) : "";
      if (kind && kind !== "user") { noise++; continue; }
    } else if (role !== "assistant") continue;
    const text = messageText(msg);
    if (!text) { skipped++; continue; }                    // 拿不到纯文本（纯图片/纯工具调用）→ 跳过
    blocks.push({ role: t === "user/message" ? "用户" : "助手", text });
  }
  return { blocks, turns: turns.size, title, first, last, skipped, noise, records: records.length };
}

/** 组装纪要 markdown：开头一句统计，然后按时间顺序分块 */
function buildSessionMemo(memo) {
  const range = memo.first && memo.last ? `${localTime(memo.first)} ~ ${localTime(memo.last)}` : "时间未知";
  const head = [
    `> 📊 会话纪要：共 **${memo.turns}** 轮 · ${range} · 正文 ${memo.blocks.length} 条`,
    `> 已剔除思考过程、工具调用与工具结果、系统事件（保留用户与助手正文）。由 DSH 会话导出。`,
    "",
    "",
  ].join("\n");
  const body = memo.blocks.map((b) => `**${b.role}**：\n\n${b.text}`).join("\n\n");
  let text = head + (body || "_（该会话没有可导出的用户/助手正文）_");
  let truncated = false;
  if (text.length > SESSION_MEMO_LIMIT) {
    truncated = true;
    text = text.slice(0, SESSION_MEMO_LIMIT) + `\n\n> ⚠️ 内容超过 ${SESSION_MEMO_LIMIT} 字符上限，已截断。\n`;
  }
  return { text, truncated };
}

/** 深度合并：对象递归合并，数组/标量整体覆盖（PUT /api/settings 的语义基础） */
function deepMerge(base, patch) {
  const out = isPlainObject(base) ? { ...base } : {};
  if (!isPlainObject(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : Array.isArray(v) ? v.slice() : v;
  }
  return out;
}

/** 读 JSON 对象文件；缺失/损坏时回落到默认值（不让坏文件把接口打挂） */
function readJsonFile(file, def) {
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf8"));
    /* ⚠️ 这里**不能**调用 `isPlainObject()`：它是 `const` 箭头（不提升），而本函数在**模块加载早期**
     *  （resolvePython 在文件顶部就会调用）也会被调用 —— 那时 isPlainObject 还在 TDZ，
     *  异常会被下面的 catch 吞掉、**静默返回空对象**（实测：settings 文件明明在，python_path 却读成空）。
     *  故判断内联在此，保持本函数只依赖 require 期就绪的东西。 */
    return (o && typeof o === "object" && !Array.isArray(o)) ? o : { ...def };
  } catch {
    return { ...def };
  }
}

// ── 设置（.dsh/settings.json） ──
const settingsFile = () => path.join(DSH_DIR, "settings.json");
/** 已知字段做类型收敛，避免脏值传到面板与 DSH 侧 */
function normalizeSettings(raw) {
  const o = deepMerge(SETTINGS_DEFAULT, raw);
  const str = (v, d) => (typeof v === "string" && v.trim() ? v.trim() : d);
  o.auto_archive = !!o.auto_archive;
  /** 布尔开关：只认真正的 true，脏值一律回落 false（默认关 = 不扫描） */
  o.auto_export_sessions = o.auto_export_sessions === true;
  o.archive_folder = str(o.archive_folder, SETTINGS_DEFAULT.archive_folder);
  o.evolution_log_folder = str(o.evolution_log_folder, SETTINGS_DEFAULT.evolution_log_folder);
  o.attach_dir = str(o.attach_dir, SETTINGS_DEFAULT.attach_dir);
  o.ingest_default_dir = str(o.ingest_default_dir, SETTINGS_DEFAULT.ingest_default_dir);
  o.skill_mirror_folder = str(o.skill_mirror_folder, SETTINGS_DEFAULT.skill_mirror_folder);
  o.python_path = str(o.python_path, SETTINGS_DEFAULT.python_path);
  o.processed_tag = str(o.processed_tag, SETTINGS_DEFAULT.processed_tag);
  const evo = isPlainObject(o.evolution) ? o.evolution : {};
  o.evolution = {
    ...evo,
    note_folder: str(evo.note_folder, SETTINGS_DEFAULT.evolution.note_folder),
    sources: Array.isArray(evo.sources)
      ? evo.sources.map(String).filter(Boolean)
      : str(evo.sources, "") ? [String(evo.sources)] : SETTINGS_DEFAULT.evolution.sources.slice(),
    index_after_learn: evo.index_after_learn !== false,
  };
  return o;
}
const readSettings = () => normalizeSettings(readJsonFile(settingsFile(), {}));

/* ── 目录名解析：都走 settings，仓库里只留通用默认值 ──────────────────────────────
 *  为什么不让这些名字以常量形式出现在代码里：它们是**用户库里的真实目录名**，
 *  写死在源码里就会随发布树一起公开（违反"发布树不带任何个人数据"）。
 *  normDirRel 会拒掉绝对路径 / 盘符 / 任何 `..` / 点开头目录，safeDir 再兜一层"必须在 vault 内"。 */
/** 附件归档目录（配置项 attach_dir）→ vault 内绝对路径；非法/越界则回落到默认值 */
function resolveDirSetting(key) {
  const s = readSettings();
  return safeDir(normDirRel(s[key]) || "") || safeDir(SETTINGS_DEFAULT[key]);
}
const attachDir = () => resolveDirSetting("attach_dir");
const ingestDefaultDir = () => resolveDirSetting("ingest_default_dir");
/** 技能镜像目录名（相对名，不是绝对路径）：与 mirrorDir() 配套 */
function skillMirrorName() {
  const s = readSettings();
  return normDirRel(s.skill_mirror_folder) || SETTINGS_DEFAULT.skill_mirror_folder;
}
/** 设置面板/DSH 侧要看的"**实际生效**的目录"（只读；用于核对配置有没有生效） */
function effectiveDirs() {
  return {
    archive_folder: readSettings().archive_folder,
    evolution_log_folder: readSettings().evolution_log_folder,
    attach_dir: toRel(attachDir()),
    ingest_default_dir: toRel(ingestDefaultDir()),
    skill_mirror_folder: skillMirrorName(),
    python: PYTHON,
    python_source: PYTHON_SOURCE,
  };
}
function writeSettings(next) {
  writeNote(settingsFile(), JSON.stringify(next, null, 2) + "\n");
  return next;
}

// ── 状态游标（.dsh/state.json） ──
const stateFile = () => path.join(DSH_DIR, "state.json");
/** 读状态：与默认值合并；exportedSessions 收敛成字符串数组（脏值不让接口打挂） */
function readState() {
  const s = deepMerge(STATE_DEFAULT, readJsonFile(stateFile(), STATE_DEFAULT));
  s.exportedSessions = Array.isArray(s.exportedSessions)
    ? [...new Set(s.exportedSessions.map((x) => String(x).trim()).filter(Boolean))]
    : [];
  return s;
}
/** 局部更新状态并写回（PATCH 语义），返回合并后的完整状态 */
function writeState(patch) {
  const next = deepMerge(readState(), patch);
  writeNote(stateFile(), JSON.stringify(next, null, 2) + "\n");
  return next;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 可度量闭环（借鉴 Hermes「生成候选 → 度量 → 保留更好的」）
 *   `.dsh/stats.jsonl` 追加式事件账本：每行一个 JSON，记录「某个方法/笔记/任务用过、结果如何」。
 *   只增不改 —— 不做读-改-写，因此不存在「半截覆盖」窗口；历史永不重写。
 *   事件形状：{"ts":<ms>,"kind":"skill|note|task|prompt","id":"<相对路径或技能名/提示词名>",
 *             "outcome":"success|rework|fail","note":"<可选>","actor":"dsh"}
 *   kind=prompt（借鉴清单第 4 条）：提示词/模板/检查清单也能像技能一样记账 —— id = 提示词名（或
 *     `.dsh/prompts/<名>.md` 相对路径），口径与 skill 完全一致，**只作为字符串存账、不参与路径拼接**。
 *   并发/半行防护：
 *     ① 进程内写入全部是**同步** appendFileSync（Node 单线程 → 两次写入不可能交错）；
 *     ② 每次只写**一整行**（JSON.stringify 会把换行/回车转义成 \n \r，故一行必是完整记录）且以 \n 结尾；
 *     ③ 读取端对坏行、未完成行一律跳过并计数 —— 一行坏 JSON 绝不打挂接口。
 *   越界防护：id 只作为**字符串**存进 JSON，从不参与任何路径拼接 → 结构上不可能写到 .dsh/ 之外。
 * ══════════════════════════════════════════════════════════════════════════ */
const STATS_KINDS = Object.freeze(["skill", "note", "task", "prompt"]);
const STATS_OUTCOMES = Object.freeze(["success", "rework", "fail"]);
const STATS_ID_MAX = 400;
const STATS_NOTE_MAX = 500;
const statsFile = () => path.join(DSH_DIR, "stats.jsonl");

/** id 清洗：去控制字符、反斜杠统一成 `/`、trim、限长；空 → null（调用方回 400） */
function normalizeStatsId(raw) {
  const s = String(raw == null ? "" : raw)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\\/g, "/")
    .trim();
  return s ? s.slice(0, STATS_ID_MAX) : null;
}

/** 追加一条事件（同步、单行、以 \n 结尾）。返回写入的事件对象。
 *  **防残行粘连**：若文件当前不以 \n 结尾（外部写入方留下半行 / 上次被中途 kill），
 *  先补一个 \n 再写 —— 否则新事件会被粘到那半行后面，一起变成坏行（实测会静默丢一条记录）。
 *  读取端本来就能容忍残行，但"容忍"不等于"该丢"；这里用 O(1) 的尾字节探测把它堵死。 */
/** JSONL 追加的 **O(1) 防残行粘连**：文件当前不以 \n 结尾（外部写入方留半行 / 上次被中途 kill）→ 先补一个 \n，
 *  否则新记录会被粘到那半行后面、一起变成坏行（实测会静默丢一条记录）。
 *  读取端本来就能容忍残行，但「容忍」不等于「该丢」；stats.jsonl 与 metrics.jsonl **共用**这一份实现。 */
function jsonlPendingPrefix(file) {
  try {
    const st = fs.statSync(file);
    if (st.size > 0) {
      const fd = fs.openSync(file, "r");
      try {
        const b = Buffer.alloc(1);
        fs.readSync(fd, b, 0, 1, st.size - 1);
        if (b[0] !== 0x0a) return "\n";
      } finally { fs.closeSync(fd); }
    }
  } catch {}                                   // 文件不存在/读不到 → 无需补换行
  return "";
}

/** 追加**一整行** JSON（同步、以 \n 结尾、只增不改）。obj 必须可 JSON.stringify——
 *  换行/回车会被转义，故一行必是完整记录，绝不会把一条记录劈成两行。 */
function appendJsonlLine(file, obj) {
  fs.mkdirSync(DSH_DIR, { recursive: true });
  fs.appendFileSync(file, jsonlPendingPrefix(file) + JSON.stringify(obj) + "\n", "utf8");
}

function appendStatsEvent({ kind, id, outcome, note }) {
  const ev = { ts: Date.now(), kind, id, outcome };
  if (note) ev.note = String(note).slice(0, STATS_NOTE_MAX);
  ev.actor = "dsh";
  appendJsonlLine(statsFile(), ev);
  return ev;
}

/** 读账本原文：坏行跳过并计数。文件不存在 = 空账本（不是错误）。
 *  末尾**没有 \n** 的残行视为「可能正在写」→ 不解析也不计入 bad（写入方写完就会补上 \n）。 */
function readStatsRaw() {
  let buf;
  try { buf = fs.readFileSync(statsFile(), "utf8"); } catch { return { events: [], bad: 0, pending: false }; }
  const lastNl = buf.lastIndexOf("\n");
  const pending = buf.length > 0 && lastNl !== buf.length - 1;
  const complete = pending ? buf.slice(0, lastNl + 1) : buf;
  const events = [];
  let bad = 0;
  for (const line of complete.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let o = null;
    try { o = JSON.parse(t); } catch { bad++; continue; }          // 坏 JSON → 跳过并计数
    if (!isPlainObject(o) || !STATS_KINDS.includes(o.kind) || !STATS_OUTCOMES.includes(o.outcome)) { bad++; continue; }
    const id = normalizeStatsId(o.id);
    if (!id) { bad++; continue; }
    events.push({
      ts: Number(o.ts) || 0, kind: o.kind, id, outcome: o.outcome,
      note: typeof o.note === "string" ? o.note : "",
      actor: typeof o.actor === "string" ? o.actor : "dsh",
    });
  }
  return { events, bad, pending };
}

/** 账本快照缓存（键 = size:mtimeMs）：/api/recall 每轮都要读度量，不能每次都全量重解析 */
let statsCache = { key: "", data: null };
function statsSnapshot() {
  let st = null;
  try { st = fs.statSync(statsFile()); } catch { return { events: [], bad: 0, pending: false }; }
  const key = `${st.size}:${st.mtimeMs}`;
  if (statsCache.data && statsCache.key === key) return statsCache.data;
  const data = readStatsRaw();
  statsCache = { key, data };
  return data;
}

/** 度量分（可解释 + 有置信度意识）：
 *   smoothed = (success + 0.5*rework + 1) / (used + 2)      // 拉普拉斯平滑（α=1）；rework 记半分
 *   score    = round(100 * (smoothed - 0.5) * 10) / 10      // 平移到「无记录 = 0」的有符号分
 *   性质：used=0 → 恰好 0；一次 success ≈ +16.7（而非 +100）；样本越多越贴近真实成功率；
 *         取值恒在 (-50, +50) 内 —— 一次好运拿不到「极高分」，一次失败也不会被打死。
 *   为什么 rework 记半分：返工 = 能用但没一次成，不该与 success / fail 等价。
 *   为什么平滑：没有平滑时 1/1 与 50/50 同分，会把「只试过一次」的方法顶到最前 —— 正是要避免的。 */
function statsScoreOf({ success, rework, used }) {
  const smoothed = (success + 0.5 * rework + 1) / (used + 2);
  return Math.round(100 * (smoothed - 0.5) * 10) / 10;
}

/** 置信度门槛 + **三态记录**（缺陷 2 修复：把"样本不足"与"没有记录"分开）：
 *    used = 0                     → "none"         没有记录（账本里查不到这个 id）
 *    0 < used < 阈值              → "insufficient" 有记录但**样本不足**，不当结论（排序不加不减）
 *    used ≥ 阈值 且 score ≥ +10   → "positive"
 *    used ≥ 阈值 且 score ≤ -10   → "negative"
 *    used ≥ 阈值 但证据中性       → "insufficient" 样本够了但不足以定性（同样不加不减）
 *  口径同源：/api/score（GET/POST）、/api/recall 的 notes/skills 全部走这一个函数。 */
const STATS_POS_MIN_USED = 2, STATS_POS_MIN_SCORE = 10;
const STATS_NEG_MIN_USED = 2, STATS_NEG_MAX_SCORE = -10;

function statsRecordOf({ used, score }) {
  if (!used) return "none";
  if (used < STATS_POS_MIN_USED || used < STATS_NEG_MIN_USED) return "insufficient";
  if (score >= STATS_POS_MIN_SCORE) return "positive";
  if (score <= STATS_NEG_MAX_SCORE) return "negative";
  return "insufficient";               // 样本已够但证据中性 → 不下结论
}

/** 无记录时的零值（**绝不返回 null**，面板/DSH 端不必做空判断） */
const STATS_ZERO = Object.freeze({ used: 0, success: 0, rework: 0, fail: 0, score: 0, record: "none", lastTs: 0 });

/** 全量汇总：Map<kind\u0000id, {kind,id,used,success,rework,fail,lastTs,score,record}> */
function statsIndex() {
  const { events, bad, pending } = statsSnapshot();
  const map = new Map();
  for (const e of events) {
    const k = `${e.kind}\u0000${e.id}`;
    let a = map.get(k);
    if (!a) { a = { kind: e.kind, id: e.id, used: 0, success: 0, rework: 0, fail: 0, lastTs: 0 }; map.set(k, a); }
    a.used++;
    a[e.outcome]++;
    if (e.ts > a.lastTs) a.lastTs = e.ts;
  }
  for (const a of map.values()) {
    a.score = statsScoreOf(a);
    a.record = statsRecordOf(a);
  }
  return { map, events, bad, pending };
}

/** 按 id 试多个候选键取值（技能：技能名 → 卡相对路径；笔记：vault 相对路径），全无 → STATS_ZERO */
function statsLookup(map, kind, ...ids) {
  for (const raw of ids) {
    const id = normalizeStatsId(raw);
    if (!id) continue;
    const a = map.get(`${kind}\u0000${id}`);
    if (a) return a;
  }
  return STATS_ZERO;
}

/** 出口形状：扁平字段 used/success/rework/fail/record + 统一入口 `stats`（含 score）。
 *  注意：`notes` 段原有的 `score` 是**相关度分**（回归红线，不得覆盖），
 *  度量分的统一取法是 `stats.score`；`skills` 段额外给一个扁平别名 `score`。 */
function statsFields(st) {
  const s = st || STATS_ZERO;
  return {
    used: s.used, success: s.success, rework: s.rework, fail: s.fail, record: s.record,
    stats: { used: s.used, success: s.success, rework: s.rework, fail: s.fail, score: s.score, record: s.record, lastTs: s.lastTs || 0 },
  };
}

/** 排序权重：有正向记录排前（0）→ 无记录 / **样本不足**（1）→ 有负向记录排后（2） */
const STATS_RANK = { positive: 0, none: 1, insufficient: 1, negative: 2 };

/* ── 度量加成（缺陷 3 修复：度量必须**参与排序**，不能只"显示"）─────────────────────
 *   rankScore = score × (1 + METRIC_BONUS_MAX × conf)，conf ∈ [-1, 1]
 *   为什么**按比例**而不是加常数：比例加成不夺走"相关性排序"的主导权 ——
 *   一条哪怕用过 100 次、全成功的笔记最多也只 +15%；而同一条笔记若与查询无关，
 *   它根本进不了召回池（AND/OR 匹配先筛），因此"用过的无关笔记压过真正相关的"不会发生；
 *   但相关性打平时（实测的 33 vs 33），有正向记录的被明确提前、有负向记录的被压后。
 *   为什么 15% 这个量级：正文命中一个词就是 +3~+8、标题命中 +10、标题整串 +15 ——
 *   15% 的加成不足以翻转**任何**一档实质相关度差距（如 33 → 37.95 仍低于 40）。 */
const METRIC_BONUS_MAX = 0.15;        // 最多 ±15% 的相关性分
const METRIC_CONF_FULL_USED = 3;      // 样本满置信所需的次数（再多也不再加权）
/** 置信度：只有三态里的 positive / negative 才给号；none（没记录）与 insufficient（样本不足/中性）
 *  **一律 0 = 不加不减** —— 这正是缺陷 2 要把两者区分出来之后才能做的事。幅度随样本数线性升到满置信。 */
function metricConfidence(st) {
  const s = st || STATS_ZERO;
  if (s.record !== "positive" && s.record !== "negative") return 0;
  const conf = Math.min(1, (Number(s.used) || 0) / METRIC_CONF_FULL_USED);
  return (s.record === "positive" ? 1 : -1) * conf;
}
/** 度量加成（相关度分为 0 或没有可用记录 → 0；保留两位小数便于人读/断言） */
function metricBonusOf(score, st) {
  const base = Number(score) || 0;
  if (!(base > 0)) return 0;
  const conf = metricConfidence(st);
  if (!conf) return 0;
  return Math.round(base * METRIC_BONUS_MAX * conf * 100) / 100;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 「是否更聪明」四条指标（任务收尾快照）—— `.dsh/metrics.jsonl`
 *   四条口径（用户与 DSH 商定，服务端**只记录与聚合，不做价值判断**）：
 *     ① userFollowups  首轮追问次数   越**少**越好 —— 第一条消息之后用户还要追问几次才对齐
 *     ② durationMs     同类任务耗时   越**短**越好 —— startedAt → endedAt（只有给了 startedAt 才有值）
 *     ③ skillsUsed     技能复用次数   越**多**越好 —— 本任务用到的库内技能/方法（技能名或相对路径）
 *     ④ notesCited     引用库内来源   越**高**越好 —— 产出里引用的 vault 相对路径条数
 *   与 `.dsh/stats.jsonl` 同一哲学：**数据由 DSH 侧在任务收尾主动上报**，服务端不猜、不评分、不改判；
 *   尤其**不判断"引用是否真实 / 追问是否有必要"**——那属于价值判断，接口只做汇总。
 *   **缺省 = 未上报（null），绝不代填 0**：userFollowups / durationMs 缺省即 null，聚合只落在非 null 样本上，
 *   并把样本数（followupsSamples / durationSamples）返回，让**上报率**可见 —— 否则"没上报"会伪装成
 *   "追问 0 次 / 耗时 0ms"，越不报越好看，指标就废了。显式传 0 仍然是有效样本。
 *   每行一个收尾快照，**只增不改**（无读-改-写窗口）；读取端跳过坏行、末尾无 \n 的残行视为 pending。
 *   越界防护：所有字符串只存进 JSON，从不参与路径拼接 → 结构上不可能写到 .dsh/ 之外。
 * ══════════════════════════════════════════════════════════════════════════ */
const METRICS_OUTCOMES = Object.freeze(["success", "partial", "fail"]);
const METRICS_TITLE_MAX = 200, METRICS_NOTE_MAX = 500;
const METRICS_ITEM_MAX = 400, METRICS_LIST_MAX = 200;
const METRICS_DAY_MS = 24 * 60 * 60 * 1000;
const METRICS_TREND_N = 5, METRICS_TREND_N_MAX = 50;
const METRICS_BETTER_WHEN = Object.freeze({
  followups: "lower", durationMs: "lower", skillReuseRate: "higher", citationRate: "higher",
});
const METRICS_LABEL = Object.freeze({
  followups: "首轮追问次数（越少越好）",
  durationMs: "同类任务耗时 ms（越短越好）",
  skillReuseRate: "技能复用任务占比（越多越好）",
  citationRate: "引用库内来源任务占比（越高越好）",
});
const metricsFile = () => path.join(DSH_DIR, "metrics.jsonl");

/** 字符串数组清洗（skillsUsed / notesCited）：去控制字符、反斜杠统一成 `/`、去空、去重、限长限量。
 *  null / undefined → `[]`（没填 = 没用技能 / 没引用）；**非数组或含非字符串元素 → null**（调用方回 400）。
 *  空数组合法——"这次没有复用"本身就是要记录的事实，不能当成缺字段丢掉。 */
function normalizeMetricsList(raw, maxItems = METRICS_LIST_MAX) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > maxItems) return null;
  const out = [];
  for (const v of raw) {
    if (typeof v !== "string") return null;
    const s = v.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\\/g, "/").trim().slice(0, METRICS_ITEM_MAX);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** 时间字段 → 毫秒：接受 ISO 字符串 / 毫秒数 / 秒级数（<1e11 视为秒）；不可解析 → NaN（调用方 400）。 */
function parseMetricsTime(raw) {
  if (raw == null || raw === "") return NaN;
  if (typeof raw === "number") return Number.isFinite(raw) ? (raw < 1e11 ? Math.round(raw * 1000) : Math.round(raw)) : NaN;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return NaN;
    if (/^\d+$/.test(t)) { const n = Number(t); return n < 1e11 ? n * 1000 : n; }
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? NaN : ms;
  }
  return NaN;
}

/** 数值字段 → 数 或 null（`null` / `undefined` / `""` 一律 null）：
 *  **不可直接用 Number()** —— Number(null) === 0，会把「没上报耗时」读成「耗时 0ms」，
 *  凭空造出样本并拉低平均耗时（实测踩过）。 */
const numOrNull = (v) => (v == null || v === "" ? null : Number(v));

/** 行 → 快照（脏行返回 null）：只做**形状**收敛，不做价值判断。
 *  宽容：缺字段按默认补齐（外部手工追加 / 旧版本写的行仍可用）；
 *  严格：只有 `title` 与可解析的 `endedAt` 缺失才算坏行 —— 没有这两个字段就不成其为一条任务快照。 */
function normalizeMetricsRecord(o) {
  if (!isPlainObject(o)) return null;
  const title = String(o.title ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!title) return null;
  const endedAt = parseMetricsTime(o.endedAt);
  if (!Number.isFinite(endedAt)) return null;
  const followups = numOrNull(o.userFollowups);   // 与 durationMs 同一套：**不能直接 Number()** ——
                                                  // Number(null)===0 会把「没上报」读成「追问 0 次」（指标诚信）
  const recallHits = numOrNull(o.recallHits);
  const durationMs = numOrNull(o.durationMs);   // 注意：不能直接 Number()——JSON 里的 null 会变成 0，
                                                // 那会凭空造出「耗时 0ms」的样本，把平均值拉低（实测踩过）
  const startedAt = parseMetricsTime(o.startedAt);
  const outcome = String(o.outcome ?? "");
  return {
    ts: Number(o.ts) || 0,
    taskId: normalizeStatsId(o.taskId) || "",
    title: title.slice(0, METRICS_TITLE_MAX),
    outcome: METRICS_OUTCOMES.includes(outcome) ? outcome : "unknown",   // 未申报 → unknown，不替用户下结论
    userFollowups: Number.isInteger(followups) && followups >= 0 ? followups : null,    // 缺省 / 非法 → null = 未上报，
                                                                                        // **不是 0**；显式 0 原样保留
    recallUsed: o.recallUsed === true,
    recallHits: Number.isInteger(recallHits) && recallHits >= 0 ? recallHits : null,    skillsUsed: normalizeMetricsList(o.skillsUsed) || [],
    notesCited: normalizeMetricsList(o.notesCited) || [],
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    endedAt,
    durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null,
    note: typeof o.note === "string" ? o.note.slice(0, METRICS_NOTE_MAX) : "",
    actor: typeof o.actor === "string" ? o.actor : "dsh",
  };
}

/** POST body → 快照（校验失败抛 status=400 的中文原因，由顶层 catch 统一转 {ok:false}）。
 *  自动补：`endedAt` 缺省 = now；给了 `startedAt` 才算 durationMs。
 *  明确拒绝：durationMs < 0（起止颠倒）与 > 24h（几乎肯定是"忘了在收尾时上报"，这种脏数据会毁掉平均值）。 */
function buildMetricsRecord(body) {
  const bad = (msg) => { const e = new Error(msg); e.status = 400; throw e; };
  const title = String(body.title ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!title) bad("title is required：POST /api/metrics {title,...}（任务名/一句话标题，必填）");
  if (title.length > METRICS_TITLE_MAX) bad(`title 过长（上限 ${METRICS_TITLE_MAX} 字）`);

  // userFollowups：**缺省 = null（未上报）**，绝不默认 0。理由：追问「越少越好」，
  // 把没上报记成 0 会让"少上报"看起来更聪明 —— 那就永远分不清是自己变聪明还是在自欺。
  // 显式传 0 **仍然有效**，语义是"确实没有追问"（这条事实必须能被记录下来）。
  let userFollowups = null;
  if (body.userFollowups != null && body.userFollowups !== "") {
    const n = Number(body.userFollowups);
    if (!Number.isInteger(n) || n < 0) bad("bad userFollowups（必须是 ≥0 的整数：首轮追问次数；缺省 = null 未上报，确实没追问请显式传 0）");
    userFollowups = n;
  }
  let outcome = "unknown";
  if (body.outcome != null && body.outcome !== "") {
    const o = String(body.outcome).trim();
    if (!METRICS_OUTCOMES.includes(o)) bad(`bad outcome（只允许 ${METRICS_OUTCOMES.join(" / ")}；缺省记 unknown）`);
    outcome = o;
  }
  if (body.recallUsed != null && typeof body.recallUsed !== "boolean") bad("bad recallUsed（必须是布尔值）");
  let recallHits = null;
  if (body.recallHits != null && body.recallHits !== "") {
    const n = Number(body.recallHits);
    if (!Number.isInteger(n) || n < 0) bad("bad recallHits（必须是 ≥0 的整数）");
    recallHits = n;
  }
  const skillsUsed = normalizeMetricsList(body.skillsUsed);
  if (!skillsUsed) bad("bad skillsUsed（必须是字符串数组：库内技能名或相对路径）");
  const notesCited = normalizeMetricsList(body.notesCited);
  if (!notesCited) bad("bad notesCited（必须是字符串数组：vault 相对路径）");
  if (body.note != null && typeof body.note === "object") bad("bad note（只接受字符串）");

  const endedAt = body.endedAt == null || body.endedAt === "" ? Date.now() : parseMetricsTime(body.endedAt);
  if (!Number.isFinite(endedAt)) bad("bad endedAt（接受 ISO 时间字符串或毫秒时间戳；缺省 = 现在）");
  let startedAt = NaN, durationMs = null;
  if (body.startedAt != null && body.startedAt !== "") {
    startedAt = parseMetricsTime(body.startedAt);
    if (!Number.isFinite(startedAt)) bad("bad startedAt（接受 ISO 时间字符串或毫秒时间戳）");
    durationMs = endedAt - startedAt;
    if (durationMs < 0) bad(`startedAt 晚于 endedAt（durationMs=${durationMs} < 0）`);
    if (durationMs > METRICS_DAY_MS) bad(`durationMs 超过 24h（${durationMs}ms）—— 疑似没在任务收尾时上报，拒绝入库`);
  }
  return {
    ts: Date.now(),
    taskId: normalizeStatsId(body.taskId) || "",
    title: title.slice(0, METRICS_TITLE_MAX),
    outcome,
    userFollowups,
    recallUsed: body.recallUsed === true,
    recallHits,
    skillsUsed,
    notesCited,
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    endedAt,
    durationMs,
    note: body.note == null ? "" : String(body.note).slice(0, METRICS_NOTE_MAX),
    actor: "dsh",
  };
}

/** 读快照账本（**只读，绝不创建文件**）：坏行跳过并计数；末尾没有 \n 的残行视为 pending（不解析、不计 bad）。
 *  文件不存在 = 空账本（不是错误）。返回前按 endedAt 倒序（同刻按写入序倒序）。 */
function readMetricsRaw() {
  let buf;
  try { buf = fs.readFileSync(metricsFile(), "utf8"); } catch { return { items: [], bad: 0, pending: false }; }
  const lastNl = buf.lastIndexOf("\n");
  const pending = buf.length > 0 && lastNl !== buf.length - 1;
  const complete = pending ? buf.slice(0, lastNl + 1) : buf;
  const items = [];
  let bad = 0;
  for (const line of complete.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let o = null;
    try { o = JSON.parse(t); } catch { bad++; continue; }        // 坏 JSON → 跳过并计数
    const rec = normalizeMetricsRecord(o);
    if (!rec) { bad++; continue; }
    items.push(rec);
  }
  items.sort((a, b) => (b.endedAt - a.endedAt) || (b.ts - a.ts));
  return { items, bad, pending };
}

const metricsR2 = (n) => Math.round(n * 100) / 100;
const metricsR4 = (n) => Math.round(n * 10000) / 10000;

/** 六项汇总。**空数组 → 全 0，绝不做除法**（不产生 NaN/Infinity，调用方不必判空）：
 *    tasks              任务数
 *    completeTasks      上报完整度：四条指标**都上报了**的任务数（口径见下方注释）
 *    avgFollowups       平均首轮追问次数（**只统计上报了 userFollowups 的样本**，样本数见 followupsSamples）
 *    avgDurationMs      平均耗时（**只统计有 durationMs 的快照**，样本数见 durationSamples）
 *    skillReuseTotal    技能复用**总次数**（所有 skillsUsed 条数之和）+ skillReuseTasks 有复用的任务数
 *    skillReuseRate     有 skillsUsed 非空的任务占比
 *    citationRate       有 notesCited 非空的任务占比 + avgCitations 平均引用条数
 *  另给 followupsTotal / followupsSamples / durationSamples / citationsTotal / outcomeCounts 便于人工核对。
 *
 *  **为什么 followups 必须带样本数**：它是"越少越好"的指标，缺省若按 0 计入，就会把"没上报"
 *  伪装成"平均 0 次追问"——上报得越少看起来越聪明，等于自欺。故缺省 = null，均值只落在非 null 样本上，
 *  并用 followupsSamples 把**上报率**摆到台面上（与 durationSamples 同一套口径）。
 *
 *  **completeTasks 口径（可测性局限，必须说清楚）**：四个维度里只有 followups / durationMs 在记录里
 *  保留 null，"没上报"是可测的；skillsUsed / notesCited 在读取端**缺省即补齐为 `[]`**（宽容旧行），
 *  与"明确上报了空数组"形状完全相同 → 结构上无法区分。因此这两个维度只能以**非空**（确实复用了技能 /
 *  确实引用了库内来源）这种可测的正向信号计入 —— 于是 completeTasks 是真实完整度的**下界**
 *  （宁可少算，也不让"没上报"看起来更好；偏向低报与本指标的立意一致）。 */
function metricsAggregate(items) {
  const tasks = items.length;
  const agg = {
    tasks,
    completeTasks: 0,
    avgFollowups: 0, followupsTotal: 0, followupsSamples: 0,
    avgDurationMs: 0, durationSamples: 0,
    skillReuseTotal: 0, skillReuseTasks: 0, skillReuseRate: 0,
    citationRate: 0, avgCitations: 0, citationsTotal: 0,
    outcomeCounts: { success: 0, partial: 0, fail: 0, unknown: 0 },
  };
  if (!tasks) return agg;
  let durSum = 0, cited = 0;
  for (const it of items) {
    const hasFollowups = it.userFollowups != null;
    if (hasFollowups) { agg.followupsTotal += it.userFollowups; agg.followupsSamples++; }
    if (it.durationMs != null) { durSum += it.durationMs; agg.durationSamples++; }
    agg.skillReuseTotal += it.skillsUsed.length;
    if (it.skillsUsed.length) agg.skillReuseTasks++;
    agg.citationsTotal += it.notesCited.length;
    if (it.notesCited.length) cited++;
    if (hasFollowups && it.durationMs != null && it.skillsUsed.length && it.notesCited.length) agg.completeTasks++;
    agg.outcomeCounts[it.outcome] = (agg.outcomeCounts[it.outcome] || 0) + 1;
  }
  agg.avgFollowups = agg.followupsSamples ? metricsR2(agg.followupsTotal / agg.followupsSamples) : 0;
  agg.avgDurationMs = agg.durationSamples ? Math.round(durSum / agg.durationSamples) : 0;
  agg.skillReuseRate = metricsR4(agg.skillReuseTasks / tasks);
  agg.citationRate = metricsR4(cited / tasks);
  agg.avgCitations = metricsR2(agg.citationsTotal / tasks);
  return agg;
}

/** 一组快照在四个维度上的取值（该组在某一维没有样本 → null = 不可比，不下结论）
 *  注意 followups 用 **followupsSamples**（非 null 样本数）判"有没有样本"，不是 tasks ——
 *  否则一组全都没上报 userFollowups 时，avgFollowups 会以 0 的身份混进趋势比较。 */
function metricsGroupValues(items) {
  const a = metricsAggregate(items);
  return {
    n: a.tasks,
    followups: a.followupsSamples ? a.avgFollowups : null,
    durationMs: a.durationSamples ? a.avgDurationMs : null,
    skillReuseRate: a.tasks ? a.skillReuseRate : null,
    citationRate: a.tasks ? a.citationRate : null,
  };
}

/** 趋势对比：**最近 window 条 vs 更早 window 条**（N 默认 5，GET ?window= 可参数化）。
 *  每条指标给 {recent, earlier, delta, direction, betterWhen, label}：
 *    direction = better（变好）/ worse（变差）/ same（持平）/ unknown（**任一侧无样本 → 不下结论**）
 *  判定规则（只判方向，不解释原因）：
 *    betterWhen=lower（追问 / 耗时）→ delta<0 为 better；betterWhen=higher（复用率 / 引用率）→ delta>0 为 better；
 *    四舍五入后 delta===0 → same。verdict 汇总：有好有坏=mixed；只有好=better；只有坏=worse；全持平=flat；全无样本=unknown。 */
function metricsTrend(items, window = METRICS_TREND_N) {
  const n = Math.min(Math.max(Math.floor(Number(window)) || METRICS_TREND_N, 1), METRICS_TREND_N_MAX);
  const recentItems = items.slice(0, n);            // items 已按 endedAt 倒序
  const earlierItems = items.slice(n, 2 * n);
  const recent = metricsGroupValues(recentItems), earlier = metricsGroupValues(earlierItems);
  const metrics = {};
  for (const key of Object.keys(METRICS_BETTER_WHEN)) {
    const betterWhen = METRICS_BETTER_WHEN[key];
    const rv = recent[key], ev = earlier[key];
    let direction = "unknown", delta = null;
    if (rv != null && ev != null) {
      delta = key === "durationMs" ? Math.round(rv - ev) : metricsR4(rv - ev);
      if (delta === 0) direction = "same";
      else direction = (betterWhen === "lower" ? delta < 0 : delta > 0) ? "better" : "worse";
    }
    metrics[key] = { label: METRICS_LABEL[key], betterWhen, recent: rv, earlier: ev, delta, direction };
  }
  const dirs = Object.values(metrics).map((m) => m.direction);
  const known = dirs.filter((d) => d !== "unknown");
  const better = known.filter((d) => d === "better").length;
  const worse = known.filter((d) => d === "worse").length;
  const verdict = !known.length ? "unknown"
    : !better && !worse ? "flat" : better && !worse ? "better" : worse && !better ? "worse" : "mixed";
  const withDir = (d) => Object.keys(metrics).filter((k) => metrics[k].direction === d);
  return {
    window: n, recentCount: recent.n, earlierCount: earlier.n,
    metrics, verdict,
    improved: withDir("better"), worsened: withDir("worse"),
    unchanged: withDir("same"), noData: withDir("unknown"),
  };
}

/** 清洗成安全文件名片段：去 Windows 非法字符/控制字符，压空白，限长 */
function safeName(s, { fallback = "untitled", max = 60, space = " " } = {}) {
  let t = String(s ?? "").replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-");
  if (space !== " ") t = t.replace(/\s+/g, space);
  t = t.replace(/\s+/g, " ").replace(/-{2,}/g, "-").replace(/^[.\s-]+|[.\s-]+$/g, "").trim();
  return t.slice(0, max) || fallback;
}

/** YAML 标量：纯「字母数字下划线 + 常见空白/- . ()」裸写，其余用 JSON 双引号（YAML 兼容） */
function yamlScalar(v) {
  const s = String(v ?? "");
  return /^[\p{L}\p{N}_][\p{L}\p{N}_\- .()（）]*$/u.test(s) ? s : JSON.stringify(s);
}
/** 路径型标量：多放行 / \ ，让 original: attachments/xxx.pdf 保持裸写（更贴合 Obsidian 习惯） */
function yamlPath(v) {
  const s = String(v ?? "");
  return /^[\p{L}\p{N}_.][\p{L}\p{N}_\- ./\\()（）]*$/u.test(s) ? s : JSON.stringify(s);
}

/** 技能候选主题 → 是否可以落成任务文件名（POST /api/skills/distill 的入参校验）。
 *  合法返回**原主题**（保留大小写 / 中文，正文用），非法一律 null（调用方 400）：
 *  空 / 超长（>80）/ 控制字符 / 路径分隔符（含 `../`、`a/b`、`C:\x`）/ 任何 `..` / 无字母数字（`.`、`-`、空白）。
 *  故主题**永远不可能**把文件写到 .dsh/inbox 之外（路由里还有 safeUnder 式双保险）。 */
function distillTopicName(raw) {
  const t = String(raw == null ? "" : raw).trim();
  if (!t || t.length > 80) return null;
  if (/[\u0000-\u001f\u007f]/.test(t)) return null;      // 控制字符
  if (/[\\/]/.test(t)) return null;                      // 路径分隔符
  if (/^[A-Za-z]:/.test(t)) return null;                 // 盘符（已被上行挡住，双保险）
  if (t.includes("..")) return null;                     // 任何 ..
  if (!/[\p{L}\p{N}]/u.test(t)) return null;             // 至少一个字母或数字
  return t;
}

/** 把相对路径安全解析到指定目录内（越界返回 null）；mustBeMd 时额外限制扩展名 */
function safeUnder(rootDir, rel, { mustBeMd = false } = {}) {
  const clean = String(rel || "").replace(/^[/\\]+/, "");
  if (!clean) return null;
  const full = path.resolve(rootDir, clean);
  const root = path.resolve(rootDir) + path.sep;
  if (!full.startsWith(root)) return null;
  if (mustBeMd && !full.toLowerCase().endsWith(".md")) return null;
  return full;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 回收站（查看 / 还原 / 清除）—— /api/delete 的配套接口
 * 目录约定：删除**不真删**，笔记被移到 .dsh/trash/<本地时间戳>__<原文件名>（平铺，无子目录）。
 *
 * **安全红线**：三个接口只允许操作 .dsh/trash/ 内的条目。
 *   绝对路径（盘符 / UNC / 前导分隔符）、任何含路径分隔符的名字、"." / ".." / 控制字符
 *   一律返回 null → 调用方统一 400；因此 name 永远解析不到 trash 目录之外。
 * 清空只遍历 .dsh/trash/ 直属的文件，绝不递归、绝不碰其它目录。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 回收站条目名 → 绝对路径；非法（越界/绝对路径/..）返回 null
 *  允许形如 `sub/x.md` 的**回收站内部**相对名（仍在 .dsh/trash/ 内），但：
 *  盘符 / UNC / 前导分隔符 / 任何 `..` 段 / 控制字符 → 一律 null（调用方 400）。 */
function trashEntryPath(name) {
  const raw = String(name ?? "").trim();
  if (!raw || raw.length > 260) return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;              // 控制字符
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) return null; // /x、C:\x、C:foo、\\server\share
  const segs = raw.replace(/\\/g, "/").split("/").filter((s) => s !== "" && s !== ".");
  if (!segs.length) return null;
  if (segs.some((s) => s === "..")) return null;                   // 任何 .. 段 → 越界，拒绝
  const full = path.resolve(TRASH_DIR, ...segs);
  if (!full.startsWith(path.resolve(TRASH_DIR) + path.sep)) return null;  // 双保险：结果必须在 trash 之内
  return full;
}

/** 是否在 .dsh/trash/ 之内（清空/递归时的双保险，避免任何路径拼接失误） */
const insideTrash = (full) => path.resolve(full).startsWith(path.resolve(TRASH_DIR) + path.sep);

/** 条目在回收站内的相对名（`\` 统一成 `/`），用于解析原名与删除时间 */
const trashRelName = (full) => path.relative(TRASH_DIR, full).split(path.sep).join("/");

/** 回收站文件名 → { originalName, deletedAt }；时间戳解析不出（或不是合法日期）时 deletedAt=null 由调用方用 mtime */
const TRASH_NAME_RE = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})__(.+)$/;
function parseTrashName(name) {
  const raw = String(name || "");
  const m = TRASH_NAME_RE.exec(raw);
  if (!m) return { originalName: raw, deletedAt: null };
  const y = +m[1], mo = +m[2], d = +m[3], hh = +m[4], mi = +m[5], ss = +m[6];
  const dt = new Date(y, mo - 1, d, hh, mi, ss);
  const ms = dt.getTime();
  // 回读校验：拒绝 2026-13-45 / 2026-02-31 这类"能构造、其实是滚过去的"假时间戳
  const ok = Number.isFinite(ms) && dt.getFullYear() === y && dt.getMonth() + 1 === mo && dt.getDate() === d;
  return { originalName: m[7], deletedAt: ok ? ms : null };
}

/* ── sidecar（还原回原目录用）──────────────────────────────────────────────
 * 条目平铺在 .dsh/trash/，文件名里**只有 basename**，光看名字回不到原目录。
 * 于是删除时在条目旁并存一份 `<条目名>.meta.json`（内容 {path, deletedAt}），
 * 还原时优先读它回到原相对路径；读不到（老条目/损坏）就退回原名解析的旧行为。
 * sidecar 一律不出现在 /api/trash 清单里，清除时随条目一起删。 */
const TRASH_META_SUFFIX = ".meta.json";
const isTrashMeta = (name) => String(name || "").endsWith(TRASH_META_SUFFIX);
/** 条目的 sidecar 路径（绝对）；src 为 trashEntryPath 解析出的绝对路径 */
const trashMetaPath = (src) => String(src) + TRASH_META_SUFFIX;

/** 原子写 sidecar：与 writeNote 同风格（临时文件 + rename），避免并发读到半截 JSON；失败不抛 */
function writeTrashMeta(src, rel) {
  const file = trashMetaPath(src), tmp = file + ".dsh-tmp";
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ path: rel, deletedAt: Date.now() }), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch { try { fs.unlinkSync(tmp); } catch {} return false; }
}

/** 读 sidecar → vault 相对原路径；读不到 / JSON 坏 / 空 / 含 `..` / 越出 vault → null（走旧行为兜底） */
function readTrashMeta(src) {
  let raw;
  try { raw = fs.readFileSync(trashMetaPath(src), "utf8"); } catch { return null; }
  let rel = "";
  try { rel = String((JSON.parse(raw) || {}).path || ""); } catch { return null; }
  rel = rel.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!rel || rel.split("/").some((s) => s === "..")) return null;
  return safeVaultPath(rel) ? rel : null;
}

/** 删 sidecar（还原 / 单条清除配套）；不存在也算成功 */
function dropTrashMeta(src) {
  try { fs.unlinkSync(trashMetaPath(src)); } catch {}
}

/** 一条回收站条目的对外形状：{name, originalName, deletedAt, bytes, mtimeMs, originalPath}
 *  originalPath = sidecar 里的 vault 相对原路径；无 sidecar（老条目）为 null。 */
function trashItem(name) {
  let st = { size: 0, mtimeMs: 0 };
  const full = path.join(TRASH_DIR, name);
  try { st = fs.statSync(full); } catch {}
  const parsed = parseTrashName(name);
  return {
    name,
    originalName: parsed.originalName || name,
    deletedAt: parsed.deletedAt || st.mtimeMs || 0,   // 解析不出时间戳 → 用 mtime
    bytes: st.size,
    mtimeMs: st.mtimeMs,
    originalPath: readTrashMeta(full),                // 有 sidecar → 原相对路径；否则 null
  };
}

/** 条目原名 → vault 相对还原路径（原名带目录就回原目录，只是文件名就放 vault 根） */
function trashRestoreRel(originalName) {
  return String(originalName || "").replace(/\\/g, "/").replace(/^\/+/, "").trim()
    .split("/").filter(Boolean).join("/");
}

/** 解析 vault 内的目标目录（用于归档落点）；越界返回 null */
function safeDir(rel) {
  const clean = String(rel || "").replace(/^[/\\]+/, "").trim();
  if (!clean) return null;
  const full = path.resolve(VAULT, clean);
  const root = path.resolve(VAULT) + path.sep;
  if (!full.startsWith(root)) return null;
  return full;
}

/** 解析任务文件路径：兼容 vault 相对（claim 返回值）、tasks 相对、纯文件名三种写法 */
function resolveTask(rel) {
  const root = path.resolve(evoDir("tasks")) + path.sep;
  const s = String(rel || "").trim().replace(/^[/\\]+/, "");
  if (!s) return null;
  const cands = [path.resolve(evoDir("tasks"), s), path.resolve(VAULT, s)]
    .filter((f) => f.startsWith(root) && f.toLowerCase().endsWith(".md"));
  if (!cands.length) return null;                 // 越界/非 md → 调用方返回 400
  const exists = cands.find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
  return exists || cands[0];                      // 都不存在时回落到候选，由调用方给出 404
}

/** 解析「已在归档目录里」的任务文件（done 重复调用时定位用）。
 *  归档目录在 vault 内可见处（可能是带层级的相对路径），故与 resolveTask 分开解析；
 *  越界/非 md/不存在 → null（调用方按 400/404 处理）。 */
function resolveArchivedTask(rel) {
  const dir = taskArchiveDir();
  const root = path.resolve(dir) + path.sep;
  const s = String(rel || "").trim().replace(/^[/\\]+/, "");
  if (!s) return null;
  const cands = [path.resolve(dir, s), path.resolve(VAULT, s)]
    .filter((f) => f.startsWith(root) && f.toLowerCase().endsWith(".md"));
  if (!cands.length) return null;
  const exists = cands.find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
  return exists || null;                          // 归档目录里没有这个文件 → 交给调用方 400
}

/** 读 JSON body：非法 JSON 记为 400（由顶层 catch 统一转成 {ok:false}）；limit 可传更大上限 */
async function readJsonBody(req, limit) {
  const raw = await readBody(req, limit);
  try {
    const o = JSON.parse(raw || "{}");
    return isPlainObject(o) ? o : {};
  } catch {
    const e = new Error("bad json body");
    e.status = 400;
    throw e;
  }
}

// ── 任务文件解析（正文里的 `- 状态：` / `- 主题：`） ──
const taskTopic = (text) => (/- 主题：\s*(.*)/.exec(text)?.[1] || text.match(/^#\s+(.+)$/m)?.[1] || "").trim();
const taskStatus = (text) => (/- 状态：\s*(.*)/.exec(text)?.[1] || "").trim() || "未知";
/** 改写 `- 状态：` 行，并在其后追加元信息行（开始/完成/结果） */
function updateStatus(text, status, extra = []) {
  const out = [];
  let done = false;
  for (const line of text.split(/\r?\n/)) {
    if (!done && /^\s*-\s*状态：/.test(line)) {
      out.push(`- 状态：${status}`, ...extra);
      done = true;
      continue;
    }
    out.push(line);
  }
  if (!done) out.push(`- 状态：${status}`, ...extra);
  return out.join("\n").replace(/\s*$/, "\n");
}

/**
 * 队列目录下**这一层**的 .md 文件（绝不递归）。
 * 归档后的任务会被**搬出 tasks/**（搬到 vault 内可见的归档目录），
 * 所以无论归档目录设在哪里，它都不可能出现在队列里、也不可能被 claim 领走。
 */
function listTaskFiles(dir = evoDir("tasks")) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".md"))
      .map((d) => d.name);
  } catch { return []; }
}
/** 旧归档目录（隐藏，已弃用）：.dsh/evolution/tasks/archive/ —— 仅供一次性迁移读取 */
const legacyTaskArchiveDir = () => evoDir("tasks", "archive");
/**
 * 任务归档目录解析（**只解析，不落盘**）：取自 settings.evolution_log_folder，**必须落在 vault 内**：
 *   绝对路径 / `..` / 点开头目录（.dsh、.obsidian…）/ 越出 vault → 一律视为非法，回退默认值。
 *   目录可能不存在（返回路径仍有效）；越界兜底失败时返回 null。
 */
function resolveTaskArchiveDir() {
  const s = readSettings();
  const rel = normDirRel(s.evolution_log_folder) || normDirRel(SETTINGS_DEFAULT.evolution_log_folder);
  return safeDir(rel) || safeDir(SETTINGS_DEFAULT.evolution_log_folder);
}
/** 任务归档目录（解析 + 确保存在，写路径用；返回绝对路径）。只读场景请用 resolveTaskArchiveDir()。 */
function taskArchiveDir() {
  const full = resolveTaskArchiveDir();
  try { fs.mkdirSync(full, { recursive: true }); } catch {}
  return full;
}
/** 目标目录里不重名的路径：同名自动 -2 / -3 …（**不覆盖**既有文件） */
function uniqueInDir(dir, name) {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  let full = path.join(dir, name);
  for (let i = 2; i < 1000 && fs.existsSync(full); i++) full = path.join(dir, `${base}-${i}${ext}`);
  return full;
}
/**
 * 一次性迁移（服务启动时跑一次）：把旧隐藏归档目录里的 .md 搬到当前归档目录。
 *   - 文件是**移动**（rename，跨卷失败才 copy+unlink）→ 源目录清空 → 幂等：重复跑不再产生任何变化；
 *   - 同名自动 -2 / -3，绝不覆盖；
 *   - 搬完旧目录为空则删掉它（里面还有非 .md 残留时不删，留给人处理）。
 * 旧目录不存在（已迁移过 / 从未用过）时**直接返回，连新目录都不创建**。
 */
function migrateTaskArchive() {
  const src = legacyTaskArchiveDir();
  let entries;
  try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return { moved: 0, failed: 0, removed: false, from: toRel(src), to: null }; }
  const dst = taskArchiveDir();
  if (path.resolve(src) === path.resolve(dst)) return { moved: 0, failed: 0, removed: false, from: toRel(src), to: toRel(dst) };
  let moved = 0, failed = 0;
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
    const from = path.join(src, e.name);
    const to = uniqueInDir(dst, e.name);
    try { fs.renameSync(from, to); moved++; }
    catch {
      try { fs.copyFileSync(from, to); fs.unlinkSync(from); moved++; }
      catch { failed++; }                                  // 搬不动就留在旧目录，下次启动重试
    }
  }
  let removed = false;
  try {
    if (!fs.readdirSync(src).length) { fs.rmdirSync(src); removed = true; }
  } catch {}
  return { moved, failed, removed, from: toRel(src), to: toRel(dst) };
}
/** 一次性迁移（服务启动时跑一次）：旧版 POST /api/skills/distill 把提炼任务写进 `.dsh/inbox/`，
 *  与任务队列（`.dsh/evolution/tasks/`）是**两个状态机**（用户实测：候选卡显示「待执行」，而下面任务队列里
 *  根本没有这条 —— 用户以为该是同一件事 ✗）。这里把它们合进进化任务队列（语义上「提炼技能」就是「库自进化」）：
 *    · 正文**不重写、不丢**：原文本原样搬过去，只补 `- 主题：`（缺时，正文侧匹配靠它）与一行 `- 迁移自：`；
 *    · 原文件**不删**：改名归档到 `.dsh/inbox/archive/`（`/api/inbox` 只列顶层 .md，故不再算待办、也不再被 DSH 当任务读）；
 *    · 文件名沿用原时间戳前缀（队列按文件名排序 → 顺序不乱），同名自动 -2 / -3，**绝不覆盖**；
 *    · 幂等：搬完 inbox 顶层不再有 `*-distill-*.md` → 下次启动 0 动作；
 *    · 搬不动的（读不到 / 主题非法 / 写失败）**留在原处**，由 handoffIndex 的 inbox 兜底继续显示。
 *  返回 {moved, failed, files:[{from,to}]}（供启动日志与自检核对，绝不静默）。 */
function migrateDistillInboxTasks() {
  const res = { moved: 0, failed: 0, files: [] };
  let names = [];
  try {
    names = fs.readdirSync(INBOX_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && /-distill-.*\.md$/i.test(e.name)).map((e) => e.name);
  } catch { return res; }
  if (!names.length) return res;
  const archDir = path.join(INBOX_DIR, "archive");
  for (const name of names) {
    const src = path.join(INBOX_DIR, name);
    let text = "";
    try { text = fs.readFileSync(src, "utf8"); } catch { res.failed++; continue; }
    const m = /-distill-(.+)$/i.exec(name.replace(/\.md$/i, ""));
    const topic = taskTopic(text) || (m ? m[1] : "") || "";
    if (!distillTopicName(topic)) { res.failed++; continue; }      // 主题取不出来 / 非法 → 原样留着，不猜
    let dest = null, body = text;
    try {
      const dir = evoDir("tasks");
      fs.mkdirSync(dir, { recursive: true });
      const tsPre = /^(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})/.exec(name)?.[1] || stamp();
      dest = uniquePath(path.join(dir, `${tsPre}-${safeName(topic, { fallback: "topic", max: 40 })}.md`));
      if (!dest || !path.resolve(dest).startsWith(path.resolve(dir) + path.sep)) { res.failed++; continue; }
      if (!/- 主题：/.test(body)) {                                  // 缺 `- 主题：` → 插在标题下 / 类型行前
        const ls = body.split(/\r?\n/);
        const hi = ls.findIndex((l) => /^\s*-\s*类型：/.test(l));
        const ti = ls.findIndex((l) => /^#\s/.test(l));
        ls.splice(hi >= 0 ? hi : (ti >= 0 ? ti + 1 : 0), 0, `- 主题：${topic}`);
        body = ls.join("\n");
      }
      const st = taskStatus(text);
      body = updateStatus(body, st === "未知" ? "待执行" : st,
        [`- 迁移自：${toRel(src)}（旧版收件箱任务，原文件已归档到 ${toRel(archDir)}/）`]);
      writeNote(dest, body);
    } catch { res.failed++; continue; }
    // 原文件**保留**：移动（跨卷失败才 copy + unlink）到 .dsh/inbox/archive/，绝不 unlink 了就没
    try {
      fs.mkdirSync(archDir, { recursive: true });
      try { fs.renameSync(src, uniqueInDir(archDir, name)); }
      catch { fs.copyFileSync(src, uniqueInDir(archDir, name)); fs.unlinkSync(src); }
    } catch {}
    res.moved++;
    res.files.push({ from: toRel(src), to: toRel(dest) });
  }
  return res;
}

/** 任务清单（按时间戳降序 = 最新在前），含从正文解析出的主题与状态 */
function readTasks() {
  const dir = evoDir("tasks");
  const files = listTaskFiles(dir);
  files.sort().reverse();
  return files.map((f) => {
    const full = path.join(dir, f);
    let text = "";
    try { text = fs.readFileSync(full, "utf8"); } catch {}
    return { name: f, path: toRel(full), topic: taskTopic(text), status: taskStatus(text) };
  });
}

/** `.dsh/skills/` 的 vault 相对前缀（用 toRel 现算，避免硬编码 `.dsh` 与 DSH_DIR 口径脱节） */
const LOCAL_SKILLS_REL = toRel(path.join(DSH_DIR, "skills")).replace(/\\/g, "/") + "/";

/** 技能统计（进化总览用）：**与 /api/recall 同源** —— 直接复用 listSkillCards()，
 *  所以 /api/evolution.skills 就是 recall 里能看到的那个技能集合的大小
 *  （修掉旧版「只数 .dsh/skills/*.md → 真实库返回 0，面板误报『没有技能可复用』」）。
 *  local = 桥自己写的 `.dsh/skills/*.md`；vault = vault 内任意 `<名>/SKILL.md`（如 copilot/skills/x/SKILL.md）。 */
function skillStats() {
  const cards = listSkillCards();
  let local = 0;
  for (const c of cards) if (String(c.path).replace(/\\/g, "/").startsWith(LOCAL_SKILLS_REL)) local++;
  return { total: cards.length, local, vault: cards.length - local };
}
/** 已提炼技能数量（总数口径；= listSkillCards().length） */
function countSkills() { return skillStats().total; }

/**
 * GET /api/skills 的载荷：**两个来源合成一份清单**，每条带 source 字段。
 *   ① local = 桥自己写的 `.dsh/skills/*.md`（可删；字段与旧版完全一致，只多一个 source）
 *   ② vault = vault 内任意 `<名>/SKILL.md`（**只读**，用户自己的文件；**复用 listSkillCards()**，不另写扫描）
 * 顺序：local 在前（仍按 mtime 降序）、vault 在后（按扫描顺序）。
 * 兼容：老键 `skills` 与新键 `items` **返回同一个数组**（旧消费者按数组用照旧，字段一个没少）。
 */
function listSkillsPayload() {
  const dir = path.join(DSH_DIR, "skills");
  const si = statsIndex();                                            // 度量账本（文件不存在 → 空账本，绝不报错）
  const mdir = mirrorDir();
  const mirOf = (name) => {
    try { return fs.existsSync(path.join(mdir, safeName(name, { fallback: "skill" }) + ".md")); } catch { return false; }
  };
  const statsOf = (name, rel) => statsFields(statsLookup(si.map, "skill", name, rel)).stats;
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md")); } catch {}
  const items = files.map((f) => {
    const full = path.join(dir, f);
    let text = "", st = { mtimeMs: 0, size: 0 };
    try { text = fs.readFileSync(full, "utf8"); st = fs.statSync(full); } catch {}
    const fm = parseFrontmatter(text);
    const name = fm.frontmatter.name || f.replace(/\.md$/i, "");
    const rel = toRel(full);
    return {
      name,
      description: fm.frontmatter.description || "",
      tags: [...new Set(fm.tags)],
      path: rel,
      source: "local",
      mtimeMs: st.mtimeMs,
      size: st.size,
      /* 新增四个字段（不破坏既有字段）：度量 / 启用态 / 可否编辑 / 是否已导出 */
      stats: statsOf(name, rel),
      enabled: fm.frontmatter.enabled === undefined ? true : parseEnabled(fm.frontmatter.enabled),
      editable: true,
      mirrored: mirOf(name),
    };
  }).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const seen = new Set(items.map((s) => String(s.path).replace(/\\/g, "/")));
  for (const c of listSkillCards()) {                                  // 与 /api/recall、/api/evolution 同源
    const rel = String(c.path).replace(/\\/g, "/");
    if (seen.has(rel) || rel.startsWith(LOCAL_SKILLS_REL)) continue;    // local 上面已列（含同名去重）
    seen.add(rel);
    items.push({
      name: c.name, description: c.description || "", tags: [],
      path: rel, source: "vault", mtimeMs: 0, size: 0,
      /* 库内技能：**恒 enabled:true、editable:false**（只读红线）；mirrored 只反映磁盘上有没有同名导出副本 */
      stats: statsOf(c.name, rel),
      enabled: true,
      editable: false,
      mirrored: mirOf(c.name),
    });
  }
  return { ok: true, count: items.length, items, skills: items };
}

/** vault 内是否存在该名字的技能（删除接口的兜底提示用；只读扫描，绝不写盘）。
 *  命中口径：技能卡的 name，或 `<名>/SKILL.md` 里的目录名 `<名>`。 */
function vaultSkillExists(name) {
  const want = String(name || "").trim().toLowerCase();
  if (!want) return false;
  for (const c of listSkillCards()) {
    const rel = String(c.path).replace(/\\/g, "/");
    if (rel.startsWith(LOCAL_SKILLS_REL)) continue;                     // 只认 vault 侧
    const segs = rel.split("/").filter(Boolean);
    const holder = segs.length >= 2 ? segs[segs.length - 2] : "";
    if (String(c.name).trim().toLowerCase() === want) return true;
    if (holder && holder.toLowerCase() === want) return true;
  }
  return false;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 技能卡「用户可看 / 可用 / 可管」的写路径（四条，全部有界）
 *   POST /api/skills/save    追加式版本化写 .dsh/skills/<名>.md（库内 / 越界一律 400）
 *   POST /api/skills/toggle  只改 frontmatter 的 `enabled:`（**正文逐字节不动**）
 *   POST /api/skills/use     写一条收件箱任务 .dsh/inbox/<ts>-usaskill-<名>.md
 *   POST /api/skills/mirror  单向导出到 <vault>/<skill_mirror_folder>/<名>.md（幂等：内容相同不重写）
 * 目录约定：库内技能（vault 内 <名>/SKILL.md）**永远只读** —— 四条路径都不碰 vault 侧文件
 * （mirror 只**写出**到 <vault>/<skill_mirror_folder>/，不读写用户自己的 SKILL.md）。
 * ══════════════════════════════════════════════════════════════════════════ */
/* 镜像目录名改为**配置项** skill_mirror_folder（见 skillMirrorName()）：默认值通用，真实名字在用户的 settings.json */
function skillsDir() { return path.join(DSH_DIR, "skills"); }
function skillsHistoryDir(slug) { return path.join(skillsDir(), ".history", slug); }
/** 镜像目录：<vault>/<skill_mirror_folder>/（单向导出的落点；用 path.join 现算，不硬编码盘符） */
function mirrorDir() { return path.join(VAULT, skillMirrorName()); }

/** 技能名合法性（落盘安全）：与 distillTopicName 同口径 —— 空 / 超长 / 控制字符 /
 *  路径分隔符（含 `../`、`a/b`）/ 盘符 / 任何 `..` / 无字母数字 → null（调用方 400）。
 *  故技能名**永远不可能**把文件写到 .dsh/skills/ 之外（路由里还有 safeUnder 双保险）。 */
function skillCardName(raw) {
  const t = String(raw == null ? "" : raw).trim();
  if (!t || t.length > 80) return null;
  if (/[\u0000-\u001f\u007f]/.test(t)) return null;
  if (/[\\/]/.test(t)) return null;
  if (/^[A-Za-z]:/.test(t)) return null;
  if (t.includes("..")) return null;
  if (!/[\p{L}\p{N}]/u.test(t)) return null;
  return t;
}

/** frontmatter 的 `enabled:` → 布尔。缺省 true（**默认启用**）；只认 false/0/no/off 为停用，
 *  未知值（含空）一律当启用 —— 宁可多带一张卡，也不因为解析不出来就静默停掉用户的技能。 */
function parseEnabled(v) {
  const s = String(v == null ? "" : v).trim().replace(/^["']|["']$/g, "").toLowerCase();
  return !/^(false|0|no|off)$/.test(s);
}

/** 本地技能名 → 绝对路径（先按文件名精确匹配，再按 frontmatter 的 name 匹配；找不到 → null）。
 *  只扫 .dsh/skills/ 直属 *.md（`.history/` 是子目录，天然不会被扫到）。 */
function localSkillPath(name) {
  const want = String(name == null ? "" : name).trim();
  if (!want) return null;
  const dir = skillsDir();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md")); } catch { return null; }
  const exact = files.find((f) => f.replace(/\.md$/i, "") === want);
  if (exact) return path.join(dir, exact);
  for (const f of files.sort()) {
    const full = path.join(dir, f);
    let text = "";
    try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
    if (String(parseFrontmatter(text).frontmatter.name || "").trim() === want) return full;
  }
  return null;
}

/** **只改 frontmatter 的 `enabled:` 一行**，正文逐字节不动。
 *  有 frontmatter：有 enabled 行就整行替换，没有就插在结束的 `---` 之前；
 *  没有 frontmatter（或没有结束行）：头部补一个最小块，原文**原样**接在后面。
 *  返回新文本；与原文完全相同（值未变）时原样返回 → 调用方可据此零写入。 */
function setEnabledFrontmatter(text, want) {
  const line = "enabled: " + (want ? "true" : "false");
  const src = String(text == null ? "" : text);
  const end = src.startsWith("---") ? src.indexOf("\n---", 3) : -1;
  if (end < 0) return "---\n" + line + "\n---\n\n" + src;
  const head = src.slice(0, end);
  const rest = src.slice(end);                 // 从「结束 ---」起的全部字节（含正文）原样保留
  const lines = head.split("\n");
  let hit = -1;
  for (let i = 0; i < lines.length; i++) { if (/^\s*enabled\s*:/.test(lines[i])) { hit = i; break; } }
  if (hit >= 0) {
    if (lines[hit].replace(/[\r\s]+$/, "").trim() === line) return src;   // 值没变 → 零写入
    lines[hit] = line;
  } else lines.push(line);
  return lines.join("\n") + rest;
}

/** POST /api/skills/save：**只写 .dsh/skills/<安全名>.md**；同名已存在 → 旧文件 copyFileSync
 *  **逐字节**拷进 .dsh/skills/.history/<名>/<ts>.md（不经字符串解码，故二进制等价）→ 再原子写新内容。
 *  历史**只增不删**，故 version = 历史条数 + 1（首次 = 1）。
 *  既有 `enabled:` 会被**保留**（否则「只改正文」的编辑会静默把停用的技能重新启用）。
 *  越界 / 空名 / `C:\x` / `a/b` / `../../evil` / 库内技能名 → {ok:false, status:400}。 */
function saveSkillCard({ name, description, content, note }) {
  const nm = skillCardName(name);
  if (!nm) return { ok: false, status: 400, error: "bad name（不得为空 / 含路径分隔符 / 盘符 / `..` / 控制字符）" };
  if (content == null) return { ok: false, status: 400, error: "content required（技能正文由 DSH 写，服务端只落盘）" };
  const slug = safeName(nm, { fallback: "skill" });
  let full = safeUnder(skillsDir(), `${slug}.md`, { mustBeMd: true });
  if (!full) return { ok: false, status: 400, error: "bad name（越界）" };
  const existing = localSkillPath(nm);
  if (!existing && vaultSkillExists(nm)) return { ok: false, status: 400, error: "vault skill is read-only: " + nm };
  if (existing) full = existing;                            // 同名已存在 → 就地更新（不改文件名）

  let exists = false, prevEnabled = null;
  try { exists = fs.statSync(full).isFile(); } catch {}
  let historyPath = null;
  if (exists) {
    try {
      const fm = parseFrontmatter(fs.readFileSync(full, "utf8"));
      if (fm.frontmatter.enabled !== undefined) prevEnabled = parseEnabled(fm.frontmatter.enabled);
    } catch {}
    const histDir = skillsHistoryDir(path.basename(full).replace(/\.md$/i, ""));
    fs.mkdirSync(histDir, { recursive: true });
    let target = "";
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    for (let i = 0; i < 1000 && !target; i++) {
      const cand = path.join(histDir, i === 0 ? `${ts}.md` : `${ts}-${i}.md`);
      if (!fs.existsSync(cand)) target = cand;
    }
    if (!target) return { ok: false, status: 500, error: "history name collision" };
    try { fs.copyFileSync(full, target); }                  // 旧内容逐字节保留（只增不删）
    catch (e) { return { ok: false, status: 500, error: `history copy failed: ${e.message}` }; }
    historyPath = toRel(target);
  }

  const head = [
    "---",
    `name: ${yamlScalar(nm)}`,
    `description: ${yamlScalar(description ?? "")}`,
    `updated: ${new Date().toISOString()}`,
  ];
  if (prevEnabled !== null) head.push(`enabled: ${prevEnabled}`);
  if (note) head.push(`note: ${yamlScalar(note)}`);
  head.push("---", "");
  const text = head.join("\n") + String(content).replace(/^\s*\n/, "");
  writeNote(full, text.endsWith("\n") ? text : text + "\n");

  const stem = path.basename(full).replace(/\.md$/i, "");
  let version = 1;
  try { version = fs.readdirSync(skillsHistoryDir(stem)).filter((f) => f.toLowerCase().endsWith(".md")).length + 1; } catch {}
  return { ok: true, name: nm, path: toRel(full), version, historyPath };
}

/** POST /api/skills/toggle：改本地技能 frontmatter 的 `enabled:`（只改这一个字段）。
 *  库内技能 / 越界名 → 400；本地没这张卡 → 404。值未变 → 不写盘（changed:false）。 */
function toggleSkillCard(name, enabled) {
  const nm = skillCardName(name);
  if (!nm) return { ok: false, status: 400, error: "bad name（不得为空 / 含路径分隔符 / 盘符 / `..` / 控制字符）" };
  const want = enabled === true || /^(true|1|yes|on)$/i.test(String(enabled == null ? "" : enabled));
  const full = localSkillPath(nm);
  if (!full) {
    if (vaultSkillExists(nm)) return { ok: false, status: 400, error: "vault skill is read-only: " + nm };
    return { ok: false, status: 404, error: "not found: " + nm };
  }
  let text = "";
  try { text = fs.readFileSync(full, "utf8"); } catch (e) { return { ok: false, status: 500, error: "read failed: " + e.message }; }
  const next = setEnabledFrontmatter(text, want);
  if (next === text) return { ok: true, name: nm, path: toRel(full), enabled: want, changed: false };
  try { writeNote(full, next); } catch (e) { return { ok: false, status: 500, error: "write failed: " + e.message }; }
  return { ok: true, name: nm, path: toRel(full), enabled: want, changed: true };
}

/** POST /api/skills/use：写一条**收件箱任务**（不碰技能卡本身）→ 越界名 400。 */
function useSkillCard({ name, note }) {
  const nm = skillCardName(name);
  if (!nm) return { ok: false, status: 400, error: "bad name（不得为空 / 含路径分隔符 / 盘符 / `..` / 控制字符）" };
  const slug = safeName(nm, { fallback: "skill", max: 40 });
  try { fs.mkdirSync(INBOX_DIR, { recursive: true }); } catch {}
  const full = uniquePath(path.join(INBOX_DIR, `${stamp()}-usaskill-${slug}.md`));
  if (!full) return { ok: false, status: 500, error: "收件箱同名任务过多（-2…-999 已用尽）" };
  if (!path.resolve(full).startsWith(path.resolve(INBOX_DIR) + path.sep)) {
    return { ok: false, status: 400, error: "越界（只允许写 .dsh/inbox/）" };
  }
  const local = localSkillPath(nm);
  const inVault = !local && vaultSkillExists(nm);
  const src = local ? `local（${toRel(local)}）` : (inVault ? "vault（库内，只读）" : "未登记（请按名字在 .dsh/skills/ 或 <名>/SKILL.md 里找）");
  const nt = String(note == null ? "" : note).replace(/\s+/g, " ").trim().slice(0, 500);
  const lines = [
    `# 🛠 用技能卡执行：${nm}`, "",
    `- 类型：技能卡执行（面板「用这张卡」排入）`,
    `- 状态：待执行`,
    `- 创建：${nowText()}`,
    `- 技能：${nm}`,
    `- 技能来源：${src}`,
  ];
  if (nt) lines.push(`- 备注：${nt}`);
  lines.push(
    "", "## 给 DSH 的指令",
    `1. 请按该技能卡执行本任务，并说明是否命中其已知边界。`,
    `2. 命中边界要点到具体哪一条；技能卡没覆盖的判据**不许越界断言**（宁缺勿编）。`,
    `3. 做完把上面的 \`- 状态：\` 改成「已完成」，并按需在 \`.dsh/evolution/logs/\` 追加一条日志。`,
    "");
  writeNote(full, lines.join("\n"));
  return { ok: true, path: toRel(full), skill: nm, source: local ? "local" : (inVault ? "vault" : "unknown") };
}

/** 镜像文件正文：**只读导出副本**声明头 + 去掉 frontmatter 的正文（确定性生成 → 幂等）。
 *  刻意**不含时间戳**：内容只由源文件推出，故「源没变 → 副本逐字节相同 → 跳过不重写」。 */
function mirrorTextOf(name, srcText) {
  const fm = parseFrontmatter(srcText);
  const desc = String(fm.frontmatter.description || "").trim();
  const body = String(fm.body || "").replace(/^\s*\n+/, "").replace(/\s*$/, "");
  const out = [
    "> ⚠️ 本文件是 `.dsh/skills/" + name + ".md` 的**只读导出副本**（由 DSH 生成）。请勿在此编辑——修改请用 DSH 面板的「编辑」，或直接告诉 DSH。",
    "",
    "<!-- 由 DSH 单向导出：源文件 `.dsh/skills/" + name + ".md` 才是真身；副本改动不会被采纳。 -->",
    "",
    "# " + name,
  ];
  if (desc) out.push("", desc);
  if (body) out.push("", body);
  return out.join("\n") + "\n";
}

/** POST /api/skills/mirror：单向导出本地技能到 <vault>/<skill_mirror_folder>/<名>.md。
 *  name 省略 = 全部本地技能；给了不存在的本地名 → 400（库内技能名同样 400，绝不导出/改动用户文件）。
 *  幂等：目标文件内容与本次生成**逐字节相同 → 不重写**，计入 skipped。 */
function mirrorSkills({ name } = {}) {
  const targets = [];
  const wantName = String(name == null ? "" : name).trim();
  if (wantName) {
    const nm = skillCardName(wantName);
    if (!nm) return { ok: false, status: 400, error: "bad name（不得为空 / 含路径分隔符 / 盘符 / `..` / 控制字符）" };
    const full = localSkillPath(nm);
    if (!full) {
      return { ok: false, status: 400, error: vaultSkillExists(nm) ? ("vault skill is read-only: " + nm) : ("not found: " + nm) };
    }
    targets.push({ name: nm, full });
  } else {
    let files = [];
    try { files = fs.readdirSync(skillsDir()).filter((f) => f.toLowerCase().endsWith(".md")); } catch {}
    for (const f of files.sort()) {
      const full = path.join(skillsDir(), f);
      let text = "";
      try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
      const nm = String(parseFrontmatter(text).frontmatter.name || f.replace(/\.md$/i, "")).trim();
      if (skillCardName(nm)) targets.push({ name: nm, full });
    }
  }
  const dirOut = mirrorDir();
  const mirrored = [], skipped = [];
  for (const t of targets) {
    let src = "";
    try { src = fs.readFileSync(t.full, "utf8"); } catch { skipped.push(t.name); continue; }
    const text = mirrorTextOf(t.name, src);
    const out = safeUnder(dirOut, safeName(t.name, { fallback: "skill" }) + ".md", { mustBeMd: true });
    if (!out) { skipped.push(t.name); continue; }
    let prev = null;
    try { prev = fs.readFileSync(out, "utf8"); } catch {}
    if (prev === text) { skipped.push(t.name); continue; }        // 幂等：内容相同 → 零写入
    writeNote(out, text);
    mirrored.push(t.name);
  }
  return { ok: true, dir: toRel(dirOut), mirrored, skipped, total: targets.length };
}

/**
 * 归档落库（/api/archive 与 /api/session/export 共用）：
 * frontmatter(title/created/source/tags) + `processed_tag` + 原子写 + 归档日志 + archiveCount+1。
 * 返回 {ok:true, path, tags} 或 {ok:false, status, error}。
 */
function archiveNote({ title, content, tags, folder, source, created }) {
  const settings = readSettings();
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean);
  const all = [...new Set([...list(tags), settings.processed_tag])];
  // 落点：folder 优先，否则 settings.archive_folder；两者都要在 vault 内
  const dir = safeDir(String(folder ?? "").trim() || settings.archive_folder);
  if (!dir) return { ok: false, status: 400, error: "bad folder" };
  // 文件名 <YYYY-MM-DD>-<title>，同名则追加 -2 / -3 …
  const base = `${localDay()}-${safeName(title, { fallback: "note" })}`;
  let full = path.join(dir, `${base}.md`);
  for (let i = 2; i < 1000 && fs.existsSync(full); i++) full = path.join(dir, `${base}-${i}.md`);
  if (fs.existsSync(full)) return { ok: false, status: 409, error: "too many duplicates" };
  const text = [
    "---",
    `title: ${yamlScalar(title)}`,
    `created: ${created || new Date().toISOString()}`,
    `source: ${yamlScalar(source || "DSH")}`,
    `tags: [${all.map(yamlScalar).join(", ")}]`,
    "---", "",
    String(content ?? "").replace(/^\s*\n/, ""),
  ].join("\n");
  writeNote(full, text.endsWith("\n") ? text : text + "\n");
  // 归档日志：按月一个文件，纯追加一行（首次创建时带一行标题）
  const logFile = path.join(DSH_DIR, "evolution", "logs", `archive-${localDay().slice(0, 7)}.md`);
  let prev = "";
  try { prev = fs.readFileSync(logFile, "utf8").replace(/\s*$/, "\n"); }
  catch { prev = `# 📦 DSH 归档日志 ${localDay().slice(0, 7)}\n\n`; }
  writeNote(logFile, prev + `- ${nowText()} 归档 ${toRel(full)}\n`);
  // 状态游标：archiveCount +1（读改写走 state.json 原子写）
  writeState({ archiveCount: (Number(readState().archiveCount) || 0) + 1 });
  return { ok: true, path: toRel(full), tags: all };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 会话导出（交付 2）：定位好的会话目录 → 纪要笔记
 * 调用方：POST /api/session/export（别名 /api/session/import）与自动导出扫描。
 * 单个会话的任何异常都在这里转成 {ok:false}，**绝不抛给调用方**（自动导出靠它做失败隔离）。
 * ══════════════════════════════════════════════════════════════════════════ */
function exportSession(hit, { title, tags, folder } = {}) {
  let records = [], badLines = 0;
  try {
    const raw = fs.readFileSync(hit.file);
    for (const line of zstdDecompressAll(raw).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch { badLines++; }        // 坏行跳过，不中断
    }
  } catch (e) {
    return { ok: false, status: 500, error: `读取会话失败：${e.message}` };
  }
  if (!records.length) return { ok: false, status: 500, error: `会话文件没有可解析记录（${hit.dir}）` };
  const memo = extractSessionMemo(records);
  const built = buildSessionMemo(memo);
  const useTitle = String(title ?? "").trim() || memo.title || `会话纪要 ${localDay()}`;
  const saved = archiveNote({
    title: useTitle,
    content: built.text,
    tags,
    folder,
    source: "DSH 会话",
    created: localDay(),                    // 本地日期（与投喂入库同一约定）
  });
  if (!saved.ok) return { ok: false, status: saved.status, error: saved.error };
  return {
    ok: true,
    note: saved.path,                        // vault 相对路径
    turns: memo.turns,
    chars: built.text.length,
    sessionDir: hit.dir,
    sessionId: (sessionHead(hit.file) || {}).id || hit.name,
    blocks: memo.blocks.length,
    truncated: built.truncated,
    skipped: memo.skipped,                   // 无纯文本被跳过的消息数
    noise: memo.noise,                       // 被判定为系统注入噪音的伪用户消息数
    badLines,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 自动导出对话（settings.auto_export_sessions）
 *   · 开关为 false → **完全不扫描**（连 readdir 都不做，也不写盘）；
 *   · 开启时：服务启动后延迟 60s 跑首轮，之后每 12 小时一轮（定时器可清理，见 start/stopAutoExportTimers）；
 *   · 候选条件（两者同时满足）：① now - mtime ≥ 2 天（用户所说「2 天内没有删除对话」）
 *                              ② 会话目录名不在 state.exportedSessions（持久化去重记录）；
 *   · 导出成功才把目录名写进 exportedSessions；单个会话失败只记日志，不中断整轮、不让服务崩溃。
 * 只写入知识库，不改动 DSH 会话本身。
 * ══════════════════════════════════════════════════════════════════════════ */
const AUTO_EXPORT_IDLE_MS = 2 * 24 * 60 * 60 * 1000;   // 静置阈值：2 天
const AUTO_EXPORT_FIRST_MS = 60 * 1000;                // 启动后首轮延迟：60 秒
const AUTO_EXPORT_EVERY_MS = 12 * 60 * 60 * 1000;      // 之后每 12 小时
const AUTO_EXPORT_LIST_LIMIT = 300;                    // candidates 接口 items 上限

/** 是否已被自动导出过：dir（相对路径，去重记录的主键）优先，兼容只记了目录名的数据 */
const isAutoExported = (done, s) => done.has(s.dir) || done.has(s.name);
/** 静置是否达标（now - mtime ≥ 2 天） */
const isIdleEnough = (s, now) => now - s.mtimeMs >= AUTO_EXPORT_IDLE_MS;

/**
 * 「下次会自动导出哪些」的只读快照：**绝不落盘、绝不落库**。
 * items 覆盖扫到的全部会话（候选排前，便于预览；每条带 exported 标记），
 * count 才是真正的候选数（≥ 2 天且未导出过）——用户由此预判下一轮会导出什么。
 */
function listExportCandidates(now = Date.now()) {
  const done = new Set(readState().exportedSessions);
  const all = listSessionDirs();
  const items = all.map((s) => ({
    dir: s.dir,
    sessionId: s.name,                                   // 目录名即 session-<uuid>，免去为预览解压会话头部
    mtimeMs: s.mtimeMs,
    ageDays: Math.round((now - s.mtimeMs) / 864000) / 100,   // 天，保留 2 位小数（864000ms = 0.01 天）
    exported: isAutoExported(done, s),
  }));
  const isCand = (it) => (!it.exported && now - it.mtimeMs >= AUTO_EXPORT_IDLE_MS) ? 1 : 0;
  items.sort((a, b) => isCand(b) - isCand(a) || b.mtimeMs - a.mtimeMs);   // 候选排前，其余按 mtime 倒序
  return {
    items: items.slice(0, AUTO_EXPORT_LIST_LIMIT),
    count: items.filter((it) => !it.exported && now - it.mtimeMs >= AUTO_EXPORT_IDLE_MS).length,
    total: all.length,
    now,
  };
}

/**
 * 跑一轮自动导出。开关关闭 → 立即返回 skipped（不扫描、不写盘）。
 * 返回 {ok, skipped, reason, scanned, candidates, exported, failed, notes[], errors[]}
 */
function runAutoExport(reason = "manual", now = Date.now()) {
  const settings = readSettings();
  if (settings.auto_export_sessions !== true) {
    console.log(`[dsh-obsidian-bridge] 自动导出（${reason}）：开关未开启 → 不扫描会话目录`);
    return { ok: true, skipped: true, reason, scanned: 0, candidates: 0, exported: 0, failed: 0, notes: [], errors: [] };
  }
  let all = [];
  try { all = listSessionDirs(); }
  catch (e) { console.error(`[dsh-obsidian-bridge] 自动导出（${reason}）：列举会话目录失败：${e.message}`); }
  const done = new Set(readState().exportedSessions);
  const cands = all.filter((s) => isIdleEnough(s, now) && !isAutoExported(done, s));
  const out = { ok: true, skipped: false, reason, scanned: all.length, candidates: cands.length, exported: 0, failed: 0, notes: [], errors: [] };
  for (const hit of cands) {
    let r;
    try { r = exportSession(hit, {}); }                   // 单个会话失败只记账，绝不中断整轮
    catch (e) { r = { ok: false, status: 500, error: String((e && e.message) || e) }; }
    if (!r || !r.ok) {
      out.failed++;
      out.errors.push(`${hit.dir}：${(r && r.error) || "未知错误"}`);
      console.error(`[dsh-obsidian-bridge] 自动导出失败：${hit.dir} —— ${(r && r.error) || "未知错误"}`);
      continue;                                           // 失败的下轮还会重试（不写去重记录）
    }
    out.exported++;
    out.notes.push(r.note);
    try {                                                 // 成功后才写 exportedSessions 并落盘
      const cur = readState().exportedSessions;
      if (!cur.includes(hit.dir)) writeState({ exportedSessions: [...cur, hit.dir] });
      done.add(hit.dir);
    } catch (e) {
      out.errors.push(`${hit.dir}：笔记已落库但记入 exportedSessions 失败 —— ${e.message}`);
      console.error(`[dsh-obsidian-bridge] 自动导出：记入 exportedSessions 失败 ${hit.dir} —— ${e.message}`);
    }
  }
  console.log(`[dsh-obsidian-bridge] 自动导出（${reason}）：扫描 ${out.scanned} 个会话 → 候选 ${out.candidates} 个 · 成功 ${out.exported} · 失败 ${out.failed}`);
  if (out.exported) console.log(`[dsh-obsidian-bridge] 自动导出落库：${out.notes.join("、")}`);
  return out;
}

let autoExportFirstTimer = null, autoExportTimer = null;
/** 注册「启动 60s 后首轮 + 之后每 12h 一轮」；重复调用会先清掉旧定时器 */
function startAutoExportTimers() {
  stopAutoExportTimers();
  autoExportFirstTimer = setTimeout(() => {
    autoExportFirstTimer = null;
    try { runAutoExport("首轮（启动后 60s）"); } catch (e) { console.error("[dsh-obsidian-bridge] 自动导出首轮异常：", e); }
    try {
      autoExportTimer = setInterval(() => {
        try { runAutoExport("定时（每 12 小时）"); } catch (e) { console.error("[dsh-obsidian-bridge] 自动导出定时轮异常：", e); }
      }, AUTO_EXPORT_EVERY_MS);
      if (autoExportTimer.unref) autoExportTimer.unref();  // 定时器不阻止进程退出
    } catch (e) { console.error("[dsh-obsidian-bridge] 自动导出定时器注册失败：", e); }
  }, AUTO_EXPORT_FIRST_MS);
  if (autoExportFirstTimer.unref) autoExportFirstTimer.unref();
  return autoExportFirstTimer;
}
/** 清理两个定时器（服务退出 / 自检收尾）：可重复调用 */
function stopAutoExportTimers() {
  if (autoExportFirstTimer) { clearTimeout(autoExportFirstTimer); autoExportFirstTimer = null; }
  if (autoExportTimer) { clearInterval(autoExportTimer); autoExportTimer = null; }
  return true;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 开工检索（GET /api/recall?q=&limit=）：DSH 新任务第一句话之后「回忆一次」——
 * 目的不只是找资料，而是把用户第一句话没说清的部分补齐（口径、命名与落盘约定、历史结论、
 * 可复用技能、已知缺口）。一次调用返回四段 + 库内习惯，全部**只读**：
 *   notes       最相关笔记（复用 searchNotesCore，即 /api/search 的检索与排序）
 *   skills      可复用技能卡（vault 内任意 `skills/<名字>/SKILL.md` + `.dsh/skills/*.md`）
 *   archived    同类历史（进化归档 = settings.evolution_log_folder）
 *   gaps        库内已记录的缺口条目（.dsh/evolution/gaps/*.md，逐条匹配）—— **默认只含未解决**
 *               （`- [ ]`，或无勾选框的旧格式）；`?includeResolved=1` 才把已解决（`- [x]`）一并返回，
 *               免得把「已经解决的」当成「未解决的未知空白」（反向误导同样要避免）。
 *   conventions 命中笔记汇总出的库内习惯（topTags / folders / frontmatterKeys）
 * 只读红线：不 mkdir、不写盘、不创建归档目录（故这里用 resolveTaskArchiveDir 而非 taskArchiveDir）。
 * ══════════════════════════════════════════════════════════════════════════ */
const RECALL_LIMIT_DEFAULT = 8;
const RECALL_LIMIT_MAX = 50;

/** limit 归一：缺省/非法/≤0 → 8；上限 50 */
function recallLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return RECALL_LIMIT_DEFAULT;
  return Math.min(Math.floor(n), RECALL_LIMIT_MAX);
}

/** 正文前 ~80 字：先剥 frontmatter、跳过前导空行与标题行（标题已单独返回），再压空白；超长补省略号 */
function bodyExcerpt(text, max = 80) {
  const lines = parseFrontmatter(String(text || "")).body.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (!lines[i].trim() || /^#{1,6}\s/.test(lines[i].trim()))) i++;
  const body = lines.slice(i).join(" ").replace(/\s+/g, " ").trim();
  return body.length > max ? body.slice(0, max) + "…" : body;
}

/** 技能卡清单：① vault 内任意 `skills/<名字>/SKILL.md`（如 copilot/skills/x/SKILL.md）
 *  ② 桥自己写的 `.dsh/skills/*.md`。只读扫描；`.` 开头目录与 SKIP_DIRS 一律不进。 */
function listSkillCards() {
  const out = [], seen = new Set();
  const add = (full, fallbackName) => {
    const rel = toRel(full);
    if (seen.has(rel)) return;
    seen.add(rel);
    let text = "";
    try { text = fs.readFileSync(full, "utf8"); } catch { return; }   // 不存在/读不动就跳过（不 stat，避免副作用）
    const fm = parseFrontmatter(text);
    out.push({
      name: String(fm.frontmatter.name || fallbackName || path.basename(full).replace(/\.md$/i, "")).trim(),
      description: String(fm.frontmatter.description || "").trim(),
      path: rel,
      /* 启用态：只有 .dsh/skills/ 下的本地卡会被「停用」（库内技能恒 true，只读红线） */
      enabled: rel.replace(/\\/g, "/").startsWith(LOCAL_SKILLS_REL)
        ? (fm.frontmatter.enabled === undefined ? true : parseEnabled(fm.frontmatter.enabled))
        : true,
      _head: text.split(/\r?\n/).slice(0, 20).join("\n"),             // 匹配用（前 20 行）；出口前剔除
    });
  };
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.name.toLowerCase() === "skills") {
        let subs = [];
        try { subs = fs.readdirSync(full, { withFileTypes: true }); } catch {}
        for (const s of subs) {
          if (s.isDirectory()) add(path.join(full, s.name, "SKILL.md"), s.name);
          else if (s.isFile() && s.name.toLowerCase() === "skill.md") add(path.join(full, s.name), s.name.replace(/\.md$/i, ""));
        }
        continue;                                                     // skills 目录内部不再下钻
      }
      walk(full);
    }
  };
  walk(VAULT);
  const dshSkills = path.join(DSH_DIR, "skills");
  let files = [];
  try { files = fs.readdirSync(dshSkills).filter((f) => f.toLowerCase().endsWith(".md")); } catch {}
  for (const f of files.sort()) add(path.join(dshSkills, f), f.replace(/\.md$/i, ""));
  return out;
}

/** 技能命中（**多词**：技能名 / 描述 / SKILL.md 前 20 行，任一词命中即入选，按命中词数降序）。
 *  **缺陷 1 修复：只返回真正命中的**。旧版"无命中 → 回退返回全部技能"会往调用方上下文里灌
 *  与本次查询无关的技能卡，而且**看起来像是命中的**（实测三个互不相关的查询返回同一批技能）；
 *  无命中一律返回**空数组**（要看全量清单请走 /api/skills，那是列表用途）。
 *  度量加权（可度量闭环）：先按 record 分档 positive → none/insufficient → negative，同档再按
 *  score → 命中词数 → 名字。statsMap 为空（或账本为空）时排序与旧行为**完全一致**。
 *  **停用跳过**：frontmatter `enabled: false` 的本地卡即使命中也不返回（缺省 true）；
 *  被跳过的命中数放在数组属性 `disabled` 上（JSON 不带出，路由另给顶层计数）。
 *  每条出口额外带 used/success/rework/fail/record/stats，以及扁平别名 score（= 度量分）。 */
function pickSkills(q, limit, statsMap = null) {
  const all = listSkillCards().sort((a, b) => a.name.localeCompare(b.name, "zh"));
  const tokens = tokenizeQuery(q);
  const rows = all.map((s) => ({
    s,
    matched: countTokenHits(tokens, `${s.name}\n${s.description}\n${s._head}`),
    st: statsMap ? statsLookup(statsMap, "skill", s.name, s.path) : STATS_ZERO,
  }));
  const on = rows.filter((r) => r.s.enabled !== false);        // 停用的卡不参与检索（开工检索会跳过）
  const picked = on.filter((r) => r.matched);                  // 无命中 → 空数组（**不再全量兜底**）
  picked.sort((a, b) =>
    (STATS_RANK[a.st.record] - STATS_RANK[b.st.record]) ||
    (b.st.score - a.st.score) ||
    (b.matched - a.matched) ||
    a.s.name.localeCompare(b.s.name, "zh"));
  const out = picked.slice(0, limit).map(({ s, st }) => {
    const { _head, enabled, ...rest } = s;
    return { ...rest, ...statsFields(st), score: st.score };
  });
  /** 数组属性（JSON.stringify 不会带出）：恒为 false —— skills 段**不再做全量兜底**。
   *  路由把它作为响应顶层 skillsFallback 返回，调用方可据此确认"空数组 = 真的没命中"。 */
  out.fallback = false;
  /** 命中了但被 `enabled: false` 跳过的条数（同样是数组属性，路由转成顶层 disabledSkills 计数） */
  out.disabled = rows.filter((r) => r.s.enabled === false && r.matched).length;
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 技能提炼 · 第一步「候选发现」（GET /api/skills/candidates?limit=10&min=3&kind=topic|container|all）
 *  kind 分类（每条候选新增字段）：topic = 真主题（有标签 / 归档任务 / 缺口 / 高分记账四项之一）；
 *    container = 只有容器信号（名字命中机器标签白名单，或证据里只有「目录 …」类）。
 *    **默认 kind=topic**：机器标签与容器目录体量最大却不是主题，展示给用户就是噪音；
 *    全量用 kind=all，只看容器用 kind=container；顶层 containerCount 恒为容器候选数。
 *  定位（红线）：**只找出「值得沉淀成技能的主题」并给出证据，不生成技能内容** ——
 *    提炼（写技能卡）由 DSH 侧完成。本接口**零写入**：不 mkdir、不写 state/settings/账本，
 *    归档目录只用 resolveTaskArchiveDir() 解析（taskArchiveDir() 会 mkdir，**此处禁用**）。
 *  四个来源（全部只读）：
 *    ① 高频标签  出现 ≥ min 篇的标签
 *    ② 高频目录  笔记数 ≥ min 的目录（一级 + 二级，口径同 GET /api/evolution/scan）
 *    ③ 归档主题  resolveTaskArchiveDir() 里每个 .md 的 `- 主题：`（缺省用文件名）
 *    ④ 记账条目  .dsh/stats.jsonl 聚合：score > 0（高分）或 used ≥ min（高频）
 *  合并口径：**同名归一后精确相等才合并**（小写 + 去首部 # + 去所有空白）。
 *    服务不做语义聚类 —— 「标签 A」与「主题 B」是不是一回事，属于理解，属于 DSH；
 *    这里只把**同名**证据汇到同一条候选上，绝不猜。
 *  归属（同样只做机械匹配）：
 *    记账 kind=note 的 id 是 vault 相对路径 → 落到「拥有该笔记」的候选（按标签/目录归属）；
 *    缺口按 gap 文件标题 `缺口清单：<主题>` 同名、或条目文本包含候选名来归属。
 *  打分（可解释；越大越该沉淀）：
 *      base  = 10 × min(标签笔记, 30) + 3 × min(纯目录笔记, 30)
 *            + 8 × highRated + 6 × archivedTasks + 5 × openGaps
 *      score = round(base × (hasSkill ? 0.4 : 1))
 *    · **标签是主题信号（10/篇），目录只是容器信号（3/篇）**：一篇笔记同时带标签又躺在该目录里时
 *      只按标签算一次（「纯目录笔记」= 该目录下未被本候选标签覆盖的笔记）；
 *      否则 剪藏仓 / 插件目录这类大杂烩会靠体量把真主题永远压在后面（实测数十篇 → 300 分）；
 *    · 两类笔记数各自封顶 30 篇（防止体量霸榜）；
 *    · highRated = 账本度量分 > 0 的条目数（口径同库内 statsScoreOf：一次 success ≈ +16.7）；
 *    · openGaps 口径（**冻结**，回归红线）：本接口**不参与**缺口生命周期 —— 归属上的缺口条目仍**全量**计入
 *      （含已标记解决的），行为与加状态标记之前逐条一致；要「真未解决 / 已解决」的计数请看
 *      /api/evolution 的 openGaps / resolvedGaps，或 /api/recall 的 counts.openGaps / counts.resolvedGaps。
 *  已有技能卡：**降权不排除**（×0.4）——「已有卡但证据还在长」本身是有用信号，
 *    要排除请调用方按 items[].hasSkill 自行过滤；匹配 = 名称 / `<名>/SKILL.md` 目录名 / 文件名
 *    同名，或**双向包含**：技能名+描述 包含 候选名，或 候选名 包含 技能名
 *    （两侧都要求 ≥3 字；比较前先做标点/宽度归一：全角→半角、`-`/`_`/空格/`·`/`：`/括号 同形化；
 *     新方向另加段对齐 + 单段短泛名否决，技能 `web` 不匹配候选 `web-scraping-tools`）。
 * ══════════════════════════════════════════════════════════════════════════ */
const CAND_LIMIT_DEFAULT = 10, CAND_LIMIT_MAX = 50;
const CAND_MIN_DEFAULT = 3, CAND_MIN_MAX = 20;
const CAND_NOTES_CAP = 30;            // 笔记数计分封顶（篇）
const CAND_TAG_NOTE_WEIGHT = 10;      // 标签（主题信号）
const CAND_DIR_NOTE_WEIGHT = 3;       // 纯目录（容器信号，权重刻意压低）
const CAND_SKILL_PENALTY = 0.4;       // 已有技能卡 → 得分 ×0.4
const CAND_EVIDENCE_PER_SOURCE = 3;   // 每类证据最多列几条（数字字段仍是全量）

/** 候选名归一（用于同名合并）：小写 + 去首部 # + 去所有空白 */
const candKey = (s) => String(s == null ? "" : s).trim().toLowerCase().replace(/^#+/, "").replace(/\s+/g, "");
/** 文本归一（用于包含匹配）：小写 + 去所有空白（「DSH 进化」与「DSH进化」视为同形） */
const candFlat = (s) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, "");
const candPosix = (s) => String(s == null ? "" : s).replace(/\\/g, "/");
/** **机器标签 / 容器目录名**白名单（通用名，不是某个库特有的主题词）：
 *  工具产物、剪藏仓、插件目录等「容器型」名字、
 *  附件区（`attachments`）这类名字体量往往最大，但**不是「值得沉淀的主题」**。
 *  `dsh([-_.\s].*)?` 只吃「DSH」「dsh-processed」，**不吃**归档目录本身（那是主题目录）。 */
const CAND_CONTAINER_RE = /^(dsh([-_.\s].*)?|copilot.*|attachments?|assets?|files?|media|images?|photos?|inbox|outbox|archives?|trash|tmp|temp|templates?)$/i;
/** 名字是否命中机器标签 / 容器目录白名单（去首部 `_ . -` 与尾部 `/ \` 后比，大小写无关） */
function candIsContainerName(name) {
  const t = String(name == null ? "" : name).trim().replace(/^[-_.\s]+/, "").replace(/[/\\]+$/, "");
  return !!t && CAND_CONTAINER_RE.test(t);
}

/** 候选 → 提炼交接状态索引（`GET /api/skills/candidates` 每条 topic 附带的 handoff 字段）。
 *  **数据源 = 进化任务（与面板「任务队列」同一批文件、同一份状态）**：
 *    「提炼技能」由 POST /api/skills/distill 写成 `.dsh/evolution/tasks/<ts>-<安全化主题>.md`，
 *    于是候选卡与队列里那张卡**读的是同一个文件** —— 单一份状态，不再各读各的（旧版读 .dsh/inbox/ ✗）。
 *    三个来源，按优先级：
 *      ① `.dsh/evolution/tasks/` = 主通道（队列里待执行 / 执行中）；
 *      ② 任务归档目录（settings.evolution_log_folder）= 「已完成」态：done 会把任务**搬出** tasks/，
 *         不读归档就永远看不到第三步（步进器第三态会凭空消失）；
 *      ③ `.dsh/inbox/` = **兜底**：旧版 distill 写的收件箱任务（启动时由 migrateDistillInboxTasks 迁移；
 *         迁移失败 / 迁移前留下的仍能显示，绝不因为换了通道就假装「没交过」）。
 *  匹配口径（**与候选同名归一同一把尺**）：candKey = 小写 + 去首部 # + 去所有空白。
 *    · 正文侧：`- 主题：`（原主题，无失真）；
 *    · 文件名侧：`<本地时间戳>-<安全化主题>` 去掉时间戳后的片段（旧式 `-distill-<主题>` 同样取）。
 *    **两侧任一命中即算同一主题** —— 于是主题含 `/` `:` `（）` 等字符时，文件名已变形，
 *    仍能靠正文匹配上（口径写清，不猜：不做模糊/包含匹配）。
 *  同名多个任务文件（同名主题连点两次 = 两个文件）→ 先比来源优先级（tasks > 归档 > inbox），同源再取 **mtimeMs 最新**。
 *  status：读 `- 状态：X`；无该字段（taskStatus 返回「未知」）→ 一律归一为「待执行」，
 *    只出三态（待执行 / 执行中 / 已完成），与面板步进器一一对应。
 *  只读（红线）：不 mkdir、不写任何文件；三个来源都不存在 → 全部 exists:false。 */
function handoffIndex() {
  const idx = new Map();                        // candKey(主题) → handoff 条目
  /** 扫一个来源目录（只扫这一层，不递归）；rank 越小优先级越高；onlyDistill 时只认旧式 distill 命名 */
  const scan = (dir, rank, onlyDistill) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
      const base = e.name.replace(/\.md$/i, "");
      const distill = /-distill-(.+)$/i.exec(base);
      if (onlyDistill && !distill) continue;
      const full = path.join(dir, e.name);
      let text = "", st = null;
      try { text = fs.readFileSync(full, "utf8"); } catch { continue; }   // 读不到 = 不算存在（宁缺勿编）
      try { st = fs.statSync(full); } catch {}
      const raw = taskStatus(text);
      const entry = {
        exists: true,
        path: toRel(full),
        status: /已完成/.test(raw) ? "已完成" : (/执行中/.test(raw) ? "执行中" : "待执行"),
        createdTs: Math.round((st && (st.birthtimeMs || st.ctimeMs)) || 0),
        mtimeMs: Math.round((st && st.mtimeMs) || 0),
      };
      const keys = [candKey(taskTopic(text))];
      const afterTs = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-(.+)$/.exec(base);
      if (afterTs) keys.push(candKey(afterTs[1]));       // 进化任务：<ts>-<安全化主题>
      if (distill) keys.push(candKey(distill[1]));       // 旧式：<ts>-distill-<安全化主题>
      for (const key of keys) {
        if (!key) continue;
        const prev = idx.get(key);
        if (prev && (prev.rank < rank || (prev.rank === rank && prev.mtimeMs >= entry.mtimeMs))) continue;
        idx.set(key, Object.assign({ rank }, entry));
      }
    }
  };
  scan(evoDir("tasks"), 0, false);                  // ① 任务队列（与任务卡同源）
  const arch = resolveTaskArchiveDir();
  if (arch) scan(arch, 1, false);                   // ② 已完成归档（归档目录读不到 → 静默跳过）
  scan(INBOX_DIR, 2, true);                         // ③ 旧版收件箱 distill 任务兜底
  for (const v of idx.values()) delete v.rank;      // rank 只用于内部选优，不进响应
  return idx;
}

function skillCandidates({ limit, min, kind } = {}) {
  /* kind 过滤：topic（**默认**，真主题）/ container（容器）/ all（全量）。
   * 默认只给 topic 的原因：机器标签与容器目录在候选榜上体量最大，展示给用户就是噪音
   * （实测容器型会靠体量压住真主题）；调用方要全量传 kind=all。 */
  const want = kind === "all" ? "" : (kind === "container" ? "container" : "topic");
  const nLimit = Number(limit), nMin = Number(min);
  const lim = Number.isFinite(nLimit) && nLimit > 0 ? Math.min(Math.floor(nLimit), CAND_LIMIT_MAX) : CAND_LIMIT_DEFAULT;
  const mn = Number.isFinite(nMin) && nMin > 0 ? Math.min(Math.floor(nMin), CAND_MIN_MAX) : CAND_MIN_DEFAULT;

  const map = new Map();                       // key → 候选桶
  const bucket = (name) => {
    const key = candKey(name);
    if (!key) return null;
    let b = map.get(key);
    if (!b) {
      b = { topic: String(name).trim(), notes: new Set(), fromTags: new Set(), fromDirs: new Set(), tags: [], dirs: [], archived: [], gaps: [], stats: [], skillNames: [] };
      map.set(key, b);
    }
    return b;
  };
  const byCountDesc = (a, b) => (b.count - a.count) || a.name.localeCompare(b.name, "zh");

  // ── ① 高频标签 / ② 高频目录：先全库计数，再只给 ≥min 的建种子 ──
  const { notes } = scanVault();               // 只读全库扫描（内部 mtime+size 缓存）
  const tagNotes = new Map(), dirNotes = new Map();
  for (const n of notes) {
    const rel = candPosix(n.path);
    for (const t of n.tags) {
      const s = tagNotes.get(t) || new Set(); s.add(rel); tagNotes.set(t, s);
    }
    const parts = rel.split("/");
    for (const d of new Set([parts.length > 1 ? parts[0] : "", parts.length > 2 ? parts.slice(0, 2).join("/") : ""])) {
      if (!d) continue;
      const s = dirNotes.get(d) || new Set(); s.add(rel); dirNotes.set(d, s);
    }
  }
  for (const [t, set] of tagNotes) {
    if (set.size < mn) continue;
    const b = bucket(t);
    if (!b) continue;
    b.tags.push({ name: t, count: set.size });
    for (const p of set) { b.notes.add(p); b.fromTags.add(p); }
  }
  for (const [d, set] of dirNotes) {
    if (set.size < mn) continue;
    const b = bucket(d);
    if (!b) continue;                          // 同名（标签与目录同名）→ 与标签桶合并
    b.dirs.push({ name: d, count: set.size });
    for (const p of set) { b.notes.add(p); b.fromDirs.add(p); }
  }

  // ── ③ 进化归档主题（只读解析目录，绝不创建）──
  const archDir = resolveTaskArchiveDir();
  let archEntries = [];
  try { archEntries = fs.readdirSync(archDir, { withFileTypes: true }); } catch { archEntries = []; }
  for (const e of archEntries.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
    const full = path.join(archDir, e.name);
    let text = "";
    try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
    const topic = taskTopic(text) || e.name.replace(/\.md$/i, "");
    const b = bucket(topic);
    if (!b) continue;
    b.archived.push({ name: e.name, path: toRel(full), topic });
  }

  // ── ④-甲 缺口清单：只做归属，不产生候选 ──
  const gapDir = evoDir("gaps");
  let gapFiles = [];
  try { gapFiles = fs.readdirSync(gapDir).filter((f) => f.toLowerCase().endsWith(".md")).sort(); } catch { gapFiles = []; }
  const gapParsed = [];
  for (const f of gapFiles) {
    const full = path.join(gapDir, f);
    let text = "";
    try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
    const topic = String(/缺口清单：\s*(.+)/.exec(text)?.[1] || f.replace(/\.md$/i, "")).trim();
    const items = [];
    for (const line of text.split(/\r?\n/)) {
      if (!/^\s*[-*]\s+/.test(line)) continue;                       // 只数条目行（标题/引用行不算）
      const t = line.replace(/^\s*[-*]\s+/, "").trim();
      if (!t || t === "（无）" || /^生成时间：/.test(t)) continue;
      items.push(t);
    }
    if (items.length) gapParsed.push({ path: toRel(full), topic, items });
  }
  for (const g of gapParsed) {
    const gk = candKey(g.topic);
    for (const b of map.values()) {
      const bk = candKey(b.topic);
      if (!bk) continue;
      const same = gk === bk;                                        // 同名 → 整个缺口文件都算相关
      const hits = g.items.filter((it) => same || (bk.length >= 2 && candFlat(it).includes(bk)));
      if (!hits.length) continue;
      b.gaps.push({ file: g.path, topic: g.topic, count: hits.length, lines: hits.slice(0, 2) });
    }
  }

  // ── ④-乙 记账账本（只读聚合）：先归属到「拥有该笔记」的候选；note 型若无所属候选，
  //    且 score>0 或 used≥min，则用**笔记标题**建一条新候选（记账本身就是来源之一）。──
  const noteByRel = new Map();
  for (const n of notes) noteByRel.set(candPosix(n.path).toLowerCase(), n);
  const owners = new Map();                     // 归一路径 → [候选桶]
  for (const b of map.values()) for (const p of b.notes) {
    const k = String(p).toLowerCase();
    const arr = owners.get(k) || []; arr.push(b); owners.set(k, arr);
  }
  const si = statsIndex();
  const statRows = [...si.map.values()].sort((a, b) =>
    (b.score - a.score) || (b.used - a.used) || String(a.id).localeCompare(String(b.id), "zh"));
  for (const a of statRows) {
    const idRel = candPosix(a.id);
    const direct = map.get(candKey(a.id));
    let targets = direct ? [direct] : (owners.get(idRel.toLowerCase()) || []);
    if (!targets.length) {
      if (a.kind !== "note") continue;            // 技能/任务记账不凭空造候选（技能已存在 / 任务另有归档来源）
      if (!(a.score > 0 || a.used >= mn)) continue;   // 只有「高分或高频」的记账才够格当来源
      const n = noteByRel.get(idRel.toLowerCase());
      const seed = bucket(n ? n.title : (idRel.split("/").pop() || "").replace(/\.md$/i, ""));
      if (!seed) continue;
      targets = [seed];
    }
    for (const b of targets) b.stats.push({ kind: a.kind, id: idRel, used: a.used, score: a.score, record: a.record });
  }

  // ── 已有技能卡匹配（只读；listSkillCards 与 /api/skills、/api/recall 同源）──
  //  标点/宽度归一（同一含义的不同写法视为同形）：
  //    · 全角 → 半角（（）［］：， 等同形化），转小写、折叠重复、去首尾分隔符
  //    · 弱分隔（- _ 空格 · ・ — –）→ "-"；强分隔（：:；;，,、。括号类）→ "|"
  //    · candCit = 两类分隔都压成 "-"，用于**比较**（同义不同形等价）
  //    · candSeg = 保留强弱，用于**边界判定**（挡「短泛名被更长同族名吞并」）
  const candCit = (s) => String(s == null ? "" : s)
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ")
    .replace(/[：:；;，,、。.！!？?（）()［］\[\]【】{}｛｝《》〈〉「」『』]/g, "-")
    .replace(/[-_\s·・—–]+/g, "-")
    .replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "")
    .toLowerCase();
  const candSeg = (s) => String(s == null ? "" : s)
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ")
    .replace(/[：:；;，,、。.！!？?（）()［］\[\]【】{}｛｝《》〈〉「」『』]/g, "|")
    .replace(/[-_\s·・—–]+/g, "-")
    .replace(/\|{2,}/g, "|").replace(/-{2,}/g, "-").replace(/^[|-]+|[|-]+$/g, "")
    .toLowerCase();
  /** 候选名是否**段对齐地包含**技能名（新方向；防误配边界见下）：
   *  ① 技能名归一后 <3 字 → 不做包含匹配（原短名规则，技能 `ab`(2 字) 不匹配 `abc…`）；
   *  ② 命中点前后必须是串首/串尾或分隔符（防止子串噪音）；
   *  ③ 单段短泛名（≤4 字且不含分隔符，如 `web`）后面紧跟**弱分隔** → 判为被更长同族名吞并，
   *     不匹配（技能 `web` ✗ 候选 `web-scraping-tools`）；后接强分隔（副标题，如 `web：入门`）
   *     或技能名本身跨 ≥2 段（`alpha-beta-gamma`）→ 放行。
   *  用「包含」而非「公共前缀」：候选可能是 `前缀-技能名` 形态，前缀受限会漏配；
   *  段对齐 + 短泛名否决已足以挡住过度匹配。 */
  const skillInsideTopic = (topic, skillName) => {
    const n = candCit(skillName);
    if (n.length < 3) return false;
    const hay = candSeg(topic);
    if (!hay) return false;
    const re = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[-|]"), "g");
    let m;
    while ((m = re.exec(hay))) {
      const before = m.index ? hay[m.index - 1] : "";
      const after = hay[m.index + m[0].length] || "";
      if (before && before !== "-" && before !== "|") continue;
      if (after && after !== "-" && after !== "|") continue;
      if (after === "-" && n.length <= 4 && !n.includes("-")) continue;
      return true;
    }
    return false;
  };
  const cards = listSkillCards();
  const skillKeys = new Map();
  for (const c of cards) {
    const segs = candPosix(c.path).split("/").filter(Boolean);
    const aliases = [c.name, segs.length >= 2 ? segs[segs.length - 2] : "", segs.length ? segs[segs.length - 1].replace(/\.md$/i, "") : ""];
    for (const x of aliases) { const k = candKey(x); if (k && !skillKeys.has(k)) skillKeys.set(k, c.name); }
  }
  for (const b of map.values()) {
    const bk = candKey(b.topic);
    if (!bk) continue;
    const hit = skillKeys.get(bk);
    if (hit) { b.skillNames.push(hit); continue; }
    const bcit = candCit(b.topic);
    if (bcit.length < 3) continue;                // 短名不做包含匹配（噪音太大）
    for (const c of cards) {
      const skillText = candCit(`${c.name}\n${c.description}`);
      if (skillText.includes(bcit)                        // ① 原方向：技能名/描述 包含 候选名
        || skillInsideTopic(b.topic, c.name)) {           // ② 新方向：候选名 包含 技能名
        b.skillNames.push(c.name); break;
      }
    }
  }

  // ── 打分 + 出口 ──
  const handoffs = handoffIndex();              // 交接状态（只读扫 .dsh/inbox；**只新增 handoff 字段**）
  const items = [];
  for (const b of map.values()) {
    const noteCount = b.notes.size;
    const highRated = b.stats.filter((s) => s.score > 0).length;
    const archivedTasks = b.archived.length;
    const openGaps = b.gaps.reduce((n, g) => n + g.count, 0);
    const skillNames = [...new Set(b.skillNames)];
    const hasSkill = skillNames.length > 0;
    const tagNotesN = Math.min(b.fromTags.size, CAND_NOTES_CAP);
    const dirOnlyN = Math.min([...b.fromDirs].filter((p) => !b.fromTags.has(p)).length, CAND_NOTES_CAP);
    const base = CAND_TAG_NOTE_WEIGHT * tagNotesN + CAND_DIR_NOTE_WEIGHT * dirOnlyN
      + 8 * highRated + 6 * archivedTasks + 5 * openGaps;
    const score = Math.round(base * (hasSkill ? CAND_SKILL_PENALTY : 1));
    const stats = b.stats.slice().sort((x, y) => (y.score - x.score) || (y.used - x.used));
    const evidence = [];
    for (const t of b.tags.slice().sort(byCountDesc).slice(0, CAND_EVIDENCE_PER_SOURCE)) evidence.push(`标签 ${t.name} ×${t.count}`);
    for (const d of b.dirs.slice().sort(byCountDesc).slice(0, CAND_EVIDENCE_PER_SOURCE)) evidence.push(`目录 ${d.name} ×${d.count}`);
    for (const x of b.archived.slice(0, CAND_EVIDENCE_PER_SOURCE)) evidence.push(`归档 ${x.name}`);
    for (const g of b.gaps.slice(0, CAND_EVIDENCE_PER_SOURCE)) evidence.push(`缺口 ${g.file}${g.count > 1 ? ` ×${g.count}` : ""}`);
    for (const s of stats.slice(0, CAND_EVIDENCE_PER_SOURCE)) evidence.push(`记账 ${s.kind} ${s.id} score=${s.score} used=${s.used}${s.record && s.record !== "none" ? ` (${s.record})` : ""}`);
    if (hasSkill) evidence.push(`已有技能卡 ${skillNames.join(" / ")}（已降权 ×${CAND_SKILL_PENALTY}）`);
    const samplePaths = [...b.notes].sort().slice(0, 3);
    if (!samplePaths.length) samplePaths.push(...b.archived.slice(0, 3).map((x) => x.path));
    /* kind 分类（**只新增字段，不改既有字段语义**）：
     *   topic     = 有主题信号：标签证据 / 归档任务 / 缺口 / **高分**记账（score > 0）
     *   container = 只有容器信号：名字命中机器标签白名单，或证据里**只有**「目录 …」类
     *               （没有上面任何一种主题信号，但有目录信号）
     * 低分记账（score ≤ 0）**不算**主题信号 —— 口径与上面「③④ 四个来源」一致。 */
    const hasTopicSignal = b.fromTags.size > 0 || archivedTasks > 0 || openGaps > 0 || highRated > 0;
    const ckind = (candIsContainerName(b.topic) || (!hasTopicSignal && b.dirs.length > 0)) ? "container" : "topic";
    items.push({ topic: b.topic, score, kind: ckind, notes: noteCount, highRated, archivedTasks, openGaps, hasSkill, skillNames, evidence, samplePaths,
      /* 交接状态（**只新增字段**，不改任何既有字段语义；老客户端忽略它即回到原行为）：
         exists=false = 还没交给 DSH 提炼（面板保持原「交给 DSH 提炼」按钮）。 */
      handoff: handoffs.get(candKey(b.topic)) || { exists: false } });
  }
  items.sort((a, b) =>
    (b.score - a.score) || (b.notes - a.notes) || (b.archivedTasks - a.archivedTasks) || a.topic.localeCompare(b.topic, "zh"));
  const containerCount = items.filter((x) => x.kind === "container").length;
  const shown = want ? items.filter((x) => x.kind === want) : items;   // topic 内仍是 score 降序
  const page = shown.slice(0, lim);
  return {
    ok: true, count: shown.length, returned: page.length, total: shown.length,
    limit: lim, min: mn, containerCount, items: page,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 进化对象 · 第四类「提示词与模板」（`<vault>/.dsh/prompts/`）
 *  借鉴清单第 4 条：前三条通道只覆盖「知识（笔记）」与「技能（技能卡）」，而 DSH 自己用的
 *  **提示词 / 模板 / 检查清单**（"开工检索怎么问" / "周报模板" / "评审清单"）散落在会话里 ——
 *  既不沉淀也不迭代。本段让它与技能同等待遇：**存放 / 索引 / 候选 / 版本 / 度量聚合**。
 *  分工（与 /api/skills/candidates 同一哲学）：服务端只做**机制**（扫描、解析、候选发现、追加式
 *  版本化、账本打通），**内容一律由 DSH 写** —— 故 candidates 只给「值得固化的模式 + 证据」，
 *  绝不生成一句提示词正文。
 *  目录约定：
 *    .dsh/prompts/<name>.md                  当前版本（frontmatter: name / description / kind / used_for）
 *    .dsh/prompts/.history/<name>/<ts>.md    历史版本（**只增不删**；save 时旧文件逐字节拷贝）
 *  kind ∈ prompt | template | checklist（其余视为坏文件 → skipped，不做猜测 / 不做降级）。
 *  只读红线：除 POST /api/prompts/save 与 DELETE /api/prompts 只写 .dsh/prompts/（含 .history）外，
 *    本段接口**零写入** —— 目录不存在不创建（readdirSync 失败即空），candidates / history 同样不
 *    mkdir、不写账本。
 *  **删除语义（与技能区对齐，但历史口径更严）**：DELETE 只移除**当前版本** `<name>.md`，
 *    `.history/<name>/` **原样保留**（历史只增不删）→ 删掉再建同名，版本链从旧历史继续（version 接着涨）。
 *  安全：name 一律先过 promptSlug()（拒空 / 路径分隔符 / 盘符 / `..` / 控制字符）→ 400，
 *    再经 safeUnder() 双保险（解析结果必须落在 .dsh/prompts/ 之内）。
 * ══════════════════════════════════════════════════════════════════════════ */
const PROMPT_KINDS = Object.freeze(["prompt", "template", "checklist"]);
const PROMPT_KIND_DEFAULT = "prompt";
const PROMPT_NAME_MAX = 80;

const promptsDir = () => path.join(DSH_DIR, "prompts");
const promptsHistoryDir = (slug) => path.join(promptsDir(), ".history", slug);

/** 提示词名 → 安全文件名片段。**拒绝而非静默清洗**：name 是调用方给的身份，悄悄改名会造成
 *  「写进去却按原名找不到」。拒绝条件：空 / 超长 / 控制字符 / 路径分隔符 / 盘符或 UNC / 绝对路径 / 纯点。
 *  通过者仍走 safeName()（折叠空白、把 Windows 非法字符如 `:` 变 `-`）+ safeUnder()（越界兜底）。 */
function promptSlug(raw) {
  const name = String(raw ?? "").trim();
  if (!name || name.length > PROMPT_NAME_MAX) return null;
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  if (/[\\/]/.test(name)) return null;                        // ../../evil、a/b、C:\x
  if (path.isAbsolute(name) || /^[A-Za-z]:/.test(name)) return null;
  if (/^\.+$/.test(name)) return null;                        // . / .. / ...
  const slug = safeName(name, { fallback: "" });
  if (!slug || /^\.+$/.test(slug)) return null;
  return slug;
}

/** 提示词库扫描（只读）：**只看 .dsh/prompts/ 直属 *.md**（点开头的 .history 自然不进）。
 *  坏文件口径（→ skipped 计数后跳过，绝不打挂接口）：读不动 / 无 frontmatter / kind 不在 PROMPT_KINDS
 *  / name 为空。「坏」不做降级猜测 —— 猜错会让一条没写好的文件静默出现在索引里。 */
function listPromptItems() {
  const dir = promptsDir();
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { items: [], skipped: 0 }; }
  const items = [];
  let skipped = 0;
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
    const full = path.join(dir, e.name);
    let text = "", st = null;
    try { text = fs.readFileSync(full, "utf8"); st = fs.statSync(full); } catch { skipped++; continue; }
    if (!String(text).startsWith("---")) { skipped++; continue; }
    const fm = parseFrontmatter(text);
    const kind = String(fm.frontmatter.kind || "").trim().toLowerCase();
    const name = String(fm.frontmatter.name || "").trim();
    if (!PROMPT_KINDS.includes(kind) || !name) { skipped++; continue; }
    items.push({
      name,
      description: String(fm.frontmatter.description || "").trim(),
      kind,
      used_for: String(fm.frontmatter.used_for || "").trim(),
      path: toRel(full),
      mtimeMs: st.mtimeMs,
      size: st.size,
    });
  }
  items.sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.name.localeCompare(b.name, "zh"));
  return { items, skipped };
}

/** GET /api/prompts 载荷：count = **过滤后**条数（调用方要的清单长度），total = 过滤前全量，skipped = 坏文件数 */
function listPromptsPayload(kindFilter) {
  const { items, skipped } = listPromptItems();
  const want = String(kindFilter || "").trim().toLowerCase();
  const filtered = want && want !== "all" ? items.filter((x) => x.kind === want) : items;
  return { ok: true, count: filtered.length, total: items.length, skipped, items: filtered };
}

/** 历史版本文件名 → 毫秒时间戳（文件名 = ISO 时间戳，`:` 与 `.` 换成 `-`）；解析不出返回 0 */
function promptTsOf(file) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(String(file));
  if (!m) return 0;
  return Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) || 0;
}

/** GET /api/prompts/history?name= → 该提示词的历史版本（时间倒序）+ current（当前版本，无则 null）。
 *  只读：.history/<name>/ 不存在 → 空列表（**不创建目录**）。 */
function listPromptHistory(rawName) {
  const slug = promptSlug(rawName);
  if (!slug) return { ok: false, status: 400, error: "bad name（不得为空 / 含路径分隔符 / 盘符 / .. / 控制字符）" };
  const hist = promptsHistoryDir(slug);
  let files = [];
  try { files = fs.readdirSync(hist).filter((f) => f.toLowerCase().endsWith(".md")); } catch { files = []; }
  const versions = files.map((f) => {
    const full = path.join(hist, f);
    let st = { mtimeMs: 0, size: 0 };
    try { st = fs.statSync(full); } catch {}
    return { name: f, path: toRel(full), ts: promptTsOf(f) || st.mtimeMs, mtimeMs: st.mtimeMs, size: st.size };
  }).sort((a, b) => (b.ts - a.ts) || b.name.localeCompare(a.name));
  let current = null;
  try {
    const st = fs.statSync(path.join(promptsDir(), `${slug}.md`));
    if (st.isFile()) current = { path: toRel(path.join(promptsDir(), `${slug}.md`)), mtimeMs: st.mtimeMs, size: st.size, version: versions.length + 1 };
  } catch {}
  return { ok: true, name: slug, count: versions.length, versions, current };
}

/** POST /api/prompts/save —— **全文件唯一的提示词写路径**，只写 .dsh/prompts/ 与 .dsh/prompts/.history/。
 *  追加式版本化：同名已存在 → 旧文件用 copyFileSync **逐字节**拷进 .history/<slug>/<ts>.md（不经字符串
 *  解码，故与原文二进制等价）→ 再原子写新内容。历史**只增不删**，故 version = 历史条数 + 1（首次 = 1）。
 *  返回 {ok,path,version,historyPath}；非法 name/kind/content → {ok:false,status:400}（路由据此回 400）。 */
function savePrompt({ name, kind, description, used_for, content, note }) {
  const slug = promptSlug(name);
  if (!slug) return { ok: false, status: 400, error: "bad name（不得为空 / 含路径分隔符 / 盘符 / .. / 控制字符）" };
  const k = String(kind == null ? "" : kind).trim().toLowerCase() || PROMPT_KIND_DEFAULT;
  if (!PROMPT_KINDS.includes(k)) return { ok: false, status: 400, error: `bad kind（只允许 ${PROMPT_KINDS.join(" / ")}）` };
  if (content == null) return { ok: false, status: 400, error: "content required（提示词正文由 DSH 写，服务端只落盘）" };
  const full = safeUnder(promptsDir(), `${slug}.md`, { mustBeMd: true });
  if (!full) return { ok: false, status: 400, error: "bad name（越界）" };

  let historyPath = null;
  let exists = false;
  try { exists = fs.statSync(full).isFile(); } catch {}
  if (exists) {
    const histDir = promptsHistoryDir(slug);
    fs.mkdirSync(histDir, { recursive: true });
    let target = "";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (let i = 0; i < 1000 && !target; i++) {
      const cand = path.join(histDir, i === 0 ? `${stamp}.md` : `${stamp}-${i}.md`);
      if (!fs.existsSync(cand)) target = cand;
    }
    if (!target) return { ok: false, status: 500, error: "history name collision" };
    try { fs.copyFileSync(full, target); }                     // 旧内容逐字节保留（只增不删）
    catch (e) { return { ok: false, status: 500, error: `history copy failed: ${e.message}` }; }
    historyPath = toRel(target);
  }

  const head = [
    "---",
    `name: ${yamlScalar(String(name).trim())}`,
    `description: ${yamlScalar(description ?? "")}`,
    `kind: ${k}`,
    `used_for: ${yamlScalar(used_for ?? "")}`,
    `updated: ${new Date().toISOString()}`,
  ];
  if (note) head.push(`note: ${yamlScalar(note)}`);
  head.push("---", "");
  const text = head.join("\n") + String(content).replace(/^\s*\n/, "");
  writeNote(full, text.endsWith("\n") ? text : text + "\n");

  let version = 1;
  try { version = fs.readdirSync(promptsHistoryDir(slug)).filter((f) => f.toLowerCase().endsWith(".md")).length + 1; } catch {}
  return { ok: true, name: String(name).trim(), kind: k, path: toRel(full), version, historyPath };
}

/** DELETE /api/prompts?name= —— 移除**当前版本** `.dsh/prompts/<slug>.md`。
 *  **历史不动**（`.history/<slug>/` 原样保留）：本段红线是「历史只增不删」，而 save 已经承诺
 *  旧内容逐字节留档；若删除再把历史一起抹掉，就等于用一个删除动作推翻了 save 的承诺。
 *  副作用（已在 UI 文案里写清）：删掉后重建同名 → version 从旧历史接着涨，不是从 1 开始。
 *  返回 {ok,deleted,name,historyKept}；name 非法 → 400；不存在 → 404；非文件（目录同名）→ 404。 */
function deletePrompt(rawName) {
  const slug = promptSlug(rawName);
  if (!slug) return { ok: false, status: 400, error: "bad name（不得为空 / 含路径分隔符 / 盘符 / .. / 控制字符）" };
  const full = safeUnder(promptsDir(), `${slug}.md`, { mustBeMd: true });
  if (!full) return { ok: false, status: 400, error: "bad name（越界）" };
  let st = null;
  try { st = fs.statSync(full); } catch {}
  if (!st || !st.isFile()) return { ok: false, status: 404, error: "not found" };
  let historyKept = 0;
  try { historyKept = fs.readdirSync(promptsHistoryDir(slug)).filter((f) => f.toLowerCase().endsWith(".md")).length; } catch {}
  try { fs.unlinkSync(full); }
  catch (e) { return { ok: false, status: 500, error: `delete failed: ${e.message}` }; }
  return { ok: true, name: slug, deleted: toRel(full), historyKept };
}

/* ── 提示词候选发现（GET /api/prompts/candidates?limit=10&min=3）────────────────
 *  定位（红线）：**只找出「值得固化成提示词 / 模板 / 检查清单的模式」并给出证据，不生成内容** ——
 *  内容由 DSH 写。纯只读：不 mkdir、不写 state/settings/账本（归档目录只用 resolveTaskArchiveDir()
 *  解析，taskArchiveDir() 会 mkdir，此处**禁用**）。
 *  三个来源（对应任务口径「归档的进化任务 / 高分笔记 / 记账」）：
 *    ① 归档的进化任务  同主题（`- 主题：`）被归档 **≥ min** 次 → 种子（最强信号：同一套流程反复在跑）
 *    ② 高分笔记        记账 kind=note：score > 0 或 used ≥ min → 种子 = **笔记标题**（被证明好用的记录方式）；
 *                      笔记自身的标签作为「场景证据」并入（解释这套问法属于什么场景）
 *    ③ 记账            非 note 条目（skill / task / prompt）：score > 0 或 used ≥ min → 种子 = 归一的 id
 *    缺口清单只做**归属**（同名或条目文本包含候选名），**不产生候选** —— 与 skillCandidates 同口径。
 *  min 门槛：只有「归档次数 ≥ min」「used ≥ min」或「score > 0」的来源才是种子；达不到的连桶都不建。
 *  打分（可解释；越大越该固化）：
 *      base  = 12 × min(归档次数, 20) + 8 × min(高分条目, 20)
 *            + 6 × min(仅高频条目, 10) + 3 × min(缺口条目, 10)
 *      score = round(base × (hasPrompt ? 0.4 : 1))
 *    · 归档权重最高：模板/流程的价值来自「同一件事被反复归档」；
 *    · 「仅高频」与「高分」互斥计数（一条同时高分又高频只算高分一次），避免重复计分；
 *    · 已有提示词 → **降权不排除**（×0.4，同 skills 口径）——「已有但证据还在长」本身就是有用信号，
 *      要排除请调用方按 hasPrompt 自行过滤；
 *    · suggest = 机械规则（不做语义理解）：归档/高频 ≥2 → template；有缺口 → checklist；否则 prompt。
 *  合并口径：**同名归一后精确相等才合并**（复用 candKey：小写 + 去首部 # + 去空白）。
 * ══════════════════════════════════════════════════════════════════════════ */
const PCAND_LIMIT_DEFAULT = 10, PCAND_LIMIT_MAX = 50;
const PCAND_MIN_DEFAULT = 3, PCAND_MIN_MAX = 20;
const PCAND_CAP = 20;
const PCAND_W_ARCHIVED = 12, PCAND_W_HIGHRATED = 8, PCAND_W_FREQUENT = 6, PCAND_W_GAP = 3;
const PCAND_PROMPT_PENALTY = 0.4;
const PCAND_EVIDENCE_PER_SOURCE = 3;

function promptCandidates({ limit, min } = {}) {
  const nLimit = Number(limit), nMin = Number(min);
  const lim = Number.isFinite(nLimit) && nLimit > 0 ? Math.min(Math.floor(nLimit), PCAND_LIMIT_MAX) : PCAND_LIMIT_DEFAULT;
  const mn = Number.isFinite(nMin) && nMin > 0 ? Math.min(Math.floor(nMin), PCAND_MIN_MAX) : PCAND_MIN_DEFAULT;

  const map = new Map();
  const bucket = (name) => {
    const key = candKey(name);
    if (!key) return null;
    let b = map.get(key);
    if (!b) { b = { topic: String(name).trim(), archived: [], stats: [], gaps: [], tags: [], promptNames: [], paths: new Set() }; map.set(key, b); }
    return b;
  };

  // ── ① 归档的进化任务：先按主题计数，只有 ≥ min 的建种子（min 门槛在此生效）──
  const archDir = resolveTaskArchiveDir();
  let archEntries = [];
  try { archEntries = fs.readdirSync(archDir, { withFileTypes: true }); } catch { archEntries = []; }
  const archByTopic = new Map();
  for (const e of archEntries.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
    const full = path.join(archDir, e.name);
    let text = "";
    try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
    const topic = String(taskTopic(text) || e.name.replace(/\.md$/i, "")).trim();
    const key = candKey(topic);
    if (!key) continue;
    let g = archByTopic.get(key);
    if (!g) { g = { topic, files: [] }; archByTopic.set(key, g); }
    g.files.push({ name: e.name, path: toRel(full) });
  }
  for (const g of archByTopic.values()) {
    if (g.files.length < mn) continue;
    const b = bucket(g.topic);
    if (!b) continue;
    b.archived.push({ topic: g.topic, count: g.files.length, files: g.files });
    for (const f of g.files) b.paths.add(f.path);
  }

  // ── ② / ③ 记账：高分或高频才是种子；能归属到已有桶的只当证据（不新建）──
  const { notes } = scanVault();
  const noteByRel = new Map();
  for (const n of notes) noteByRel.set(candPosix(n.path).toLowerCase(), n);
  const si = statsIndex();
  const statRows = [...si.map.values()].sort((a, b) =>
    (b.score - a.score) || (b.used - a.used) || String(a.id).localeCompare(String(b.id), "zh"));
  for (const a of statRows) {
    const idRel = candPosix(a.id);
    const high = a.score > 0, freq = a.used >= mn;
    let b = map.get(candKey(a.id));
    let note = null;
    if (a.kind === "note") {
      note = noteByRel.get(idRel.toLowerCase()) || null;
      const title = note ? note.title : (idRel.split("/").pop() || "").replace(/\.md$/i, "");
      if (!b) b = map.get(candKey(title));
      if (!b && (high || freq)) b = bucket(title);
    } else if (!b && (high || freq)) {
      b = bucket(idRel.split("/").pop() || a.id);              // 技能 / 任务 / 提示词的记账直接用 id
    }
    if (!b) continue;
    b.stats.push({ kind: a.kind, id: idRel, used: a.used, score: a.score, record: a.record });
    if (note) {
      b.paths.add(candPosix(note.path));
      for (const t of note.tags) b.tags.push(t);               // 场景证据
    }
  }

  // ── 缺口清单：只做归属，不产生候选（口径同 skillCandidates）──
  const gapDir = evoDir("gaps");
  let gapFiles = [];
  try { gapFiles = fs.readdirSync(gapDir).filter((f) => f.toLowerCase().endsWith(".md")).sort(); } catch { gapFiles = []; }
  for (const f of gapFiles) {
    const full = path.join(gapDir, f);
    let text = "";
    try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
    const topic = String(/缺口清单：\s*(.+)/.exec(text)?.[1] || f.replace(/\.md$/i, "")).trim();
    const entries = [];
    for (const line of text.split(/\r?\n/)) {
      if (!/^\s*[-*]\s+/.test(line)) continue;
      const t = line.replace(/^\s*[-*]\s+/, "").trim();
      if (!t || t === "（无）" || /^生成时间：/.test(t)) continue;
      entries.push(t);
    }
    if (!entries.length) continue;
    const gk = candKey(topic);
    for (const b of map.values()) {
      const bk = candKey(b.topic);
      if (!bk) continue;
      const same = gk === bk;
      const hits = entries.filter((it) => same || (bk.length >= 2 && candFlat(it).includes(bk)));
      if (!hits.length) continue;
      b.gaps.push({ file: toRel(full), topic, count: hits.length, lines: hits.slice(0, 2) });
    }
  }

  // ── 已有提示词匹配（只读；同名或双向包含 ≥3 字）→ 降权 + 证据 ──
  const promptItems = listPromptItems().items;
  for (const b of map.values()) {
    const bk = candKey(b.topic), flatT = candFlat(b.topic);
    for (const p of promptItems) {
      const flatP = candFlat(p.name);
      if (!flatP) continue;
      const same = candKey(p.name) === bk;
      const contains = (flatP.length >= 3 && flatT.includes(flatP)) || (flatT.length >= 3 && flatP.includes(flatT));
      if (same || contains) { b.promptNames.push(`${p.name}[${p.kind}]`); break; }
    }
  }

  // ── 打分 + 出口 ──
  const items = [];
  for (const b of map.values()) {
    const archivedTasks = b.archived.reduce((n, x) => n + x.count, 0);
    const highRated = b.stats.filter((s) => s.score > 0).length;
    const frequentOnly = b.stats.filter((s) => s.used >= mn && !(s.score > 0)).length;   // 与高分互斥，避免重复计分
    const frequent = b.stats.filter((s) => s.used >= mn).length;
    const openGaps = b.gaps.reduce((n, g) => n + g.count, 0);
    const promptNames = [...new Set(b.promptNames)];
    const hasPrompt = promptNames.length > 0;
    const base = PCAND_W_ARCHIVED * Math.min(archivedTasks, PCAND_CAP)
      + PCAND_W_HIGHRATED * Math.min(highRated, PCAND_CAP)
      + PCAND_W_FREQUENT * Math.min(frequentOnly, 10)
      + PCAND_W_GAP * Math.min(openGaps, 10);
    const score = Math.round(base * (hasPrompt ? PCAND_PROMPT_PENALTY : 1));
    const suggest = (archivedTasks >= 2 || frequentOnly >= 2) ? "template" : (openGaps >= 1 ? "checklist" : "prompt");
    const stats = b.stats.slice().sort((x, y) => (y.score - x.score) || (y.used - x.used));
    const tagCounts = [...b.tags.reduce((m, t) => m.set(t, (m.get(t) || 0) + 1), new Map()).entries()]
      .sort((a, c) => (c[1] - a[1]) || String(a[0]).localeCompare(String(c[0]), "zh"));
    const evidence = [];
    for (const x of b.archived.slice(0, 2)) {
      evidence.push(`归档 ${x.files.slice(0, 3).map((f) => f.name).join(" / ")}${x.count > 1 ? ` ×${x.count}` : ""}`);
    }
    for (const s of stats.slice(0, PCAND_EVIDENCE_PER_SOURCE)) {
      evidence.push(`记账 ${s.kind} ${s.id} score=${s.score} used=${s.used}${s.record && s.record !== "none" ? ` (${s.record})` : ""}`);
    }
    for (const [t, c] of tagCounts.slice(0, PCAND_EVIDENCE_PER_SOURCE)) evidence.push(`场景标签 ${t} ×${c}`);
    for (const g of b.gaps.slice(0, PCAND_EVIDENCE_PER_SOURCE)) evidence.push(`缺口 ${g.file}${g.count > 1 ? ` ×${g.count}` : ""}`);
    if (hasPrompt) evidence.push(`已有提示词 ${promptNames.join(" / ")}（已降权 ×${PCAND_PROMPT_PENALTY}）`);
    items.push({
      topic: b.topic, score, suggest, archivedTasks, highRated, frequent, openGaps,
      hasPrompt, promptNames, evidence, samplePaths: [...b.paths].sort().slice(0, 3),
    });
  }
  items.sort((a, b) => (b.score - a.score) || (b.archivedTasks - a.archivedTasks) || a.topic.localeCompare(b.topic, "zh"));
  const page = items.slice(0, lim);
  return {
    ok: true, count: items.length, returned: page.length, total: items.length,
    limit: lim, min: mn, items: page,
    sources: [
      `归档的进化任务（同主题 ≥ ${mn} 次）`,
      "高分笔记（记账 kind=note：score > 0 或 used ≥ min → 以笔记标题为候选）",
      "记账（skill / task / prompt：score > 0 或 used ≥ min）",
      "缺口清单（只归属到已有候选，不产生候选）",
    ],
    note: "只给「值得固化的模式 + 证据」，**不生成提示词内容**（内容由 DSH 写）；纯只读，不创建目录、不写账本。",
  };
}

/** 同类历史（进化归档）：与 GET /api/evolution/archive 同目录、同「主题 / 完成时间」解析口径；
 *  多词匹配**文件名 / 标题**（任一词命中即入选，命中词数降序 → 再按完成时间倒序），无命中返回 []。
 *  只读：目录不存在**不创建**。 */
function findArchived(q, limit) {
  const dir = resolveTaskArchiveDir();
  if (!dir) return [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const tokens = tokenizeQuery(q), items = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
    const full = path.join(dir, e.name);
    let text = "", mtime = 0;
    try { text = fs.readFileSync(full, "utf8"); } catch {}
    try { mtime = fs.statSync(full).mtimeMs; } catch {}
    const title = taskTopic(text) || e.name.replace(/\.md$/i, "");
    const matched = countTokenHits(tokens, `${e.name}\n${title}`);
    if (!matched) continue;
    const finishedAt = (/- 完成：\s*(.*)/.exec(text)?.[1] || "").trim();
    items.push({ path: toRel(full), title, finishedAt, _ts: Date.parse(finishedAt) || mtime, _matched: matched });
  }
  items.sort((a, b) => (b._matched - a._matched) || (b._ts - a._ts) || b.path.localeCompare(a.path));
  return items.slice(0, limit).map(({ _ts, _matched, ...rest }) => rest);
}

/** 命中笔记 frontmatter 的键名集合：parseFrontmatter 把 `tags` 单独抽进 tags 数组，
 *  这里按原文补回 `tags` 键（库内习惯里「怎么写 frontmatter」本身就是重要口径）。 */
function frontmatterKeysOf(hits) {
  const keys = new Set();
  for (const h of hits) {
    for (const k of Object.keys(h.frontmatter || {})) keys.add(k);
    const raw = String(h.text || "");
    if (!raw.startsWith("---")) continue;
    const end = raw.indexOf("\n---", 3);
    if (end >= 0 && /^[ \t]*tags[ \t]*:/im.test(raw.slice(3, end))) keys.add("tags");
  }
  return [...keys];
}

/** 库内已记录的缺口（.dsh/evolution/gaps/*.md）：**多词**匹配 q（任一词命中即入选，命中词数降序 →
 *  同分保持文件/行号原序）。**只认条目行**（口径见 parseGapItems），每条带 resolved 状态：
 *    默认只返回**未解决**条目（`- [ ]` 或无勾选框的旧格式）；includeResolved=true 时已解决（`- [x]`）一并返回。
 *  返回 { items, openGaps, resolvedGaps, total }：
 *    · items —— 本次返回的条目（受 limit 截断；默认只含未解决），每项 {file, line, text, resolved}
 *    · openGaps / resolvedGaps —— **命中口径**（limit 截断前）：调用方据此知道「这次命中的缺口里
 *      有几条其实**已经解决**」，而不是因为被过滤掉就以为库里没有记录（反向误导同样要避免） */
function findGapHits(q, limit, includeResolved = false) {
  const dir = evoDir("gaps");
  const empty = { items: [], openGaps: 0, resolvedGaps: 0, total: 0 };
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md")).sort(); } catch { return empty; }
  const tokens = tokenizeQuery(q), out = [];
  for (const f of files) {
    const full = path.join(dir, f);
    let text = "";
    try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
    for (const it of parseGapItems(text)) {
      const matched = countTokenHits(tokens, it.text);
      if (!matched) continue;
      out.push({ file: toRel(full), line: it.line, text: it.text.slice(0, 200), resolved: it.resolved, _matched: matched });
    }
  }
  out.sort((a, b) => b._matched - a._matched);        // sort 稳定 → 同分保持文件/行号原序
  const openGaps = out.filter((h) => !h.resolved).length;
  const resolvedGaps = out.length - openGaps;
  const shown = includeResolved ? out : out.filter((h) => !h.resolved);
  return {
    items: shown.slice(0, limit).map(({ _matched, ...rest }) => rest),
    openGaps, resolvedGaps, total: out.length,
  };
}

// ── 路由 ──
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  applyCors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  try {
    if (p === "/api/ping") return json(res, 200, { ok: true, ts: Date.now(), vault: VAULT, port: PORT });

    // 首页：过渡用的极简状态页（M2 面板改为 DSH 原生 DOM 后，此处仅作自检）
    if (p === "/" || p === "/index.html") {
      let count = 0;
      try { count = scanVault().notes.length; } catch {}
      const html = `<!doctype html><meta charset="utf-8">
<title>DSH × Obsidian 知识桥</title>
<style>body{font:14px/1.7 system-ui;margin:24px;color:#e6e6e6;background:#1b1b1c}
h1{font-size:16px;margin:0 0 12px}code{color:#8ab4f8}.k{color:#9aa0a6}</style>
<h1>DSH × Obsidian 知识桥 <span class="k">(M1)</span></h1>
<p><span class="k">vault：</span><code>${VAULT}</code></p>
<p><span class="k">已索引笔记：</span><code>${count}</code> 篇</p>
<p><span class="k">接口：</span><code>/api/index</code> <code>/api/search?q=</code> <code>/api/recall?q=</code> <code>/api/score</code> <code>/api/metrics</code> <code>/api/note</code>
<code>/api/move</code> <code>/api/move-dir</code> <code>/api/mkdir</code> <code>/api/tag</code> <code>/api/inbox</code>
<code>/api/evolution</code> <code>/api/evolution/claim</code> <code>/api/evolution/done</code> <code>/api/evolution/reset</code> <code>/api/skills/candidates</code> <code>/api/skills/distill</code> <code>/api/skills/save</code> <code>/api/skills/toggle</code> <code>/api/skills/use</code> <code>/api/skills/mirror</code> <code>/api/prompts</code> <code>/api/prompts/candidates</code> <code>/api/prompts/history</code> <code>/api/prompts/save</code> <code>/api/obsidian/status</code> <code>/api/obsidian/uri</code>
<code>/api/session/list</code> <code>/api/session/export</code> <code>/api/session/export/candidates</code>
<code>/api/delete</code> <code>/api/trash</code>
<code>/api/trash/restore</code> <code>/api/trash/purge</code></p>
<p class="k">M2 起，DSH 面板将改用原生 DOM 直接调用这些接口，不再使用 iframe。</p>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    // 索引：目录树 + 笔记清单（追加 attachments，供阅读视图做文件名匹配；既有字段不变）
    if (p === "/api/index") {
      const { notes, dirs } = scanVault();
      const attachments = listAttachments().map((f) => ({ path: f.path, name: f.name, size: f.size, mtimeMs: f.mtimeMs }));
      return json(res, 200, {
        ok: true, vault: VAULT, count: notes.length,
        dirs,
        notes: notes.map((n) => ({ path: n.path, title: n.title, tags: n.tags, mtimeMs: n.mtimeMs, size: n.size })),
        attachments,
      });
    }

    // ── 原始文件：二进制直出（图片 / 音视频 / PDF / 文本），供阅读视图与「投喂」复用 ──
    if (p === "/api/raw" && req.method === "GET") {
      // searchParams 已解码一次；再准备一个「双重编码」候选（中文路径被编码两次时兜底）
      const given = url.searchParams.get("path") || "";
      const cands = [given];
      if (/%[0-9a-fA-F]{2}/.test(given)) {
        try { const d = decodeURIComponent(given); if (d !== given) cands.push(d); } catch {}
      }
      let full = null, valid = false;
      for (const c of cands) {
        const f = safeRawPath(c);
        if (!f) continue;                       // 越界 / 扩展名不在白名单
        valid = true;
        try { if (fs.statSync(f).isFile()) { full = f; break; } } catch {}
      }
      // 路径本身合法但文件不存在 → 404；路径不合法（越界/类型不允许）→ 400
      if (!full) return fail(res, valid ? 404 : 400, valid ? "not found" : "bad path");
      return sendRaw(res, full);
    }

    // ── 附件清单：图片 / 音视频 / PDF，mtime 倒序，最多 200 条 ──
    if (p === "/api/attachments" && req.method === "GET") {
      const files = listAttachments().map((f) => ({ path: f.path, name: f.name, size: f.size }));
      return json(res, 200, { ok: true, count: files.length, files });
    }

    // 搜索：标题 / 标签 / 正文，多词 AND 优先、OR 兜底（检索与排序核心 = searchNotesCore，/api/recall 复用同一套）
    if (p === "/api/search") {
      const q = (url.searchParams.get("q") || "").trim();
      const tag = (url.searchParams.get("tag") || "").trim();
      const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
      const hits = searchNotesCore(q, { tag, limit });
      // 原有字段全部保留，仅新增 matchMode（顶层，取值 and/or，与每条 hit 上的 matchMode 一致）
      return json(res, 200, { ok: true, q, tag, matchMode: hits.matchMode, total: hits.length, hits });
    }

    // ── 开工检索（只读）：一次调用拿全「回忆」——相关笔记 / 可复用技能 / 同类历史 / 已知缺口 + 库内习惯 ──
    if (p === "/api/recall" && req.method === "GET") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return fail(res, 400, "q is required：/api/recall?q=<关键词>（开工检索需要一个检索词；limit 默认 8、上限 50）");
      const limit = recallLimit(url.searchParams.get("limit"));
      const includeResolved = /^(1|true|yes)$/i.test(url.searchParams.get("includeResolved") || "");
      const hits = searchNotesCore(q, { limit, withText: true });   // 复用 /api/search 的检索与排序
      // 四段形状不变：notes 每项原有字段原样保留，只**新增** score / matchMode
      // （开工检索是 DSH 判断「这条结果可不可信、是不是弱兜底」的依据）
      const si = statsIndex();                                     // 度量账本（文件不存在 → 空账本，绝不报错）
      // 四段形状不变：notes 每项原有字段原样保留，只**新增** score / matchMode
      // （开工检索是 DSH 判断「这条结果可不可信、是不是弱兜底」的依据）
      const notes = hits.map((h) => {
        const st = statsLookup(si.map, "note", h.path);            // note 的 id 口径 = vault 相对路径
        const metricBonus = metricBonusOf(h.score, st);            // 缺陷 3：温和的度量加成（可正可负可为 0）
        return {
          path: h.path, title: h.title, tags: h.tags,
          updatedAt: new Date(h.mtimeMs).toISOString(),
          excerpt: bodyExcerpt(h.text),
          score: h.score,                                          // 相关度分：**保持原值不变**（回归红线）
          rankScore: Math.round((h.score + metricBonus) * 100) / 100,   // 最终排序分 = 相关度分 + 度量加成
          metricBonus,                                             // 加成明细（正=提前 / 负=压后 / 0=不加不减）
          matchMode: h.matchMode,
          metricScore: st.score,                                   // 度量分（与 skills[].score 同义；统一取 stats.score）
          ...statsFields(st),
        };
      });
      const skills = pickSkills(q, limit, si.map);
      const archived = findArchived(q, limit);
      const gapsHit = findGapHits(q, limit, includeResolved);     // 默认只含未解决条目（见 findGapHits）
      const gaps = gapsHit.items;
      // 库内习惯：从命中笔记汇总（tag 频次前 5 / 所在目录去重前 5 / frontmatter 键名集合）
      const tagFreq = new Map();
      for (const n of notes) for (const t of n.tags) tagFreq.set(t, (tagFreq.get(t) || 0) + 1);
      const topTags = [...tagFreq.entries()]
        .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0], "zh")).slice(0, 5).map(([t]) => t);
      const folders = [...new Set(notes.map((n) => path.posix.dirname(n.path)).filter((d) => d && d !== "."))].slice(0, 5);
      const frontmatterKeys = frontmatterKeysOf(hits);
      // 排序体现度量（**在算完 conventions 之后再排**，避免 folders 这类"按出现顺序"的字段被度量重排改写）：
      // 直接用 rankScore（相关度 + 温和的度量加成）降序 —— 相关性打平时，正向记录被提前、负向记录被压后；
      // 相关性差距明显时加成量级（≤15%）不足以翻转（"用过 100 次的无关笔记"压不过真正相关的，
      // 且无关笔记本就进不了召回池）。没有可用度量时 rankScore === score，三级键退化为旧行为，
      // Array.sort 稳定 → 顺序与改动前逐条一致。
      notes.sort((a, b) =>
        (b.rankScore - a.rankScore) ||
        (b.score - a.score) ||
        (Date.parse(b.updatedAt) - Date.parse(a.updatedAt)));
      return json(res, 200, {
        ok: true, q, limit,
        notes, skills, archived, gaps,
        // skillsFallback 恒 false：skills 段只返回**真正命中**的技能，不再"无命中回退全量"（缺陷 1）
        skillsFallback: skills.fallback === true,
        // disabledSkills：命中了但被 `enabled: false` 跳过的条数（面板据此解释"为什么少了一张卡"）
        disabledSkills: skills.disabled || 0,
        conventions: { topTags, folders, frontmatterKeys },
        // counts：notes/skills/archived 三段语义不变；gaps 现在**默认只含未解决**，故：
        //   · counts.gaps       = 本次**返回**的缺口条目数（旧字段，默认口径下 = 未解决命中数，受 limit 截断）
        //   · counts.openGaps   = 本次**命中**的未解决条目数（限流截断前）
        //   · counts.resolvedGaps = 本次命中的**已解决**条目数（默认不返回，但计数告知"q 命中的缺口里有几条已解决"）
        counts: {
          notes: notes.length, skills: skills.length, archived: archived.length, gaps: gaps.length,
          openGaps: gapsHit.openGaps, resolvedGaps: gapsHit.resolvedGaps,
        },
        gapsNote: "gaps 默认只含未解决条目（`- [ ]`，或无勾选框的旧格式）；counts.openGaps/resolvedGaps 为本次命中口径（不受 limit 截断）；?includeResolved=1 一并返回已解决条目（`- [x]`）。",
      });
    }

    // ── 度量账本（可度量闭环）：记一笔 / 读汇总 —— 见文件上方「可度量闭环」段 ──
    // POST /api/score {kind,id,outcome,note?} → 追加一行事件（**只增不改**），返回该 id 的即时汇总
    if (p === "/api/score" && req.method === "POST") {
      const body = await readJsonBody(req);
      const kind = String(body.kind ?? "").trim();
      const outcome = String(body.outcome ?? "").trim();
      const id = normalizeStatsId(body.id);
      if (!STATS_KINDS.includes(kind)) return fail(res, 400, `bad kind（只允许 ${STATS_KINDS.join(" / ")}）`);
      if (!STATS_OUTCOMES.includes(outcome)) return fail(res, 400, `bad outcome（只允许 ${STATS_OUTCOMES.join(" / ")}）`);
      if (!id) return fail(res, 400, "id is required（技能名 或 vault 相对路径；只作为字符串存账，不参与路径拼接）");
      if (body.note != null && typeof body.note === "object") return fail(res, 400, "bad note（只接受字符串）");
      appendStatsEvent({ kind, id, outcome, note: body.note == null ? "" : String(body.note) });
      const a = statsLookup(statsIndex().map, kind, id);
      return json(res, 200, {
        ok: true, id, kind, outcome,
        stats: { used: a.used, success: a.success, rework: a.rework, fail: a.fail, score: a.score, record: a.record },
      });
    }

    // GET /api/score?id=&kind=&limit= → items 每条 {id,kind,used,success,rework,fail,score,lastTs}；
    //   recent = 最近事件（时间倒序）；skipped = 读取时跳过的**坏行/非法行**数（不是错误，只是计数）。
    if (p === "/api/score" && req.method === "GET") {
      const idRaw = (url.searchParams.get("id") || "").trim();
      const kind = (url.searchParams.get("kind") || "").trim();
      if (kind && !STATS_KINDS.includes(kind)) return fail(res, 400, `bad kind（只允许 ${STATS_KINDS.join(" / ")}）`);
      const id = idRaw ? normalizeStatsId(idRaw) : null;
      if (idRaw && !id) return fail(res, 400, "bad id（清洗后为空）");
      const limit = Math.min(Math.max(Math.floor(Number(url.searchParams.get("limit") || 20)) || 20, 1), 200);
      const { events, bad, pending } = statsSnapshot();
      const filtered = events.filter((e) => (!kind || e.kind === kind) && (!id || e.id === id));
      const agg = new Map();
      for (const e of filtered) {
        const k = `${e.kind}\u0000${e.id}`;
        let a = agg.get(k);
        if (!a) { a = { kind: e.kind, id: e.id, used: 0, success: 0, rework: 0, fail: 0, lastTs: 0 }; agg.set(k, a); }
        a.used++; a[e.outcome]++; if (e.ts > a.lastTs) a.lastTs = e.ts;
      }
      const items = [...agg.values()].map((a) => ({ ...a, score: statsScoreOf(a), record: statsRecordOf({ used: a.used, score: statsScoreOf(a) }) }))
        .sort((a, b) => (b.score - a.score) || (b.used - a.used) || a.id.localeCompare(b.id, "zh"))
        .slice(0, 500);
      const recent = filtered.slice(-limit).reverse();
      return json(res, 200, {
        ok: true, id, kind, limit,
        total: events.length, matched: filtered.length, skipped: bad, pending,
        items, recent,
      });
    }

    // ── 「是否更聪明」四条指标（任务收尾快照）：记一笔 / 读汇总 + 趋势 —— 见文件上方「四条指标」段 ──
    // POST /api/metrics {taskId?,title,startedAt?,endedAt?,recallUsed,recallHits?,skillsUsed,notesCited,userFollowups,outcome,note?}
    //   → 追加一行快照（**只增不改**），返回该条 + 全量 aggregate + 默认窗口 trend。
    if (p === "/api/metrics" && req.method === "POST") {
      const body = await readJsonBody(req);
      const rec = buildMetricsRecord(body);
      appendJsonlLine(metricsFile(), rec);
      const { items, bad, pending } = readMetricsRaw();
      return json(res, 200, {
        ok: true, item: rec,
        total: items.length, skipped: bad, pending,
        aggregate: metricsAggregate(items),
        trend: metricsTrend(items, METRICS_TREND_N),
      });
    }

    // GET /api/metrics?limit=50&since=&window=5
    //   items = 按 endedAt **倒序**的前 limit 条；aggregate / trend 恒基于**过滤后全量**（不是 limit 切片），
    //   否则 limit 会悄悄改变"平均水平"。since 只按 endedAt 过滤（≥since）。
    //   skipped = 读取时跳过的坏行数（不是错误，只是计数）；pending = 末尾残行（可能正在写）。
    //   文件不存在 → items:[] + 全 0 aggregate（**只读，绝不创建文件**）。
    if (p === "/api/metrics" && req.method === "GET") {
      const limit = Math.min(Math.max(Math.floor(Number(url.searchParams.get("limit") || 50)) || 50, 1), 500);
      const sinceRaw = (url.searchParams.get("since") || "").trim();
      const since = sinceRaw ? parseMetricsTime(sinceRaw) : NaN;
      if (sinceRaw && !Number.isFinite(since)) return fail(res, 400, "bad since（接受 ISO 时间字符串或毫秒时间戳）");
      const window = Math.min(Math.max(Math.floor(Number(url.searchParams.get("window") || METRICS_TREND_N)) || METRICS_TREND_N, 1), METRICS_TREND_N_MAX);
      const { items, bad, pending } = readMetricsRaw();
      const matched = Number.isFinite(since) ? items.filter((it) => it.endedAt >= since) : items;
      return json(res, 200, {
        ok: true,
        file: path.relative(VAULT, metricsFile()).split(path.sep).join("/"),
        limit, since: Number.isFinite(since) ? since : null, window,
        total: items.length, matched: matched.length, skipped: bad, bad, pending,
        aggregate: metricsAggregate(matched),
        trend: metricsTrend(matched, window),
        items: matched.slice(0, limit),
      });
    }

    // 读单篇
    if (p === "/api/note" && req.method === "GET") {
      const full = safeNotePath(url.searchParams.get("path"));
      if (!full) return fail(res, 400, "bad path");
      if (!fs.existsSync(full)) return fail(res, 404, "not found");
      return json(res, 200, { ok: true, ...readNote(full) });
    }

    // 写单篇（存在即覆盖）
    if (p === "/api/note" && req.method === "PUT") {
      const { path: rel, text } = JSON.parse(await readBody(req));
      const full = safeNotePath(rel);
      if (!full) return fail(res, 400, "bad path");
      writeNote(full, String(text ?? ""));
      return json(res, 200, { ok: true, path: toRel(full), mtimeMs: fs.statSync(full).mtimeMs });
    }

    // 新建单篇（已存在则拒绝，除非 force / unique）
    //   正文既接受既有字段 text，也接受 content（面板「新建笔记」按后者命名）；
    //   unique=true 时同名自动改用 -2 / -3 …（不报错、不覆盖），返回实际落盘路径。
    if (p === "/api/note" && req.method === "POST") {
      const { path: rel, text, content, force, unique } = JSON.parse(await readBody(req));
      let full = safeNotePath(rel);
      if (!full) return fail(res, 400, "bad path");
      if (fs.existsSync(full) && !force) {
        if (unique !== true) return fail(res, 409, "already exists");
        const alt = uniquePath(full);
        if (!alt) return fail(res, 409, "too many duplicates");
        full = alt;
      }
      writeNote(full, String(text !== undefined ? text : (content !== undefined ? content : "")));
      return json(res, 200, { ok: true, path: toRel(full) });
    }

    // ── 删除笔记：**不真删**，移到 .dsh/trash/<本地时间戳>__<原文件名>（可恢复） ──
    // 安全：解析后必须仍在 vault 内且以 .md 结尾（越界/非 md → 400），文件不存在 → 404。
    if (p === "/api/delete" && req.method === "POST") {
      const body = await readJsonBody(req);
      const full = safeNotePath(body.path);
      if (!full) return fail(res, 400, "bad path（只允许 vault 内以 .md 结尾的路径）");
      let st;
      try { st = fs.statSync(full); } catch { return fail(res, 404, "not found"); }
      if (!st.isFile()) return fail(res, 404, "not found");
      fs.mkdirSync(TRASH_DIR, { recursive: true });
      const dest = uniquePath(path.join(TRASH_DIR, `${stamp()}__${path.basename(full)}`));
      if (!dest) return fail(res, 500, "回收站同名文件过多");
      fs.renameSync(full, dest);          // 同盘移动：原子且不产生半截文件
      writeTrashMeta(dest, toRel(full));  // 并存 sidecar：记住原相对路径，供 restore 回原目录（写失败不影响删除成功）
      cache.delete(full);                 // 索引缓存剔除，避免刚删的笔记还在列表里
      return json(res, 200, { ok: true, trashed: toRel(dest), name: path.basename(full), originalPath: toRel(full) });
    }

    // ── 回收站清单（只读）：mtime 倒序；每条带 originalName（原名）/ deletedAt（删除时间）/ bytes / mtimeMs ──
    if (p === "/api/trash" && req.method === "GET") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50) || 50, 1), 500);
      let entries = [];
      try { entries = fs.readdirSync(TRASH_DIR, { withFileTypes: true }); } catch {}
      const items = entries
        .filter((e) => e.isFile() && !e.name.startsWith(".") && !isTrashMeta(e.name))  // sidecar 绝不出现在清单里
        .map((e) => trashItem(e.name))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      return json(res, 200, { ok: true, count: items.length, items: items.slice(0, limit), dir: toRel(TRASH_DIR) });
    }

    // ── 回收站还原：{name, to?} → 移回 vault（同名自动 -2/-3，绝不覆盖） ──
    // name 只允许 .dsh/trash/ 内的条目名（越界/绝对路径/.. → 400），条目不存在 → 404。
    // 优先级：显式 to > sidecar 里的原相对路径（回原目录，父目录不存在则建）> 文件名 `__` 后原名的旧行为（落 vault 根）。
    if (p === "/api/trash/restore" && req.method === "POST") {
      const body = await readJsonBody(req);
      const src = trashEntryPath(body.name);
      if (!src) return fail(res, 400, "bad name（只允许 .dsh/trash/ 内的条目名）");
      let st;
      try { st = fs.statSync(src); } catch { return fail(res, 404, "not found"); }
      if (!st.isFile()) return fail(res, 404, "not found");
      const parsed = parseTrashName(trashRelName(src));
      const wantTo = String(body.to ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
      if (wantTo && /\/$/.test(wantTo)) return fail(res, 400, "bad to（目标必须是 vault 内的文件路径）");
      const metaRel = wantTo ? null : readTrashMeta(src);          // 无 sidecar（老条目）→ null，行为不变
      const rel = wantTo || metaRel || trashRestoreRel(parsed.originalName) || path.basename(src);
      const dst = safeVaultPath(rel);
      if (!dst) return fail(res, 400, "bad to（目标必须落在 vault 内）");
      const dest = fs.existsSync(dst) ? uniquePath(dst) : dst;     // 同名 → -2 / -3 …，不覆盖
      if (!dest) return fail(res, 409, "同名文件过多（-2…-999 已用尽）");
      fs.mkdirSync(path.dirname(dest), { recursive: true });       // 原目录被删过 → 自动补建
      fs.renameSync(src, dest);                                    // 同盘移动：原子
      dropTrashMeta(src);                                          // 条目已离开回收站，sidecar 同步删掉
      cache.delete(dest);                                          // 索引缓存剔除，避免旧内容残留
      return json(res, 200, {
        ok: true, path: toRel(dest), restoredTo: toRel(dest), name: trashRelName(src),
        originalName: parsed.originalName, renamed: dest !== dst, viaSidecar: !!metaRel,
      });
    }

    // ── 回收站清除：给 name 删该条；不给则清空整个回收站；返回 {ok, removed} ──
    // 清空只在 .dsh/trash/ 内递归删**文件**（顺带清掉空子目录），绝不碰 trash 之外的任何路径。
    if (p === "/api/trash/purge" && req.method === "POST") {
      const body = await readJsonBody(req);
      const name = String(body.name ?? "").trim();
      if (name) {
        const full = trashEntryPath(name);
        if (!full) return fail(res, 400, "bad name（只允许 .dsh/trash/ 内的条目名）");
        let st;
        try { st = fs.statSync(full); } catch { return fail(res, 404, "not found"); }
        if (!st.isFile()) return fail(res, 404, "not found");
        fs.unlinkSync(full);
        dropTrashMeta(full);                                        // sidecar 随条目一起删，不留孤儿
        return json(res, 200, { ok: true, removed: 1, name });
      }
      let removed = 0;
      const rmIn = (dir) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (!insideTrash(full)) continue;                       // 双保险：绝不越界
          if (e.isDirectory()) { rmIn(full); try { fs.rmdirSync(full); } catch {} continue; }
          if (!e.isFile()) continue;
          // sidecar 也一并删除，但 removed 只计**真实条目**（不把 .meta.json 算成一条）
          try { fs.unlinkSync(full); if (!isTrashMeta(e.name)) removed++; } catch {}
        }
      };
      rmIn(TRASH_DIR);
      return json(res, 200, { ok: true, removed, dir: toRel(TRASH_DIR) });
    }

    // 移动 / 重命名
    if (p === "/api/move" && req.method === "POST") {
      const { from, to, force } = JSON.parse(await readBody(req));
      const src = safeNotePath(from), dst = safeNotePath(to);
      if (!src || !dst) return fail(res, 400, "bad path");
      if (!fs.existsSync(src)) return fail(res, 404, "source not found");
      if (fs.existsSync(dst) && !force) return fail(res, 409, "target exists");
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
      return json(res, 200, { ok: true, from: toRel(src), to: toRel(dst) });
    }

    // ── 移动 / 重命名**目录**（结构页目录节点的「移动」入口）：{from,to} 均为 vault 相对路径 ──
    // 拒绝式校验，绝不合并 / 绝不覆盖：
    //   ① from/to 必须是严格的 vault 相对路径（绝对路径 / UNC / 盘符 / .. / 点开头系统目录 → 400）
    //   ② from 必须是**已存在的目录** → 否则 404
    //   ③ to 是 from 自身或其后代 → 400（禁止移入自身子孙）
    //   ④ to 已存在 → 400（不合并、不覆盖；仅大小写不同的纯重命名除外）
    //   ⑤ to 的父目录不存在 → **自动创建**（recursive，与 /api/mkdir、/api/move 的落盘口径一致，
    //      也只有这样才支持「输入 目标父目录/新名字 一步到位」的面板交互）
    // 成功返回 {ok,from,to,files}；files = 实际搬动的 .md 篇数（先数后搬）。
    if (p === "/api/move-dir" && req.method === "POST") {
      const body = await readJsonBody(req);
      const fromRel = normDirRel(body.from), toRelWant = normDirRel(body.to);
      if (!fromRel || !toRelWant) {
        return fail(res, 400, "bad path（只能是 vault 内的相对目录路径：不允许绝对路径 / UNC / .. / 点开头的系统目录）");
      }
      const src = safeVaultPath(fromRel), dst = safeVaultPath(toRelWant);
      if (!src || !dst) return fail(res, 400, "bad path（源与目标都必须落在 vault 内）");
      const srcRoot = path.resolve(src), dstRoot = path.resolve(dst);
      let st;
      try { st = fs.statSync(srcRoot); } catch { return fail(res, 404, "source directory not found"); }
      if (!st.isDirectory()) return fail(res, 404, "source is not a directory");
      if (dstRoot === srcRoot || dstRoot.startsWith(srcRoot + path.sep)) {
        return fail(res, 400, "bad target（目标不能是源目录自身或其子孙）");
      }
      if (fs.existsSync(dstRoot) && !samePathCI(srcRoot, dstRoot)) {
        return fail(res, 400, "target exists（不合并、不覆盖）");
      }
      fs.mkdirSync(path.dirname(dstRoot), { recursive: true });   // 父目录不存在则自动创建
      const files = countMdFiles(srcRoot);                        // 必须先数：搬完目录就没了
      fs.renameSync(srcRoot, dstRoot);                            // 同盘移动：原子，Obsidian 实时感知
      invalidateCacheUnder(srcRoot);                              // 索引缓存：剔除被移动子树的旧键
      return json(res, 200, { ok: true, from: toRel(srcRoot), to: toRel(dstRoot), files });
    }

    // 新建目录
    if (p === "/api/mkdir" && req.method === "POST") {
      const { dir } = JSON.parse(await readBody(req));
      const clean = String(dir || "").replace(/^[/\\]+/, "");
      const full = path.resolve(VAULT, clean);
      if (!full.startsWith(path.resolve(VAULT) + path.sep)) return fail(res, 400, "bad dir");
      fs.mkdirSync(full, { recursive: true });
      return json(res, 200, { ok: true, dir: toRel(full) });
    }

    // 打标签：写入 frontmatter 的 tags 列表（幂等）
    if (p === "/api/tag" && req.method === "POST") {
      const { path: rel, tags, mode = "add" } = JSON.parse(await readBody(req));
      const full = safeNotePath(rel);
      if (!full || !fs.existsSync(full)) return fail(res, 400, "bad path");
      const raw = fs.readFileSync(full, "utf8");
      const fm = parseFrontmatter(raw);
      const want = (Array.isArray(tags) ? tags : [tags]).map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean);
      let now = [...new Set([...fm.tags, ...inlineTags(fm.body)])];
      now = mode === "remove" ? now.filter((t) => !want.includes(t)) : [...new Set([...now, ...want])];
      const rest = Object.entries(fm.frontmatter).map(([k, v]) => `${k}: ${v}`).join("\n");
      const head = ["---", rest, `tags: [${now.join(", ")}]`, "---"].filter((l) => l !== "").join("\n");
      writeNote(full, head + "\n\n" + fm.body.replace(/^\s*\n/, ""));
      return json(res, 200, { ok: true, path: toRel(full), tags: now });
    }

    // 收件箱（Obsidian 侧 dsh-bridge 插件"送给 DSH"的落点）
    if (p === "/api/inbox") {
      const dir = path.join(DSH_DIR, "inbox");
      let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse(); } catch {}
      // 计数只算「未处理」：处理完被标记为「- 状态：已完成」的任务文件仍保留在目录里作记录，
      // 但不再计入待办 —— 否则面板徽标永远不降，用户会以为没人处理。
      const pending = [];
      for (const f of files) {
        let done = false;
        try { done = /^\s*-\s*状态：\s*已完成/m.test(fs.readFileSync(path.join(dir, f), "utf8")); } catch {}
        if (!done) pending.push(f);
      }
      return json(res, 200, { ok: true, count: pending.length, total: files.length, files: pending, all: files, dir });
    }

    // ── 设置：读（与默认值合并）/ 深度合并写回 ──
    if (p === "/api/settings" && req.method === "GET") {
      return json(res, 200, { ok: true, settings: readSettings(), effective: effectiveDirs() });
    }
    if (p === "/api/settings" && req.method === "PUT") {
      const patch = await readJsonBody(req);
      const next = writeSettings(normalizeSettings(deepMerge(readSettings(), patch)));
      return json(res, 200, { ok: true, settings: next });
    }

    // ── 状态游标：读 .dsh/state.json（无则返回默认值） ──
    if (p === "/api/state" && req.method === "GET") {
      return json(res, 200, { ok: true, state: readState() });
    }

    // ══════════════════════════════════════════════════════════════════════
    // 会话导出：把某个 DSH 会话导出成 Obsidian 纪要笔记（走归档通路）
    // 手动：POST /api/session/export（旧名 /api/session/import 仍可用）
    // 自动：settings.auto_export_sessions 开启时由 runAutoExport 定时扫描
    // ══════════════════════════════════════════════════════════════════════

    // 会话清单：sessionId 倒查 / 「自动导出」排查用；sessions 根不存在时返回空数组
    if (p === "/api/session/list" && req.method === "GET") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20) || 20, 1), 200);
      const all = listSessionDirs();
      const items = all.slice(0, limit).map((s) => {
        const h = sessionHead(s.file);
        return {
          dir: s.dir,
          sessionId: (h && h.id) || s.name,
          mtimeMs: s.mtimeMs,
          bytes: s.bytes,
          workspace: s.workspace,
        };
      });
      return json(res, 200, { ok: true, items, total: all.length, home: DSH_SESSIONS });
    }

    // 自动导出候选预览：**只读**（绝不落盘、绝不入库），让用户预判「下次会导出哪些」
    // items 覆盖全部会话（候选排前，每条带 exported）；count = 真正的候选数（静置 ≥ 2 天且未导出过）
    if (p === "/api/session/export/candidates" && req.method === "GET") {
      const r = listExportCandidates();
      return json(res, 200, {
        ok: true,
        count: r.count,
        items: r.items,
        total: r.total,
        idleDays: AUTO_EXPORT_IDLE_MS / 86400000,
        home: DSH_SESSIONS,
      });
    }

    // 会话 → 纪要笔记：{sessionId?|dir?, title?}，落 settings.archive_folder
    // 路径别名：/api/session/export（现行）与 /api/session/import（旧名，保留可用）指向同一处理器
    if ((p === "/api/session/export" || p === "/api/session/import") && req.method === "POST") {
      const body = await readJsonBody(req);
      const hit = locateSession({ dir: body.dir, sessionId: body.sessionId });
      if (!hit) {
        return fail(res, 404, `找不到会话（sessionId=${body.sessionId || "-"} dir=${body.dir || "-"}）；sessions 根：${DSH_SESSIONS}`);
      }
      const r = exportSession(hit, { title: body.title, tags: body.tags, folder: body.folder });
      if (!r.ok) return fail(res, r.status || 500, r.error);
      return json(res, 200, r);
    }

    // ── P1 项目沉淀：把 DSH 的项目记忆归档成知识库笔记 ──
    if (p === "/api/archive" && req.method === "POST") {
      const body = await readJsonBody(req);
      const title = String(body.title ?? "").trim();
      if (!title) return fail(res, 400, "title required");
      const r = archiveNote({
        title,
        content: String(body.content ?? ""),
        tags: body.tags,
        folder: body.folder,
        source: body.source ? String(body.source) : "DSH",
        created: new Date().toISOString(),
      });
      if (!r.ok) return fail(r.status, r.error);
      return json(res, 200, { ok: true, path: r.path, tags: r.tags });
    }


    // ── 技能提炼「候选发现」（只读）：只找出「值得沉淀成技能的主题」+ 证据，**不生成技能内容**
    //   来源：高频标签 / 高频目录 / 进化归档主题 / 记账高分高频条目；纯只读（不 mkdir、不写 state）。
    if (p === "/api/skills/candidates" && req.method === "GET") {
      /* kind 白名单校验：**空 = 默认 topic**（老调用方不带该参数 → 自动拿到「只有主题」的新默认）。
         未知取值一律 400，不静默兜底 —— 否则客户端传错参数会以为「候选就是这些」。 */
      const kind = String(url.searchParams.get("kind") || "topic").trim().toLowerCase();
      if (kind !== "topic" && kind !== "container" && kind !== "all") {
        return fail(res, 400, "bad kind（只允许 topic / container / all；缺省 = topic）");
      }
      return json(res, 200, skillCandidates({
        limit: url.searchParams.get("limit"),
        min: url.searchParams.get("min"),
        kind,
      }));
    }

    // ── 提示词库（第四类进化对象）：列表 / 候选 / 历史 / 追加式保存 ──
    //   GET /api/prompts[?kind=prompt|template|checklist|all]
    //     只扫 .dsh/prompts/*.md；目录不存在 → items:[] 且**不创建目录**；坏文件 → skipped 计数。
    if (p === "/api/prompts" && req.method === "GET") {
      const kind = (url.searchParams.get("kind") || "").trim().toLowerCase();
      if (kind && kind !== "all" && !PROMPT_KINDS.includes(kind)) {
        return fail(res, 400, `bad kind（只允许 ${PROMPT_KINDS.join(" / ")} / all）`);
      }
      return json(res, 200, listPromptsPayload(kind));
    }
    //   GET /api/prompts/candidates?limit=10&min=3 → 只发现「值得固化成提示词/模板的模式」+ 证据，不生成内容
    if (p === "/api/prompts/candidates" && req.method === "GET") {
      return json(res, 200, promptCandidates({
        limit: url.searchParams.get("limit"),
        min: url.searchParams.get("min"),
      }));
    }
    //   GET /api/prompts/history?name= → 该提示词的历史版本（时间倒序）+ current；只读，不建目录
    if (p === "/api/prompts/history" && req.method === "GET") {
      const r = listPromptHistory(url.searchParams.get("name"));
      return r.ok ? json(res, 200, r) : fail(res, r.status, r.error);
    }
    //   POST /api/prompts/save {name,kind,content,description?,used_for?,note?}
    //     同名已存在 → 旧内容先**逐字节**归档到 .dsh/prompts/.history/<name>/<ts>.md（只增不删）→ 再写新版本
    if (p === "/api/prompts/save" && req.method === "POST") {
      const body = await readJsonBody(req);
      const r = savePrompt({
        name: body.name, kind: body.kind, description: body.description,
        used_for: body.used_for, content: body.content, note: body.note,
      });
      if (!r.ok) return fail(res, r.status || 400, r.error || "save failed");
      return json(res, 200, r);
    }
    //   DELETE /api/prompts?name=<名>
    //     移除**当前版本** `.dsh/prompts/<名>.md`；`.history/<名>/` **原样保留**（历史只增不删）。
    //     与技能区 DELETE 同一套越界口径：name 先过 promptSlug()（400）→ 再经 safeUnder() 双保险。
    if (p === "/api/prompts" && req.method === "DELETE") {
      const r = deletePrompt(url.searchParams.get("name"));
      if (!r.ok) return fail(res, r.status || 400, r.error || "delete failed");
      return json(res, 200, r);
    }

    // ── P2 技能库：列出技能（**两个来源**：local `.dsh/skills/*.md` + vault `<名>/SKILL.md`） ──
    //   每条带 source（local 可删 / vault 只读），并保留 items 为数组、skills 为同一数组（旧消费者不破）。
    if (p === "/api/skills" && req.method === "GET") {
      return json(res, 200, listSkillsPayload());
    }
    // ── P2 技能库：写技能（同名覆盖） ──
    if (p === "/api/skills" && req.method === "POST") {
      const body = await readJsonBody(req);
      const name = String(body.name ?? "").trim();
      if (!name) return fail(res, 400, "name required");
      const full = safeUnder(path.join(DSH_DIR, "skills"), `${safeName(name, { fallback: "skill" })}.md`, { mustBeMd: true });
      if (!full) return fail(res, 400, "bad name");
      const tags = (Array.isArray(body.tags) ? body.tags : body.tags ? [body.tags] : [])
        .map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean);
      const text = [
        "---",
        `name: ${yamlScalar(name)}`,
        `description: ${yamlScalar(body.description ?? "")}`,
        `tags: [${tags.map(yamlScalar).join(", ")}]`,
        "---", "",
        String(body.content ?? "").replace(/^\s*\n/, ""),
      ].join("\n");
      writeNote(full, text.endsWith("\n") ? text : text + "\n");
      return json(res, 200, { ok: true, path: toRel(full) });
    }
    // ── P2 技能库：按 name 删除技能文件（**只允许 .dsh/skills/<名>.md**） ──
    //   红线：vault 内技能（copilot/skills/x/SKILL.md 等）是用户自己的文件 → 一律 400，绝不删。
    //   越界口径：`path` 不在 .dsh/skills/ 内 / name 含路径分隔符 / 绝对路径 / 纯点名 → 400。
    if (p === "/api/skills" && req.method === "DELETE") {
      const rawName = String(url.searchParams.get("name") || "").trim();
      const rawPath = String(url.searchParams.get("path") || "").trim();
      if (!rawName && !rawPath) return fail(res, 400, "name required");
      let name = rawName.replace(/\.md$/i, "");
      if (rawPath) {                                    // path 别名：只接受 .dsh/skills/ 下的单层 <名>.md
        const rel = rawPath.replace(/\\/g, "/").replace(/^\.?\//, "");
        const tail = rel.startsWith(LOCAL_SKILLS_REL) ? rel.slice(LOCAL_SKILLS_REL.length) : null;
        if (tail === null || !tail || tail.includes("/") || !/\.md$/i.test(tail)) {
          return fail(res, 400, "vault skills are read-only (only .dsh/skills/<name>.md can be deleted)");
        }
        name = tail.replace(/\.md$/i, "");
      }
      if (!name) return fail(res, 400, "name required");
      if (/[\\/]/.test(name) || /^[.\s-]*$/.test(name)) {                // 路径分隔符 / 纯点名（. .. ...）→ 越界
        return fail(res, 400, "vault skills are read-only (only .dsh/skills/<name>.md can be deleted)");
      }
      const full = safeUnder(path.join(DSH_DIR, "skills"), `${safeName(name, { fallback: "skill" })}.md`, { mustBeMd: true });
      if (!full) return fail(res, 400, "bad name");
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
        // 本地没有同名文件，但 vault 里有同名技能 → 明确 400 说清「库内技能只读」，不误报 404
        if (vaultSkillExists(name)) return fail(res, 400, "vault skill is read-only: " + name);
        return fail(res, 404, "not found");
      }
      fs.unlinkSync(full);
      return json(res, 200, { ok: true, deleted: toRel(full), source: "local" });
    }

    // ── 技能卡「用户可管」四条写路径（见文件上方「技能卡用户可看/可用/可管」段）──
    //   共同约束：**只允许写 .dsh/skills/ 与 <vault>/<skill_mirror_folder>/ 与 .dsh/inbox/**；
    //   库内技能名 / 越界名（`../../evil`、空、`C:\x`、`a/b`）一律 400，且不产生任何写入。
    //   POST /api/skills/save {name,description?,content,note?} → 追加式版本化写本地技能卡
    if (p === "/api/skills/save" && req.method === "POST") {
      const body = await readJsonBody(req);
      const r = saveSkillCard({
        name: body.name, description: body.description, content: body.content, note: body.note,
      });
      if (!r.ok) return fail(res, r.status || 400, r.error || "save failed");
      return json(res, 200, r);
    }
    //   POST /api/skills/toggle {name,enabled} → 只改 frontmatter 的 enabled:（正文逐字节不动）
    if (p === "/api/skills/toggle" && req.method === "POST") {
      const body = await readJsonBody(req);
      const r = toggleSkillCard(body.name, body.enabled);
      if (!r.ok) return fail(res, r.status || 400, r.error || "toggle failed");
      return json(res, 200, r);
    }
    //   POST /api/skills/use {name,note?} → 写一条收件箱任务（DSH 下次开工会按这张卡执行）
    if (p === "/api/skills/use" && req.method === "POST") {
      const body = await readJsonBody(req);
      const r = useSkillCard({ name: body.name, note: body.note });
      if (!r.ok) return fail(res, r.status || 400, r.error || "use failed");
      return json(res, 200, r);
    }
    //   POST /api/skills/mirror {name?} → 单向导出本地技能到 <vault>/<skill_mirror_folder>/（幂等）
    if (p === "/api/skills/mirror" && req.method === "POST") {
      const body = await readJsonBody(req);
      const r = mirrorSkills({ name: body.name });
      if (!r.ok) return fail(res, r.status || 400, r.error || "mirror failed");
      return json(res, 200, r);
    }

    // ── P3 工作单：扫描知识库结构 → 该研究什么（topics）+ 哪里缺东西（gaps） ──
    if (p === "/api/evolution/scan" && req.method === "GET") {
      const { notes, dirs } = scanVault();
      const topicMap = new Map();
      const bump = (kind, name, note) => {
        const key = `${kind}|${name}`;
        const hit = topicMap.get(key) || { name, kind, noteCount: 0, samplePaths: [] };
        hit.noteCount++;
        if (hit.samplePaths.length < 3) hit.samplePaths.push(note.path);
        topicMap.set(key, hit);
      };
      for (const n of notes) {
        const parts = n.path.split("/");
        if (parts.length > 1) {
          bump("dir", parts[0], n);                                    // 一级目录
          if (parts.length > 2) bump("dir", parts.slice(0, 2).join("/"), n); // 二级目录
        }
        for (const t of n.tags) bump("tag", t, n);                     // 标签频次
      }
      const topics = [...topicMap.values()]
        .sort((a, b) => b.noteCount - a.noteCount || a.name.localeCompare(b.name))
        .slice(0, 20);

      // 缺口检测：占位标记 / 空章节 / 只含占位引用的段落
      const MARKER = /(待补充|待完善|TODO|TBD|待填|\(空\)|（空）)/;
      const PLACEHOLDER = /^(\.{2,}|…+|—+|-+|_+|\?+|？+|待补充|待完善|待填|待定|TODO|TBD|xxx|\(空\)|（空）)?$/i;
      const clip = (s) => s.replace(/\s+/g, " ").trim().slice(0, 60);
      const gaps = [];
      for (const n of notes) {
        if (gaps.length >= 200) break;
        let body = "";
        try { body = parseFrontmatter(fs.readFileSync(path.join(VAULT, n.path), "utf8")).body; } catch { continue; }
        const lines = body.split(/\r?\n/);
        for (let i = 0; i < lines.length && gaps.length < 200; i++) {
          const line = lines[i];
          if (MARKER.test(line)) { // 规则 1：显式占位标记
            gaps.push({ path: n.path, title: n.title, kind: "marker", snippet: clip(line) });
            continue;
          }
          const h = /^(#{1,6})\s+(.*)$/.exec(line);
          if (h) { // 规则 2：空章节（## 及以下标题紧跟另一个标题）
            let j = i + 1;
            while (j < lines.length && !lines[j].trim()) j++;
            if (h[1].length >= 2 && j < lines.length && /^#{1,6}\s+/.test(lines[j])) {
              gaps.push({ path: n.path, title: n.title, kind: "empty-section", snippet: clip(line) });
            }
            continue;
          }
          if (/^\s*>/.test(line)) { // 规则 3：整段只含占位引用
            const block = [];
            let j = i;
            while (j < lines.length && /^\s*>/.test(lines[j])) { block.push(lines[j].replace(/^\s*>\s?/, "").trim()); j++; }
            if (PLACEHOLDER.test(block.join(" ").trim())) {
              gaps.push({ path: n.path, title: n.title, kind: "placeholder", snippet: clip(`> ${block.join(" ")}`) || ">" });
            }
            i = j - 1;
            continue;
          }
        }
      }
      const tagSet = new Set();
      for (const n of notes) for (const t of n.tags) tagSet.add(t);
      const generatedAt = new Date().toISOString();
      writeState({ lastScanAt: generatedAt });
      return json(res, 200, {
        ok: true, generatedAt,
        stats: { notes: notes.length, dirs: dirs.length, tags: tagSet.size },
        topics, gaps,
      });
    }

    // ── P3 产出物：进化日志（digest）+ 缺口清单，并推进 lastReport 游标 ──
    if (p === "/api/evolution/report" && req.method === "POST") {
      const body = await readJsonBody(req);
      const topic = String(body.topic ?? "").trim();
      if (!topic) return fail(res, 400, "topic required");
      const slug = safeName(topic, { fallback: "topic", max: 40, space: "_" });
      const ts = stamp();
      const newKnowledge = Array.isArray(body.newKnowledge) ? body.newKnowledge : [];
      const gapList = Array.isArray(body.gaps) ? body.gaps : [];
      const sources = Array.isArray(body.sources) ? body.sources : body.sources ? [body.sources] : [];
      const itemName = (x) => String(typeof x === "string" ? x : x?.name ?? "").trim() || "(未命名)";
      const itemNote = (x, k) => String(typeof x === "string" ? "" : x?.[k] ?? x?.note ?? "").trim();
      const logFull = path.join(evoDir("logs"), `${ts}-${slug}.md`);
      const gapFull = path.join(evoDir("gaps"), `${ts}-${slug}.md`);
      const logText = [
        `# 🧬 进化日志：${topic}`, "",
        `- 生成时间：${nowText()}`,
        `- 摘要：${String(body.summary ?? "").trim() || "（无）"}`, "",
        `## 新发现 / 完善的知识`, "",
        ...(newKnowledge.length ? newKnowledge.map((x) => `- ${itemName(x)}${itemNote(x, "note") ? ` —— ${itemNote(x, "note")}` : ""}`) : ["- （无）"]), "",
        `## 参考来源`, "",
        ...(sources.length ? sources.map((s) => `- ${String(typeof s === "string" ? s : s?.url || s?.name || JSON.stringify(s))}`) : ["- （无）"]), "",
      ].join("\n");
      const gapText = [
        `# 🕳️ 缺口清单：${topic}`, "",
        `- 生成时间：${nowText()}`, "",
        `## 未搜到 / 待补充的知识点`, "",
        ...(gapList.length ? gapList.map((x) => `- ${itemName(x)}${itemNote(x, "reason") ? `（原因：${itemNote(x, "reason")}）` : ""}`) : ["- （无）"]), "",
        `> 以上知识点未能补全，请用户补充：可直接在 Obsidian 里补写，或把资料放进 \`.dsh/inbox/\` 交给 DSH 处理。`, "",
      ].join("\n");
      writeNote(logFull, logText);
      writeNote(gapFull, gapText);
      writeState({ lastReport: toRel(logFull) });
      return json(res, 200, { ok: true, log: toRel(logFull), gap: toRel(gapFull) });
    }

    /* ── 缺口生命周期：把一条缺口标成「已解决」 ──────────────────────────────
     * POST /api/evolution/gaps/resolve  body {file, text | line, note?}
     *   · 匹配：`line`（1 起，必须是条目行）优先；否则用 `text`（条目文字，先全等、再唯一包含）
     *   · 改写（**最小手术**）：只把该行的勾选框改成 `[x]`，并在行尾**追加** `（已解决 YYYY-MM-DD：<note>）`；
     *     原条目文字**逐字节保留**，其余行**逐字节不动**（不重排、不 normalize 换行、不删任何东西）
     *   · 越界 / 文件不存在 / 匹配不到 / 匹配到多条 → 一律 400 中文原因，且**不写任何文件**
     *   · 已经是 [x] → 幂等：200 返回 resolved:0 / alreadyResolved:true，不重复追加说明（零写入）
     *   · 返回 {ok, file, resolved:1, openGaps, resolvedGaps}（后两者为全库计数，即时反映结果） */
    if (p === "/api/evolution/gaps/resolve" && req.method === "POST") {
      const body = await readJsonBody(req);
      const spec = resolveGapFilePath(body.file);
      if (spec.error) return fail(res, 400, spec.error);
      let exists = false;
      try { exists = fs.statSync(spec.full).isFile(); } catch {}
      if (!exists) return fail(res, 400, `缺口文件不存在：${spec.rel}（只允许标记 .dsh/evolution/gaps/ 内**已存在**的文件）`);
      const text = fs.readFileSync(spec.full, "utf8");
      const items = parseGapItems(text);
      if (!items.length) return fail(res, 400, `该文件没有可标记的缺口条目：${spec.rel}（条目行 = \`- 文字\` / \`- [ ] 文字\`）`);
      const wantText = body.text == null ? "" : String(body.text).trim();
      const wantLine = body.line == null || body.line === "" ? null : Number(body.line);
      let target = null;
      if (wantLine != null) {
        if (!Number.isInteger(wantLine) || wantLine <= 0) return fail(res, 400, "line 必须是正整数（条目所在行号，从 1 起）");
        target = items.find((it) => it.line === wantLine) || null;
        if (!target) return fail(res, 400, `第 ${wantLine} 行不是缺口条目（只有 \`- 文字\` 形式的条目行可标记；标题 / 生成时间 / 引用行都不算）`);
      } else if (wantText) {
        const norm = (s) => String(s).replace(/\s+/g, " ").trim();
        const want = norm(wantText);
        const exact = items.filter((it) => norm(it.text) === want);
        const hit = exact.length ? exact : items.filter((it) => norm(it.text).includes(want));
        if (!hit.length) return fail(res, 400, `text 匹配不到缺口条目：${spec.rel} 共 ${items.length} 条，均不含该文字（可改用 line 指定行号）`);
        if (hit.length > 1) return fail(res, 400, `text 匹配到 ${hit.length} 条缺口条目，无法确定是哪一条（请写全条目文字，或改用 line）`);
        target = hit[0];
      } else {
        return fail(res, 400, "需要 text（条目文字）或 line（条目所在行号）之一");
      }
      // 定位目标行的原始字节区间（只替换这一段；其余部分原样拼回 → 逐字节保留）
      const starts = [0];
      for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
      const lineStart = starts[target.line - 1];
      let lineEnd = text.indexOf("\n", lineStart);
      if (lineEnd < 0) lineEnd = text.length;
      let contentEnd = lineEnd;
      if (contentEnd > lineStart && text[contentEnd - 1] === "\r") contentEnd--;   // 保留 CRLF 的 \r
      const origLine = text.slice(lineStart, contentEnd);
      const mm = GAP_ITEM_RE.exec(origLine);
      if (!mm) return fail(res, 400, `第 ${target.line} 行不是缺口条目，无法标记`);
      const already = target.resolved;
      if (!already) {
        // 分组 1（缩进/项目符号）与分组 3（原条目文字）**原样引用**，只在两者之间补 `[x] `、行尾追加说明
        const nextLine = `${mm[1]}[x] ${mm[3]}${gapResolvedSuffix(body.note)}`;
        writeNote(spec.full, text.slice(0, lineStart) + nextLine + text.slice(contentEnd));
      }
      const totals = gapTotals();
      return json(res, 200, {
        ok: true,
        file: spec.rel,
        resolved: already ? 0 : 1,
        alreadyResolved: already,
        line: target.line,
        text: target.text,
        openGaps: totals.openGaps,
        resolvedGaps: totals.resolvedGaps,
      });
    }

    // ── P3 任务队列：认领最早的「待执行」任务 → 执行中（追加开始时间） ──
    if (p === "/api/evolution/claim" && req.method === "POST") {
      const dir = evoDir("tasks");
      const files = listTaskFiles(dir);   // 只扫队列这一层：归档目录在 tasks/ 之外（且不递归），归档任务领不到
      files.sort(); // 文件名以时间戳开头 → 升序即最早优先
      for (const f of files) {
        const full = path.join(dir, f);
        let text = "";
        try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
        if (!/^\s*-\s*状态：\s*待执行\s*$/m.test(text)) continue;
        const next = updateStatus(text, "执行中", [`- 开始：${nowText()}`]);
        writeNote(full, next);
        return json(res, 200, { ok: true, task: { path: toRel(full), topic: taskTopic(next), content: next } });
      }
      return fail(res, 404, "no pending task");
    }

    // ── P3 任务队列：标记任务已完成 / 失败（追加完成时间与结果）→ **归档**到知识库可见目录 ──
    if (p === "/api/evolution/done" && req.method === "POST") {
      const body = await readJsonBody(req);
      // path 既可能是队列里的任务（vault 相对 / tasks 相对 / 纯文件名），
      // 也可能是**已在归档目录**里的同一个任务（重复调用，见下）
      const queued = resolveTask(body.path);
      const full = (queued && fs.existsSync(queued)) ? queued : (resolveArchivedTask(body.path) || queued);
      if (!full) return fail(res, 400, "bad path");
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return fail(res, 404, "task not found");
      const extra = [`- 完成：${nowText()}`];
      const result = String(body.result ?? "").trim();
      if (result) extra.push(`- 结果：${result.replace(/\s*\n\s*/g, " ")}`);
      // 重复调用时先去掉旧的「完成 / 结果」行，避免元信息堆积
      const prev = fs.readFileSync(full, "utf8")
        .split(/\r?\n/).filter((l) => !/^\s*-\s*(完成|结果)：/.test(l)).join("\n");
      writeNote(full, updateStatus(prev, body.ok === false ? "失败" : "已完成", extra));
      const original = toRel(full);
      // 写盘完成后归档：搬到 settings.evolution_log_folder（目录不存在则建；同名自动 -2、-3，不覆盖）
      // 已在归档目录里的文件视为重复调用，原样返回，不再二次搬动
      if (path.resolve(path.dirname(full)) === path.resolve(evoDir("tasks"))) {
        const dir = taskArchiveDir();
        try {
          fs.mkdirSync(dir, { recursive: true });
          const dest = uniqueInDir(dir, path.basename(full));
          try { fs.renameSync(full, dest); }
          catch { fs.copyFileSync(full, dest); fs.unlinkSync(full); }   // 跨卷/占用兜底
          return json(res, 200, { ok: true, path: original, archivedTo: toRel(dest) });
        } catch (e) {
          // 归档失败不回滚任务状态：响应里如实说明，path 仍是原路径（向后兼容）
          return json(res, 200, { ok: true, path: original, archivedTo: "", archiveError: String(e.message || e) });
        }
      }
      return json(res, 200, { ok: true, path: original, archivedTo: original });
    }

    // ── P3 任务队列：退回「待执行」（认领后反悔 / 误领）→ 状态回「待执行」，清掉「开始」行 ──
    //   与 claim 的「总是领最早一条」配对：面板上「执行中」卡片旁的次级按钮走这里。
    //   已经归档（搬出 tasks/）的任务**不给退回** —— 改状态会造成「归档里躺着待执行」的错觉。
    if (p === "/api/evolution/reset" && req.method === "POST") {
      const body = await readJsonBody(req);
      const queued = resolveTask(body.path);
      if (!queued) return fail(res, 400, "bad path");
      if (!fs.existsSync(queued) || !fs.statSync(queued).isFile()) return fail(res, 404, "task not found");
      if (path.resolve(path.dirname(queued)) !== path.resolve(evoDir("tasks"))) {
        return fail(res, 400, "task not in queue（已归档的任务不能退回）");
      }
      const prev = fs.readFileSync(queued, "utf8")
        .split(/\r?\n/).filter((l) => !/^\s*-\s*(开始|完成|结果)：/.test(l)).join("\n");
      writeNote(queued, updateStatus(prev, "待执行"));
      return json(res, 200, { ok: true, path: toRel(queued), status: "待执行" });
    }

    // ── 已完成任务归档（只读）：读 settings.evolution_log_folder，按「- 完成：」时间倒序 ──
    if (p === "/api/evolution/archive" && req.method === "GET") {
      const rawLimit = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : 50;
      const dir = taskArchiveDir();
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md")); } catch { files = []; }
      let items = files.map((f) => {
        const full = path.join(dir, f);
        let text = "", mtime = 0;
        try { text = fs.readFileSync(full, "utf8"); } catch {}
        try { mtime = fs.statSync(full).mtimeMs; } catch {}
        const finishedAt = (/- 完成：\s*(.*)/.exec(text)?.[1] || "").trim();
        return { name: f, path: toRel(full), topic: taskTopic(text), status: taskStatus(text),
          finishedAt, result: (/- 结果：\s*(.*)/.exec(text)?.[1] || "").trim(), _ts: Date.parse(finishedAt) || mtime };
      });
      items.sort((a, b) => (b._ts - a._ts) || b.name.localeCompare(a.name));
      items = items.map(({ _ts, ...rest }) => rest);
      return json(res, 200, { ok: true, count: items.length, items: items.slice(0, limit) });
    }

    // ── 进化总览：任务（含状态）/ 日志 / 缺口 / 技能数 / 状态游标；POST 仍可创建任务 ──
    if (p === "/api/evolution" && req.method === "GET") {
      const tasks = readTasks();
      const { logs } = listEvolution();
      // 缺口带生命周期：默认只列**仍有未解决条目**的文件（全部解决的默认隐藏；?includeResolved=1 看全量）。
      // `gaps` 仍是**文件名数组**（旧面板 evoList 依赖此形状），状态明细放进新增的 gapFiles。
      const includeResolved = /^(1|true|yes)$/i.test(url.searchParams.get("includeResolved") || "");
      const gapAll = gapSummaries();
      const openGaps = gapTotals(gapAll);                       // 全库口径（不受默认过滤影响）
      const gapList = includeResolved ? gapAll : gapAll.filter((g) => g.openGaps > 0);
      const sk = skillStats();                       // 与 /api/recall 的 skills 同源（都是 listSkillCards）
      return json(res, 200, {
        ok: true,
        tasks,
        taskFiles: tasks.map((t) => t.name), // 兼容旧面板（client.js 期望文件名数组）
        logs, gaps: gapList.map((g) => g.name),
        // 新增计数（条目口径，全库）：openGaps = 未解决条目数；resolvedGaps = 已解决条目数
        openGaps: openGaps.openGaps,
        resolvedGaps: openGaps.resolvedGaps,
        // 新增明细：每个缺口文件的条目状态（line / text / resolved），供面板与 DSH 直接展示，不必再解析文件
        gapFiles: gapList.map((g) => ({
          name: g.name, path: g.path, topic: g.topic,
          total: g.total, openGaps: g.openGaps, resolvedGaps: g.resolvedGaps, items: g.items,
        })),
        gapsNote: "gaps/gapFiles 默认只含仍有未解决条目的文件（全部解决的默认隐藏）；openGaps/resolvedGaps 为全库条目计数（含被默认隐藏的文件）；?includeResolved=1 返回全量。条目无勾选框 = 未解决（旧格式兼容）。",
        skills: sk.total,                    // 总数：.dsh/skills/*.md + vault 内 <名>/SKILL.md
        skillsLocal: sk.local,               // 分项：桥自己写的 .dsh/skills/*.md
        skillsVault: sk.vault,               // 分项：vault 内的 <名>/SKILL.md（如 copilot/skills/x/SKILL.md）
        state: readState(),
      });
    }
    if (p === "/api/evolution" && req.method === "POST") {
      const { topic, kind } = await readJsonBody(req);
      const created = createEvolutionTask(topic, kind);
      return json(res, 200, { ok: true, task: toRel(created), ...listEvolution() });
    }

    // Obsidian 联动：REST API 状态（面板据此决定能否执行 Obsidian 命令）
    if (p === "/api/obsidian/status") {
      let key = "";
      try {
        const raw = fs.readFileSync(path.join(VAULT, ".obsidian", "plugins", "local-rest-api", "data.json"), "utf8");
        key = JSON.parse(raw).apiKey || "";
      } catch {}
      if (!key) return json(res, 200, { ok: true, restApi: "no-key" });
      try {
        const r = await httpsJson("https://127.0.0.1:27124/", { Authorization: `Bearer ${key}` });
        return json(res, 200, {
          ok: true,
          restApi: r.status === 200 ? "up" : "down",
          authenticated: r.body.authenticated === true,
          version: r.body.manifest?.version,
          name: r.body.manifest?.name,
        });
      } catch (e) {
        return json(res, 200, { ok: true, restApi: "unreachable", note: String(e.message) });
      }
    }

    // 生成 obsidian:// 深链（面板"跳去 Obsidian 打开"用）
    if (p === "/api/obsidian/uri") {
      const rel = url.searchParams.get("path") || "";
      const vaultName = path.basename(VAULT);
      const file = rel.replace(/\.md$/i, "");
      const uri = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file)}`;
      return json(res, 200, { ok: true, uri });
    }

    // ══════════════════════════════════════════════════════════════════════
    // 投喂入库（交付 1）：上传识别 / 入库 / 交 DSH 深度整理 / 清单 / 清理
    // ══════════════════════════════════════════════════════════════════════

    // 1) 上传 + 提取：{name,dataB64} → 原件落 .dsh/inbox/files/<ts>__<名> → extract.py
    //    兼容分支 {id}：对已暂存文件重新提取（面板刷新后点「识别」不重复落盘）
    if (p === "/api/ingest" && req.method === "POST") {
      const body = await readJsonBody(req, INGEST_BODY_LIMIT);
      let id = "", full = null, name = "", bytes = 0;
      if (body.id && !body.dataB64) {
        full = safeUnder(INBOX_FILES, String(body.id));
        if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) return fail(res, 404, "暂存文件不存在或 id 非法");
        id = path.basename(full);
        name = idToName(id);
        bytes = fs.statSync(full).size;
      } else {
        const dataB64 = String(body.dataB64 || "");
        if (!dataB64) return fail(res, 400, "缺少 dataB64（或用 {id} 对已暂存文件重新提取）");
        let buf = null;
        try { buf = Buffer.from(dataB64.replace(/^data:[^,]*,/, ""), "base64"); } catch { buf = null; }
        if (!buf || !buf.length) return fail(res, 400, "base64 解码失败或文件为空");
        if (buf.length > INGEST_MAX_BYTES) {
          return fail(res, 413, `文件过大（${(buf.length / 1048576).toFixed(1)}MB，上限 ${INGEST_MAX_BYTES / 1048576}MB）`);
        }
        name = safeFileBase(body.name, "file");
        fs.mkdirSync(INBOX_FILES, { recursive: true });
        full = uniquePath(path.join(INBOX_FILES, `${stamp()}__${name}`));
        if (!full) return fail(res, 500, "暂存目录同名文件过多");
        const tmp = full + ".part";                       // 原子落盘：避免半截文件被 /list 看到
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, full);
        id = path.basename(full);
        bytes = buf.length;
      }
      const ex = await extractStaged(id, full);
      const text = ex.ok ? ex.text : "";
      return json(res, 200, {
        ok: true, id, name, staged: true, bytes,
        kind: ex.ok ? ex.kind : "unknown",
        text, truncated: !!ex.truncated, meta: ex.meta || {},
        // PDF 内嵌图片：已按原字节抽到 .dsh/inbox/files/ 下（图片清单也写进投喂任务文件）
        // **新增 images[].rel** = 相对暂存目录的路径（如 `课件__img02.jpg`）——
        // 前端缩略图**优先用 rel**（绝对路径里的盘符/用户名不该出现在 URL 里，且换了 vault 盘符也不失效）；
        // file（绝对路径）原样保留，后端两种都收（向前兼容）。
        images: (ex.images || []).map((im) => (im && typeof im === "object" ? { ...im, rel: stageRel(im.file) } : im)),
        imagesSkipped: ex.imagesSkipped || [], pageRender: ex.pageRender || null,
        // 疑似扫描页（文字层极薄且含图像）：面板据此决定要不要提示「知识应在图片里」
        //   —— 原来只在投喂任务文件的图片清单里用到；面板侧需要在**识别结果**里就能判（前端 ingThin）
        suspectScan: ex.suspectScan || [],
        // 水印线索：文字型（已从正文剔除，在此留证）/ 图片型（只标记不删）；rasterPng = 光栅开关状态
        watermarkLines: ex.watermarkLines || [], rasterPng: ex.rasterPng || null,
        // 老格式转换线索（extract.py 新增）：原扩展名 + {tool, ms, ok}；非老格式为 null
        convertedFrom: ex.convertedFrom || null,
        convert: ex.convert || null,
        guess: { title: guessTitle(text, name), tags: guessTags(name, text) },
        // 提取失败不影响暂存：原件已在盘上，仍可手填入库或交 DSH 深度整理
        ...(ex.ok ? {} : { error: ex.error, extract: "failed" }),
      });
    }

    // 2) 入库：写标准 frontmatter 笔记 + 原件归档 <attach_dir>/ + 追加投喂日志
    if (p === "/api/ingest/save" && req.method === "POST") {
      const body = await readJsonBody(req, INGEST_BODY_LIMIT);
      const src = safeUnder(INBOX_FILES, String(body.id || ""));
      if (!src || !fs.existsSync(src) || !fs.statSync(src).isFile()) return fail(res, 400, "id 非法或暂存文件不存在");
      const id = path.basename(src);
      const origName = idToName(id);
      const settings = readSettings();
      const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean);
      const tags = [...new Set([...list(body.tags), settings.processed_tag])];
      const title = String(body.title ?? "").trim() || path.basename(origName, path.extname(origName)) || "未命名";
      // 默认落 = **长期保留区**（settings.ingest_default_dir；曾兜底暂存目录 `00-inbox` ✗，那里会被定期清理）；
      // 用户传了 folder 就用用户的（库内相对路径；越界由 safeDir 拦成 400）。下方 fs.mkdirSync(dir,{recursive})
      // 会**自动创建**这个目录 —— 不要求用户先手动建 ✓
      const dir = String(body.folder ?? "").trim() ? safeDir(String(body.folder).trim()) : ingestDefaultDir();
      if (!dir) return fail(res, 400, "bad folder");

      // 2a) 原件归档（先做，才能把附件相对路径写进 frontmatter.original）
      let attachment = null;
      if (body.linkOriginal !== false) {
        const aDir = attachDir();
        fs.mkdirSync(aDir, { recursive: true });
        const dest = uniquePath(path.join(aDir, safeFileBase(origName, "file")));
        if (!dest) return fail(res, 500, "附件目录同名文件过多");
        fs.copyFileSync(src, dest);
        attachment = toRel(dest);
      }
      const attName = attachment ? path.basename(attachment) : "";
      const original = attachment || toRel(src);

      // 2a-2) 内嵌图片**真正带进笔记**（用户实测：图在文件夹里看得到、笔记/缩略图里只看到一串路径 ✗）
      //   · 有知识的图（`likelyWatermark !== true`）**复制**到 <vault>/<attach_dir>/（同名自动 -2 / -3 …，绝不覆盖）；
      //   · 正文生成**真正的 Obsidian 图片引用** `![[文件名]]` + 每张图下一行占位说明（注释由 DSH 后续看图补）；
      //   · 路径文本清单**降级为附录**（供排查），但它不再是图片的唯一形态；
      //   · 复制失败**如实写明**（哪几张 + 原因），绝不静默。
      const imgCopied = [], imgRenamed = [], imgFailed = [], imgSkipped = [];
      try {
        const ex = await extractStaged(id, src);            // 命中内存缓存 → 不会重复起 Python
        for (const im of (Array.isArray(ex && ex.images) ? ex.images : [])) {
          if (!im || typeof im.file !== "string") continue;
          if (im.likelyWatermark === true) {                 // 水印 / 装饰图：只记数，不进笔记
            imgSkipped.push({ file: path.basename(im.file), page: im.page == null ? null : im.page });
            continue;
          }
          const srcImg = safeUnder(INBOX_FILES, im.file);
          if (!srcImg || !fs.existsSync(srcImg) || !fs.statSync(srcImg).isFile()) {
            imgFailed.push({ file: im.file, reason: "不在暂存目录内或已不存在" });
            continue;
          }
          fs.mkdirSync(aDir, { recursive: true });
          const from = path.basename(srcImg);
          const dest = uniquePath(path.join(aDir, safeFileBase(from, "img")));
          if (!dest) { imgFailed.push({ file: from, reason: "附件目录同名文件过多" }); continue; }
          try { fs.copyFileSync(srcImg, dest); }
          catch (e) { imgFailed.push({ file: from, reason: "复制失败：" + (e && e.message ? e.message : e) }); continue; }
          const to = path.basename(dest);
          if (to !== from) imgRenamed.push({ from, to });
          imgCopied.push({ name: to, page: im.page == null ? null : im.page, w: im.w, h: im.h, bytes: im.bytes, rel: stageRel(srcImg) });
        }
      } catch (e) {
        imgFailed.push({ file: "(提取结果不可用)", reason: String(e && e.message ? e.message : e) });
      }

      // 2b) 笔记落盘（同名自动 -2 / -3 …，不报错）
      fs.mkdirSync(dir, { recursive: true });
      const notePath = uniquePath(path.join(dir, `${safeName(title, { fallback: "note" })}.md`));
      if (!notePath) return fail(res, 409, "too many duplicates");
      const summary = String(body.summary ?? "").trim().replace(/\s*\n\s*/g, " ");
      const parts = [];
      if (summary) parts.push(`> 摘要：${summary}`, "");
      parts.push(String(body.body ?? "").replace(/^\s*\n/, "").replace(/\s+$/, ""));
      if (attachment) {                                    // Obsidian 内嵌预览 / 普通链接
        parts.push("", ATTACH_INLINE(extOf(attName)) ? `![[${attName}]]` : `[[${attName}]]`);
      }
      if (imgCopied.length) {                              // Obsidian 里**看得见**的图（不再是路径文本）
        parts.push("", "## 内嵌图片", "");
        imgCopied.forEach((im, i) => {
          parts.push(`![[${im.name}]]`,
            `图 ${i + 1}：（待 DSH 看图补注释）` + (im.page == null ? "" : ` · 原第 ${im.page} 页`), "");
        });
        parts.pop();                                       // 去掉末尾空行（下方统一收尾）
      }
      if (imgCopied.length || imgSkipped.length || imgFailed.length) {
        parts.push("", "## 内嵌图片清单（路径文本 · 仅供排查）", "");
        for (const im of imgCopied) {
          parts.push(`- 已带入笔记：\`attachments/${im.name}\`` +
            (im.rel ? ` ← 暂存件 \`${im.rel}\`` : "") +
            (im.bytes == null ? "" : ` · ${im.w == null ? "?" : im.w}×${im.h == null ? "?" : im.h} · ${im.bytes}B`));
        }
        for (const im of imgSkipped) parts.push(`- 未带入（疑似水印/装饰，仍在暂存目录）：第 ${im.page == null ? "?" : im.page} 页 · \`${im.file}\``);
        for (const f of imgFailed) parts.push(`- ⚠️ **未复制成功**：\`${f.file}\` —— ${f.reason}`);
        if (imgRenamed.length) parts.push(`- 重名改名（附件目录已有同名，绝不覆盖）：` + imgRenamed.map((r) => `\`${r.from}\` → \`${r.to}\``).join("；"));
        parts.push("");
      }
      const text = [
        "---",
        `title: ${yamlScalar(title)}`,
        `created: ${localDay()}`,
        `source: 文件投喂`,
        `original: ${yamlPath(original)}`,
        `tags: [${tags.map(yamlScalar).join(", ")}]`,
        "---", "",
        parts.join("\n").replace(/\s+$/, ""),
        "",
      ].join("\n");
      writeNote(notePath, text);

      // 2b-2) 投喂清单（护栏）：图片已复制进 `attachments/` + 笔记已落盘之后，**追加一行**记录本次带了哪些附件。
      //   为什么：`attachments/` 会被用户的「清理未使用附件」误删（投喂产出的图当时确实没有被别的笔记引用），
      //   有这条清单才知道「本该有哪些」→ 可从暂存区重抽 / 从 git 恢复（只提示，**不自动改文件** ✗）。
      //   写失败**不影响入库**（笔记与附件已落盘）→ 只记不抛，绝不因此回滚 ✗。
      try {
        appendJsonlLine(ingestManifestFile(), {
          ts: Date.now(),
          note: toRel(notePath),
          images: imgCopied.map((im) => toRel(path.join(aDir, im.name))),
          original: attachment || "",                       // 归档原件（同为 attachments/ 内附件，一并纳入清单）
          source: String(body.source ?? "").trim() || "文件投喂",
        });
      } catch (eMf) { /* 清单只是恢复依据，不是主链：失败静默，入库结果照常返回 */ }

      // 2c) 投喂日志：按月一个文件，纯追加一行
      const logFile = path.join(evoDir("logs"), `ingest-${localDay().slice(0, 7)}.md`);
      let prev = "";
      try { prev = fs.readFileSync(logFile, "utf8").replace(/\s*$/, "\n"); }
      catch { prev = `# 📥 DSH 投喂入库日志 ${localDay().slice(0, 7)}\n\n`; }
      writeNote(logFile, prev + `- ${nowText()} 投喂入库 ${toRel(notePath)} ← ${origName}\n`);
      return json(res, 200, {
        ok: true, note: toRel(notePath), attachment,
        // 图片带入结果（前端据此给一句轻提示；**失败如实回报**，前端与笔记里都能看到）
        imagesCopied: imgCopied.length, imagesCopiedList: imgCopied,
        imagesSkippedWatermark: imgSkipped.length,
        imagesFailed: imgFailed.length, imagesFailedList: imgFailed, imagesRenamed: imgRenamed,
      });
    }

    // 2d) 投喂附件清单（**只读**）：GET /api/ingest/manifest?note=<vault 相对路径>
    //   返回该笔记投喂入库时记录的附件（内嵌图 + 归档原件）+ **逐个**判断是否还在（present / missing）。
    //   用途：`attachments/` 被「清理未使用附件」误删后，面板在笔记查看器里提示「有 N 张附件已被清理」。
    //   红线：只读 `.dsh/ingest-manifest.jsonl` + fs.existsSync —— **不补文件、不改笔记、不自动清理** ✗。
    //   边界：绝对路径 / 盘符 / UNC / `..` 逃逸 / 库外 → 400；从没投喂过（无记录）→ 200 空清单（不是错）。
    if (p === "/api/ingest/manifest" && req.method === "GET") {
      const raw = String(url.searchParams.get("note") || "").trim();
      if (!raw) return fail(res, 400, "缺少 note（vault 相对路径，如 <目录>/xxx.md）");
      if (raw.length > 1024 || /[\u0000-\u001f\u007f]/.test(raw)) return fail(res, 400, "note 非法");
      if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || /^\\\\/.test(raw)) {
        return fail(res, 400, "note 必须是 vault 相对路径（不接受绝对路径 / UNC）");
      }
      const full = safeDir(raw.replace(/\\/g, "/"));
      if (!full) return fail(res, 400, "note 越界（必须落在 vault 内）");
      const rel = toRel(full);
      const mf = ingestManifestFor(rel);
      const items = mf.items.map((r) => {
        const abs = safeDir(r);
        let st = null;
        try { st = abs ? fs.statSync(abs) : null; } catch {}
        const okFile = !!(st && st.isFile());
        return okFile ? { path: r, status: "present", bytes: st.size } : { path: r, status: "missing" };
      });
      const missingList = items.filter((i) => i.status === "missing").map((i) => i.path);
      return json(res, 200, {
        ok: true, note: rel,
        entries: mf.entries, ts: mf.ts,                 // 记录条数 / 最近一次投喂时间（从没投喂过 → 0）
        images: items.length, present: items.length - missingList.length, missing: missingList.length,
        items, missingList,
      });
    }

    // 3) 交 DSH 深度整理：任务文件写进 .dsh/inbox/（Obsidian → DSH 收件箱，DSH 会来读）
    if (p === "/api/ingest/queue" && req.method === "POST") {
      const body = await readJsonBody(req, INGEST_BODY_LIMIT);
      const src = safeUnder(INBOX_FILES, String(body.id || ""));
      if (!src || !fs.existsSync(src) || !fs.statSync(src).isFile()) return fail(res, 400, "id 非法或暂存文件不存在");
      const id = path.basename(src);
      const origName = idToName(id);
      const ex = await extractStaged(id, src);
      const text = (ex.ok ? ex.text : "").trim();
      const stem = path.basename(origName, path.extname(origName));
      const taskPath = path.join(INBOX_DIR, `${stamp()}-ingest-${safeName(stem, { fallback: "file", max: 30 })}.md`);
      const note = String(body.note ?? "").trim();
      const textBlock = text
        ? text
        : "（该文件无法抽文本，需 DSH 用多模态看图 / 或重新获取）";
      writeNote(taskPath, [
        `# 🤖 DSH 深度整理任务：${origName}`,
        ``,
        `- 类型：文件投喂`,
        `- 状态：待执行`,
        `- 创建：${nowText()}`,
        `- 原始文件：${src}`,
        `- 暂存副本：.dsh/inbox/files/${id}`,
        `- 提取结果：${ex.ok ? `kind=${ex.kind}${ex.truncated ? "（已截断）" : ""}` : `失败 —— ${ex.error}`}`,
        ...(ex.kind === "pdf"
          ? [`- 内嵌图片：抽出 ${(ex.images || []).length} 张 / 跳过 ${(ex.imagesSkipped || []).length} 个图像流（详见下方图片清单）`,
             `- 水印线索：文字型 ${(ex.watermarkLines || []).length} 条（**已从正文剔除**，不是正文内容；见下方清单）/ 图片型疑似 ${(ex.images || []).filter((im) => im && im.likelyWatermark).length} 张（**未删**）`,
             `- 光栅转 PNG：${ex.rasterPng && ex.rasterPng.enabled ? `已开启（试 ${ex.rasterPng.tried} / 成功 ${ex.rasterPng.done}）` : "关闭（默认零依赖，只原字节直出 JPEG/PNG）"}`]
          : []),
        `- 用户备注：${note || "（无）"}`,
        ...ingestImageBlock(ex),
        `## 给 DSH 的指令`,
        `1. 阅读下方提取文本；若为空（图片 / 音视频 / 扫描件），直接用多模态看 \`${src}\`。`,
        `   若上方有「内嵌图片清单」，请**逐张用多模态看那些图片文件**（PDF 里的图已抽成独立 PNG/JPEG）——`,
        `   图上的知识不在文字层里，必须看图；看完把要点并入整理结果，并在每张图下方补一行机器可读注释（图号 / 出处页 / 内容要点）。`,
        `2. 分析内容，拟定 \`title\` / \`tags\`（3–6 个）/ 一句话摘要。`,
        `3. 用标准 frontmatter（title / created / source / tags）把整理结果写入知识库合适目录；`,
        `   原件请归档到 \`attachments/\`，正文用 \`![[文件名]]\`（图片/音视频/PDF）或 \`[[文件名]]\` 引用。`,
        `4. 产出缺口清单：本次素材没讲清、需用户补充或需联网补全的知识点 → \`.dsh/evolution/gaps/\`。`,
        `5. 处理完在本文件把 \`- 状态：\` 改成「已完成」，并在 \`.dsh/evolution/logs/\` 追加一条日志。`,
        ``,
        `## 提取到的文本`,
        ``,
        textBlock,
        ``,
      ].join("\n"));
      return json(res, 200, { ok: true, task: toRel(taskPath) });
    }

    // 3b) 笔记 → DSH：把某篇笔记「交给 DSH 处理」（知识库 → DSH 的反向通道）。
    //     与 /api/ingest/queue **同一收件箱 .dsh/inbox/、同一文件风格**（# 标题 + 元信息行 +
    //     「## 给 DSH 的指令」+ 正文块）；区别只是来源从「投喂暂存件」换成「库内既有笔记」，
    //     所以正文只带**前 500 字摘要**并给出 vault 相对路径，让 DSH 自己去读原文。
    //     安全：path 必须在 vault 内且以 .md 结尾（越界 / 非 md → 400）；文件不存在 → 404。
    //     文件名 <本地时间戳>-交给DSH-<安全化标题>.md，经 uniquePath 兜底：连点两次 = 两个任务文件，绝不覆盖。
    if (p === "/api/handoff" && req.method === "POST") {
      const body = await readJsonBody(req);
      const rel = String(body.path ?? "").trim();
      const full = safeNotePath(rel);                     // vault 内 + .md，越界/非 md → null
      if (!full) return fail(res, 400, "bad path（只允许 vault 内以 .md 结尾的笔记路径）");
      let st = null;
      try { st = fs.statSync(full); } catch {}
      if (!st || !st.isFile()) return fail(res, 404, `笔记不存在：${rel || "(空)"}`);

      let raw = "";
      try { raw = fs.readFileSync(full, "utf8"); }
      catch (e) { return fail(res, 500, `读取笔记失败：${e && e.message ? e.message : e}`); }

      const fm = parseFrontmatter(raw);
      const noteRel = toRel(full);
      const title = String(fm.frontmatter.title || "").trim() || path.basename(full, path.extname(full)) || "未命名";
      const userNote = String(body.note ?? "").trim();
      const src = fm.body.replace(/\r\n/g, "\n").trim();   // 去掉 frontmatter，摘要给正文
      const excerpt = src.slice(0, 500);
      const truncated = src.length > excerpt.length;

      fs.mkdirSync(INBOX_DIR, { recursive: true });
      const taskPath = uniquePath(path.join(INBOX_DIR, `${stamp()}-交给DSH-${safeName(title, { fallback: "note", max: 30 })}.md`));
      if (!taskPath) return fail(res, 500, "收件箱同名任务过多（-2…-999 已用尽）");

      const lines = [
        `# 🧠 DSH 笔记处理任务：${title}`,
        ``,
        `- 类型：笔记交接`,
        `- 状态：待执行`,
        `- 创建：${nowText()}`,
        `- 来源笔记：${noteRel}`,
        `- 笔记标题：${title}`,
        `- 笔记绝对路径：${full}`,
        `- 用户备注：${userNote || "（无）"}`,
        ``,
        `## 给 DSH 的指令`,
        `1. 打开这篇笔记读全文：\`${noteRel}\`（vault 相对路径；绝对路径 \`${full}\`）—— 下面只有前 500 字摘要，判断一律以原文为准。`,
        `2. 提炼要点：一句话摘要 + 3–7 条要点（结论 / 数据 / 步骤优先）。`,
        `3. 找出缺口：概念没讲清、缺例子、与库内其它笔记冲突或重复、需要联网补全的知识点。`,
        `4. 判断是否值得进技能库：若能复用为方法论 / 流程 / 清单 → 写 \`.dsh/skills/<名字>.md\`（POST /api/skills {name, description, content}）。`,
        `5. **把产出写回知识库**（按需选一种或多种，都只碰 vault 内的 .md）：`,
        `   - 新建笔记：POST /api/note {path, text, unique:true}（path 为 vault 相对路径，同名自动 -2）`,
        `   - 改写原笔记：PUT /api/note {path:"${noteRel}", text}（整篇覆盖；先读后写，别丢原文）`,
        `   - 归档成标准笔记：POST /api/archive {title, content, tags, folder}`,
        `   - 补标签：POST /api/tag {path, tags}（默认 mode="add"，幂等）`,
        `   - 等价替代：直接用 DSH 自己的写文件工具写进 vault。`,
        `6. 缺口清单 → \`.dsh/evolution/gaps/\`；处理日志 → \`.dsh/evolution/logs/\`。`,
        `7. 处理完把本文件 \`- 状态：\` 改成「已完成」，并写清产出落在哪几个路径。`,
        ``,
        `## 笔记正文摘要（前 500 字${truncated ? "，已截断" : ""}）`,
        ``,
        excerpt || "（正文为空：可能只有 frontmatter，请直接读原文）",
      ];
      if (truncated) lines.push(``, `…（仅摘要，完整正文请读 \`${noteRel}\`）`);
      lines.push(``);
      writeNote(taskPath, lines.join("\n"));

      let inboxCount = 0;
      try { inboxCount = fs.readdirSync(INBOX_DIR).filter((f) => f.endsWith(".md")).length; } catch {}
      return json(res, 200, { ok: true, task: toRel(taskPath), inboxCount });
    }

    // 3c) 技能候选 → DSH 提炼：把 `/api/skills/candidates` 发现的**主题**交给 DSH 写成技能卡。
    //     ⚠️ 不能复用 /api/handoff —— 它只接受 **vault 内以 .md 结尾的笔记路径**，而候选是「主题」，
    //        可能根本没有对应笔记（如刚冒头的标签 / 缺口），故独立一个接口。
    //     **落点 = .dsh/evolution/tasks/（与任务队列同一个状态机）**：
    //       「提炼技能」在语义上就是「库自进化」的一种 —— 写进进化任务队列之后
    //       ① 面板「任务队列」里看得见、领得到、完得成；② 候选卡的 handoff（handoffIndex）读的就是这里
    //       → 候选卡与队列**显示同一个任务、同一份状态**。
    //       （旧版写 .dsh/inbox/ 是**第二个状态机**：用户实测候选卡「待执行」而队列里根本没有它 ✗；旧文件由
    //        migrateDistillInboxTasks 一次性迁移 + handoffIndex 兜底读，不丢数据。）
    //     写盘范围（红线）：**只有** .dsh/evolution/tasks/<ts>-<安全化主题>.md；
    //        uniquePath 兜底 → 同名主题连点两次 = 两个任务文件，**绝不覆盖**旧任务。
    //     **绝不自动生成技能卡**：本接口只写任务，提炼永远由 DSH 做（与 skillCandidates 同一哲学）。
    //     入参：{topic, score?, evidence?}；topic 必填且过 distillTopicName（越界 → 400）；
    //        evidence 给了就必须是数组（非数组 → 400），逐条进正文。
    if (p === "/api/skills/distill" && req.method === "POST") {
      const body = await readJsonBody(req);
      const topic = distillTopicName(body.topic);
      if (!topic) return fail(res, 400, "bad topic（必填；不得含路径分隔符 / 盘符 / `..` / 控制字符 / 空名；长度 ≤ 80）");
      const rawEv = body.evidence === undefined || body.evidence === null ? [] : body.evidence;
      if (!Array.isArray(rawEv)) return fail(res, 400, "bad evidence（必须是数组）");
      const evidence = rawEv.slice(0, 40)
        .map((x) => String(x == null ? "" : x).replace(/\s+/g, " ").trim().slice(0, 500))
        .filter(Boolean);
      const sc = Number(body.score);

      const taskDir = evoDir("tasks");
      fs.mkdirSync(taskDir, { recursive: true });
      const taskPath = uniquePath(path.join(taskDir, `${stamp()}-${safeName(topic, { fallback: "topic", max: 40 })}.md`));
      if (!taskPath) return fail(res, 500, "任务队列同名任务过多（-2…-999 已用尽）");
      if (!path.resolve(taskPath).startsWith(path.resolve(taskDir) + path.sep)) {
        return fail(res, 500, "任务队列路径越界（已拒绝写入）");   // 双保险：绝不写 .dsh/evolution/tasks 之外
      }

      const lines = [
        `# 🧪 DSH 技能提炼任务：${topic}`,
        ``,
        `- 类型：技能提炼（候选）`,
        `- 状态：待执行`,
        `- 创建：${nowText()}`,
        `- 主题：${topic}`,
      ];
      if (Number.isFinite(sc)) lines.push(`- 候选分：${Math.round(sc)}`);
      lines.push(
        `- 来源：GET /api/skills/candidates（kind=topic）`,
        `- 队列：.dsh/evolution/tasks/（与面板「任务队列」同一份状态：领取 → 执行中 → 完成归档）`,
        ``,
        `## 给 DSH 的指令`,
        `1. 请据此提炼成技能卡：写 \`.dsh/skills/<名>.md\`，含【什么时候用 / 步骤 / 已知边界 / 证据与可信度】。`,
        `2. 证据只当线索：库内标题党多，先按证据去读对应笔记 / 目录原文再定稿（可信度分层：我产出 > 用户投喂 > Clipping）。`,
        `3. **没把握就别硬写**：证据撑不起一张卡时，写清缺什么（缺口 → \`.dsh/evolution/gaps/\`），绝不编内容。`,
        `4. 本任务是**进化任务队列**里的一条：做完请把它标为已完成（面板「任务队列」里点「标为完成」，或把上面的 \`- 状态：\` 改成「已完成」），` +
          `并在 \`.dsh/evolution/logs/\` 追加一条日志。`,
        ``,
        `## 证据（逐条）`,
        ``,
      );
      lines.push(...(evidence.length ? evidence.map((e) => `- ${e}`) : ["- （无：候选只有弱信号，请先自行取证）"]));
      lines.push(``);
      writeNote(taskPath, lines.join("\n"));

      return json(res, 200, { ok: true, path: toRel(taskPath), kind: "evolution-task" });
    }

    // 4) 暂存清单：只列 .dsh/inbox/files/ 下的原件
    //    PDF 抽图产物（`<原名>__imgNN.jpg` / `<原名>__page NN.png`）是**派生件**、不是待入库文件 → 不列，
    //    否则它们会被当成暂存件显示（用户点「入库」会拿一张图当原件，流程就乱了）
    if (p === "/api/ingest/list" && req.method === "GET") {
      let entries = [];
      try { entries = fs.readdirSync(INBOX_FILES, { withFileTypes: true }); } catch {}
      /* 深度整理状态：**一次扫描** `.dsh/inbox/*-ingest-*.md` 建索引，每项查表（只读、不写盘）。
         新增字段 `deep`（既有字段 id/name/kind/bytes/mtimeMs/staged 逐字不变，老前端不受影响）。 */
      const deepIdx = ingestDeepIndex();
      const items = entries
        .filter((e) => e.isFile() && !e.name.endsWith(".part") && !e.name.startsWith(".") && !DERIVED_IMG_RE.test(e.name))
        .map((e) => {
          const full = path.join(INBOX_FILES, e.name);
          let st = { size: 0, mtimeMs: 0 };
          try { st = fs.statSync(full); } catch {}
          const nm = idToName(e.name);
          return { id: e.name, name: nm, kind: kindOf(e.name), bytes: st.size, mtimeMs: st.mtimeMs, staged: true,
            deep: ingestDeepOf(deepIdx, nm) };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      return json(res, 200, { ok: true, count: items.length, items });
    }

    // 4b) 内嵌图片缩略图（**只读**）：GET /api/ingest/thumb?path=<暂存目录 .dsh/inbox/files/ 内的派生图>
    //     口径 = **解析后必须落在暂存目录内**（而不是"必须相对"）：
    //       · 绝对路径（extract.py 的 images[].file 原值）/ vault 相对路径 / **暂存目录相对路径**（images[].rel）都接受；
    //       · 一律 path.resolve 后与 .dsh/inbox/files/ 的**真实路径**比对（`..` 在解析时已被归一）；
    //       · 落在暂存目录内 → 放行；在外 → 400（`..` 逃逸 / 别盘符 / UNC / 系统路径解析后必然在外）。
    //     其余安全边界照旧：只放行**图片扩展名**（400）；空 / 控制字符 / 超长（400）；不存在（404）；目录（400）。
    //     （旧口径靠"输入里含 `.dsh/inbox/files/` 就切掉前半段"来兜绝对路径 —— 能用但脆：换个写法、换个盘符
    //      就得靠运气；现在改成"解析后落在暂存目录内"这一条**可判定的规则**，绝对/相对两条路同一把尺。）
    //     为什么不用现成的 /api/raw：那个的口径是"vault 内任何位置 + 媒体/文档扩展名"，
    //     对"只给暂存区看图"来说面太大；这个接口把可达面收窄到**一个目录 + 图片类型**。
    if (p === "/api/ingest/thumb" && req.method === "GET") {
      let raw = String(url.searchParams.get("path") || "");
      if (/%[0-9a-fA-F]{2}/.test(raw)) { try { const d = decodeURIComponent(raw); if (d !== raw) raw = d; } catch {} }
      raw = raw.replace(/\\/g, "/").trim();
      if (!raw || raw.length > 1024 || /[\u0000-\u001f\u007f]/.test(raw)) {
        return fail(res, 400, "bad path（只允许 .dsh/inbox/files/ 内的图片）");
      }
      // 同一份输入可能有三种写法 → 逐个解析，只保留**落在暂存目录内**的候选，优先取真实存在的那个
      const cands = [];
      if (!path.isAbsolute(raw)) cands.push(path.resolve(VAULT, raw));      // vault 相对（`.dsh/inbox/files/x.jpg`）
      const marker = ".dsh/inbox/files/";
      const at = raw.toLowerCase().lastIndexOf(marker);
      if (at >= 0) {
        const tail = raw.slice(at + marker.length);
        if (tail && !tail.includes("/")) cands.push(path.resolve(INBOX_FILES, tail));   // 绝对路径里取后半段
      }
      cands.push(path.resolve(INBOX_FILES, raw));                            // 暂存目录相对（images[].rel）/ 绝对路径
      const rootL = path.resolve(INBOX_FILES).toLowerCase() + path.sep;
      const inside = cands.filter((c) => c.toLowerCase().startsWith(rootL));
      const full = inside.find((c) => fs.existsSync(c)) || inside[0];
      if (!full) return fail(res, 400, "bad path（越界：只允许 .dsh/inbox/files/ 内的文件）");
      if (!/^image\//.test(ATTACH_TYPES[extOf(full)] || "")) return fail(res, 400, "bad ext（只允许图片）");
      if (!fs.existsSync(full)) return fail(res, 404, "not found");
      if (fs.statSync(full).isDirectory()) return fail(res, 400, "bad path（这是目录，不是图片文件）");
      return sendRaw(res, full);
    }

    // 5) 清理暂存原件：只允许 .dsh/inbox/files/ 内（越界 400）
    if (p === "/api/ingest/discard" && req.method === "POST") {
      const body = await readJsonBody(req, INGEST_BODY_LIMIT);
      const full = safeUnder(INBOX_FILES, String(body.id || ""));
      if (!full) return fail(res, 400, "bad id（只允许删除 .dsh/inbox/files/ 内的暂存件）");
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return fail(res, 404, "not found");
      const id = path.basename(full);
      fs.unlinkSync(full);
      extractCache.delete(id);
      // 顺手清掉该原件的 PDF 抽图产物（`<原名>__imgNN.*` / `<原名>__page NN.png`）：
      // 只在**没有别的暂存原件共用同一原名**时才删（同名文件再投喂时，图片是共用的同一批）
      try {
        const stemOf = (n) => path.basename(idToName(n), path.extname(idToName(n))).slice(0, 80);
        const stem = stemOf(id);
        const rest = fs.readdirSync(INBOX_FILES).filter((n) => n !== id && !n.endsWith(".part") && !DERIVED_IMG_RE.test(n));
        const shared = rest.some((n) => stemOf(n) === stem);
        if (stem && !shared) {
          for (const n of fs.readdirSync(INBOX_FILES)) {
            if (DERIVED_IMG_RE.test(n) && n.startsWith(stem + "__")) fs.unlinkSync(path.join(INBOX_FILES, n));
          }
        }
      } catch (e) {
        // 清理派生件失败不影响「已删原件」的结果，但留痕便于排查
        console.error("[ingest/discard] 派生图片清理失败：", e && e.message ? e.message : e);
      }
      return json(res, 200, { ok: true, deleted: id });
    }

    // 6) 暂存孤儿对账：POST /api/ingest/reconcile（?dry=1 只算不做）
    //    同一个实现也挂在 **GET**（但强制只读）：面板打开投喂页的自动对账走 GET，
    //    这样「打开页面」的请求集里**没有任何写方法**（GET 天然不可能移文件）。
    if (p === "/api/ingest/reconcile" && (req.method === "POST" || req.method === "GET")) {
      let body = {};
      if (req.method === "POST") body = await readJsonBody(req, INGEST_BODY_LIMIT);
      const q = String(url.searchParams.get("dry") || "").trim();
      const dry = req.method === "GET" ? true : (q ? /^(1|true|yes|on)$/i.test(q) : body.dry === true);
      /* 宽限期可覆盖（`?graceHours=` 或 body.graceHours，0 = 关闭宽限，只认「有未完成任务 / 有引用」） */
      const gRaw = url.searchParams.get("graceHours") != null ? url.searchParams.get("graceHours") : body.graceHours;
      let grace = RECONCILE_GRACE_HOURS;
      if (gRaw !== undefined && gRaw !== null && gRaw !== "") {
        grace = Number(gRaw);
        if (!Number.isFinite(grace) || grace < 0) return fail(res, 400, "bad graceHours（需 ≥ 0 的数字）");
      }
      return json(res, 200, { ok: true, dry, ...reconcileStaged(dry, grace) });
    }

    // 7) 回收区清单（**只读**）：GET /api/ingest/trash/list —— 投喂页「回收区」展开用
    if (p === "/api/ingest/trash/list" && req.method === "GET") {
      let entries = [];
      try { entries = fs.readdirSync(INBOX_TRASH, { withFileTypes: true }); } catch {}
      const rootL = path.resolve(INBOX_TRASH).toLowerCase() + path.sep;
      const todayTs = trashDirDay(localDay());
      const dirs = [];
      for (const e of entries) {
        const full = path.resolve(INBOX_TRASH, e.name);
        if (!full.toLowerCase().startsWith(rootL) || !e.isDirectory()) continue;   // 双保险：只看回收区内的目录
        const files = [];
        let hasReport = false;
        let st = null; try { st = fs.statSync(full); } catch {}
        for (const n of (() => { try { return fs.readdirSync(full); } catch { return []; } })()) {
          if (n === "reconcile-report.md") { hasReport = true; continue; }   // 对账报告是**凭证**不是可恢复的暂存件：只标记，不进清单
          let s2 = null; try { s2 = fs.statSync(path.join(full, n)); } catch {}
          if (!s2 || !s2.isFile()) continue;
          files.push({ name: n, bytes: s2.size, mtimeMs: Math.round(s2.mtimeMs) });
        }
        files.sort((a, b) => a.name.localeCompare(b.name));
        const dayTs = trashDirDay(e.name);
        const ageDays = (dayTs != null && todayTs != null)
          ? Math.floor((todayTs - dayTs) / 86400000)
          : Math.floor((Date.now() - ((st && st.mtimeMs) || Date.now())) / 86400000);
        dirs.push({ date: e.name, files, count: files.length, bytes: files.reduce((s, f) => s + f.bytes, 0),
          ageDays, purgeDefault: ageDays >= TRASH_KEEP_DAYS,
          report: hasReport ? `${e.name}/reconcile-report.md` : null });
      }
      dirs.sort((a, b) => b.date.localeCompare(a.date));
      return json(res, 200, { ok: true, dirs, count: dirs.reduce((s, d) => s + d.count, 0), dirCount: dirs.length, keepDays: TRASH_KEEP_DAYS });
    }

    // 8) 回收区**彻底清理**（⚠️ 全流程**唯一允许真删**的入口，且必须显式调用）：
    //    POST /api/ingest/trash/purge {olderThanDays?:30} —— 只删 `.dsh/inbox/trash/<日期>/` 目录，
    //    年龄按**目录名日期**算（解析不出才退回 mtime）；默认 30 天，`0` = 立即清空回收区。
    if (p === "/api/ingest/trash/purge" && req.method === "POST") {
      const body = await readJsonBody(req, INGEST_BODY_LIMIT);
      let days = TRASH_KEEP_DAYS;
      if (body.olderThanDays !== undefined && body.olderThanDays !== null && body.olderThanDays !== "") {
        days = Number(body.olderThanDays);
        if (!Number.isFinite(days) || days < 0) return fail(res, 400, "bad olderThanDays（需 ≥ 0 的数字）");
      }
      let entries = [];
      try { entries = fs.readdirSync(INBOX_TRASH, { withFileTypes: true }); } catch {}
      const rootL = path.resolve(INBOX_TRASH).toLowerCase() + path.sep;
      const todayTs = trashDirDay(localDay());
      const removed = [], kept = [];
      for (const e of entries) {
        const full = path.resolve(INBOX_TRASH, e.name);
        if (!full.toLowerCase().startsWith(rootL)) continue;              // 双保险：只在回收区内
        if (!e.isDirectory()) { kept.push({ dir: e.name, reason: "不是目录（回收区只收目录）" }); continue; }
        const dayTs = trashDirDay(e.name);
        let ageDays;
        if (dayTs != null && todayTs != null) ageDays = Math.floor((todayTs - dayTs) / 86400000);
        else { let st = null; try { st = fs.statSync(full); } catch {} ageDays = Math.floor((Date.now() - ((st && st.mtimeMs) || Date.now())) / 86400000); }
        if (ageDays < days) { kept.push({ dir: e.name, ageDays, reason: `未超过 ${days} 天` }); continue; }
        let bytes = 0, count = 0;
        for (const n of (() => { try { return fs.readdirSync(full); } catch { return []; } })()) {
          try { const s = fs.statSync(path.join(full, n)); if (s.isFile()) { bytes += s.size; count++; } } catch {}
        }
        try { fs.rmSync(full, { recursive: true, force: true }); }
        catch (err) { kept.push({ dir: e.name, ageDays, reason: "删除失败：" + (err && err.message ? err.message : err) }); continue; }
        removed.push({ dir: e.name, files: count, bytes });
      }
      return json(res, 200, { ok: true, olderThanDays: days, removed,
        removedDirs: removed.length, removedFiles: removed.reduce((s, r) => s + r.files, 0), kept });
    }

    // 9) 回收区恢复：POST /api/ingest/trash/restore {file} —— 只认**回收区内**的相对文件名
    //    （裸 `<名>` 就在各日期目录里从新到旧找；`<日期>/<名>` 指定目录）。
    //    派生图恢复时**把它的原件一起带回来**（反之原件恢复会把名下派生图带回）——
    //    与对账「派生图跟随原件」同一口径，避免刚恢复就又被判定成孤儿。
    if (p === "/api/ingest/trash/restore" && req.method === "POST") {
      const body = await readJsonBody(req, INGEST_BODY_LIMIT);
      const raw = String(body.file || "").trim().replace(/\\/g, "/");
      if (!raw || raw.length > 300 || /[\u0000-\u001f\u007f]/.test(raw)) return fail(res, 400, "bad file（空 / 超长 / 控制字符）");
      if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) return fail(res, 400, "bad file（只接受回收区内的相对文件名）");
      const segs = raw.split("/").filter((s) => s !== "" && s !== ".");
      if (!segs.length || segs.some((s) => s === "..")) return fail(res, 400, "bad file（越界）");
      if (segs.length > 2) return fail(res, 400, "bad file（只接受 <名> 或 <日期>/<名>）");
      const rootL = path.resolve(INBOX_TRASH).toLowerCase() + path.sep;
      let src = null;
      if (segs.length === 2) {
        const cand = path.resolve(INBOX_TRASH, segs[0], segs[1]);
        if (cand.toLowerCase().startsWith(rootL) && fs.existsSync(cand) && fs.statSync(cand).isFile()) src = cand;
      } else {
        let ds = [];
        try { ds = fs.readdirSync(INBOX_TRASH, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name).sort().reverse(); } catch {}
        for (const d of ds) {
          const cand = path.resolve(INBOX_TRASH, d, segs[0]);
          if (cand.toLowerCase().startsWith(rootL) && fs.existsSync(cand) && fs.statSync(cand).isFile()) { src = cand; break; }
        }
      }
      if (!src) return fail(res, 404, "回收区里找不到该文件（GET /api/ingest/trash/list 可看清单）");
      const srcDir = path.dirname(src), name = path.basename(src);
      const back = (f) => {
        const from = path.join(srcDir, f);
        try { if (!fs.statSync(from).isFile()) return null; } catch { return null; }
        fs.mkdirSync(INBOX_FILES, { recursive: true });
        const dest = uniquePath(path.join(INBOX_FILES, f));
        if (!dest) return null;
        try { fs.renameSync(from, dest); } catch { return null; }
        return { file: f, to: toRel(dest) };
      };
      let siblings = [];
      try { siblings = fs.readdirSync(srcDir); } catch {}
      const wanted = [];
      const own = derivedOwnerStem(name);
      if (own) {
        const orig = siblings.find((n) => !DERIVED_IMG_RE.test(n) && stageStem(n) === own);
        if (orig) wanted.push(orig);
      } else {
        const stem = stageStem(name);
        for (const n of siblings) { if (DERIVED_IMG_RE.test(n) && derivedOwnerStem(n) === stem) wanted.push(n); }
      }
      wanted.push(name);
      const restored = [];
      for (const f of wanted) { const r = back(f); if (r) restored.push(r); }
      if (!restored.length) return fail(res, 500, "恢复失败（同名过多或移动被拒）");
      return json(res, 200, { ok: true, restored, from: toRel(srcDir) });
    }

    return fail(res, 404, `no route: ${req.method} ${p}`);
  } catch (e) {
    // 参数/JSON 类错误带 status（=4xx），其余一律 500；绝不让异常逃逸
    return fail(res, Number(e && e.status) || 500, String(e && e.message ? e.message : e));
  }
});

// 端口被占用时优雅退出：开机自启场景下避免与"已有实例/手动实例"互抢导致崩溃循环
server.on("error", (e) => {
  if (e && e.code === "EADDRINUSE") {
    console.log(`[dsh-obsidian-bridge] 端口 ${PORT} 已被占用 → 判定为已有实例在运行，本次启动退出`);
    process.exit(0);
  }
  console.error("[dsh-obsidian-bridge] 致命错误：", e);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[dsh-obsidian-bridge] http://127.0.0.1:${PORT}/  vault=${VAULT}`);
  // 一次性迁移：把旧隐藏归档目录 .dsh/evolution/tasks/archive/ 的 .md 搬到可见归档目录
  // （settings.evolution_log_folder）；幂等，仅启动时跑一次
  try {
    const mg = migrateTaskArchive();
    if (mg.moved || mg.failed || mg.removed) {
      console.log(`[dsh-obsidian-bridge] 进化任务归档迁移：${mg.from} → ${mg.to}，搬走 ${mg.moved} 个` +
        `${mg.failed ? `，失败 ${mg.failed} 个` : ""}${mg.removed ? "，旧目录已删除" : ""}`);
    }
  } catch (e) {
    console.error("[dsh-obsidian-bridge] 进化任务归档迁移失败（不影响服务）：", e && e.message ? e.message : e);
  }
  // 一次性迁移：旧版 distill 收件箱任务 → 进化任务队列（候选卡与任务队列合成**同一个状态机**）；幂等
  try {
    const mg = migrateDistillInboxTasks();
    if (mg.moved || mg.failed) {
      console.log(`[dsh-obsidian-bridge] 技能提炼任务迁移（.dsh/inbox → .dsh/evolution/tasks）：搬走 ${mg.moved} 个` +
        `${mg.failed ? `，留在原处 ${mg.failed} 个` : ""}（原文件归档到 .dsh/inbox/archive/，不删）`);
      for (const f of mg.files) console.log(`[dsh-obsidian-bridge]   ${f.from} → ${f.to}`);
    }
  } catch (e) {
    console.error("[dsh-obsidian-bridge] 技能提炼任务迁移失败（不影响服务，handoffIndex 会读 inbox 兜底）：", e && e.message ? e.message : e);
  }
  // 自动导出：「启动 60s 后首轮 + 之后每 12 小时」（开关关闭时每轮立即空转返回，不扫描）
  startAutoExportTimers();
  console.log(`[dsh-obsidian-bridge] 自动导出定时器已注册（首轮 +${AUTO_EXPORT_FIRST_MS / 1000}s，之后每 ${AUTO_EXPORT_EVERY_MS / 3600000}h；开关：auto_export_sessions）`);
});

// 仅供自检/测试使用：暴露自动导出入口与候选快照（本文件作为脚本运行时不受任何影响）
export { runAutoExport, listExportCandidates, startAutoExportTimers, stopAutoExportTimers, exportSession, AUTO_EXPORT_IDLE_MS, migrateTaskArchive, taskArchiveDir, legacyTaskArchiveDir, migrateDistillInboxTasks };
