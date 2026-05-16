#!/usr/bin/env python3
"""
Helmsman Phosphor — single-operator instrument panel.
Output: F:/toxicavenger/disclosure/pursue-console/design/helmsman-phosphor.png

A 1800x1200 cockpit instrument. One focal frame (current page) slightly
offset from center; supporting gauges orbit at dimmer phosphor.
"""
from PIL import Image, ImageDraw, ImageFilter
import math, random, datetime
from pathlib import Path

ROOT = Path(r"F:/toxicavenger/disclosure/pursue-console")
FONT_DIR = Path(r"C:/Users/guru8/AppData/Roaming/Claude/local-agent-mode-sessions/skills-plugin/b8479bcb-49c5-490c-9c54-5a5f7d6d20f5/23339d37-fc49-4612-b536-c30b630a3402/skills/canvas-design/canvas-fonts")
OUT = ROOT / "design" / "helmsman-phosphor.png"

from PIL import ImageFont
def F(name, size): return ImageFont.truetype(str(FONT_DIR / name), size)

# Helmsman Phosphor palette — 5 stops, no decoration colors
PHOSPHOR_BG       = (3, 9, 7)         # near-black canvas
PHOSPHOR_GREEN    = (124, 255, 178)   # steady-state primary
PHOSPHOR_DIM      = (54, 118, 88)     # secondary instruments
PHOSPHOR_HAIR     = (22, 58, 42)      # hairline dividers
PHOSPHOR_GHOST    = (12, 32, 24)      # almost-canvas
CYAN_FRESH        = (130, 182, 255)   # the freshest signal — used once
AMBER             = (255, 217, 61)    # "has earned a label" — used sparingly
AMBER_DIM         = (118, 92, 24)
ROSE              = (255, 107, 157)   # error — used very rarely
WHISPER           = (84, 154, 118)    # quiet supporting text

# Single mono family, weight + scale as the only variables.
F_HERO_NUM   = F("GeistMono-Bold.ttf", 188)   # the big focal numeral
F_LARGE_NUM  = F("GeistMono-Bold.ttf", 62)
F_MED_NUM    = F("GeistMono-Bold.ttf", 38)
F_SMALL_NUM  = F("GeistMono-Bold.ttf", 26)
F_TITLE      = F("GeistMono-Bold.ttf", 36)
F_CAP        = F("GeistMono-Regular.ttf", 11)   # widely-letterspaced caps
F_CAP_MED    = F("GeistMono-Regular.ttf", 13)
F_BODY       = F("IBMPlexMono-Regular.ttf", 14)
F_TIME       = F("GeistMono-Bold.ttf", 22)
F_LBL        = F("GeistMono-Regular.ttf", 10)
F_TINY       = F("GeistMono-Regular.ttf", 9)

W, H = 1800, 1200

# ------------- canvas + base texture -------------
img = Image.new("RGB", (W, H), PHOSPHOR_BG)
d = ImageDraw.Draw(img, "RGBA")

# Barely-there grain
random.seed(11)
grain = Image.new("RGB", (W, H))
gpx = grain.load()
for y in range(H):
    for x in range(W):
        n = random.randint(0, 6)
        gpx[x, y] = (n // 5, n // 3, n // 4)
img = Image.blend(img, grain, 0.04)

# Gentle scanlines
overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
od = ImageDraw.Draw(overlay)
for y in range(0, H, 2):
    od.line([(0, y), (W, y)], fill=(0, 0, 0, 16))
img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")

# Vignette toward the corners — gives the eye a center
v = Image.new("L", (W, H), 0)
vd = ImageDraw.Draw(v)
cx, cy = W // 2, H // 2
maxR = max(cx, cy) * 1.4
for r in range(int(maxR), 0, -2):
    a = int(150 * (r / maxR) ** 2.6)
    vd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=a)
img.paste((1, 4, 3), (0, 0), v.filter(ImageFilter.GaussianBlur(120)))
d = ImageDraw.Draw(img, "RGBA")

MARGIN = 120

# ---------------------------------------------------
# TOP RAIL — minimal header
# ---------------------------------------------------
d.text((MARGIN, 70),
       "P U R S U E   //   V O L U N T E E R   I N S T R U M E N T",
       fill=PHOSPHOR_GREEN, font=F_CAP_MED)
d.text((MARGIN, 96),
       "S E S S I O N   B 7 4   ·   O P E R A T O R   @ r i z z l e r o c",
       fill=PHOSPHOR_DIM, font=F_LBL)

