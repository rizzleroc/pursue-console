// Render the Helmsman Cockpit as a single-screen PNG mockup.
// Output: helmsman-cockpit.png (1440 x 900, laptop-tab proportions)

import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { writeFileSync } from "node:fs";

const W = 1440, H = 900;
const c = createCanvas(W, H);
const g = c.getContext("2d");

// ---- palette ----
const INK       = "#05080a";
const INK_DEEP  = "#02050a";
const PHOS      = "#3ee08b";        // emerald
const PHOS_DIM  = "rgba(62,224,139,0.55)";
const PHOS_FAINT= "rgba(62,224,139,0.22)";
const AMBER     = "#f5b042";
const AMBER_DIM = "rgba(245,176,66,0.55)";
const CYAN      = "#6fe1ff";
const CYAN_DIM  = "rgba(111,225,255,0.55)";
const RULE      = "rgba(62,224,139,0.18)";
const RULE_HARD = "rgba(62,224,139,0.35)";
const TEXT_DIM  = "rgba(180,210,200,0.55)";

// ---- fonts ----
const MONO = "ui-monospace, 'Cascadia Mono', 'Consolas', monospace";

// ---- background: radial vignette + scanlines + grain ----
const grad = g.createRadialGradient(W/2, H/2, 100, W/2, H/2, Math.max(W,H)*0.75);
grad.addColorStop(0, INK);
grad.addColorStop(1, INK_DEEP);
g.fillStyle = grad;
g.fillRect(0, 0, W, H);

// scanlines
g.fillStyle = "rgba(0,0,0,0.18)";
for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1);

// grain
for (let i = 0; i < 4200; i++) {
  const x = Math.random()*W, y = Math.random()*H;
  g.fillStyle = `rgba(62,224,139,${Math.random()*0.04})`;
  g.fillRect(x, y, 1, 1);
}

// ---- helpers ----
function text(s, x, y, { size=12, color=PHOS, font=MONO, weight="400", letter=0, align="left", baseline="alphabetic" } = {}) {
  g.font = `${weight} ${size}px ${font}`;
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = baseline;
  if (letter) {
    // crude letter-spacing
    let cx = x;
    const total = [...s].reduce((a, ch) => a + g.measureText(ch).width + letter, -letter);
    if (align === "center") cx = x - total/2;
    if (align === "right")  cx = x - total;
    g.textAlign = "left";
    for (const ch of s) {
      g.fillText(ch, cx, y);
      cx += g.measureText(ch).width + letter;
    }
  } else {
    g.fillText(s, x, y);
  }
}

function frame(x, y, w, h, { stroke=RULE_HARD, lw=1, label, labelColor=PHOS_DIM } = {}) {
  g.strokeStyle = stroke;
  g.lineWidth = lw;
  g.strokeRect(x + 0.5, y + 0.5, w, h);
  if (label) {
    // notch for the label
    g.fillStyle = INK;
    const padX = 8;
    g.font = `400 10px ${MONO}`;
    const w2 = g.measureText(label).width + padX*2;
    g.fillRect(x + 14, y - 6, w2, 12);
    text(label, x + 14 + padX, y + 3, { size: 10, color: labelColor, letter: 1.2 });
  }
}

function glowText(s, x, y, opts) {
  // halo
  g.save();
  g.shadowColor = opts.color || PHOS;
  g.shadowBlur = opts.blur || 8;
  text(s, x, y, opts);
  g.restore();
}

// ---- top bar: title + identity ----
text("HELMSMAN  ·  COCKPIT", 32, 38, { size: 14, color: PHOS, letter: 4 });
text("pursue-vision-mcp  v0.1.0   ·   helper instrument panel", 32, 58, { size: 11, color: TEXT_DIM, letter: 1.2 });

// right-side: operator + clock
text("OPERATOR", W - 32, 30, { size: 9, color: PHOS_DIM, letter: 2, align: "right" });
text("rizzleroc@cockpit-01", W - 32, 46, { size: 12, color: CYAN, letter: 0.6, align: "right" });
text("SESSION  ·  02:47:13", W - 32, 64, { size: 11, color: AMBER_DIM, letter: 1.4, align: "right" });

