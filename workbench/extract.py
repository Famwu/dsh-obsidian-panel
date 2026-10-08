#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""DSH × Obsidian「投喂」统一提取器

把一个文件抽成纯文本（PDF 还会把**内嵌图片**按原始字节抽出来），供知识库入库使用。
由桥接服务调用：
    python extract.py <文件绝对路径> [--out <图片输出目录>] [--no-images] [--raster-png]
stdout 只输出一行 JSON：
    {"ok":true,"kind":"pdf","text":"...","meta":{"title":..,"author":..,"pages":N,"chars":N,"truncated":bool},
     "images":[{"file":..,"page":1,"kind":"jpeg","w":1313,"h":483,"bytes":128874,"likelyWatermark":false}],
     "imagesSkipped":[{"page":1,"kind":"FlateDecode","reason":".."}],
     "watermarkLines":[{"text":"www.xxx.com 下载","pages":[1,2,3],"count":3}],
     "rasterPng":{"enabled":false,"tried":0,"done":0},
     "pageRender":{"available":false,"rendered":[],"reason":".."},
     "suspectScan":[2],"pages":[{"page":1,"chars":812,"images":2,"suspectScan":false}]}
失败时：
    {"ok":false,"error":"..."}

依赖（DSH 自带 Python 已装，无需联网）：python-docx / python-pptx / openpyxl / pypdf
设计原则：
  - 永不抛未捕获异常到 stdout（否则调用方拿不到 JSON）
  - 文本统一截断到 MAX_CHARS，避免把巨表/长 PDF 灌爆上下文
  - 图片类不抽文本（由 DSH 侧多模态看图），只回元信息
  - **零依赖**：不 pip install、不改环境；PDF 内嵌图片默认只做「JPEG / PNG 原字节直出」，
    其余编码（JPEG2000 / CCITT / JBIG2 / FlateDecode 原始光栅 …）一律跳过并在
    imagesSkipped 里逐条列出（页号 + 类型 + 原因），绝不静默丢弃
  - **水印只标记、不擅自删**：文字型水印（跨 ≥3 页重复的短行）从正文剔除但逐条记进
    watermarkLines；图片型水印（每页重复 logo / 印章、面积极小）**照常抽出**，
    images[].likelyWatermark=true 供主代理判断来源/版权
  - **光栅转 PNG 是 opt-in**（`--raster-png`，默认关闭）：开启时才用 Pillow 把能解码的
    FlateDecode/LZW 原始光栅转成 PNG，解不开的仍逐条跳过并写明原因；没有 Pillow 也不崩，
    只报「不可用」并保持其余行为不变
  - 可复现：同一输入重复跑 → 同样的文件名、同样的字节（编号按「页序 → 页内 XObject 顺序」，
    字节完全相同的图只留一份，取它首次出现的页号）
  - **老二进制格式走 LibreOffice 转换**（.doc/.xls/.ppt/.rtf：OLE 复合文档 / RTF，**不是**
    OOXML（zip+XML），本文件自己解不开）：调用 **DSH 自带 LibreOffice 无头模式**先转成
    .docx/.xlsx/.pptx，落在**临时目录**，再走下面的既有抽取路径；**原文件只读、绝不改写**。
    结果里新增 `convertedFrom`（原扩展名）与 `convert:{tool,ms,ok}`；**探测不到 LibreOffice、
    转换失败或转换超时（120s）→ 明确返回 {"ok":false,"error":...}**，绝不静默返回空正文。