# Right side: live clock + status
now = datetime.datetime.now().strftime("%H : %M : %S")
nw = d.textlength(now, font=F_TIME)
d.text((W - MARGIN - nw, 70), now, fill=PHOSPHOR_GREEN, font=F_TIME)
status = "A C T I V E"
sw = d.textlength(status, font=F_LBL)
# Pulse halo for the status dot
pulse_x = W - MARGIN - sw - 22
pulse_y = 105
halo = Image.new("RGBA", (W, H), (0, 0, 0, 0))
hd = ImageDraw.Draw(halo)
for r in range(20, 4, -1):
    a = max(0, 16 - (r - 4) * 1)
    hd.ellipse([pulse_x - r, pulse_y - r, pulse_x + r, pulse_y + r],
               fill=(*PHOSPHOR_GREEN, a))
halo = halo.filter(ImageFilter.GaussianBlur(2))
img = Image.alpha_composite(img.convert("RGBA"), halo).convert("RGB")
d = ImageDraw.Draw(img, "RGBA")
d.ellipse([pulse_x - 4, pulse_y - 4, pulse_x + 4, pulse_y + 4], fill=PHOSPHOR_GREEN)
d.text((W - MARGIN - sw, pulse_y - 5), status, fill=PHOSPHOR_GREEN, font=F_LBL)

# Single hairline rule
d.line([(MARGIN, 145), (W - MARGIN, 145)], fill=PHOSPHOR_HAIR, width=1)

# ---------------------------------------------------
# CENTER FRAME — the focal instrument (current page)
# Slightly offset left of center so the eye has a place to rest.
# ---------------------------------------------------
FOCAL_W = 820
FOCAL_H = 500
FOCAL_X = MARGIN + 40
FOCAL_Y = 220

# Frame brackets in cyan — the freshest signal
d.line([(FOCAL_X, FOCAL_Y),       (FOCAL_X + 36, FOCAL_Y)],   fill=CYAN_FRESH, width=2)
d.line([(FOCAL_X, FOCAL_Y),       (FOCAL_X, FOCAL_Y + 36)],   fill=CYAN_FRESH, width=2)
d.line([(FOCAL_X + FOCAL_W - 36, FOCAL_Y), (FOCAL_X + FOCAL_W, FOCAL_Y)], fill=CYAN_FRESH, width=2)
d.line([(FOCAL_X + FOCAL_W, FOCAL_Y), (FOCAL_X + FOCAL_W, FOCAL_Y + 36)], fill=CYAN_FRESH, width=2)
d.line([(FOCAL_X, FOCAL_Y + FOCAL_H), (FOCAL_X + 36, FOCAL_Y + FOCAL_H)], fill=CYAN_FRESH, width=2)
d.line([(FOCAL_X, FOCAL_Y + FOCAL_H), (FOCAL_X, FOCAL_Y + FOCAL_H - 36)], fill=CYAN_FRESH, width=2)
d.line([(FOCAL_X + FOCAL_W - 36, FOCAL_Y + FOCAL_H), (FOCAL_X + FOCAL_W, FOCAL_Y + FOCAL_H)], fill=CYAN_FRESH, width=2)
d.line([(FOCAL_X + FOCAL_W, FOCAL_Y + FOCAL_H), (FOCAL_X + FOCAL_W, FOCAL_Y + FOCAL_H - 36)], fill=CYAN_FRESH, width=2)

# Header inside frame
d.text((FOCAL_X + 24, FOCAL_Y + 22),
       "N O W   P R O C E S S I N G", fill=CYAN_FRESH, font=F_CAP_MED)
d.text((FOCAL_X + 24, FOCAL_Y + 44),
       "frame stable · awaiting reply", fill=PHOSPHOR_DIM, font=F_LBL)

# Layout zones inside the focal frame — left text column + right thumbnail.
# Compute thumbnail position first so the text column is sized to not collide.
THUMB_W = 168
THUMB_H = 220
THUMB_X = FOCAL_X + FOCAL_W - THUMB_W - 32
THUMB_Y = FOCAL_Y + 110
TEXT_RIGHT = THUMB_X - 36   # right edge of the text column

# Document id + page — the headline (constrained to text column)
eid_label = "incident-summaries"
# Use a smaller title weight so it fits comfortably
F_DOC_TITLE = F("GeistMono-Bold.ttf", 30)
d.text((FOCAL_X + 24, FOCAL_Y + 100),
       eid_label.upper(), fill=PHOSPHOR_GREEN, font=F_DOC_TITLE)
d.text((FOCAL_X + 24, FOCAL_Y + 142),
       "department of war  ·  project blue book carryover",
       fill=PHOSPHOR_DIM, font=F_LBL)