// hairline divider
g.strokeStyle = RULE;
g.lineWidth = 1;
g.beginPath(); g.moveTo(32, 80); g.lineTo(W-32, 80); g.stroke();

// ---- main grid layout ----
const PAD = 32;
const TOP = 110;
const COL_GAP = 18;
const ROW_GAP = 18;

// left column (current page, large)  — 880 wide
const L = { x: PAD, y: TOP, w: 880, h: 440 };
// right column (status cluster)     — rest
const R = { x: L.x + L.w + COL_GAP, y: TOP, w: W - PAD - (L.x + L.w + COL_GAP), h: 440 };

// completions stripe full-width
const S = { x: PAD, y: L.y + L.h + ROW_GAP, w: W - PAD*2, h: 130 };

// dual progress bars at bottom
const P = { x: PAD, y: S.y + S.h + ROW_GAP, w: W - PAD*2, h: 130 };

// ---- L: NOW PROCESSING ----
frame(L.x, L.y, L.w, L.h, { label: "NOW  PROCESSING" });

// preview thumbnail box (left side)
const TH = { x: L.x + 28, y: L.y + 44, w: 220, h: 290 };
g.strokeStyle = RULE_HARD;
g.strokeRect(TH.x + 0.5, TH.y + 0.5, TH.w, TH.h);

// fake doc thumbnail content
g.fillStyle = "rgba(62,224,139,0.04)";
g.fillRect(TH.x + 1, TH.y + 1, TH.w - 2, TH.h - 2);
// header band
g.fillStyle = "rgba(62,224,139,0.10)";
g.fillRect(TH.x + 8, TH.y + 12, TH.w - 16, 18);
// fake text lines
g.fillStyle = "rgba(62,224,139,0.18)";
const lineY0 = TH.y + 44;
const lineWs = [180, 196, 172, 188, 160, 192, 144, 178, 168, 196, 152, 184, 120];
for (let i = 0; i < lineWs.length; i++) {
  g.fillRect(TH.x + 8, lineY0 + i*16, lineWs[i], 4);
}
// redaction bars
g.fillStyle = "rgba(245,176,66,0.55)";
g.fillRect(TH.x + 40, lineY0 + 3*16, 90, 8);
g.fillRect(TH.x + 60, lineY0 + 8*16, 120, 8);

// thumbnail caption
text("page-014.png", TH.x + TH.w/2, TH.y + TH.h + 18, { size: 10, color: TEXT_DIM, letter: 1.2, align: "center" });

// right of thumbnail: identifiers
const I = { x: TH.x + TH.w + 36, y: TH.y };

text("EVENT", I.x, I.y + 10, { size: 10, color: PHOS_DIM, letter: 2 });
glowText("fbi-62hq83894", I.x, I.y + 56, { size: 44, color: PHOS, weight: "600", letter: 1.2, blur: 10 });

text("PAGE", I.x, I.y + 96, { size: 10, color: PHOS_DIM, letter: 2 });
glowText("014 / 179", I.x, I.y + 138, { size: 36, color: AMBER, weight: "500", letter: 1.4, blur: 6 });

text("STAGE", I.x, I.y + 186, { size: 10, color: PHOS_DIM, letter: 2 });

// stage bullet
const stages = ["RENDER", "ENCODE", "VISION", "PARSE"];
const sx = I.x, sy = I.y + 210;
let cx = sx;
for (let i = 0; i < stages.length; i++) {
  const done = i < 2;
  const active = i === 2;
  const dot = done ? PHOS : active ? AMBER : "rgba(180,210,200,0.25)";
  g.fillStyle = dot;
  g.beginPath(); g.arc(cx + 6, sy + 6, 5, 0, Math.PI*2); g.fill();
  if (active) {
    g.strokeStyle = AMBER_DIM; g.lineWidth = 1;
    g.beginPath(); g.arc(cx + 6, sy + 6, 10, 0, Math.PI*2); g.stroke();
  }
  text(stages[i], cx + 18, sy + 10, { size: 11, color: done ? PHOS_DIM : active ? AMBER : TEXT_DIM, letter: 1.4 });
  cx += 130;
}

