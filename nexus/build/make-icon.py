"""生成 NEXUS 应用图标：深色圆角方块 + 渐变节点网络（与 tokens.css 配色一致）"""
from PIL import Image, ImageDraw
import math, os

S = 1024          # 超采样画布
BG0 = (7, 8, 12)
BG1 = (11, 13, 19)
C1 = (123, 92, 255)    # #7b5cff
C2 = (91, 140, 255)    # #5b8cff
C3 = (34, 211, 238)    # #22d3ee


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def grad(t):
    """0..1 映射 紫→蓝→青"""
    if t < 0.5:
        return lerp(C1, C2, t / 0.5)
    return lerp(C2, C3, (t - 0.5) / 0.5)


def rounded_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def make():
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    radius = int(S * 0.225)

    # 底板：径向柔和渐变
    plate = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    pd = ImageDraw.Draw(plate)
    for i in range(S // 2, 0, -2):
        t = i / (S / 2)
        col = lerp(BG1, BG0, t)
        pd.ellipse([S / 2 - i, S / 2 - i, S / 2 + i, S / 2 + i], fill=col + (255,))
    plate.putalpha(rounded_mask(S, radius))
    img = Image.alpha_composite(img, plate)

    d = ImageDraw.Draw(img)

    # 顶部高光条，制造玻璃感
    hl = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hl)
    hd.rounded_rectangle([0, 0, S - 1, int(S * 0.5)], radius=radius, fill=(255, 255, 255, 10))
    hl.putalpha(Image.composite(hl.split()[3], Image.new('L', (S, S), 0), rounded_mask(S, radius)))
    img = Image.alpha_composite(img, hl)
    d = ImageDraw.Draw(img)

    # 渐变描边
    border = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    bd = ImageDraw.Draw(border)
    w = max(3, int(S * 0.011))
    steps = 360
    for i in range(steps):
        a0 = i * 360 / steps
        a1 = (i + 1) * 360 / steps
        # 用圆弧近似描边，颜色沿角度渐变
        col = grad((math.sin(math.radians(a0)) + 1) / 2)
        bd.arc([w, w, S - 1 - w, S - 1 - w], start=a0 - 90, end=a1 - 90, fill=col + (235,), width=w)
    border.putalpha(Image.composite(border.split()[3], Image.new('L', (S, S), 0), rounded_mask(S, radius)))
    img = Image.alpha_composite(img, border)
    d = ImageDraw.Draw(img)

    # 节点网络：中心 hub + 3 卫星
    cx, cy = S / 2, S / 2
    hub = 0.085 * S
    sat_r = 0.30 * S
    sat = 0.055 * S
    angles = [-90, 30, 150]
    pts = [(cx + sat_r * math.cos(math.radians(a)), cy + sat_r * math.sin(math.radians(a))) for a in angles]

    # 连线（带渐变与发光）
    for idx, (px, py) in enumerate(pts):
        for k in range(2):
            wl = int(S * (0.020 - k * 0.008))
            layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
            ld = ImageDraw.Draw(layer)
            ld.line([cx, cy, px, py], fill=grad(idx / 2) + (70 - k * 30,), width=wl)
            img = Image.alpha_composite(img, layer.filter(__import__('PIL.ImageFilter', fromlist=['x']).GaussianBlur(S * 0.012)))
        layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        ld.line([cx, cy, px, py], fill=grad(idx / 2) + (230,), width=max(3, int(S * 0.009)))
        img = Image.alpha_composite(img, layer)
    d = ImageDraw.Draw(img)

    # 卫星节点
    from PIL import ImageFilter
    for idx, (px, py) in enumerate(pts):
        glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        gd.ellipse([px - sat * 1.9, py - sat * 1.9, px + sat * 1.9, py + sat * 1.9], fill=grad(idx / 2) + (95,))
        img = Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(S * 0.022)))
        d = ImageDraw.Draw(img)
        d.ellipse([px - sat, py - sat, px + sat, py + sat], fill=grad(idx / 2) + (255,))
        d.ellipse([px - sat * 0.42, py - sat * 0.42, px + sat * 0.42, py + sat * 0.42], fill=(255, 255, 255, 235))

    # 中心 hub：亮核 + 光晕
    glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([cx - hub * 2.6, cy - hub * 2.6, cx + hub * 2.6, cy + hub * 2.6], fill=C1 + (110,))
    img = Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(S * 0.03)))
    d = ImageDraw.Draw(img)
    d.ellipse([cx - hub, cy - hub, cx + hub, cy + hub], fill=(255, 255, 255, 250))
    d.ellipse([cx - hub * 0.62, cy - hub * 0.62, cx + hub * 0.62, cy + hub * 0.62], fill=grad(0.15) + (255,))

    return img


if __name__ == '__main__':
    out_dir = r'C:\Users\Jacob\WorkBuddy\2026-11-13-12-48-00\nexus\build'
    os.makedirs(out_dir, exist_ok=True)
    im = make()
    png = os.path.join(out_dir, 'icon.png')
    im.resize((512, 512), Image.LANCZOS).save(png)
    ico = os.path.join(out_dir, 'icon.ico')
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    im.save(ico, format='ICO', sizes=sizes)
    print('生成:', png, os.path.getsize(png), 'bytes')
    print('生成:', ico, os.path.getsize(ico), 'bytes')