# The huge page numeral — focal point, anchored under the title
page_label = "PAGE"
d.text((FOCAL_X + 24, FOCAL_Y + 198), page_label, fill=PHOSPHOR_DIM, font=F_CAP)
# big glow under the number
glow_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow_layer)
big_num = "142"
gd.text((FOCAL_X + 24, FOCAL_Y + 214), big_num, font=F_HERO_NUM, fill=(*CYAN_FRESH, 100))
glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(12))
img = Image.alpha_composite(img.convert("RGBA"), glow_layer).convert("RGB")
d = ImageDraw.Draw(img, "RGBA")
d.text((FOCAL_X + 24, FOCAL_Y + 214), big_num, font=F_HERO_NUM, fill=CYAN_FRESH)

# Right side of focal frame: tiny preview thumbnail placeholder
# (in the real dashboard this is the rendered PNG)
d.rectangle([THUMB_X, THUMB_Y, THUMB_X + THUMB_W, THUMB_Y + THUMB_H],
            outline=PHOSPHOR_DIM, width=1)
# Fake page content — horizontal text lines suggesting a typed page
random.seed(73)
for i in range(18):
    y = THUMB_Y + 16 + i * 11
    if y > THUMB_Y + THUMB_H - 12: break
    width = random.randint(50, THUMB_W - 32)
    indent = random.choice([10, 10, 10, 20])
    d.line([(THUMB_X + indent, y), (THUMB_X + indent + width, y)],
           fill=PHOSPHOR_GHOST, width=1)
d.text((THUMB_X, THUMB_Y - 20), "P R E V I E W", fill=PHOSPHOR_DIM, font=F_LBL)
d.text((THUMB_X + THUMB_W - d.textlength("180 KB", font=F_LBL), THUMB_Y + THUMB_H + 6),
       "180 KB", fill=PHOSPHOR_DIM, font=F_LBL)

# Vertical hairline dividing text column from thumbnail
mid_x = TEXT_RIGHT + 18
d.line([(mid_x, FOCAL_Y + 90), (mid_x, FOCAL_Y + FOCAL_H - 90)],
       fill=PHOSPHOR_GHOST, width=1)

# Bottom strip of focal frame: tiny meta row — moved BELOW the numeral
# (the numeral's baseline ends around y = FOCAL_Y + 214 + 188 = ~402,
# so the meta row sits at FOCAL_Y + 430 with breathing room above).
meta_y = FOCAL_Y + FOCAL_H - 44
d.text((FOCAL_X + 24, meta_y),
       "B A T C H   5  /  5     ·     E L A P S E D   0 1 m 4 7 s     ·     T O K E N S   3 . 2 k",
       fill=PHOSPHOR_DIM, font=F_CAP_MED)

# ---------------------------------------------------
# RIGHT COLUMN — instrument cluster
# ---------------------------------------------------
RC_X = FOCAL_X + FOCAL_W + 80
RC_W = W - MARGIN - RC_X

# Time-elapsed gauge
d.text((RC_X, FOCAL_Y),
       "S H I F T   E L A P S E D", fill=PHOSPHOR_DIM, font=F_CAP)
d.text((RC_X, FOCAL_Y + 20), "01:42:17",
       fill=PHOSPHOR_GREEN, font=F_LARGE_NUM)
d.text((RC_X, FOCAL_Y + 96),
       "since you started helping",
       fill=PHOSPHOR_DIM, font=F_LBL)

# Slice progress
d.line([(RC_X, FOCAL_Y + 140), (RC_X + RC_W, FOCAL_Y + 140)],
       fill=PHOSPHOR_HAIR, width=1)
d.text((RC_X, FOCAL_Y + 160), "Y O U R   S L I C E", fill=PHOSPHOR_DIM, font=F_CAP)
slice_done, slice_total = 14, 20
d.text((RC_X, FOCAL_Y + 178),
       f"{slice_done}", fill=AMBER, font=F_MED_NUM)
d.text((RC_X + 60, FOCAL_Y + 196),
       f"/ {slice_total} pages",
       fill=PHOSPHOR_DIM, font=F_LBL)

# Slice progress bar
sbar_y = FOCAL_Y + 232
sbar_h = 6
d.rectangle([RC_X, sbar_y, RC_X + RC_W, sbar_y + sbar_h], fill=PHOSPHOR_GHOST)
sw = int(RC_W * (slice_done / slice_total))
d.rectangle([RC_X, sbar_y, RC_X + sw, sbar_y + sbar_h], fill=AMBER)
d.text((RC_X, sbar_y + sbar_h + 4),
       f"{round(slice_done/slice_total*100)} % of your slice",
       fill=PHOSPHOR_DIM, font=F_TINY)

