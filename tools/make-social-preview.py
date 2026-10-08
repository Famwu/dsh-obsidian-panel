#!/usr/bin/env python3
"""生成 GitHub 仓库的 Social preview 卡片图（1280×640，2:1，GitHub 推荐尺寸）。

为什么要脚本化：卡片迟早要跟项目一起更新（改标题/加能力），手绘一张就再也没法改了；
放成脚本后 `python tools/make-social-preview.py` 随时重生成，产物是 docs/social-preview.png。

## ⭐ 中心安全构图（2026-10-09 因真实裁切问题重做）

同一张 og:image 会被各平台**按自己的比例裁切**后再显示，实测：

| 平台/比例 | 裁切方式 | 对旧版（左对齐构图）的影响 |
|---|---|---|
| 2:1（Telegram/Slack/多数 unfurl） | 不裁 | 完整 ✓ |
| 1.91:1（Twitter/X 大卡、LinkedIn、Discord） | 左右各切 ~29px | 几乎无损 ✓ |
| 1.33:1（Facebook、微信/QQ 大图） | 左右各切 ~215px | ✗ 标题成了「H × Obsidian」、首个胶囊丢失、页脚缺字 |
| 1:1（微信/QQ 小方图） | 左右各切 ~320px | ✗ 标题只剩「Obsidian」、URL 断头 |

根因：旧版关键内容从 `x=76` 开始，而 1.33:1 的中心裁切从 `x≈215` 起、1:1 从 `x=320` 起 → 左边一律被切。
**修法**：所有**关键元素**（标题 / 副标题 / 能力胶囊 / 页脚 / 仓库地址）一律**居中**画在中间
`x∈[320,960]`（= 1:1 裁切后仍在画面内的 640px 安全带）内；装饰性图形（面板示意）放到安全带**之外**
并降低不透明度 —— 被裁掉不影响信息。
脚本会**逐元素断言**其包围盒落在安全带内，越界直接报错退出（不靠肉眼看）。

依赖：Pillow（DSH 自带 Python 已装）。字体用 Windows 自带的雅黑 / Segoe UI；
非 Windows 或字体缺失时会**明确报缺哪个字体**并退出，不静默出一张糊图。
用法：`python tools/make-social-preview.py [输出路径]`（默认 docs/social-preview.png）
"""
import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover
    sys.exit("需要 Pillow：python -m pip install pillow")

# ⭐ 踩过的坑：Windows 控制台默认是 GBK，脚本里打印 ✓ / 中文会直接抛 UnicodeEncodeError（断言通过了却"看起来失败"）。
# 统一把 stdout 改成 UTF-8（失败也不影响绘图，故容错处理）。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # pragma: no cover
    pass

W, H = 1280, 640
CX = W // 2
# 1:1 中心裁切后仍在画面内的横向范围 —— 关键元素必须全部落在这里
SAFE_L, SAFE_R = CX - 320, CX + 320          # 320 .. 960
# 卡片底部那行仓库地址（发布后写死在这里；被单独转发时别人也能找到仓库）
REPO = "github.com/Famwu/dsh-obsidian-panel"
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(os.path.dirname(HERE), "docs", "social-preview.png")

# 主题色（与面板深色主题一致）
BG_TOP = (11, 14, 24)
BG_BOT = (21, 26, 46)
ACCENT = (99, 102, 241)      # 靛蓝
ACCENT_SOFT = (76, 81, 191)
TX = (232, 235, 244)
TX2 = (154, 163, 188)
CHIP_BG = (30, 36, 60)
CHIP_BD = (56, 64, 96)

CN_BD = "C:/Windows/Fonts/msyhbd.ttc"
CN_RG = "C:/Windows/Fonts/msyh.ttc"
EN_BD = "C:/Windows/Fonts/segoeuib.ttf"
EN_RG = "C:/Windows/Fonts/segoeui.ttf"

_boxes = []   # 记录关键元素的包围盒，最后统一断言


def font(path, size, what):
    if not os.path.exists(path):
        sys.exit(f"缺少字体 {path}（{what}）—— 请改脚本里的字体路径，或改用本机有的中文字体")
    return ImageFont.truetype(path, size)


def has_cjk(s):
    return any("\u2e80" <= ch <= "\u9fff" or "\uf900" <= ch <= "\ufaff" or "\uff00" <= ch <= "\uffef" for ch in s)