"""
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

MAX_CHARS = 200_000

# 扫描页判定阈值：**非空白字符数**低于此值、且该页确有图像对象 → suspectScan。
# 理由：正常文字页的非空白字符数通常是数百到数千；纯扫描件/图片页的文字层只有
# 0～几十个字符（页码、页眉、「第 N 页」之类），撑不起正文。取 32 是明显低于任何
# 正文页、又高于页码噪声的值；再叠加「该页含图像对象」，避免把空白页误报成扫描页。
SUSPECT_SCAN_MAX_CHARS = 32

# 扫描页渲染（可选，仅当环境里有 PyMuPDF 时）：上限与 DPI，避免一次渲染上百页
PAGE_RENDER_MAX = 20
PAGE_RENDER_DPI = 150

TEXT_EXT = {".md", ".markdown", ".txt", ".csv", ".tsv", ".json", ".log", ".yml", ".yaml", ".html", ".htm", ".xml", ".ini", ".cfg"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".tif", ".tiff", ".heic", ".avif"}
AV_EXT = {".mp4", ".webm", ".mov", ".mkv", ".mp3", ".wav", ".m4a", ".flac"}

# ── 老格式（用户实测「DOC 好像识别不了」的根因）───────────────────────────────
# .doc / .xls / .ppt 是 Word 97-2003 / Excel 97-2003 / PowerPoint 97-2003，容器是
# **OLE 复合文档**（magic D0 CF 11 E0 A1 B1 1A E1），与 .docx/.xlsx/.pptx 的
# **OOXML（zip+XML，magic PK）**是两套完全不同的东西 —— python-docx / python-pptx /
# openpyxl 只认 OOXML，对 .doc 必然失败。这里统一交给 DSH 自带 LibreOffice 无头转换。
# 值 = 转换目标扩展名（转换后走下面的既有抽取路径）。
LEGACY_EXT = {".doc": ".docx", ".xls": ".xlsx", ".ppt": ".pptx", ".rtf": ".docx"}

# LibreOffice 无头转换超时（秒）：冷启动实测 ~16s，大文档更久；超时**中止并报明**，不静默
CONVERT_TIMEOUT_S = 120

# OOXML（zip+XML）内嵌图片所在目录：与 PDF 抽图同口径，只按原始字节直出，绝不重编码
OOXML_MEDIA_DIRS = {
    ".docx": "word/media/", ".docm": "word/media/", ".dotx": "word/media/",
    ".pptx": "ppt/media/", ".ppsx": "ppt/media/",
    ".xlsx": "xl/media/", ".xlsm": "xl/media/",
}

JPEG_SOI = b"\xff\xd8\xff"
JPEG_EOI = b"\xff\xd9"
PNG_SIG = b"\x89PNG\r\n\x1a\n"
PNG_IEND = b"IEND"

# 输出扩展名（只允许这两种容器，且**原字节直出**、不重编码）
KIND_EXT = {"jpeg": ".jpg", "png": ".png"}

# ── 水印（只标记 / 只剔正文行，绝不删图）──────────────────────────────────────
# 为什么是 3 页：水印是**自动化**加盖的，正常正文（标题、知识点）不会在两页以上
# 逐字重复；「2 页」太松（跨页续表头、重复小标题会被误切），所以取 3。
# 为什么是 40 字符：水印是页脚/页边的一小段（网址、站点名、机构名）；≥40 字符的行
# 多半是真正文（长句），宁可漏剔也不误切。
WATERMARK_MIN_PAGES = 3
WATERMARK_MAX_CHARS = 40
# 只剔**含水印特征词**的重复短行：网址后缀 / www / 机构内参 / 翻录 / 版权 / 扫码关注。
# 没有特征词的重复短行（如页眉章节名）**一律保留** —— 宁可留水印，不可切正文。
WATERMARK_RE = re.compile(
    r"www\.|https?://|\.(?:com|cn|net|org|top|xyz|cc|vip|io|info|edu|gov|tv)\b"
    r"|下载|转载|转贴|禁转|内部|资料|版权|扫码|关注|订阅|微信|公众号|QQ群|QQ\s*群"
    r"|仅供参考|请勿|外传|侵权|客服|网址|©|\(c\)|（c）|copyright",
    re.IGNORECASE,
)
# 图片型水印：同一图片字节出现在 ≥N 页（与文字水印同口径）
IMG_WATERMARK_MIN_PAGES = 3
# 或：面积小于页面面积的该比例（A4 一页 ≈ 60000 pt²，2% ≈ 1200 pt² ≈ 35×35pt）
IMG_WATERMARK_MAX_AREA_RATIO = 0.02
# 面积判据的兜底下限：小于 16×16 像素的不按「小图标水印」标记。
# 理由：真实库里大量 50×50 的 FlateDecode 渐变色块/图标本身就是**内容**，
# 只靠面积会把它们全标成水印、反过来误导主代理，故给一个下限。
IMG_WATERMARK_MIN_SIDE = 16

# 光栅转 PNG（opt-in，需 Pillow）：PDF /ColorSpace → Pillow 原始模式
RASTER_CS_TO_MODE = {
    "/DeviceGray": "L", "/G": "L", "/CalGray": "L",
    "/DeviceRGB": "RGB", "/RGB": "RGB", "/CalRGB": "RGB",
    "/DeviceCMYK": "CMYK", "/CMYK": "CMYK",
}

# 桥接服务暂存件名形如 <YYYY-MM-DD-HH-mm-ss>__<原名>；抽图时剥掉该前缀 → 用「原文件名」
STAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}__")


def clip(text):
    if text is None:
        return "", False
    if len(text) > MAX_CHARS:
        return text[:MAX_CHARS], True
    return text, False


def read_text_file(path):
    for enc in ("utf-8-sig", "utf-8", "gb18030", "latin-1"):
        try:
            with open(path, "r", encoding=enc, errors="strict") as f:
                return f.read()
        except (UnicodeDecodeError, UnicodeError):
            continue
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


# ──────────────────────────────────────────────────────────────────────────────
# PDF 内嵌图片：原字节直出（只认 JPEG / PNG 容器）
# ──────────────────────────────────────────────────────────────────────────────

def base_stem(path):
    """输入文件 → 用于派生图片文件名的「原文件名（去扩展名）」。
    剥掉桥接服务的 <时间戳>__ 前缀（与 server.mjs 的 idToName 口径一致）；
    截断到 80 字符，给 Windows 长路径留余量。"""
    stem = os.path.splitext(os.path.basename(path))[0]
    stem = STAMP_RE.sub("", stem)
    stem = stem.strip().strip(".") or "file"
    return stem[:80]


def jpeg_size(data):
    """从 JPEG 字节里读尺寸（扫 SOFn 段）。读不到返回 (None, None)，不猜。"""
    n = len(data)
    i = 2
    while i + 3 < n:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0x01, 0xD8) or 0xD0 <= marker <= 0xD7:   # 无长度字段的标记
            i += 2
            continue
        if marker in (0xD9, 0xDA):                             # EOI / SOS：后面没有尺寸段了
            return None, None
        if i + 4 > n:
            return None, None
        seglen = int.from_bytes(data[i + 2:i + 4], "big")
        if seglen < 2:
            return None, None
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):   # SOF0-15
            if i + 9 > n:
                return None, None
            h = int.from_bytes(data[i + 5:i + 7], "big")
            w = int.from_bytes(data[i + 7:i + 9], "big")
            return w, h
        i += 2 + seglen
    return None, None


def png_size(data):
    """从 PNG 字节里读尺寸（IHDR 固定位于 offset 16）。读不到返回 (None, None)。"""
    if len(data) >= 24 and data[:8] == PNG_SIG and data[12:16] == b"IHDR":
        w = int.from_bytes(data[16:20], "big")
        h = int.from_bytes(data[20:24], "big")
        return w, h
    return None, None


def detect_container(data):
    """按**魔数**判断容器：('jpeg'|'png', 是否见到结束标记) 或 (None, False)。"""
    if data.startswith(JPEG_SOI):
        return "jpeg", data.rfind(JPEG_EOI) > 0
    if data.startswith(PNG_SIG):
        return "png", data.rfind(PNG_IEND) > 0
    return None, False


def stream_bytes(obj):
    """取图像流字节，尽量给**原始容器字节**：
    1) 先用 pypdf 的 get_data()（应用 /Filter 后的数据；/DCTDecode 就是原 JPEG 字节）；
    2) 若它不是 JPEG/PNG 容器，再退回**未解码的原始流**（有些 PDF 把 PNG 文件原样塞进流里、
       却声明了别的 /Filter —— 这种只能从原始流里认出来）；
    3) 都认不出就返回 get_data() 结果（交给上层判为「非容器 → 跳过」）。
    返回 (data|None, error|None)。"""
    data = None
    err = None
    try:
        data = bytes(obj.get_data())
    except Exception as e:
        err = e
    if data is not None and detect_container(data)[0] is not None:
        return data, None
    raw = getattr(obj, "_data", None)          # pypdf 私有属性：取不到就走不到这一步
    if isinstance(raw, (bytes, bytearray)):
        raw = bytes(raw)
        if detect_container(raw)[0] is not None:
            return raw, None
    if data is not None:
        return data, None
    return None, err


def filter_kind(obj):
    """把 PDF 里的 /Filter 转成给人看的类型名（用于 imagesSkipped）。"""
    try:
        f = obj.get("/Filter")
    except Exception:
        f = None
    if f is None:
        return "unknown"
    try:
        f = f.get_object() if hasattr(f, "get_object") else f
    except Exception:
        pass
    names = list(f) if isinstance(f, (list, tuple)) else [f]
    out = []
    for n in names:
        s = str(n)
        out.append({
            "/DCTDecode": "DCTDecode(JPEG)",
            "/JPXDecode": "JPXDecode(JPEG2000)",
            "/CCITTFaxDecode": "CCITTFaxDecode(CCITT)",
            "/JBIG2Decode": "JBIG2Decode(JBIG2)",
            "/FlateDecode": "FlateDecode(原始光栅)",
            "/LZWDecode": "LZWDecode(原始光栅)",
            "/RunLengthDecode": "RunLengthDecode(原始光栅)",
            "/ASCII85Decode": "ASCII85Decode",
            "/ASCIIHexDecode": "ASCIIHexDecode",
        }.get(s, s.lstrip("/")))
    return "+".join(out) if out else "unknown"


def _ref_key(ref, name):
    """图像对象的稳定去重键：优先间接引用号（PDF 里同一对象被多页引用时相等）。"""
    idnum = getattr(ref, "idnum", None)
    if idnum is not None:
        return ("ref", idnum, getattr(ref, "generation", 0))
    return ("name", name, id(ref))


def iter_page_images(page):
    """按 PDF 文件顺序产出该页（含嵌套 Form XObject）的图像对象：[(key, name, obj)]。
    顺序稳定 → 抽出的 imgNN 编号可复现。"""
    out = []
    seen = set()

    def walk(res, depth):
        if res is None or depth > 6:
            return
        try:
            xo = res.get_object() if hasattr(res, "get_object") else res
            xo = xo.get("/XObject")
            if xo is None:
                return
            xo = xo.get_object()
            items = list(xo.items())
        except Exception:
            return
        for name, ref in items:
            key = _ref_key(ref, name)
            if key in seen:
                continue
            seen.add(key)
            try:
                obj = ref.get_object() if hasattr(ref, "get_object") else ref
            except Exception:
                continue
            try:
                sub = str(obj.get("/Subtype") or "")
            except Exception:
                sub = ""
            if sub == "/Image":
                out.append((key, name, obj))
            elif sub == "/Form":
                try:
                    walk(obj.get("/Resources"), depth + 1)
                except Exception:
                    pass

    try:
        walk(page.get("/Resources"), 0)
    except Exception:
        pass
    return out


# ──────────────────────────────────────────────────────────────────────────────
# PDF 文字型水印：跨页重复短行 → 剔出正文，但**逐条记进 watermarkLines**（不静默丢）
# ──────────────────────────────────────────────────────────────────────────────

def watermark_key(line):
    """水印比对键：去掉行首编号/项目符号与空白 → 同一水印在不同页的细微差异不影响归并。"""
    s = re.sub(r"^\s*(?:[-*·•●○◆■□▪◦]|\(?\d{1,3}\)?[.、)）])\s*", "", line)
    s = re.sub(r"[ \t\u3000]+", " ", s).strip()
    return s


def watermark_hit(text):
    """这一行是否带水印特征（网址 / 内参 / 翻录 / 版权 / 扫码关注…）。"""
    return bool(WATERMARK_RE.search(text))


def detect_watermark_lines(page_texts):
    """扫全部页的**行**，找出跨页重复的水印行。
    判据（与常量注释一致）：同一行（去空白后完全相同）出现在 ≥3 个**不同页**
    + 长度 ≤40 字符 + 含水印特征词。
    返回 {归一化文本: 原文}：原文取出现页数最高的一条。"""
    stat = {}          # key → {"texts": {原文: 计数}, "pages": set()}
    for pno, t in page_texts:
        seen_here = set()
        for raw in t.split("\n"):
            s = raw.strip()
            if not s:
                continue
            k = watermark_key(s)
            if not k or k in seen_here:          # 同一页重复出现只算一次（按页计数）
                continue
            seen_here.add(k)
            e = stat.setdefault(k, {"texts": {}, "pages": set()})
            e["texts"][s] = e["texts"].get(s, 0) + 1
            e["pages"].add(pno)
    out = {}
    for k, e in stat.items():
        if len(k) > WATERMARK_MAX_CHARS or len(e["pages"]) < WATERMARK_MIN_PAGES:
            continue
        if not watermark_hit(k):
            continue
        out[k] = sorted(e["texts"].items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
    return out


def strip_watermark_lines(text, hits):
    """把命中水印的行从**正文**里剔掉：水印行整行删除，不留空行。
    理由：pypdf 的 extract_text 会在行尾自带换行，若只清空文字会**多出一行空行**，
    正文结构就变了；整行删除后正文的换行结构与改动前一致（其余行逐行未变）。"""
    if not hits or not text:
        return text
    kept = []
    for raw in text.split("\n"):
        if raw.strip() and watermark_key(raw.strip()) in hits:
            continue
        kept.append(raw)
    return "\n".join(kept)


def watermark_line_records(page_texts, hits):
    """→ [{text, pages:[...], count}]；count = 出现的**页数**，按页数/文本稳定排序。"""
    recs = []
    for k, src in hits.items():
        pgs = sorted(pno for pno, t in page_texts
                     if any(watermark_key(r.strip()) == k for r in t.split("\n") if r.strip()))
        if pgs:
            recs.append({"text": src, "pages": pgs, "count": len(pgs)})
    recs.sort(key=lambda r: (-r["count"], r["text"]))
    return recs


def strip_watermarks(page_texts, hits):
    """正文整体剔水印：返回与 page_texts 等长的 [(pno, text)]。"""
    if not hits:
        return page_texts
    return [(pno, strip_watermark_lines(t, hits)) for pno, t in page_texts]


# ──────────────────────────────────────────────────────────────────────────────
# 可选：FlateDecode 等「原始光栅」→ PNG（opt-in，需 Pillow；默认关闭）
# ──────────────────────────────────────────────────────────────────────────────

def pillow_status():
    """(PIL.Image | None, 原因)。**没有 Pillow 也绝不装**，只说明并跳过。"""
    try:
        from PIL import Image
    except Exception as e:
        return None, ("未安装 Pillow，--raster-png 光栅转 PNG 不可用"
                      "（零依赖原则，不自动 pip install；其余抽出照常）：%s: %s" % (type(e).__name__, e))
    return Image, None


def obj_cs_bpc(obj):
    """读 PDF 图像字典的 /ColorSpace 与 /BitsPerComponent，转成 (Pillow 模式, 位深, 调色板)。"""
    try:
        cs = obj.get("/ColorSpace")
        cs = cs.get_object() if hasattr(cs, "get_object") else cs
    except Exception:
        cs = None
    if isinstance(cs, (list, tuple)) and cs:
        head = str(cs[0])
        if head == "/Indexed" or head == "/I":
            try:
                base = cs[1]
                base = base.get_object() if hasattr(base, "get_object") else base
                lut = cs[3]
                lut = lut.get_object() if hasattr(lut, "get_object") else lut
                return "P", 8, bytes(lut)
            except Exception:
                return None, None, None
        return None, None, None                    # ICCBased / DeviceN… 不猜
    if cs is None:
        return None, None, None
    mode = RASTER_CS_TO_MODE.get(str(cs))
    if mode is None:
        return None, None, None
    try:
        bpc = obj.get("/BitsPerComponent")
        bpc = int(bpc) if bpc is not None else 8
    except Exception:
        bpc = 8
    if str(cs) in ("/DeviceGray", "/G", "/CalGray"):
        if bpc == 1:
            return "1", 1, None
        if bpc == 2:
            return "L;2", 2, None
        if bpc == 4:
            return "L;4", 4, None
        if bpc == 16:
            return "I;16B", 16, None
    if str(cs) in ("/DeviceRGB", "/RGB", "/CalRGB") and bpc == 16:
        return None, None, None                    # 16 位 RGB 不猜
    if mode == "CMYK":
        return "CMYK", bpc, None
    return mode, bpc, None


def raster_to_png(obj, data):
    """FlateDecode 等原始光栅 → PNG 字节（Pillow 解码）。失败返回 (None, 原因)。
    **不渲染、只解码**：按 /ColorSpace + /BitsPerComponent 解释字节，不猜尺寸。"""
    Image, why = pillow_status()
    if Image is None:
        return None, why
    try:
        w = int(obj.get("/Width"))
        h = int(obj.get("/Height"))
    except Exception:
        return None, "缺少 /Width /Height，无法解析原始光栅 → 跳过"
    mode, bpc, palette = obj_cs_bpc(obj)
    if mode is None or bpc is None:
        return None, "ColorSpace 不是 DeviceGray/DeviceRGB/DeviceCMYK/Indexed（或不支持该位深）→ 跳过"
    try:
        if mode == "P":
            expect = w * h                       # /Indexed：每像素 1 字节（8 位）
        elif mode == "1":
            expect = ((w + 7) // 8) * h          # 1 位/像素，每行按字节对齐
        elif ";" in mode:                        # L;2 / L;4：低位深灰度，每行按字节对齐
            b = int(mode.partition(";")[2])
            expect = ((w * b + 7) // 8) * h
        elif mode == "I;16B":
            expect = w * h * 2
        elif mode == "CMYK":
            expect = w * h * 4
        elif mode == "RGB":
            expect = w * h * 3
        elif mode == "L":
            expect = w * h
        else:
            expect = 0
    except Exception:
        return None, "尺寸/位深异常（%s×%s bpc=%s）→ 跳过" % (w, h, bpc)
    if expect <= 0:
        return None, "无法确定原始光栅字节数（mode=%s bpc=%s）→ 跳过" % (mode, bpc)
    if len(data) != expect:
        return None, ("原始光栅字节数不符（%d 字节 ≠ 期望 %d；可能有 Predictor/每行填充）→ 跳过"
                      % (len(data), expect))
    try:
        if mode == "1":
            im = Image.frombytes("1", (w, h), data, "raw", "1;8")
        elif mode == "I;16B":
            im = Image.frombytes("I;16B", (w, h), data, "raw", "I;16B")
        elif ";" in mode:                        # L;2 / L;4：Pillow 的 raw 解码器模式串同形
            base, _, b = mode.partition(";")
            im = Image.frombytes("L", (w, h), data, "raw", "%s;%s" % (base, b))
        else:
            im = Image.frombytes(mode, (w, h), data)
    except Exception as e:
        return None, "Pillow 解码失败：%s: %s → 跳过" % (type(e).__name__, e)
    if mode == "P" and palette:
        try:
            im.putpalette(palette)
        except Exception:
            pass
    if im.mode in ("CMYK", "I;16B", "P", "1"):
        try:
            im = im.convert("RGB")
        except Exception:
            pass
    buf = io.BytesIO()
    try:
        im.save(buf, format="PNG")
    except Exception as e:
        return None, "PNG 编码失败：%s: %s → 跳过" % (type(e).__name__, e)
    return buf.getvalue(), None


def write_bytes(path, data):
    """原子落盘；内容完全相同时不重写（保持 mtime，便于肉眼确认「可复现」）。"""
    try:
        with open(path, "rb") as f:
            if f.read() == data:
                return "unchanged"
    except Exception:
        pass
    tmp = path + ".part"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    return "written"


# ──────────────────────────────────────────────────────────────────────────────
# OOXML（docx/pptx/xlsx）内嵌图片：原字节直出（与 PDF 抽图同口径，只认 JPEG / PNG）
# ──────────────────────────────────────────────────────────────────────────────

OOXML_MEDIA_MAX_BYTES = 16 * 1024 * 1024   # 单张图上限：超过只记 imagesSkipped，不落盘
OOXML_MEDIA_MAX_MEDIA = 200                # 单包最多处理多少张 media（防巨包卡死）
OOXML_REFS_BUDGET = 40 * 1024 * 1024       # 水印判据扫描 XML/rels 的总字节预算（防巨包卡死）


class ExtractError(Exception):
    """**必须原样回报给用户**的提取失败（如「未找到 LibreOffice，无法转换 .doc」）。
    与「可降级异常」区分：某张图解不开、某页渲染不了属于后者，只记一条 imagesSkipped，
    绝不影响正文抽取（既有口径）。"""


def extract_ooxml_media(path, outdir, stem=None, want_images=True):
    """OOXML（zip+XML：docx/pptx/xlsx）内嵌图片 → **原始字节**直出到 outdir。
    返回 (images, imagesSkipped)，元素形状**与 PDF 抽图一致**
    （file/page/kind/w/h/bytes/likelyWatermark），另加 part（包内部件名）与 source="ooxml"。
    口径：不解码、不重编码；同字节只留一份；水印/装饰**只标记不丢弃**。"""
    import zipfile
    ext = os.path.splitext(path)[1].lower()
    prefix = OOXML_MEDIA_DIRS.get(ext)
    if prefix is None:
        return [], []
    if stem is None:
        stem = base_stem(path)
    images, skipped = [], []
    try:
        zf = zipfile.ZipFile(path)
    except Exception as e:
        return [], [{"page": None, "part": None, "kind": "unknown",
                     "reason": "不是有效的 OOXML 包（zip 打不开）：%s: %s" % (type(e).__name__, e)}]
    with zf:
        try:
            names = zf.namelist()
        except Exception as e:
            return [], [{"page": None, "part": None, "kind": "unknown", "reason": "包内清单读取失败：%s" % e}]
        media = [n for n in names if n.startswith(prefix) and not n.endswith("/")][:OOXML_MEDIA_MAX_MEDIA]
        if not media:
            return [], []
        if not want_images:
            return [], []
        # 水印判据一：同一 media 文件基名在包内 XML/rels 里被引用几次（docx 无「页」概念）
        basenames = sorted({n.rsplit("/", 1)[-1] for n in media if n.rsplit("/", 1)[-1]})
        refs = dict((b, 0) for b in basenames)
        budget = OOXML_REFS_BUDGET
        for n in names:
            if not (n.endswith(".xml") or n.endswith(".rels")):
                continue
            try:
                info = zf.getinfo(n)
            except Exception:
                continue
            if info.file_size > OOXML_REFS_BUDGET or info.file_size > budget:
                continue
            budget -= info.file_size
            try:
                txt = zf.read(n).decode("utf-8", "ignore")
            except Exception:
                continue
            for b in basenames:
                refs[b] += txt.count(b)
        a4_px = 794 * 1123                     # A4 @96dpi：OOXML 里没有「页对象」，用等效面积

        def mark(name, w, h):
            """与 PDF 同口径的「疑似水印 / 装饰图」标记：**只标记、绝不丢弃**。"""
            if refs.get(name.rsplit("/", 1)[-1], 0) >= IMG_WATERMARK_MIN_PAGES:
                return True
            return bool(w and h and w >= IMG_WATERMARK_MIN_SIDE and h >= IMG_WATERMARK_MIN_SIDE
                        and (w * h) < a4_px * IMG_WATERMARK_MAX_AREA_RATIO)

        try:
            os.makedirs(outdir, exist_ok=True)
        except Exception as e:
            return [], [{"page": None, "part": None, "kind": "unknown",
                         "reason": "输出目录创建失败：%s（%s）" % (e, outdir)}]
        by_hash = {}
        counter = 0
        for name in media:
            try:
                info = zf.getinfo(name)
            except Exception:
                continue
            if info.file_size > OOXML_MEDIA_MAX_BYTES:
                skipped.append({"page": None, "part": name, "kind": "unknown",
                                "reason": "单张图超过 %dMB → 跳过" % (OOXML_MEDIA_MAX_BYTES // 1048576)})
                continue
            try:
                data = zf.read(name)
            except Exception as e:
                skipped.append({"page": None, "part": name, "kind": "unknown",
                                "reason": "包内部件读取失败：%s: %s" % (type(e).__name__, e)})
                continue
            kind, complete = detect_container(data)
            if kind is None:
                # 与 PDF 默认分支**同一句话口径**：老 .doc 里的 EMF/WMF 元文件会走到这里
                skipped.append({"page": None, "part": name, "kind": (os.path.splitext(name)[1].lstrip(".") or "unknown"),
                                "reason": "不是 JPEG/PNG 容器（%s）→ 按零依赖原则不重编码，跳过"
                                          % (os.path.splitext(name)[1].lstrip(".") or "unknown")})
                continue
            w, h = (jpeg_size(data) if kind == "jpeg" else png_size(data))
            digest = hashlib.md5(data).hexdigest()
            if digest in by_hash:              # 字节完全相同的图只留一份（同 PDF 口径）
                continue
            counter += 1
            fn = "%s__img%02d%s" % (stem, counter, KIND_EXT[kind])
            full = os.path.join(outdir, fn)
            try:
                write_bytes(full, data)
            except Exception as e:
                counter -= 1
                skipped.append({"page": None, "part": name, "kind": kind,
                                "reason": "落盘失败：%s: %s" % (type(e).__name__, e)})
                continue
            by_hash[digest] = full
            if not complete:
                skipped.append({"page": None, "part": name, "kind": kind,
                                "reason": "已抽出但未见到结束标记（JPEG 缺 FFD9 / PNG 缺 IEND），源流可能不完整"})
            images.append({"file": full, "page": None, "kind": kind, "w": w, "h": h, "bytes": len(data),
                           "source": "ooxml", "part": name, "likelyWatermark": mark(name, w, h)})
    return images, skipped


def ooxml_extra(path, outdir=None, want_images=True, stem=None):
    """OOXML 的 images / imagesSkipped —— **纯新增字段**。
    任何异常都降级成一条 imagesSkipped，绝不影响正文抽取（与 PDF 抽图同口径）。"""
    if not want_images:
        return {"images": [], "imagesSkipped": []}
    if outdir is None:
        outdir = os.path.dirname(os.path.abspath(path))
    try:
        images, skipped = extract_ooxml_media(path, outdir, stem=stem)
    except Exception as e:
        return {"images": [], "imagesSkipped": [{"page": None, "part": None, "kind": "unknown",
                                                 "reason": "OOXML 内嵌图片抽取失败：%s: %s" % (type(e).__name__, e)}]}
    return {"images": images, "imagesSkipped": skipped}


# ──────────────────────────────────────────────────────────────────────────────
# 老格式（.doc/.xls/.ppt/.rtf）→ LibreOffice 无头转换：只探测、只读原文件、只写临时目录
# ──────────────────────────────────────────────────────────────────────────────

# 环境变量：**一旦设置就以它为准、不再回退探测**（便于稳定复现「找不到 → 明确报错」）
LO_ENV_KEYS = ("DSH_OBSIDIAN_SOFFICE", "DSH_SOFFICE")
NODE_ENV_KEYS = ("DSH_OBSIDIAN_NODE", "DSH_NODE")
# 本机实测：DSH 只自带 libreoffice-kit（原生后端 libreoffice-kit.exe + kit cli.js），
# **没有**独立的 soffice.exe；所以 soffice 探测不到时回退到 kit（仍由 LibreOffice 引擎干活）。
# 下面三条都是**相对**路径：从本进程的 Python 解释器位置逐级上溯去找 DSH 安装根，
# 因此本文件里**不写死任何盘符路径**（发布树的隐私扫描口径）。
KIT_CLI_REL = os.path.join("node_modules", "@deepseek-ai", "libreoffice-kit", "lib", "cli.js")
NODE_REL = os.path.join("node", "bin", "node.exe")
SOFFICE_REL = os.path.join("LibreOffice", "program", "soffice.exe")


def _ancestors(start, depth=8):
    """start 目录 + 它的各级父目录（最多 depth 级）。"""
    out, d = [], os.path.abspath(start)
    for _ in range(depth):
        out.append(d)
        nd = os.path.dirname(d)
        if nd == d:
            break
        d = nd
    return out


def _kit_cli_candidates():
    """DSH 自带 libreoffice-kit 的 cli.js：从 sys.executable（DSH 自带 Python）上溯推断安装根。
    形如 <DSH>/resources/runtime/primary-runtime/dependencies/python/python.exe →
    <DSH>/resources/app.asar.unpacked/dsh/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js。"""
    try:
        start = os.path.dirname(os.path.abspath(sys.executable))
    except Exception:
        return []
    out = []
    for d in _ancestors(start):
        out.append(os.path.join(d, "app.asar.unpacked", "dsh", KIT_CLI_REL))
        out.append(os.path.join(d, "dsh", KIT_CLI_REL))
        out.append(os.path.join(d, KIT_CLI_REL))
    return out


def _node_candidates():
    """DSH 自带 node.exe：同样是**相对**上溯（<DSH>/.../dependencies/node/bin/node.exe）。"""
    try:
        start = os.path.dirname(os.path.abspath(sys.executable))
    except Exception:
        return []
    out = []
    for d in _ancestors(start, 6):
        out.append(os.path.join(d, NODE_REL))
        out.append(os.path.join(d, "node.exe"))
    return out


def _soffice_candidates():
    """系统安装的 LibreOffice：只用环境变量拼路径（不写死盘符）。"""
    out = []
    for k in ("ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"):
        base = os.environ.get(k)
        if base:
            out.append(os.path.join(base, SOFFICE_REL))
    la = os.environ.get("LOCALAPPDATA")
    if la:
        out.append(os.path.join(la, "Programs", SOFFICE_REL))
    # DSH 自带里若真有独立 soffice.exe（本机没有，留着向前兼容）
    out.extend(os.path.join(d, "app.asar.unpacked", "dsh", "node_modules", "@deepseek-ai",
                            "libreoffice-kit-win32-x64", "program", "program", "soffice.exe")
               for d in _ancestors(os.path.dirname(os.path.abspath(sys.executable))))
    return out


def find_libreoffice():
    """探测 LibreOffice。返回 (conv|None, why)：conv = {"kind":"soffice","exe":..}
    或 {"kind":"kit","cli":..,"node":..}；探测不到时 conv=None，why 是人类可读原因。"""
    env_lo = ""
    for k in LO_ENV_KEYS:
        if os.environ.get(k, "").strip():
            env_lo = os.environ[k].strip()
            break
    node = ""
    for k in NODE_ENV_KEYS:
        if os.environ.get(k, "").strip():
            node = os.environ[k].strip()
            break
    if not node:
        for c in _node_candidates():          # 先认 DSH 自带 node（确定性强），再退回 PATH
            if os.path.isfile(c):
                node = c
                break
    if not node:
        node = shutil.which("node") or shutil.which("node.exe") or ""
    if env_lo:
        if not os.path.isfile(env_lo):
            return None, "环境变量指定的 LibreOffice 路径不存在：%s" % env_lo
        if env_lo.lower().endswith(".js"):
            if node and os.path.isfile(node):
                return {"kind": "kit", "cli": env_lo, "node": node}, ""
            return None, "环境变量指定的 LibreOffice Kit（%s）需要 Node，但没找到 node" % env_lo
        return {"kind": "soffice", "exe": env_lo}, ""
    exe = shutil.which("soffice") or shutil.which("soffice.exe") or ""
    if not exe:
        for c in _soffice_candidates():
            if os.path.isfile(c):
                exe = c
                break
    if exe:
        return {"kind": "soffice", "exe": exe}, ""
    for c in _kit_cli_candidates():
        if os.path.isfile(c) and node and os.path.isfile(node):
            return {"kind": "kit", "cli": c, "node": node}, ""
    return None, ("未找到 soffice(.exe)，也没找到 DSH 自带 LibreOffice Kit"
                  "（已试 %s；可用环境变量 DSH_OBSIDIAN_SOFFICE 显式指定）"
                  % (os.path.join("...", "app.asar.unpacked", "dsh", KIT_CLI_REL)))


def convert_to_ooxml(src, dst, target_ext):
    """LibreOffice **无头模式**把 src 转成 dst（dst 在临时目录里）。返回 (tool, ms)。
    失败 / 超时 / 产物不是 OOXML → 抛 ExtractError（**绝不把转换失败当成空文档**）。"""
    conv, why = find_libreoffice()
    if conv is None:
        raise ExtractError("未找到 LibreOffice，无法转换 %s（%s）"
                           % (os.path.splitext(src)[1].lower(), why))
    src_abs, dst_abs = os.path.abspath(src), os.path.abspath(dst)
    if conv["kind"] == "kit":
        argv = [conv["node"], conv["cli"], "convert", "--input", src_abs, "--output", dst_abs]
        tool = "libreoffice-kit"
    else:
        argv = [conv["exe"], "--headless", "--norestore", "--nolockcheck", "--nodefault", "--nologo",
                "--convert-to", target_ext.lstrip("."), "--outdir", os.path.dirname(dst_abs), src_abs]
        tool = "soffice"
    t0 = time.time()
    try:
        p = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=CONVERT_TIMEOUT_S,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired:
        raise ExtractError("LibreOffice 转换超时（%ds）：%s" % (CONVERT_TIMEOUT_S, os.path.basename(src)))
    except Exception as e:
        raise ExtractError("LibreOffice 转换无法启动（%s：%s）" % (type(e).__name__, e))
    ms = int((time.time() - t0) * 1000)
    if not os.path.isfile(dst_abs) or os.path.getsize(dst_abs) <= 0:
        out = p.stdout.decode("utf-8", "replace").strip()
        err = p.stderr.decode("utf-8", "replace").strip()
        detail = err or out or ("退出码 %s" % p.returncode)
        raise ExtractError("LibreOffice 转换失败（%s）：%s" % (os.path.basename(src), detail[-500:]))
    try:
        with open(dst_abs, "rb") as f:
            head = f.read(4)
    except Exception as e:
        raise ExtractError("LibreOffice 转换产物读不到（%s：%s）" % (type(e).__name__, e))
    if not head.startswith(b"PK"):
        raise ExtractError("LibreOffice 转换产物不是 OOXML（字节头 %r 不是 PK）：%s"
                           % (head, os.path.basename(dst_abs)))
    return tool, ms


def extract_legacy(path, ext, outdir, want_images=True):
    """老格式（.doc/.xls/.ppt/.rtf）→ 临时目录里转 OOXML → **走既有抽取路径**。
    返回 (kind, text, meta, extra)。原文件**只读**（先复制进临时目录再交给 LibreOffice，
    LibreOffice 永远看不到、更写不到用户的文件）；临时目录结束后删除。
    找不到 LibreOffice / 转换失败 / 超时 → 抛 ExtractError（由 main 转成 {"ok":false,...}）。"""
    target_ext = LEGACY_EXT[ext]
    if outdir is None:
        outdir = os.path.dirname(os.path.abspath(path))
    stem = base_stem(path)
    tmpdir = tempfile.mkdtemp(prefix="dsh-lo-conv-")
    try:
        local_src = os.path.join(tmpdir, "in" + ext)
        dst = os.path.join(tmpdir, "in" + target_ext)
        try:
            shutil.copyfile(path, local_src)
        except Exception as e:
            raise ExtractError("转换前复制原文件失败（%s：%s）" % (type(e).__name__, e))
        tool, ms = convert_to_ooxml(local_src, dst, target_ext)
        if target_ext == ".docx":
            kind, text, meta = extract_docx(dst)
        elif target_ext == ".pptx":
            kind, text, meta = extract_pptx(dst)
        else:
            kind, text, meta = extract_xlsx(dst)
        extra = ooxml_extra(dst, outdir, want_images, stem=stem)
        extra["convertedFrom"] = ext.lstrip(".")
        extra["convert"] = {"tool": tool, "ms": ms, "ok": True}
        return kind, text, dict(meta or {}), extra
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def render_scan_pages(path, outdir, stem, pages):
    """可选：用 PyMuPDF(fitz) 把疑似扫描页渲染成 PNG。**没有 fitz 就跳过，绝不安装。**"""
    res = {"available": False, "rendered": []}
    try:
        import fitz   # PyMuPDF：只在环境里已有时才用
    except Exception as e:
        res["reason"] = ("未安装 PyMuPDF(fitz)，跳过扫描页渲染（零依赖原则，不自动 pip install）；"
                         "图片仍已按原字节抽出。%s: %s" % (type(e).__name__, e))
        return res
    res["available"] = True
    note = []
    try:
        doc = fitz.open(path)
    except Exception as e:
        res["reason"] = "PyMuPDF 打开失败：%s: %s" % (type(e).__name__, e)
        return res
    try:
        todo = list(pages)[:PAGE_RENDER_MAX]
        if len(pages) > PAGE_RENDER_MAX:
            note.append("疑似扫描页共 %d 页，只渲染前 %d 页" % (len(pages), PAGE_RENDER_MAX))
        for pno in todo:
            try:
                pg = doc.load_page(pno - 1)
                pix = pg.get_pixmap(dpi=PAGE_RENDER_DPI)
                try:
                    png = pix.tobytes("png")
                except Exception:            # 老版本 PyMuPDF 只有 getPNGData()
                    png = pix.getPNGData()
                fn = "%s__page %02d.png" % (stem, pno)
                full = os.path.join(outdir, fn)
                write_bytes(full, png)
                res["rendered"].append({"file": full, "page": pno})
            except Exception as e:
                note.append("第 %d 页渲染失败：%s" % (pno, e))
    finally:
        try:
            doc.close()
        except Exception:
            pass
    if note:
        res["reason"] = "；".join(note)
    return res


def extract_pdf_images(path, outdir, want_images=True, want_raster=False):
    """扫 PDF 里的图像流 → JPEG/PNG 原字节直出到 outdir。
    返回 (images, imagesSkipped, pages_info, rasterStat)。任何内部异常都降级成
    imagesSkipped 的一条记录，绝不影响文字抽取。
    want_raster=True（--raster-png，opt-in）时，额外用 Pillow 尝试把
    FlateDecode/LZW 等**原始光栅**解码成 PNG（`<原名>__rasterNN.png`）；
    解不开的仍然逐条跳过并写明原因。默认 False → 行为与改动前完全一致。"""
    from pypdf import PdfReader
    reader = PdfReader(path)
    stem = base_stem(path)
    images, skipped, pages_info = [], [], []
    used = {}          # 对象键 → 已落地文件（同一图像对象被多页引用时只抽一次）
    by_hash = {}       # 字节 MD5 → 已落地文件（同一张图在多页各存一份对象时只留一份）
    counter = [0]
    try:
        os.makedirs(outdir, exist_ok=True)
    except Exception as e:
        return images, [{"page": None, "kind": "unknown", "reason": "输出目录创建失败：%s（%s）" % (e, outdir)}], [], {"tried": 0, "done": 0}

    npages = len(reader.pages)
    appear = {}        # 对象键 → 引用它的**不同页数**（图片型水印判据一）
    appear_file = {}   # 落地文件 → 该文件被引用到的最多页数（同一文件可能由多个键去重而来）
    page_area = None   # 当前页面积(pt²)，用于「小图标/小印章」判据
    raster_stat = {"tried": 0, "done": 0}
    raster_why = None  # --raster-png 开不了的整体原因（如 Pillow 缺失），只报一次

    def mark(path_full, w, h):
        """给刚落地的图算图片型水印标记：同一图字节出现在 ≥3 页，或图很小（<页面 2%）时标记。
        **只标记、绝不丢弃** —— 水印往往正是版权/来源线索。"""
        return bool(
            (npages >= IMG_WATERMARK_MIN_PAGES
             and appear_file.get(path_full, 0) >= IMG_WATERMARK_MIN_PAGES)
            or (page_area and w and h and w >= IMG_WATERMARK_MIN_SIDE and h >= IMG_WATERMARK_MIN_SIDE
                and (w * h) < page_area * IMG_WATERMARK_MAX_AREA_RATIO)
        )

    for pno, page in enumerate(reader.pages, 1):
        try:
            mb = page.mediabox
            page_area = abs((mb.width or 0) * (mb.height or 0))
        except Exception:
            page_area = None
        try:
            objs = iter_page_images(page)
        except Exception as e:
            objs = []
            skipped.append({"page": pno, "kind": "unknown", "reason": "页图像资源解析失败：%s: %s" % (type(e).__name__, e)})
        for key, name, obj in objs:                         # 先记「被哪些页引用」（水印判据要全量页）
            appear[key] = appear.get(key, 0) + 1
        for key, name, obj in objs:
            if key in used:
                continue                                    # 已有同一对象 → 复用同一文件，不重复落盘
            if not want_images:
                used[key] = None
                continue
            fkind = filter_kind(obj)
            try:
                data, derr = stream_bytes(obj)
            except Exception as e:
                data, derr = None, e
            if data is None:
                skipped.append({"page": pno, "kind": fkind, "reason": "图像流解码失败（%s: %s）→ 跳过" % (type(derr).__name__, derr)})
                continue
            kind, complete = detect_container(data)
            if kind is None:
                # opt-in：能解码的原始光栅 → PNG；解不开的照样跳过并写明原因
                if want_raster and data:
                    raster_stat["tried"] += 1
                    Image, why = pillow_status()
                    if Image is None:
                        raster_why = why
                    elif raster_why is None:
                        png, perr = raster_to_png(obj, data)
                        if png is None:
                            skipped.append({"page": pno, "kind": fkind,
                                            "reason": "光栅解码失败：%s（--raster-png 已开启）" % perr})
                        else:
                            digest = hashlib.md5(png).hexdigest()
                            if digest in by_hash:
                                used[key] = by_hash[digest]
                                continue
                            counter[0] += 1
                            fn = "%s__raster%02d.png" % (stem, counter[0])
                            full = os.path.join(outdir, fn)
                            try:
                                write_bytes(full, png)
                            except Exception as e:
                                counter[0] -= 1
                                skipped.append({"page": pno, "kind": fkind,
                                                "reason": "落盘失败：%s: %s" % (type(e).__name__, e)})
                                continue
                            used[key] = full
                            by_hash[digest] = full
                            raster_stat["done"] += 1
                            w, h = png_size(png)
                            if w is None or h is None:
                                try:
                                    w = int(obj.get("/Width")) if obj.get("/Width") is not None else None
                                    h = int(obj.get("/Height")) if obj.get("/Height") is not None else None
                                except Exception:
                                    w, h = None, None
                            appear_file[full] = max(appear_file.get(full, 0), appear.get(key, 0))
                            images.append({"file": full, "page": pno, "kind": "png", "w": w, "h": h,
                                           "bytes": len(png), "source": "raster",
                                           "likelyWatermark": mark(full, w, h)})
                            continue
                if not want_raster:
                    # 默认分支的 reason 与改动前**逐字节一致**（调用方/回归对照依赖它）
                    skipped.append({"page": pno, "kind": fkind,
                                    "reason": "不是 JPEG/PNG 容器（%s）→ 按零依赖原则不重编码，跳过" % fkind})
                elif raster_why:
                    skipped.append({"page": pno, "kind": fkind, "reason": "光栅转 PNG 不可用：%s" % raster_why})
                else:
                    skipped.append({"page": pno, "kind": fkind,
                                    "reason": "光栅解码失败：不支持的颜色空间或字节数不符（--raster-png 已开启）"})
                continue
            w, h = (jpeg_size(data) if kind == "jpeg" else png_size(data))
            if w is None or h is None:                      # 字节里读不到 → 退回 PDF 字典里的声明值
                try:
                    w = int(obj.get("/Width")) if obj.get("/Width") is not None else None
                    h = int(obj.get("/Height")) if obj.get("/Height") is not None else None
                except Exception:
                    w, h = None, None
            digest = hashlib.md5(data).hexdigest()
            if digest in by_hash:                           # 同一张图（字节完全相同）只留一份，不重复编号
                used[key] = by_hash[digest]
                appear_file[used[key]] = max(appear_file.get(used[key], 0), appear.get(key, 0))
                continue
            counter[0] += 1
            fn = "%s__img%02d%s" % (stem, counter[0], KIND_EXT[kind])
            full = os.path.join(outdir, fn)
            try:
                write_bytes(full, data)
            except Exception as e:
                counter[0] -= 1
                skipped.append({"page": pno, "kind": fkind, "reason": "落盘失败：%s: %s" % (type(e).__name__, e)})
                continue
            used[key] = full
            by_hash[digest] = full
            if not complete:
                skipped.append({"page": pno, "kind": fkind, "reason": "已抽出但未见到结束标记（JPEG 缺 FFD9 / PNG 缺 IEND），源流可能不完整"})
            appear_file[full] = appear.get(key, 0)
            images.append({"file": full, "page": pno, "kind": kind, "w": w, "h": h, "bytes": len(data),
                           "likelyWatermark": mark(full, w, h)})
        pages_info.append({"page": pno, "images": len(objs)})

    return images, skipped, pages_info, raster_stat


def extract_docx(path):
    from docx import Document
    doc = Document(path)
    parts = []
    for p in doc.paragraphs:
        t = (p.text or "").strip()
        if t:
            style = (p.style.name or "") if p.style is not None else ""
            prefix = "# " if style.lower().startswith("heading 1") else ("## " if style.lower().startswith("heading") else "")
            parts.append(prefix + t)
    for ti, table in enumerate(doc.tables):
        parts.append("\n[表格 %d]" % (ti + 1))
        for row in table.rows:
            cells = [((c.text or "").strip().replace("\n", " ")) for c in row.cells]
            parts.append(" | ".join(cells))
    cp = doc.core_properties
    meta = {"title": cp.title or "", "author": cp.author or "", "created": str(cp.created or "")}
    return "docx", "\n".join(parts), meta


def extract_pptx(path):
    """PPTX 文字抽取。**ppt / pptx 是两条不同的路**（用户实测「ppt 识别不了」就是这里）：

      · `.pptx`（OOXML，zip+XML）→ **本函数**：python-pptx 遍历 `slide.shapes`，
        **递归进组合形状（GROUP）**，另抽表格、**图表文字**（标题 / 分类名 / 系列名）与备注。
        坑（修的就是这个）：`slide.shapes` **不会递归进组合形状** —— 真实 PPT 大量正文
        放在 group 里，只遍历顶层会得到一份几乎空的笔记（用户看到的就是「识别不了」✗）。
      · `.ppt`（97-2003 二进制 OLE 复合文档）→ **本函数不处理**：python-pptx 打不开 OOXML
        以外的格式；由 extract_legacy() 先用 DSH 自带 LibreOffice 无头转成 .pptx，再走这里
        （结果里带 `convertedFrom` / `convert:{tool,ms,ok}`；转不了就明确报错，不静默 ✗）。
      · 内嵌图片也不在本函数：由 ooxml_extra() 按 `ppt/media/*` **原字节**直出
        （images[].source="ooxml"，与 PDF 抽图同口径；不支持的编码逐条进 imagesSkipped）。

    反静默（原实现 `except: pass` + 空正文也报 ok:true）：
      · 一页都没有 → 抛 ExtractError（明确报错，不返回空正文）；
      · 有页但一个字都没抽到 → `meta.warnings` 写明（并给 `meta.pages`，让面板的
        「文字层极薄」提示对 PPT 也能命中 —— 提示文案在前端，见 client.js 的 ingThin）；
      · 备注 / 某个形状 / 组合展开失败 → `meta.warnings` 逐条记，不再吞。
    """
    try:
        from pptx import Presentation
    except Exception as e:
        raise ExtractError("未安装 python-pptx，无法抽取 .pptx（%s: %s）" % (type(e).__name__, e))
    prs = Presentation(path)
    parts = []
    warnings = []
    stat = {"bodys": 0, "smartart": 0}      # bodys = 正文字数（非空白）；smartart = 抽不到的图形个数

    def chart_text(ch):
        """图表里的文字**不在 shape.text_frame 里**，只能走 chart API：标题 + 分类名 + 系列名。
        分类/系列各设上限，避免千点图表把正文灌爆（超出的不抽，不静默：见 stats）。"""
        out = []
        try:
            if getattr(ch, "has_title", False):
                t = (ch.chart_title.text_frame.text or "").strip()
                if t:
                    out.append(t)
        except Exception:
            pass
        try:
            plots = list(ch.plots)
        except Exception:
            plots = []
        for plot in plots:
            try:
                cats = [str(getattr(c, "label", "") or "").strip() for c in plot.categories]
                cats = [c for c in cats if c]
                if cats:
                    more = len(cats) - 60
                    out.append("【分类】" + "、".join(cats[:60]) + ("（另有 %d 项未列）" % more if more > 0 else ""))
            except Exception:
                pass
            try:
                names = [str(s.name or "").strip() for s in plot.series]
                names = [n for n in names if n]
                if names:
                    more = len(names) - 40
                    out.append("【系列】" + "、".join(names[:40]) + ("（另有 %d 项未列）" % more if more > 0 else ""))
            except Exception:
                pass
        return "\n".join([x for x in out if x])

    def walk(shapes, depth=0):
        """展平形状树：**递归进组合形状**（GROUP 才有 .shapes）。
        深度设 6：嵌套组合极罕见，防病态文件把栈打爆。"""
        for shape in shapes:
            yield shape
            if depth < 6 and getattr(shape, "shapes", None) is not None:
                try:
                    for sub in walk(shape.shapes, depth + 1):
                        yield sub
                except Exception as e:
                    warnings.append("组合形状展开失败（%s: %s）" % (type(e).__name__, e))

    def add(t):
        t = (t or "").strip()
        if t:
            parts.append(t)
            stat["bodys"] += len(re.sub(r"\s+", "", t))

    for i, slide in enumerate(prs.slides, 1):
        parts.append("\n## 第 %d 页" % i)
        try:
            shapes = list(walk(slide.shapes))
        except Exception as e:
            warnings.append("第 %d 页形状遍历失败（%s: %s）" % (i, type(e).__name__, e))
            shapes = []
        for shape in shapes:
            try:
                if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
                    for para in shape.text_frame.paragraphs:
                        add("".join(run.text or "" for run in para.runs))
                if getattr(shape, "has_table", False) and shape.has_table:
                    for row in shape.table.rows:
                        line = " | ".join((c.text or "").strip().replace("\n", " ") for c in row.cells)
                        parts.append(line)
                        stat["bodys"] += len(re.sub(r"\s+", "", line))
                if getattr(shape, "has_chart", False) and shape.has_chart:
                    add(chart_text(shape.chart))
                # SmartArt / 图示：python-pptx 拿不到图形数据（真在 dgm 部件里）→ 只记账不谎报
                try:
                    if "dgm:relIds" in shape._element.xml:
                        stat["smartart"] += 1
                except Exception:
                    pass
            except Exception as e:
                warnings.append("第 %d 页某个形状抽取失败（%s: %s）" % (i, type(e).__name__, e))
        try:
            if slide.has_notes_slide and slide.notes_slide.notes_text_frame is not None:
                notes = slide.notes_slide.notes_text_frame.text.strip()
                if notes:
                    add("[备注] " + notes)
        except Exception as e:
            warnings.append("第 %d 页备注读取失败（%s: %s）" % (i, type(e).__name__, e))

    slides = len(prs.slides)
    if slides <= 0:
        raise ExtractError("本 .pptx 一页都没有（slides=0），没有可抽取的内容")
    if stat["smartart"]:
        warnings.append("有 %d 个 SmartArt / 图示：其文字存在图形部件里，python-pptx 抽不到 → "
                        "如需这部分知识，请让 DSH 看图或另想办法" % stat["smartart"])
    if stat["bodys"] <= 0:
        warnings.append("本演示文稿 %d 页**一个字都没抽到**（文字层为空）——知识很可能在图片里："
                        "用【让 DSH 深度整理】交给 DSH 看图，或自行截图" % slides)
    # pages = 幻灯片数：只为让面板的「文字层极薄」判据（client.js ingThin 读 meta.pages）对 PPT 生效；
    # 语义上的页数请仍看 slides（PDF 的 pages 是真实页数，两者不混用）
    meta = {"slides": slides, "pages": slides, "bodyChars": stat["bodys"]}
    if warnings:
        meta["warnings"] = warnings
    return "pptx", "\n".join(parts), meta


def extract_xlsx(path):
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    parts = []
    for ws in wb.worksheets:
        parts.append("\n## 工作表：%s" % ws.title)
        n = 0
        for row in ws.iter_rows(values_only=True):
            if row is None:
                continue
            cells = [("" if v is None else str(v).replace("\n", " ")) for v in row]
            if not any(cells):
                continue
            parts.append(" | ".join(cells))
            n += 1
            if n >= 3000:
                parts.append("...（本表超过 3000 行，已截断）")
                break
    try:
        wb.close()
    except Exception:
        pass
    return "xlsx", "\n".join(parts), {"sheets": len(wb.worksheets)}


def extract_pdf(path, outdir=None, want_images=True, want_raster=False):
    from pypdf import PdfReader
    reader = PdfReader(path)
    parts = []
    per_page = []
    page_texts = []          # [(页码, 原始页文本)]：水印检测要在**全部页**上统计算重复

    # 图片抽取与逐页统计：先跑一遍（失败也降级成 skipped 记录，不影响文字）
    if outdir is None:
        outdir = os.path.dirname(os.path.abspath(path))
    try:
        images, images_skipped, pages_info, raster_stat = extract_pdf_images(path, outdir, want_images, want_raster)
    except Exception as e:
        images = []
        images_skipped = [{"page": None, "kind": "unknown", "reason": "图片抽取整体失败：%s: %s" % (type(e).__name__, e)}]
        pages_info = []
        raster_stat = {"tried": 0, "done": 0}
    page_stat = {p["page"]: p for p in pages_info}
    stem = base_stem(path)

    for i, page in enumerate(reader.pages, 1):
        try:
            t = page.extract_text() or ""
        except Exception as e:
            t = "[本页提取失败：%s]" % e
        page_texts.append((i, t))
        nonws = len(re.sub(r"\s+", "", t))
        st = page_stat.setdefault(i, {"page": i, "images": 0})
        if st.get("images", 0) == 0:                      # 图片扫描早退时补一次（只用页资源，不重解码）
            try:
                st["images"] = len(iter_page_images(page))
            except Exception:
                pass
        st["chars"] = nonws
        st["suspectScan"] = bool(nonws < SUSPECT_SCAN_MAX_CHARS and st.get("images", 0) > 0)
        per_page.append(st)
        if t.strip():
            parts.append("\n## 第 %d 页\n%s" % (i, t.strip()))
        if sum(len(p) for p in parts) > MAX_CHARS:
            parts.append("\n...（内容过长，已截断）")
            break

    # 文字型水印：跨页重复短行 → 从正文剔除，但逐条记进 watermarkLines（不静默丢）
    try:
        wm_hits = detect_watermark_lines(page_texts)
        wm_records = watermark_line_records(page_texts, wm_hits)
        parts = []
        for pno, st_text in strip_watermarks(page_texts, wm_hits):
            # 与改动前**完全同形**：页首 '\n' + 页头 + '\n' + 页文本（页尾空白一并去掉）
            body = st_text.strip()
            if body:
                parts.append("\n## 第 %d 页\n%s" % (pno, body))
    except Exception as e:
        wm_hits, wm_records = {}, []
        images_skipped.append({"page": None, "kind": "watermark",
                               "reason": "水印检测失败（不影响正文与图片）：%s: %s" % (type(e).__name__, e)})

    per_page.sort(key=lambda p: p["page"])
    suspect = [p["page"] for p in per_page if p.get("suspectScan")]
    # 疑似扫描页：有 fitz 就渲染成 PNG，没有就只标 available:false（绝不安装依赖）
    try:
        page_render = render_scan_pages(path, outdir, stem, suspect)
    except Exception as e:
        page_render = {"available": False, "rendered": [], "reason": "渲染尝试失败：%s: %s" % (type(e).__name__, e)}
    meta = {}
    try:
        md = reader.metadata or {}
        meta = {
            "title": str(md.get("/Title") or ""),
            "author": str(md.get("/Author") or ""),
            "subject": str(md.get("/Subject") or ""),
        }
    except Exception:
        pass
    meta["pages"] = len(reader.pages)
    meta["imageCount"] = len(images)
    meta["imageSkippedCount"] = len(images_skipped)
    meta["suspectScanPages"] = suspect
    meta["watermarkLineCount"] = len(wm_records)
    meta["watermarkImageCount"] = sum(1 for im in images if im.get("likelyWatermark"))
    raster_report = dict(raster_stat, enabled=bool(want_raster))
    if not want_raster:
        # 提示放**新字段**里（不动 imagesSkipped 既有 reason 文本 → 默认输出逐字节不变）
        raster_report["note"] = ("默认关闭：原始光栅（FlateDecode/LZW…）按零依赖原则只跳过不重编码；"
                                 "如需把它们转 PNG，加 --raster-png（服务侧设 DSH_INGEST_RASTER_PNG=1）")
    return "pdf", "\n".join(parts), meta, {
        "images": images,
        "imagesSkipped": images_skipped,
        "watermarkLines": wm_records,
        "pageRender": page_render,
        "suspectScan": suspect,
        "rasterPng": raster_report,
        "pages": per_page,
    }


HELP = {
    "ok": True,
    "usage": "extract.py <文件绝对路径> [--out <图片输出目录>] [--no-images] [--raster-png]",
    "description": ("把文件抽成纯文本；PDF / OOXML（docx/pptx/xlsx）额外把内嵌 JPEG/PNG 按原字节抽到磁盘，"
                    "标记水印并列出被跳过的图像编码（--raster-png 时把可解码的原始光栅转 PNG）。"
                    "老格式 .doc/.xls/.ppt/.rtf 先用 DSH 自带 LibreOffice 无头转成 OOXML 再抽。"),
    "options": {
        "--out DIR": "图片输出目录（默认：输入文件所在目录）",
        "--no-images": "只抽文字，不落图片",
        "--raster-png": ("【默认关闭·opt-in】用 Pillow 把 FlateDecode 等**原始光栅**解码成 "
                         "PNG（<原名>__rasterNN.png）；解不开的仍逐条跳过并写明原因。"
                         "代价：依赖 Pillow（缺失则报错/跳过，绝不自动安装），且图片数量会明显增多。"),
        "--help": "显示本帮助",
    },
    "outputFields": {
        "images": "[{file, page, kind(jpeg|png), w, h, bytes, likelyWatermark, source?}] "
                  "原字节直出的图片；likelyWatermark=true 只表示**疑似水印**（每页重复 logo/印章 或面积 < 页面 %d%%），"
                  "**不删除、不替换**，供主代理据此判断来源/版权" % round(IMG_WATERMARK_MAX_AREA_RATIO * 100),
        "imagesSkipped": "[{page, kind, reason}] 未抽出的图像（不许静默丢弃）",
        "watermarkLines": "[{text, pages:[...], count}] 文字型水印：跨 ≥%d 页重复、长度 ≤%d、"
                          "且含网址/内参/翻录/版权等特征词的短行 —— **已从正文剔除**，但在此逐条留证（不静默丢）"
                          % (WATERMARK_MIN_PAGES, WATERMARK_MAX_CHARS),
        "rasterPng": "{enabled, tried, done} 光栅转 PNG 开关状态与条数（enabled=false 时行为与默认零依赖完全一致）",
        "pageRender": "{available, rendered:[{file,page}], reason?} 扫描页渲染（需 PyMuPDF，缺失则 available=false）",
        "suspectScan": "[页号] 文字层极薄且含图像的页（阈值为非空白字符数 < %d）" % SUSPECT_SCAN_MAX_CHARS,
        "pages": "[{page, chars, images, suspectScan}] 逐页统计",
        "convertedFrom": "老格式才有：原扩展名（doc|xls|ppt|rtf）—— 该文件是先经 LibreOffice 无头转换后才抽取的",
        "convert": "{tool, ms, ok} 老格式的转换记录（tool = soffice | libreoffice-kit）；失败时整体返回 {\"ok\":false,\"error\":...}",
    },
    "legacy": "老格式 .doc/.xls/.ppt/.rtf（OLE 复合文档 / RTF，**不是** OOXML）会先用 "
              "DSH 自带 LibreOffice 无头转成 .docx/.xlsx/.pptx（临时目录，**原文件只读**）再抽取；"
              "探测不到 LibreOffice / 转换失败 / 转换超时（%ds）→ 明确报错，绝不静默返回空正文。"
              "可用环境变量 DSH_OBSIDIAN_SOFFICE 指定 soffice(.exe) 或 kit 的 cli.js（一旦设置即不再回退探测）" % CONVERT_TIMEOUT_S,
}


def parse_args(argv):
    path, outdir, want_images, want_raster = None, None, True, False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("-h", "--help"):
            return {"help": True}
        if a == "--out":
            i += 1
            if i >= len(argv):
                raise ValueError("--out 需要一个目录参数")
            outdir = argv[i]
        elif a.startswith("--out="):
            outdir = a[len("--out="):]
        elif a == "--no-images":
            want_images = False
        elif a == "--raster-png":
            want_raster = True                       # opt-in：默认关闭，保持零依赖语义
        elif a.startswith("-") and a != "-":
            raise ValueError("未知参数：%s（用 --help 看用法）" % a)
        elif path is None:
            path = a
        else:
            raise ValueError("多余的参数：%s" % a)
        i += 1
    return {"help": False, "path": path, "outdir": outdir,
            "wantImages": want_images, "wantRaster": want_raster}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: extract.py <file> [--out DIR] [--no-images]"}, ensure_ascii=False))
        return 1
    try:
        args = parse_args(sys.argv[1:])
    except ValueError as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 1
    if args["help"]:
        print(json.dumps(HELP, ensure_ascii=False, indent=2))
        return 0

    path = args["path"]
    if not path:
        print(json.dumps({"ok": False, "error": "usage: extract.py <file> [--out DIR] [--no-images]"}, ensure_ascii=False))
        return 1
    if not os.path.isfile(path):
        print(json.dumps({"ok": False, "error": "file not found: " + path}, ensure_ascii=False))
        return 1

    ext = os.path.splitext(path)[1].lower()
    size = os.path.getsize(path)
    extra = {}
    try:
        if ext in LEGACY_EXT:
            # 老格式（.doc/.xls/.ppt/.rtf）：LibreOffice 无头转 OOXML 后**走下面的既有路径**。
            # 失败即明确报错（含「未找到 LibreOffice」），**绝不静默返回空正文**。
            kind, text, meta, extra = extract_legacy(path, ext, args["outdir"], args["wantImages"])
        elif ext == ".docx":
            kind, text, meta = extract_docx(path)
            extra = ooxml_extra(path, args["outdir"], args["wantImages"])
        elif ext == ".pptx":
            kind, text, meta = extract_pptx(path)
            extra = ooxml_extra(path, args["outdir"], args["wantImages"])
        elif ext in (".xlsx", ".xlsm"):
            kind, text, meta = extract_xlsx(path)
            extra = ooxml_extra(path, args["outdir"], args["wantImages"])
        elif ext == ".pdf":
            kind, text, meta, extra = extract_pdf(path, args["outdir"], args["wantImages"], args["wantRaster"])
        elif ext in TEXT_EXT:
            kind, text, meta = "text", read_text_file(path), {}
        elif ext in IMAGE_EXT:
            kind, text, meta = "image", "", {"note": "图片不抽文本，交由 DSH 多模态识别"}
        elif ext in AV_EXT:
            kind, text, meta = "media", "", {"note": "音视频不抽文本"}
        else:
            kind, text, meta = "unknown", "", {"note": "未支持的扩展名：%s" % (ext or "(无)")}
    except ExtractError as e:
        # 老格式转换的**明确失败**：原样回报（不带异常类名前缀），面板/调用方直接把这句话给用户看
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 1
    except Exception as e:  # 任何库异常都转成 JSON 错误，不污染 stdout
        print(json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, ensure_ascii=False))
        return 1

    text, truncated = clip(text)
    meta = dict(meta or {})
    meta.update({"chars": len(text), "bytes": size, "ext": ext})
    out = {"ok": True, "kind": kind, "text": text, "truncated": truncated, "meta": meta}
    out.update(extra)   # PDF / OOXML / 老格式转换才有：images / imagesSkipped / pageRender / suspectScan / pages / convertedFrom / convert
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    sys.exit(main())