# Global corpus progress
d.line([(RC_X, FOCAL_Y + 290), (RC_X + RC_W, FOCAL_Y + 290)],
       fill=PHOSPHOR_HAIR, width=1)
d.text((RC_X, FOCAL_Y + 308), "C O R P U S   ( G L O B A L )",
       fill=PHOSPHOR_DIM, font=F_CAP)
d.text((RC_X, FOCAL_Y + 326), "1,184",
       fill=PHOSPHOR_GREEN, font=F_MED_NUM)
d.text((RC_X + 130, FOCAL_Y + 344),
       "of  ~ 1,621 pages",
       fill=PHOSPHOR_DIM, font=F_LBL)
gbar_y = FOCAL_Y + 380
d.rectangle([RC_X, gbar_y, RC_X + RC_W, gbar_y + sbar_h], fill=PHOSPHOR_GHOST)
gw = int(RC_W * 0.73)
d.rectangle([RC_X, gbar_y, RC_X + gw, gbar_y + sbar_h], fill=PHOSPHOR_GREEN)
d.text((RC_X, gbar_y + sbar_h + 4),
       "73 % search-ready",
       fill=PHOSPHOR_DIM, font=F_TINY)

# ---------------------------------------------------
# BOTTOM RAIL — recent completions stripe (last 6)
# ---------------------------------------------------
BR_Y = FOCAL_Y + FOCAL_H + 80
d.line([(MARGIN, BR_Y), (W - MARGIN, BR_Y)], fill=PHOSPHOR_HAIR, width=1)
d.text((MARGIN, BR_Y + 18),
       "L A S T   S I X   C O M P L E T I O N S",
       fill=PHOSPHOR_DIM, font=F_CAP)

recents = [
    ("p 138", "OK",       PHOSPHOR_GREEN, "1.7s · batched"),
    ("p 139", "OK",       PHOSPHOR_GREEN, "1.4s · batched"),
    ("p 140", "OK",       PHOSPHOR_GREEN, "2.1s · batched"),
    ("p 141", "FALLBACK", AMBER,          "single-page after fetch retry"),
    ("p 142", "OK",       PHOSPHOR_GREEN, "1.9s · batched · CURRENT NEIGHBOR"),
    ("p 143", "PENDING",  CYAN_FRESH,     "now …"),
]
cell_w = (W - 2 * MARGIN) / len(recents)
for i, (page, st, color, sub) in enumerate(recents):
    x = MARGIN + i * cell_w
    # vertical hairline separator
    if i > 0:
        d.line([(x - 18, BR_Y + 42), (x - 18, BR_Y + 130)],
               fill=PHOSPHOR_GHOST, width=1)
    d.text((x, BR_Y + 50), page, fill=color, font=F_TITLE)
    d.text((x, BR_Y + 96), st, fill=color, font=F_CAP_MED)
    d.text((x, BR_Y + 114), sub, fill=PHOSPHOR_DIM, font=F_TINY)

# ---------------------------------------------------
# BOTTOM FOOTER — "thank you" gesture, single line
# ---------------------------------------------------
FOOT_Y = H - 70
d.line([(MARGIN, FOOT_Y - 30), (W - MARGIN, FOOT_Y - 30)],
       fill=PHOSPHOR_HAIR, width=1)
thank = "Y O U R   W A T C H   M A T T E R S   ·   1 4   P A G E S   A D D E D   T O D A Y   ·   T H A N K   Y O U"
tw = d.textlength(thank, font=F_CAP_MED)
d.text((W/2 - tw/2, FOOT_Y),
       thank, fill=AMBER_DIM, font=F_CAP_MED)

# Final bloom on bright phosphor
img_l = img.convert("RGBA")
bloom = Image.new("RGBA", (W, H), (0, 0, 0, 0))
bl = ImageDraw.Draw(bloom)
bl.text((FOCAL_X + 24, FOCAL_Y + 220), big_num,
        font=F_HERO_NUM, fill=(*CYAN_FRESH, 80))
bl.text((RC_X, FOCAL_Y + 20), "01:42:17",
        font=F_LARGE_NUM, fill=(*PHOSPHOR_GREEN, 60))
bloom = bloom.filter(ImageFilter.GaussianBlur(10))
img = Image.alpha_composite(img_l, bloom).convert("RGB")

OUT.parent.mkdir(parents=True, exist_ok=True)
img.save(OUT, "PNG", optimize=True)
print(f"wrote {OUT}  {OUT.stat().st_size // 1024} KB")