def pick(cn_path, en_path, size, text, what):
    """⭐ 踩过的坑：Segoe UI 这类**西文字体没有 CJK 字形**，拿它去画含中文的字符串会出**豆腐块**（□□□）。
    所以规则是「**只要字符串里有中文，就用雅黑**」—— 雅黑同时带西文字形，混排不会掉字；
    纯西文才用 Segoe UI（西文观感更好）。"""
    return font(cn_path if has_cjk(text) else en_path, size, what)


def gradient():
    img = Image.new("RGB", (W, H), BG_TOP)
    d = ImageDraw.Draw(img)
    for y in range(H):
        t = y / (H - 1)
        d.line([(0, y), (W, y)], fill=tuple(round(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t) for i in range(3)))
    return img


def glow(img):
    """右上角一团柔光：多层同心圆做低透明度叠加（Pillow 没有径向渐变，用叠加代替）"""
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy, rmax = W - 150, -80, 620
    for i in range(38, 0, -1):
        r = rmax * i / 38
        a = round(3 + 26 * (1 - i / 38))
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(ACCENT[0], ACCENT[1], ACCENT[2], a))
    return Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")


def decor_panel(layer, x0, y0, x1, y1, alpha):
    """装饰用的抽象「侧边面板」示意：画在半透明层上（低不透明度 = 被裁掉不心疼）。
    只画在安全带之外。"""
    dd = ImageDraw.Draw(layer)
    dd.rounded_rectangle([x0, y0, x1, y1], radius=14, fill=(17, 21, 36, alpha), outline=(48, 56, 84, alpha), width=2)
    dd.rounded_rectangle([x0, y0, x1, y0 + 42], radius=14, fill=(23, 28, 46, alpha))
    dd.rectangle([x0, y0 + 30, x1, y0 + 42], fill=(23, 28, 46, alpha))
    dd.rounded_rectangle([x0 + 14, y0 + 13, x0 + 30, y0 + 29], radius=5, fill=(ACCENT[0], ACCENT[1], ACCENT[2], alpha))
    dd.ellipse([x1 - 30, y0 + 15, x1 - 18, y0 + 27], fill=(52, 211, 153, alpha))
    dd.rounded_rectangle([x0 + 14, y0 + 58, x1 - 14, y0 + 88], radius=8, fill=(14, 18, 32, alpha), outline=(44, 52, 78, alpha), width=1)
    for i in range(3):
        ty = y0 + 106 + i * 68
        dd.rounded_rectangle([x0 + 14, ty, x1 - 14, ty + 54], radius=9, fill=(20, 25, 42, alpha), outline=(40, 47, 70, alpha), width=1)
        dd.rounded_rectangle([x0 + 26, ty + 12, x0 + 26 + (200 - i * 30), ty + 22], radius=5, fill=(70, 78, 112, alpha))
        dd.rounded_rectangle([x0 + 26, ty + 30, x0 + 26 + (140 - i * 20), ty + 38], radius=4, fill=(48, 55, 82, alpha))
        dd.rounded_rectangle([x0 + 26, ty + 44, x0 + 26 + 46, ty + 51], radius=4, fill=(ACCENT_SOFT[0], ACCENT_SOFT[1], ACCENT_SOFT[2], alpha))
    return layer


def text_c(d, text, y, f, fill, what):
    """居中画一行；记录包围盒用于「必须在安全带内」的断言"""
    w = d.textlength(text, font=f)
    x = round(CX - w / 2)
    d.text((x, y), text, font=f, fill=fill)
    bbox = d.textbbox((x, y), text, font=f)
    _boxes.append((what, text, bbox))
    return bbox


