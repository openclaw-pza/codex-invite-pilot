# build-state-sheet.py — 把线上现状的六个状态拼成一张图，给设计师看。
#
# 用途：换排版要新开设计线程，新线程没有项目记忆。
# 与其写一千字描述"我们有哪些组件"，不如给一张图 —— 组件、状态、细节一眼全在。
#
# 这张图的定位是「现状，是要被取代的」，不是"照着做"。
# 所以每格的标注要写清楚这一屏在干什么、买家在这儿待多久，
# 让设计师知道哪一屏是重头戏（等码那屏要看 20 分钟，收码那屏是唯一该有戏的）。
#
# 用法：python scripts/build-state-sheet.py

import io, os
from PIL import Image, ImageDraw, ImageFont

SP = r'C:/WINDOWS/TEMP/claude/D----/fae349b8-7916-464f-82e6-ab335a208072/scratchpad'
GUIDE = r'F:/sms-project/public/vend/guide'
OUT = r'F:/sms-project/design/现状快照-给ClaudeDesign.jpg'

FONT = 'C:/Windows/Fonts/msyh.ttc'
FONT_B = 'C:/Windows/Fonts/msyhbd.ttc'
BG = (24, 24, 27)
INK = (240, 240, 238)
DIM = (150, 152, 156)
ACC = (233, 200, 122)

CELL_W = 900          # 每格图片宽度
GAP = 26
PAD = 34
CAP_H = 96            # 每格标注区高度

# (文件, 标题, 说明) —— 说明里要写清楚这一屏的**停留时长**和**重要程度**
CELLS = [
    (SP + '/pal/now-idle.jpg', '① 空态 · 还没验卡密',
     '首屏。左栏是卡密输入 + 720 个服务的搜索列表；右边整块是主舞台，验证码将来出现在这里。'),
    (GUIDE + '/step-2b.jpg', '② 选地区中',
     '每行：国旗 + 地区名 + 库存状态 + 一个标签（可用 / 卡密余额不足 / 已补差价）。一屏要能看到十几行。'),
    (GUIDE + '/step-3.jpg', '③ 等验证码中 —— 最重要',
     '买家取到号之后停在这一屏，最长 20 分钟。号码 + 六个空格子 + 倒计时 + 换号/取消按钮。'),
    (SP + '/pal/now-code.jpg', '④ 验证码到达 —— 唯一该有戏的一屏',
     '六格填满 + 短信原文 + 一键复制。这是全站唯一应该有戏剧性的时刻，其余都该安静。'),
    (GUIDE + '/step-topup.jpg', '⑤ 补差价弹窗',
     '三行计算（地区价 / 卡密抵扣 / 应补金额）+ 支付宝收款码 + 备注要求 + 两个按钮。'),
    (SP + '/chk-ann.jpg', '⑥ 公告弹窗 · 首次打开自动弹',
     '三条注意事项 + 一块「可用/余额不足」名词解释 + 一个方形二维码和一张竖版宣传图 + 今日不再提示。'),
    (GUIDE + '/step-mail.jpg', '⑦ 临时邮箱面板 · 另一个标签页',
     '免费赠品。一个地址 + 实时刷新的收件箱，信里认出验证码会单独标出来给一键复制。'),
]


def fit(path, w):
    im = Image.open(path).convert('RGB')
    return im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)


f_title = ImageFont.truetype(FONT_B, 30)
f_desc = ImageFont.truetype(FONT, 22)
f_head = ImageFont.truetype(FONT_B, 46)
f_sub = ImageFont.truetype(FONT, 24)

imgs = [fit(p, CELL_W) for p, _, _ in CELLS]
# 两列
col_h = []
for c in (0, 1):
    h = sum(imgs[i].height + CAP_H + GAP for i in range(c, len(imgs), 2))
    col_h.append(h)

HEAD_H = 150
W = PAD * 2 + CELL_W * 2 + GAP
H = HEAD_H + max(col_h) + PAD

sheet = Image.new('RGB', (W, H), BG)
d = ImageDraw.Draw(sheet)

d.text((PAD, PAD), '验证码取号 · 线上现状快照', font=f_head, fill=INK)
d.text((PAD, PAD + 62),
       '这是即将被取代的版本，不是参考。附上它是为了让你看清我们有哪些组件、哪些状态。',
       font=f_sub, fill=DIM)
d.line([(PAD, HEAD_H - 16), (W - PAD, HEAD_H - 16)], fill=(52, 52, 56), width=1)

ys = [HEAD_H, HEAD_H]
for i, (im, (_, title, desc)) in enumerate(zip(imgs, CELLS)):
    col = i % 2
    x = PAD + col * (CELL_W + GAP)
    y = ys[col]
    d.text((x, y + 6), title, font=f_title, fill=ACC)
    # 说明可能一行放不下，按宽度手动折行
    line, lines = '', []
    for ch in desc:
        if d.textlength(line + ch, font=f_desc) > CELL_W - 8:
            lines.append(line); line = ch
        else:
            line += ch
    lines.append(line)
    for n, ln in enumerate(lines[:2]):
        d.text((x, y + 46 + n * 28), ln, font=f_desc, fill=DIM)
    sheet.paste(im, (x, y + CAP_H))
    d.rectangle([x, y + CAP_H, x + CELL_W - 1, y + CAP_H + im.height - 1], outline=(58, 58, 62))
    ys[col] = y + CAP_H + im.height + GAP

os.makedirs(os.path.dirname(OUT), exist_ok=True)
# 传给设计工具的图，宽度压到 2000 以内，免得太重
if sheet.width > 2000:
    sheet = sheet.resize((2000, round(sheet.height * 2000 / sheet.width)), Image.LANCZOS)
sheet.save(OUT, 'JPEG', quality=84, optimize=True, progressive=True)
print('size', sheet.size, os.path.getsize(OUT) // 1024, 'KB')
print("saved ok")