// elapsed on this page
text("ELAPSED ON PAGE", I.x, I.y + 268, { size: 10, color: PHOS_DIM, letter: 2 });
text("00:00:38", I.x, I.y + 294, { size: 22, color: CYAN, letter: 1.4 });

text("PACE", I.x + 200, I.y + 268, { size: 10, color: PHOS_DIM, letter: 2 });
text("25.0s ± 0.6", I.x + 200, I.y + 294, { size: 22, color: CYAN, letter: 1.4 });

text("BATCH", I.x + 420, I.y + 268, { size: 10, color: PHOS_DIM, letter: 2 });
text("4 / 4", I.x + 420, I.y + 294, { size: 22, color: CYAN, letter: 1.4 });

// ---- R: STATUS CLUSTER ----
frame(R.x, R.y, R.w, R.h, { label: "STATUS" });

// daemon dot
const dDot = { x: R.x + 28, y: R.y + 56 };
// halo
g.fillStyle = "rgba(62,224,139,0.22)";
g.beginPath(); g.arc(dDot.x + 10, dDot.y + 10, 18, 0, Math.PI*2); g.fill();
g.fillStyle = PHOS;
g.beginPath(); g.arc(dDot.x + 10, dDot.y + 10, 8, 0, Math.PI*2); g.fill();

text("DAEMON", R.x + 64, R.y + 54, { size: 10, color: PHOS_DIM, letter: 2 });
text("ACTIVE", R.x + 64, R.y + 76, { size: 20, color: PHOS, letter: 2, weight: "500" });

// session clock
text("SESSION  CLOCK", R.x + 28, R.y + 118, { size: 10, color: PHOS_DIM, letter: 2 });
glowText("02:47:13", R.x + 28, R.y + 168, { size: 42, color: CYAN, weight: "500", letter: 2, blur: 8 });

// daemon mode rows
const rowY0 = R.y + 210;
const rows = [
  ["MODE",         "STEADY"],
  ["NEXT  BREAK",  "in 04:12"],
  ["CDP  PORT",    "9222"],
  ["MCP  PORT",    "9223"],
  ["MONITOR",      "9224"],
  ["TOKEN",        "validated"],
];
for (let i = 0; i < rows.length; i++) {
  const y = rowY0 + i*30;
  text(rows[i][0], R.x + 28,  y, { size: 10, color: PHOS_DIM, letter: 1.8 });
  text(rows[i][1], R.x + R.w - 28, y, { size: 12, color: PHOS, letter: 1, align: "right" });
  if (i < rows.length - 1) {
    g.strokeStyle = RULE;
    g.beginPath(); g.moveTo(R.x + 22, y + 14); g.lineTo(R.x + R.w - 22, y + 14); g.stroke();
  }
}

// thank-you gesture at the bottom of R
const thanksY = R.y + R.h - 38;
text("·  THANK  YOU  FOR  HELPING  ·", R.x + R.w/2, thanksY, { size: 10, color: CYAN_DIM, letter: 3, align: "center" });
text("every page you process is one less still hidden", R.x + R.w/2, thanksY + 18, { size: 10, color: TEXT_DIM, letter: 0.6, align: "center" });

// ---- S: RECENT COMPLETIONS STRIPE ----
frame(S.x, S.y, S.w, S.h, { label: "RECENT  ·  LAST  6  PAGES" });

const completions = [
  { evt: "fbi-62hq83894", page: "013", t: "00:00:26", status: "OK"        },
  { evt: "fbi-62hq83894", page: "012", t: "00:00:24", status: "OK"        },
  { evt: "fbi-62hq83894", page: "011", t: "00:00:41", status: "BATCH→1"   },
  { evt: "fbi-62hq83894", page: "010", t: "00:00:22", status: "OK"        },
  { evt: "fbi-62hq83894", page: "009", t: "00:00:25", status: "OK"        },
  { evt: "fbi-62hq83894", page: "008", t: "00:00:23", status: "OK"        },
];

