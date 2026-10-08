#!/usr/bin/env python3
"""生成 GitHub 仓库的 Social preview 卡片图（1280×640，2:1，GitHub 推荐尺寸）。

为什么要脚本化：卡片迟早要跟项目一起更新（改标题/加能力），手绘一张就再也没法改了；
放成脚本后 `python tools/make-social-preview.py` 随时重生成，产物是 docs/social-preview.png。

设计口径：
  · 底板用面板**深色主题**的配色（#0b0e18 → #151a2e）+ 右上角靛蓝柔光，和产品观感一致；
  · 只用**两行主文案 + 四个能力词 + 一行技术定位** —— 社交卡片常常被缩到 500px 宽显示，
    字多了一定糊；宁可少写，也不要小字。
  · 中英双语：中文说用途、英文说定位（与仓库 About 同一口径）。
  · 不含任何个人数据（无库名 / 无盘符 / 无机器路径）。

依赖：Pillow（DSH 自带 Python 已装）。字体用 Windows 自带的雅黑 / Segoe UI；
非 Windows 或字体缺失时会**明确报缺哪个字体**并退出，不静默出一张糊图。
"""
import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover
    sys.exit("需要 Pillow：python -m pip install pillow")

W, H = 1280, 640
# 卡片底部那行仓库地址（发布后写死在这里；被单独转发时别人也能找到仓库）
REPO = "github.com/Famwu/dsh-obsidian-panel"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "docs", "social-preview.png")

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


def panel_mock(d):
    """右侧一块抽象「侧边面板」示意（纯几何，不含任何产品文案）"""
    x0, y0, x1, y1 = 826, 132, 1208, 508
    d.rounded_rectangle([x0, y0, x1, y1], radius=14, fill=(17, 21, 36), outline=(48, 56, 84), width=2)
    d.rounded_rectangle([x0, y0, x1, y0 + 46], radius=14, fill=(23, 28, 46))
    d.rectangle([x0, y0 + 32, x1, y0 + 46], fill=(23, 28, 46))
    # 顶部小色块 + 圆点（呼应面板头部）
    d.rounded_rectangle([x0 + 16, y0 + 14, x0 + 34, y0 + 32], radius=5, fill=ACCENT)
    d.ellipse([x1 - 34, y0 + 17, x1 - 20, y0 + 31], fill=(52, 211, 153))
    # 搜索框
    d.rounded_rectangle([x0 + 16, y0 + 62, x1 - 16, y0 + 96], radius=8, fill=(14, 18, 32), outline=(44, 52, 78), width=1)
    # 三条「笔记」
    for i in range(3):
        ty = y0 + 118 + i * 78
        d.rounded_rectangle([x0 + 16, ty, x1 - 16, ty + 62], radius=9, fill=(20, 25, 42), outline=(40, 47, 70), width=1)
        d.rounded_rectangle([x0 + 30, ty + 14, x0 + 30 + (250 - i * 34), ty + 26], radius=5, fill=(70, 78, 112))
        d.rounded_rectangle([x0 + 30, ty + 36, x0 + 30 + (170 - i * 22), ty + 45], radius=4, fill=(48, 55, 82))
        d.rounded_rectangle([x0 + 30, ty + 52, x0 + 30 + 54, ty + 61], radius=4, fill=(ACCENT_SOFT[0], ACCENT_SOFT[1], ACCENT_SOFT[2]))
        d.rounded_rectangle([x0 + 92, ty + 52, x0 + 92 + 42, ty + 61], radius=4, fill=(38, 45, 70))
    # 底部一行（在线状态）
    d.ellipse([x0 + 18, y1 - 30, x0 + 30, y1 - 18], fill=(52, 211, 153))
    d.rounded_rectangle([x0 + 40, y1 - 27, x0 + 176, y1 - 17], radius=5, fill=(46, 54, 80))


def main():
    img = glow(gradient())
    d = ImageDraw.Draw(img)
    panel_mock(d)

    x = 76
    f_title = pick(CN_BD, EN_BD, 78, "DSH × Obsidian", "标题")
    f_sub_cn = font(CN_BD, 40, "中文副标题")
    f_sub_en = font(EN_RG, 27, "英文副标题")
    f_chip = font(CN_RG, 25, "能力词")

    d.text((x, 96), "DSH × Obsidian", font=f_title, fill=TX)
    d.text((x, 200), "第二大脑", font=f_sub_cn, fill=TX)
    d.text((x + 178, 216), "Second Brain", font=f_sub_en, fill=ACCENT)

    # 四个能力词（胶囊）
    chips = ["会话导出", "交给 DSH", "库自进化", "开工检索"]
    cx = x
    for c in chips:
        tw = d.textlength(c, font=f_chip)
        d.rounded_rectangle([cx, 282, cx + tw + 34, 326], radius=22, fill=CHIP_BG, outline=CHIP_BD, width=1)
        d.text((cx + 17, 293), c, font=f_chip, fill=TX2)
        cx += tw + 34 + 12

    # 页脚：技术定位（与仓库 About 口径一致）
    foot1 = "零依赖本地桥接 · Zero-dependency local bridge"
    foot2 = "Node 18+ · MIT License · Obsidian plugin + DSH panel"
    f_foot1 = pick(CN_RG, EN_RG, 21, foot1, "页脚中文行")
    f_foot2 = pick(CN_RG, EN_RG, 21, foot2, "页脚西文行")
    d.rounded_rectangle([x, 384, x + 4, 424], radius=2, fill=ACCENT)
    d.text((x + 20, 388), foot1, font=f_foot1, fill=TX2)
    d.text((x + 20, 420), foot2, font=f_foot2, fill=(120, 129, 156))
    f_repo = pick(CN_RG, EN_RG, 22, REPO, "仓库地址")
    d.text((x, 556), REPO, font=f_repo, fill=(96, 104, 132))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img.save(OUT, "PNG", optimize=True)
    kb = os.path.getsize(OUT) / 1024
    print(f"已生成 {OUT}")
    print(f"尺寸 {img.size[0]}x{img.size[1]}（GitHub 推荐 1280x640，2:1）· {kb:.1f} KB（上限 1024 KB）")
    if img.size != (1280, 640) or kb > 1024:
        sys.exit("不符合 GitHub 的 social preview 约束")


if __name__ == "__main__":
    main()
