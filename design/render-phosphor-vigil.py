#!/usr/bin/env python3
"""
Phosphor Vigil — render the visual philosophy as a single immersive composition.

Output: F:/toxicavenger/disclosure/pursue-console/design/phosphor-vigil.png
A 2400x1500 watchroom frame, all typography in the GeistMono / IBMPlexMono
families, no decorative gestures the data doesn't earn.
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import math, random, json, datetime
from pathlib import Path

ROOT = Path(r"F:/toxicavenger/disclosure/pursue-console")
FONT_DIR = Path(r"C:/Users/guru8/AppData/Roaming/Claude/local-agent-mode-sessions/skills-plugin/b8479bcb-49c5-490c-9c54-5a5f7d6d20f5/23339d37-fc49-4612-b536-c30b630a3402/skills/canvas-design/canvas-fonts")
OUT = ROOT / "design" / "phosphor-vigil.png"

# ---- canvas + palette ----
# Aspect tuned for a watchroom monitor — slightly taller gives each stratum
# the room it needs to breathe without crowding the feed.
W, H = 2400, 1600
PHOSPHOR_BG       = (3, 9, 7)
PHOSPHOR_BG_DEEP  = (1, 5, 4)
PHOSPHOR_GREEN    = (124, 255, 178)
PHOSPHOR_DIM      = (54, 118, 88)
PHOSPHOR_HAIR     = (22, 58, 42)
PHOSPHOR_GHOST    = (12, 32, 24)
AMBER             = (255, 217, 61)
AMBER_DIM         = (118, 92, 24)
CYAN_FRESH        = (130, 182, 255)
WHISPER           = (84, 154, 118)

def F(name, size): return ImageFont.truetype(str(FONT_DIR / name), size)

# Font assignments per philosophy: one mono family, weight as the only variable.
# Sizes recalibrated for the taller canvas — restraint without tininess.
F_TITLE      = F("GeistMono-Bold.ttf", 78)         # monumental room name (smaller, more confident)
F_SUBTITLE   = F("GeistMono-Regular.ttf", 18)
F_BIG_NUM    = F("GeistMono-Bold.ttf", 168)        # the principal totals
F_NUM        = F("GeistMono-Bold.ttf", 60)
F_LABEL      = F("GeistMono-Regular.ttf", 11)
F_LABEL_M    = F("GeistMono-Regular.ttf", 13)
F_BODY       = F("IBMPlexMono-Regular.ttf", 16)
F_BODY_BOLD  = F("IBMPlexMono-Bold.ttf", 16)
F_HEAD       = F("GeistMono-Bold.ttf", 14)
F_TINY       = F("GeistMono-Regular.ttf", 9)
F_AXIS       = F("GeistMono-Regular.ttf", 10)
F_TIME       = F("GeistMono-Bold.ttf", 18)

img = Image.new("RGB", (W, H), PHOSPHOR_BG)
d = ImageDraw.Draw(img, "RGBA")

# ---- base texture: barely-there grain + scanlines ----
# Grain is the room's dust, not its surface. Keep it well below conscious
# perception; the scanlines do the heavy "this is a CRT" work.
random.seed(7)
grain = Image.new("RGB", (W, H))
gpx = grain.load()
for y in range(H):
    for x in range(W):
        n = random.randint(0, 6)
        gpx[x, y] = (n // 5, n // 3, n // 4)
img = Image.blend(img, grain, 0.05)

# Scanlines — gentler, but the cadence is everything
overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
od = ImageDraw.Draw(overlay)
for y in range(0, H, 2):
    od.line([(0, y), (W, y)], fill=(0, 0, 0, 18))
img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
d = ImageDraw.Draw(img, "RGBA")

# Vignette — soft photographic darkening at the edges
v = Image.new("L", (W, H), 0)
vd = ImageDraw.Draw(v)
cx, cy = W // 2, H // 2
maxR = max(cx, cy) * 1.3
for r in range(int(maxR), 0, -2):
    a = int(140 * (r / maxR) ** 2.6)
    vd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=a)
img.paste((1, 4, 3), (0, 0), v.filter(ImageFilter.GaussianBlur(100)))
d = ImageDraw.Draw(img, "RGBA")

# ============================================================
# Top header band — eyebrow, ID slugs, monumental room name, time
# ============================================================
MARGIN = 110
TOP = 90
hair = PHOSPHOR_HAIR

# Whisper-quiet ceremonial eyebrow — center-aligned, widely letterspaced
eyebrow = "◇   P R E S I D E N T I A L   U N S E A L I N G   ·   R E P O R T I N G   S Y S T E M   F O R   U A P   E N C O U N T E R S   ◇"
ew = d.textlength(eyebrow, font=F_SUBTITLE)
d.text(((W - ew) / 2, TOP), eyebrow, fill=AMBER_DIM, font=F_SUBTITLE)

# Slim hairline under the eyebrow at half-width — earned visual confirmation
HR_HEAD = TOP + 36
d.line([(W//2 - 220, HR_HEAD), (W//2 + 220, HR_HEAD)], fill=PHOSPHOR_HAIR, width=1)

# Monumental room name — restrained halo, tightened letter spacing
ROOM_Y = TOP + 78
room = "L I V E   W A T C H"
rw = d.textlength(room, font=F_TITLE)
room_x = (W - rw) / 2

# Indicator dot — small, dignified, soft halo (no broadcast)
pulse_r = 9
px = room_x - 44
py = ROOM_Y + 44
# Single soft halo at one-third intensity
halo = Image.new("RGBA", (W, H), (0, 0, 0, 0))
hd = ImageDraw.Draw(halo)
for r in range(pulse_r * 5, pulse_r, -1):
    a = max(0, 14 - int((r - pulse_r) * 0.6))
    hd.ellipse([px - r, py - r, px + r, py + r], fill=(*PHOSPHOR_GREEN, a))
halo = halo.filter(ImageFilter.GaussianBlur(2))
img = Image.alpha_composite(img.convert("RGBA"), halo).convert("RGB")
d = ImageDraw.Draw(img, "RGBA")
d.ellipse([px - pulse_r, py - pulse_r, px + pulse_r, py + pulse_r], fill=PHOSPHOR_GREEN)

# Room name — quiet, deep phosphor glow under
glow_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow_layer)
gd.text((room_x, ROOM_Y), room, font=F_TITLE, fill=(*PHOSPHOR_GREEN, 70))
glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(10))
img = Image.alpha_composite(img.convert("RGBA"), glow_layer).convert("RGB")
d = ImageDraw.Draw(img, "RGBA")
d.text((room_x, ROOM_Y), room, font=F_TITLE, fill=PHOSPHOR_GREEN)

# Identifier left — monospaced ID slug + status line
d.text((MARGIN, TOP + 78), "P U R S U E   //   W A T C H",
       fill=PHOSPHOR_GREEN, font=F_TIME)
d.text((MARGIN, TOP + 108),
       "S E C T I O N    A     ·     L I N K    N O M I N A L     ·     O P E R A T O R    A U T O",
       fill=PHOSPHOR_DIM, font=F_LABEL)

# Right side — UTC clock + channel
now = datetime.datetime.utcnow().strftime("%Y - %m - %d     %H : %M : %S    U T C")
nw = d.textlength(now, font=F_TIME)
d.text((W - MARGIN - nw, TOP + 78), now, fill=PHOSPHOR_GREEN, font=F_TIME)
ch = "C H A N N E L     R E L E A S E   0 1"
cw_ = d.textlength(ch, font=F_LABEL)
d.text((W - MARGIN - cw_, TOP + 108), ch, fill=PHOSPHOR_DIM, font=F_LABEL)

# Generous single rule across the page — the page's first major breath
RULE1 = TOP + 200
d.line([(MARGIN, RULE1), (W - MARGIN, RULE1)], fill=hair, width=1)

# ============================================================
# Telemetry stratum — four monumental totals
# Each cell: tiny widely-spaced label / huge numeral / one whisper sub.
# No ticks, no boxes. The data is the only graphic.
# ============================================================
TEL_Y = RULE1 + 56
cells = [
    ("P A G E S",        "1,184",  "decoded · cumulative"),
    ("C H A R A C T E R S", "1.94M","indexed corpus text"),
    ("V I S I O N",      "247",    "GPT-transcribed pages"),
    ("T E S S E R A C T","569",    "awaiting vision re-pass"),
]
cw = (W - 2 * MARGIN) / 4
for i, (label, num, sub) in enumerate(cells):
    x = MARGIN + i * cw
    d.text((x, TEL_Y), label, fill=PHOSPHOR_DIM, font=F_LABEL_M)
    nc = PHOSPHOR_GREEN if i < 3 else AMBER
    d.text((x, TEL_Y + 28), num, fill=nc, font=F_BIG_NUM)
    d.text((x, TEL_Y + 220), sub, fill=WHISPER, font=F_LABEL)
    # Cell divider — a single vertical hairline between cells, not at the edges
    if i > 0:
        d.line([(x - 24, TEL_Y - 4), (x - 24, TEL_Y + 240)], fill=PHOSPHOR_GHOST, width=1)

RULE2 = TEL_Y + 268
d.line([(MARGIN, RULE2), (W - MARGIN, RULE2)], fill=hair, width=1)

# ============================================================
# Three-column body:  left osc/sparkline  ·  center feed  ·  right gauges
# ============================================================
BODY_Y = RULE2 + 36
BODY_BOT = H - 110

LEFT_W   = 460
CENTER_W = 1060
RIGHT_W  = 440
GAP      = 40
LEFT_X = MARGIN
CENTER_X = LEFT_X + LEFT_W + GAP
RIGHT_X  = CENTER_X + CENTER_W + GAP

# ---- LEFT COLUMN: signal histogram + waveform ----
d.text((LEFT_X, BODY_Y), "INGEST RATE / 24H", fill=PHOSPHOR_DIM, font=F_HEAD)
d.text((LEFT_X, BODY_Y + 18), "pages per hour", fill=PHOSPHOR_DIM, font=F_TINY)

# 24-bar histogram
HIST_Y = BODY_Y + 50
HIST_H = 180
bars = [3, 5, 8, 4, 6, 2, 1, 0, 0, 1, 3, 6, 9, 14, 17, 22, 19, 16, 12, 14, 10, 7, 4, 3]
bmax = max(bars)
bw = (LEFT_W - 20) / len(bars)
for i, b in enumerate(bars):
    bh = int((b / bmax) * HIST_H)
    bx = LEFT_X + 8 + i * bw
    by = HIST_Y + HIST_H - bh
    d.rectangle([bx, by, bx + bw - 3, HIST_Y + HIST_H], fill=PHOSPHOR_DIM)
    if i == 15:  # current peak: brighter
        d.rectangle([bx, by, bx + bw - 3, HIST_Y + HIST_H], fill=PHOSPHOR_GREEN)
# axis line
d.line([(LEFT_X + 8, HIST_Y + HIST_H), (LEFT_X + LEFT_W - 8, HIST_Y + HIST_H)],
       fill=PHOSPHOR_HAIR, width=1)
# axis labels
d.text((LEFT_X + 8, HIST_Y + HIST_H + 6), "00", fill=PHOSPHOR_DIM, font=F_AXIS)
d.text((LEFT_X + (LEFT_W - 8) / 2 - 6, HIST_Y + HIST_H + 6), "12", fill=PHOSPHOR_DIM, font=F_AXIS)
d.text((LEFT_X + LEFT_W - 24, HIST_Y + HIST_H + 6), "24", fill=PHOSPHOR_DIM, font=F_AXIS)

# Waveform — oscilloscope trace
WAVE_Y = HIST_Y + HIST_H + 70
d.text((LEFT_X, WAVE_Y - 30), "OSCILLATION · LAST 90s", fill=PHOSPHOR_DIM, font=F_HEAD)
WH = 110
pts = []
random.seed(42)
for i in range(LEFT_W - 16):
    base = math.sin(i * 0.08) * 28 + math.sin(i * 0.21 + 1.7) * 14
    noise = random.gauss(0, 6)
    spike = 0
    if 240 <= i <= 250:
        spike = -38  # a recent signal arrival
    pts.append((LEFT_X + 8 + i, WAVE_Y + WH // 2 + base + noise + spike))
for i in range(len(pts) - 1):
    color = CYAN_FRESH if 240 <= i <= 252 else PHOSPHOR_GREEN
    d.line([pts[i], pts[i + 1]], fill=color, width=2)
# axis
d.line([(LEFT_X + 8, WAVE_Y + WH), (LEFT_X + LEFT_W - 8, WAVE_Y + WH)],
       fill=PHOSPHOR_HAIR, width=1)
d.text((LEFT_X + 8, WAVE_Y + WH + 6), "−90s", fill=PHOSPHOR_DIM, font=F_AXIS)
d.text((LEFT_X + LEFT_W - 32, WAVE_Y + WH + 6), "NOW", fill=AMBER, font=F_AXIS)

# Frequency mark
SIG_Y = WAVE_Y + WH + 60
d.text((LEFT_X, SIG_Y), "CHANNELS", fill=PHOSPHOR_DIM, font=F_HEAD)
channels = [
    ("VISION",     "1.2 hz", CYAN_FRESH),
    ("TESSERACT",  "0.3 hz", AMBER),
    ("PDFJS",      "—",      PHOSPHOR_DIM),
    ("USER DROP",  "—",      PHOSPHOR_DIM),
]
for i, (name, hz, col) in enumerate(channels):
    cy_ = SIG_Y + 30 + i * 26
    d.text((LEFT_X, cy_), f"  {name}", fill=col, font=F_BODY)
    rt = d.textlength(hz, font=F_BODY)
    d.text((LEFT_X + LEFT_W - rt - 8, cy_), hz, fill=col, font=F_BODY)
    d.line([(LEFT_X, cy_ + 22), (LEFT_X + LEFT_W - 8, cy_ + 22)], fill=PHOSPHOR_GHOST, width=1)

# ---- CENTER COLUMN: arriving signals (the feed) ----
d.text((CENTER_X, BODY_Y), "▌ARRIVING SIGNALS", fill=PHOSPHOR_GREEN, font=F_HEAD)
right_meta = "VISION × OCR · UTC TIMESTAMPS · MOST RECENT FIRST"
d.text((CENTER_X + CENTER_W - d.textlength(right_meta, font=F_TINY), BODY_Y + 3),
       right_meta, fill=PHOSPHOR_DIM, font=F_TINY)
d.line([(CENTER_X, BODY_Y + 22), (CENTER_X + CENTER_W, BODY_Y + 22)],
       fill=PHOSPHOR_HAIR, width=1)

entries = [
    ("00:00:12", "VISION", "INCIDENT-SUMMARIES",  "p 141",
     "Officer reports object “naturally cigar-shaped, silvery, traveling in a westerly direction at about 1,500 mph at 6,000 ft altitude.”",
     True),
    ("00:00:47", "VISION", "FBI-62HQ-83894",      "p 092",
     "Telegram from SAC Washington: subject states he observed three discs over the Potomac at 1430 hrs local. Pinned a photograph to the back of the report.",
     False),
    ("00:01:33", "VISION", "1949-DISCS",          "p 040",
     "Witness near Twin Falls describes saucer descending vertically without sound, then accelerating south at terrific velocity. (?) signature follows.",
     False),
    ("00:02:14", "OCR",    "COMETA",              "p 075",
     "increasingly cut off from the common opinion. John Lear, son of the aircraft builder, contributed details on the Nevada base, in “area 51.”",
     False),
    ("00:02:58", "VISION", "PRESIDENTIAL-1963",   "p 003",
     "“What is the Government's position on the matter of intelligent life on other planets?” — question forwarded to the White House for response.",
     False),
    ("00:03:22", "VISION", "KRASUSKI-1944",       "p 011",
     "Krasuski observed a large, circular vehicle ascending vertically from the compound. He says it rose silently and was lost from view in cloud cover.",
     False),
    ("00:04:09", "OCR",    "INCIDENT-SUMMARIES",  "p 144",
     "Object's apparent shape was disk-like. Color: silver. Observed by two pilots from National Guard AT-6 flying easterly heading at 7,500 ft.",
     False),
    ("00:05:01", "VISION", "AMC-1947",            "p 014",
     "Document dated 23 September 1947. Subject: AMC opinion on Flying Discs. “The phenomenon reported is something real and not visionary or fictitious.”",
     False),
    ("00:05:48", "VISION", "GENERAL-1948",        "p 022",
     "Project Sign analyst notes: 25 cases now meet criteria. Recommend wider distribution of report. Signed and dated under classification stamp.",
     False),
]

ROW_H = 96
fy = BODY_Y + 44
for i, (t, src, eid, page, snippet, fresh) in enumerate(entries):
    if fy + ROW_H > BODY_BOT - 8:
        break
    # Soft inter-row whisper — only between rows, never above the first
    if i > 0:
        d.line([(CENTER_X + 8, fy - 8), (CENTER_X + CENTER_W - 8, fy - 8)],
               fill=PHOSPHOR_GHOST, width=1)
    # Left rail — full row height, brighter on the fresh entry
    rail_color = CYAN_FRESH if fresh else PHOSPHOR_GHOST
    rail_w = 2 if fresh else 1
    d.line([(CENTER_X, fy - 2), (CENTER_X, fy + ROW_H - 16)], fill=rail_color, width=rail_w)
    # Time stamp — amber only when fresh, otherwise dim
    d.text((CENTER_X + 18, fy + 2), f"T + {t}",
           fill=AMBER if fresh else PHOSPHOR_DIM, font=F_HEAD)
    # Source tag — cyan VISION reads as the freshest channel
    src_color = CYAN_FRESH if src == "VISION" else AMBER
    src_x = CENTER_X + 144
    d.text((src_x, fy + 2), src, fill=src_color, font=F_HEAD)
    # Event id chain
    eid_x = src_x + d.textlength(src, font=F_HEAD) + 18
    d.text((eid_x, fy + 2), eid, fill=PHOSPHOR_GREEN, font=F_HEAD)
    # Page marker on the right — tertiary
    pw = d.textlength(page, font=F_HEAD)
    d.text((CENTER_X + CENTER_W - pw - 8, fy + 2), page, fill=PHOSPHOR_DIM, font=F_HEAD)
    # Snippet — typographic quotes, single-pixel indent, breathable leading
    snippet_quoted = f'“ {snippet} ”'
    words = snippet_quoted.split(" ")
    line = ""
    sy = fy + 32
    max_w = CENTER_W - 32
    snippet_color = PHOSPHOR_GREEN if fresh else WHISPER
    leading = 24
    for w in words:
        test = (line + " " + w).strip()
        if d.textlength(test, font=F_BODY) > max_w:
            d.text((CENTER_X + 18, sy), line, fill=snippet_color, font=F_BODY)
            sy += leading
            line = w
            if sy + leading > fy + ROW_H - 12: break
        else:
            line = test
    if line and sy + leading <= fy + ROW_H - 4:
        d.text((CENTER_X + 18, sy), line, fill=snippet_color, font=F_BODY)
    fy += ROW_H

# ---- RIGHT COLUMN: agency gauges + bearing dial ----
d.text((RIGHT_X, BODY_Y), "AGENCY DISTRIBUTION", fill=PHOSPHOR_DIM, font=F_HEAD)

agencies = [
    ("DEPT/WAR",   42, AMBER),
    ("FBI",        18, PHOSPHOR_GREEN),
    ("NASA",       11, CYAN_FRESH),
    ("DEPT/STATE",  7, PHOSPHOR_GREEN),
    ("COMETA",      6, AMBER),
    ("OTHER",      16, PHOSPHOR_DIM),
]
agy_max = max(a[1] for a in agencies)
ay = BODY_Y + 30
for label, val, col in agencies:
    d.text((RIGHT_X, ay), label, fill=col, font=F_LABEL_M)
    pct_w = int((val / 100) * (RIGHT_W - 80))
    bar_y = ay + 18
    d.rectangle([RIGHT_X, bar_y, RIGHT_X + RIGHT_W - 80, bar_y + 4], fill=PHOSPHOR_GHOST)
    d.rectangle([RIGHT_X, bar_y, RIGHT_X + pct_w, bar_y + 4], fill=col)
    pct_str = f"{val:>3} %"
    d.text((RIGHT_X + RIGHT_W - 70, ay), pct_str, fill=col, font=F_LABEL_M)
    ay += 38

# A polar/bearing dial — quiet decoration that earns its place by reading
# as "where are signals coming from" on the globe.
DIAL_Y = ay + 30
d.text((RIGHT_X, DIAL_Y), "GEOSPATIAL BEARING", fill=PHOSPHOR_DIM, font=F_HEAD)
DIAL_CX = RIGHT_X + RIGHT_W // 2
DIAL_CY = DIAL_Y + 200
DIAL_R = 130
# Outer ring + grid
d.ellipse([DIAL_CX - DIAL_R, DIAL_CY - DIAL_R, DIAL_CX + DIAL_R, DIAL_CY + DIAL_R],
          outline=PHOSPHOR_HAIR, width=1)
d.ellipse([DIAL_CX - DIAL_R*2//3, DIAL_CY - DIAL_R*2//3,
           DIAL_CX + DIAL_R*2//3, DIAL_CY + DIAL_R*2//3], outline=PHOSPHOR_GHOST, width=1)
d.ellipse([DIAL_CX - DIAL_R//3, DIAL_CY - DIAL_R//3,
           DIAL_CX + DIAL_R//3, DIAL_CY + DIAL_R//3], outline=PHOSPHOR_GHOST, width=1)
# Cardinal ticks + labels
for ang, label in [(0, "N"), (90, "E"), (180, "S"), (270, "W")]:
    r = math.radians(ang - 90)
    x1 = DIAL_CX + math.cos(r) * (DIAL_R - 4)
    y1 = DIAL_CY + math.sin(r) * (DIAL_R - 4)
    x2 = DIAL_CX + math.cos(r) * (DIAL_R - 16)
    y2 = DIAL_CY + math.sin(r) * (DIAL_R - 16)
    d.line([(x1, y1), (x2, y2)], fill=PHOSPHOR_DIM, width=1)
    lx = DIAL_CX + math.cos(r) * (DIAL_R + 14) - 4
    ly = DIAL_CY + math.sin(r) * (DIAL_R + 14) - 6
    d.text((lx, ly), label, fill=PHOSPHOR_DIM, font=F_LABEL)
# Sample bearings (signal arrival directions)
random.seed(11)
signals = [
    (28, 0.85, CYAN_FRESH),    # arctic, fresh
    (155, 0.72, PHOSPHOR_GREEN),
    (212, 0.65, PHOSPHOR_GREEN),
    (300, 0.55, AMBER),
    (335, 0.30, PHOSPHOR_DIM),
    (95, 0.92, PHOSPHOR_GREEN),
    (78, 0.40, PHOSPHOR_DIM),
    (47, 0.60, PHOSPHOR_GREEN),
]
for ang, mag, col in signals:
    r = math.radians(ang - 90)
    rad = mag * DIAL_R
    x = DIAL_CX + math.cos(r) * rad
    y = DIAL_CY + math.sin(r) * rad
    sz = 4 if col == CYAN_FRESH else 3
    d.ellipse([x - sz, y - sz, x + sz, y + sz], fill=col)
# Center crosshair
d.line([(DIAL_CX - 6, DIAL_CY), (DIAL_CX + 6, DIAL_CY)], fill=PHOSPHOR_DIM, width=1)
d.line([(DIAL_CX, DIAL_CY - 6), (DIAL_CX, DIAL_CY + 6)], fill=PHOSPHOR_DIM, width=1)
# Sweep wedge — barely there, like a frame caught mid-rotation
sweep_ang = 73
for k in range(30):
    r = math.radians(sweep_ang - k * 1.4 - 90)
    a = max(0, 32 - int(k * 1.1))
    x = DIAL_CX + math.cos(r) * DIAL_R
    y = DIAL_CY + math.sin(r) * DIAL_R
    d.line([(DIAL_CX, DIAL_CY), (x, y)], fill=(*PHOSPHOR_GREEN, int(a)), width=1)

# Bottom rule — single line, centered short accent
d.line([(MARGIN, BODY_BOT), (W - MARGIN, BODY_BOT)], fill=hair, width=1)

# Footer — generous gap from the rule, widely letterspaced
FOOT_Y = BODY_BOT + 36
left_foot = "W A T C H K E E P E R     ·     A U T O M A T E D   V I G I L     ·     H U M A N - I N - L O O P   T R A N S C R I P T I O N"
d.text((MARGIN, FOOT_Y), left_foot, fill=PHOSPHOR_DIM, font=F_LABEL_M)
foot_right = "P H O S P H O R - V I G I L     ·     S E C T I O N   A     ·     P A G E   0 1"
d.text((W - MARGIN - d.textlength(foot_right, font=F_LABEL_M), FOOT_Y),
       foot_right, fill=PHOSPHOR_DIM, font=F_LABEL_M)

# Final whisper glow — overall slight bloom on bright phosphor pixels
img_l = img.convert("RGBA")
bloom = Image.new("RGBA", (W, H), (0, 0, 0, 0))
bl = ImageDraw.Draw(bloom)
# re-draw a couple of bright elements for glow
bl.text((room_x, ROOM_Y), room, font=F_TITLE, fill=(*PHOSPHOR_GREEN, 90))
for i, (label, num, sub) in enumerate(cells):
    x = MARGIN + i * cw
    bl.text((x, TEL_Y + 22), num,
            fill=(*PHOSPHOR_GREEN, 70) if i < 3 else (*AMBER, 70), font=F_BIG_NUM)
bloom = bloom.filter(ImageFilter.GaussianBlur(8))
img = Image.alpha_composite(img_l, bloom).convert("RGB")

OUT.parent.mkdir(parents=True, exist_ok=True)
img.save(OUT, "PNG", optimize=True)
print(f"wrote {OUT}  {OUT.stat().st_size//1024} KB")