const cellW = (S.w - 24) / 6;
for (let i = 0; i < 6; i++) {
  const cx2 = S.x + 12 + i*cellW;
  const cy2 = S.y + 26;
  const cellH = S.h - 38;

  // subtle cell frame
  g.strokeStyle = RULE;
  g.strokeRect(cx2 + 0.5, cy2 + 0.5, cellW - 8, cellH);

  const row = completions[i];
  const statusColor = row.status === "OK" ? PHOS : row.status.startsWith("BATCH") ? AMBER : "#ff7676";

  text("PAGE", cx2 + 12, cy2 + 18, { size: 9, color: PHOS_DIM, letter: 1.8 });
  text(row.page, cx2 + 12, cy2 + 42, { size: 22, color: PHOS, weight: "500", letter: 1.2 });

  text(row.evt, cx2 + 12, cy2 + 62, { size: 9, color: TEXT_DIM, letter: 0.6 });

  text("TIME", cx2 + 12, cy2 + 82, { size: 9, color: PHOS_DIM, letter: 1.8 });
  text(row.t, cx2 + 12, cy2 + 96, { size: 12, color: CYAN, letter: 1 });

  // status pip (top-right of cell, with comfortable label gap)
  const pipX = cx2 + cellW - 80;
  g.fillStyle = statusColor;
  g.beginPath(); g.arc(pipX, cy2 + 18, 4, 0, Math.PI*2); g.fill();
  text(row.status, pipX + 10, cy2 + 21, { size: 9, color: statusColor, letter: 1.4 });
}

// ---- P: PROGRESS ----
frame(P.x, P.y, P.w, P.h, { label: "PROGRESS" });

function progressBar(x, y, w, label, value, total, color) {
  text(label, x, y + 10, { size: 10, color: PHOS_DIM, letter: 2 });
  const pct = value / total;
  const pctStr = (pct * 100).toFixed(1) + "%";
  text(`${value.toLocaleString()} / ${total.toLocaleString()}`, x + w, y + 10, { size: 11, color: PHOS, letter: 1, align: "right" });

  const barY = y + 22;
  const barH = 14;
  // track
  g.fillStyle = "rgba(62,224,139,0.08)";
  g.fillRect(x, barY, w, barH);
  g.strokeStyle = RULE_HARD;
  g.strokeRect(x + 0.5, barY + 0.5, w, barH);
  // fill
  g.save();
  g.shadowColor = color;
  g.shadowBlur = 8;
  g.fillStyle = color;
  g.fillRect(x + 2, barY + 2, Math.max(2, (w - 4) * pct), barH - 4);
  g.restore();

  // tick marks every 10%
  g.strokeStyle = "rgba(0,0,0,0.45)";
  for (let i = 1; i < 10; i++) {
    const tx = x + (w * i / 10);
    g.beginPath(); g.moveTo(tx, barY); g.lineTo(tx, barY + barH); g.stroke();
  }

  // clamp label so it never crosses bar edges
  const labelX = Math.max(x + 28, Math.min(x + w - 28, x + w * pct));
  text(pctStr, labelX, barY + barH + 18, { size: 11, color, letter: 1, align: "center" });
}

progressBar(P.x + 28, P.y + 24, P.w - 56, "YOUR  SLICE  ·  fbi-62hq83894",   13, 179, AMBER);
progressBar(P.x + 28, P.y + 76, P.w - 56, "GLOBAL  CORPUS  ·  pages OCR'd", 4128, 8742, PHOS);

// ---- footer hair ----
g.strokeStyle = RULE;
g.beginPath(); g.moveTo(32, H - 28); g.lineTo(W-32, H - 28); g.stroke();
text("polling /progress every 1s   ·   monitor :9224   ·   built by hand, run by you", 32, H - 14, { size: 10, color: TEXT_DIM, letter: 1.4 });
text("HELMSMAN  COCKPIT  ·  01", W - 32, H - 14, { size: 10, color: PHOS_DIM, letter: 2, align: "right" });

// final vignette pass
const vg = g.createRadialGradient(W/2, H/2, Math.max(W,H)*0.35, W/2, H/2, Math.max(W,H)*0.75);
vg.addColorStop(0, "rgba(0,0,0,0)");
vg.addColorStop(1, "rgba(0,0,0,0.55)");
g.fillStyle = vg;
g.fillRect(0, 0, W, H);

writeFileSync("F:/toxicavenger/disclosure/helmsman-cockpit.png", c.toBuffer("image/png"));
console.log("wrote helmsman-cockpit.png");