def build():
    global _boxes
    _boxes = []
    img = glow(gradient())

    # ① 装饰（安全带之外、低不透明度）—— 先画，给中间留干净底
    deco = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    decor_panel(deco, 14, 168, 262, 480, 78)       # 左边缘
    decor_panel(deco, 1022, 150, 1266, 500, 96)    # 右边缘
    img = Image.alpha_composite(img.convert("RGBA"), deco).convert("RGB")
    d = ImageDraw.Draw(img)

    # ② 顶部小图标：抽象面板（44px 宽，落在安全带内）
    icon = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    di = ImageDraw.Draw(icon)
    ix0, iy0 = CX - 22, 74
    di.rounded_rectangle([ix0, iy0, ix0 + 44, iy0 + 44], radius=10, fill=(23, 28, 46, 255), outline=(56, 64, 96, 255), width=2)
    di.rounded_rectangle([ix0 + 8, iy0 + 9, ix0 + 15, iy0 + 16], radius=2, fill=ACCENT)
    di.rounded_rectangle([ix0 + 8, iy0 + 22, ix0 + 36, iy0 + 26], radius=2, fill=(70, 78, 112))
    di.rounded_rectangle([ix0 + 8, iy0 + 31, ix0 + 28, iy0 + 35], radius=2, fill=(52, 60, 88))
    img = Image.alpha_composite(img.convert("RGBA"), icon).convert("RGB")
    d = ImageDraw.Draw(img)
    _boxes.append(("顶部图标", "[icon]", (ix0, iy0, ix0 + 44, iy0 + 44)))

    # ③ 关键元素：全部居中，且必须落在安全带内
    f_title = pick(CN_BD, EN_BD, 66, "DSH × Obsidian", "标题")
    text_c(d, "DSH × Obsidian", 148, f_title, TX, "标题")

    f_sub = pick(CN_RG, EN_RG, 30, "第二大脑 · Second Brain", "副标题")
    text_c(d, "第二大脑 · Second Brain", 228, f_sub, TX2, "副标题")

    # 能力胶囊（居中排一行）
    f_chip = font(CN_RG, 21, "能力词")
    chips = ["会话导出", "交给 DSH", "库自进化", "开工检索"]
    gap, pad = 10, 15
    widths = [d.textlength(c, font=f_chip) + pad * 2 for c in chips]
    total = sum(widths) + gap * (len(chips) - 1)
    cx = round(CX - total / 2)
    for c, cw in zip(chips, widths):
        d.rounded_rectangle([cx, 294, cx + cw, 336], radius=21, fill=CHIP_BG, outline=CHIP_BD, width=1)
        d.text((cx + pad, 303), c, font=f_chip, fill=TX2)
        cx += cw + gap
    _boxes.append(("胶囊行", " / ".join(chips), (round(CX - total / 2), 294, round(CX + total / 2), 336)))

    # 短强调线（居中）
    d.rounded_rectangle([CX - 48, 372, CX + 48, 376], radius=2, fill=ACCENT)
    _boxes.append(("强调线", "[rule]", (CX - 48, 372, CX + 48, 376)))

    foot1 = "零依赖本地桥接 · Zero-dependency local bridge"
    foot2 = "Node 18+ · MIT License · Obsidian plugin + DSH panel"
    f_foot1 = pick(CN_RG, EN_RG, 20, foot1, "页脚一")
    f_foot2 = pick(CN_RG, EN_RG, 19, foot2, "页脚二")
    text_c(d, foot1, 400, f_foot1, TX2, "页脚一")
    text_c(d, foot2, 430, f_foot2, (120, 129, 156), "页脚二")

    f_repo = pick(CN_RG, EN_RG, 21, REPO, "仓库地址")
    text_c(d, REPO, 522, f_repo, (96, 104, 132), "仓库地址")

    return img


def assert_safe():
    bad = []
    for what, text, box in _boxes:
        if box[0] < SAFE_L or box[2] > SAFE_R:
            bad.append(f"{what}：x {box[0]}..{box[2]} 越界（安全带 {SAFE_L}..{SAFE_R}）「{text[:28]}」")
    if bad:
        print("✗ 中心安全断言失败：")
        for b in bad:
            print("   " + b)
        sys.exit(1)
    widest = max((b[2] - b[0], what) for what, _, b in _boxes)
    print(f"✓ 中心安全断言通过：{len(_boxes)} 个关键元素的包围盒全部落在 x∈[{SAFE_L},{SAFE_R}]")
    print(f"  最宽元素：{widest[1]}（{widest[0]}px，安全带净宽 {SAFE_R - SAFE_L}px）")


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUT
    img = build()
    assert_safe()
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    img.save(out, "PNG", optimize=True)
    kb = os.path.getsize(out) / 1024
    print(f"已生成 {out}")
    print(f"尺寸 {img.size[0]}x{img.size[1]}（GitHub 推荐 1280x640，2:1）· {kb:.1f} KB（上限 1024 KB）")
    if img.size != (1280, 640) or kb > 1024:
        sys.exit("不符合 GitHub 的 social preview 约束")


if __name__ == "__main__":
    main()
