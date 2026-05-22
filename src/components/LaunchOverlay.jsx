import React, { useEffect, useRef, useState } from "react";

// One-time launch overlay for the 2.0 drop. Shows the declassified DVIDS
// sensor footage inline and hypes the release. Once dismissed it never
// shows again (localStorage gate lives in App — this component just calls
// onClose). Motion follows Emil Kowalski's playbook: ease-out entrances,
// blur+scale reveals, staggered children, transform/opacity/filter only.

const SEEN_KEY = "pursue:launch-2.0-seen";

// Curated, ranked. Each clip is real DVIDS sensor footage from Release 01.
const CLIPS = [
  { videoId: "1006073", code: "PR-28", tag: "SWIR-ONLY DIAMOND",   loc: "Mediterranean Sea", flag: "anchor", line: 'Diamond with a probe at ~434 kts — visible ONLY on short-wave IR. Invisible to the naked eye.' },
  { videoId: "1006106", code: "PR-46", tag: "FOOTBALL-SHAPED BODY", loc: "East China Sea",     flag: "anchor", line: "Football body with three radial projections. The most distinctive morphology in the tranche." },
  { videoId: "1006080", code: "PR-34", tag: 'SEA-SKIM "90° TURNS"', loc: "Aegean Sea",         flag: "anchor", line: 'Multiple 90-degree turns at ~80 mph, just above the ocean surface.' },
  { videoId: "1006083", code: "PR-36", tag: "ERRATIC WHITE OBJECT", loc: "Persian Gulf",        flag: "high",   line: 'Solid white object moving erratically over water. Sensor never achieved a lock.' },
  { videoId: "1006074", code: "PR-29", tag: "INVERTED TEARDROP",    loc: "Gulf of Oman",        flag: "high",   line: "Inverted-teardrop contrast with a trailing linear mass at 24,000 ft." },
  { videoId: "1006076", code: "PR-31", tag: '"HALO EFFECT" CLUSTER', loc: "Syria",              flag: "high",   line: 'Misshapen ball of white light with a glare/halo of "unknown origin."' },
  { videoId: "1006111", code: "PR-49", tag: "TWO OBJECTS · NEWEST",  loc: "North America",      flag: "high",   line: "Sensor disengages and pans to track two areas of contrast. The most recent clip released." },
];

const FLAG_COLOR = {
  anchor: "text-amber-300 border-amber-500/60",
  high: "text-emerald-300 border-emerald-500/50",
  med: "text-cyan-300 border-cyan-600/50",
};

function RadarCanvas() {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    let w = 0, h = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
    const blips = Array.from({ length: 26 }, () => ({
      a: Math.random() * Math.PI * 2,
      r: 0.12 + Math.random() * 0.86,
      born: Math.random(),
      life: 0.5 + Math.random(),
    }));

    const resize = () => {
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    let sweep = 0, raf = 0;
    const draw = () => {
      const cx = w / 2, cy = h / 2;
      const R = Math.hypot(w, h) * 0.62;
      ctx.clearRect(0, 0, w, h);

      // concentric rings
      ctx.lineWidth = 1;
      for (let i = 1; i <= 5; i++) {
        ctx.beginPath();
        ctx.arc(cx, cy, (R * i) / 5, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(16,185,129,${0.04 + i * 0.012})`;
        ctx.stroke();
      }
      // cross hairs
      ctx.strokeStyle = "rgba(16,185,129,0.05)";
      ctx.beginPath();
      ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
      ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
      ctx.stroke();

      // sweep wedge with fading trail
      const grad = ctx.createConicGradient
        ? ctx.createConicGradient(sweep, cx, cy)
        : null;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, sweep - 0.55, sweep);
      ctx.closePath();
      if (grad) {
        grad.addColorStop(0, "rgba(16,185,129,0)");
        grad.addColorStop(0.94, "rgba(16,185,129,0)");
        grad.addColorStop(1, "rgba(52,211,153,0.22)");
        ctx.fillStyle = grad;
      } else {
        ctx.fillStyle = "rgba(52,211,153,0.10)";
      }
      ctx.fill();
      ctx.restore();

      // leading edge line
      ctx.strokeStyle = "rgba(110,231,183,0.35)";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(sweep) * R, cy + Math.sin(sweep) * R);
      ctx.stroke();

      // blips — flash when the sweep passes over them
      for (const b of blips) {
        const bx = cx + Math.cos(b.a) * b.r * R;
        const by = cy + Math.sin(b.a) * b.r * R;
        let diff = ((sweep - b.a) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
        const intensity = Math.max(0, 1 - diff / (0.9 * b.life));
        if (intensity > 0.01) {
          ctx.beginPath();
          ctx.arc(bx, by, 1.5 + intensity * 2.5, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(110,231,183,${intensity * 0.8})`;
          ctx.fill();
        }
      }

      if (!reduce) {
        sweep += 0.012;
        raf = requestAnimationFrame(draw);
      }
    };
    draw();

    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); };
  }, []);

  return <canvas ref={ref} className="absolute inset-0 w-full h-full" aria-hidden="true" />;
}

export default function LaunchOverlay({ onClose }) {
  const [active, setActive] = useState(0);
  const [closing, setClosing] = useState(false);
  const [swapKey, setSwapKey] = useState(0);
  const clip = CLIPS[active];

  const dismiss = () => {
    if (closing) return;
    setClosing(true);
    try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* private mode */ }
    setTimeout(onClose, 320);
  };

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") dismiss(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, []);

  const pick = (i) => { if (i !== active) { setActive(i); setSwapKey(k => k + 1); } };

  return (
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-6 bg-black/85 backdrop-blur-md ${closing ? "lo-backdrop-out" : "lo-backdrop-in"}`}
      onClick={dismiss}
      role="dialog" aria-modal="true" aria-label="PURSUE Console 2.0 launch"
      style={{ fontFamily: "'IBM Plex Mono','JetBrains Mono',monospace" }}
    >
      <style>{`
        @keyframes loBackdropIn { from { opacity: 0; backdrop-filter: blur(0); } to { opacity: 1; } }
        @keyframes loBackdropOut { from { opacity: 1; } to { opacity: 0; } }
        @keyframes loPanelIn { from { opacity: 0; transform: scale(0.965) translateY(14px); filter: blur(8px); } to { opacity: 1; transform: scale(1) translateY(0); filter: blur(0); } }
        @keyframes loPanelOut { from { opacity: 1; transform: scale(1) translateY(0); filter: blur(0); } to { opacity: 0; transform: scale(0.97) translateY(6px); filter: blur(6px); } }
        @keyframes loRise { from { opacity: 0; transform: translateY(12px); filter: blur(5px); } to { opacity: 1; transform: translateY(0); filter: blur(0); } }
        @keyframes loSwap { from { opacity: 0; filter: blur(7px); transform: scale(1.012); } to { opacity: 1; filter: blur(0); transform: scale(1); } }
        @keyframes loPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
        .lo-backdrop-in { animation: loBackdropIn 260ms cubic-bezier(0.23,1,0.32,1) both; }
        .lo-backdrop-out { animation: loBackdropOut 300ms cubic-bezier(0.23,1,0.32,1) both; }
        .lo-panel-in { animation: loPanelIn 460ms cubic-bezier(0.23,1,0.32,1) both; }
        .lo-panel-out { animation: loPanelOut 300ms cubic-bezier(0.32,0.72,0,1) both; }
        .lo-rise { animation: loRise 520ms cubic-bezier(0.23,1,0.32,1) both; }
        .lo-swap { animation: loSwap 380ms cubic-bezier(0.23,1,0.32,1) both; }
        .lo-pulse { animation: loPulse 1.8s ease-in-out infinite; }
        .lo-card { transition: transform 220ms cubic-bezier(0.23,1,0.32,1), border-color 220ms, background-color 220ms, box-shadow 220ms; }
        .lo-card:hover { transform: translateY(-2px); }
        .lo-cta { transition: transform 160ms cubic-bezier(0.23,1,0.32,1), box-shadow 200ms, background-color 200ms; }
        .lo-cta:hover { transform: translateY(-1px); box-shadow: 0 0 36px rgba(52,211,153,0.4); }
        .lo-cta:active { transform: scale(0.975); }
        @media (prefers-reduced-motion: reduce) {
          .lo-panel-in,.lo-backdrop-in,.lo-rise,.lo-swap,.lo-pulse,.lo-panel-out,.lo-backdrop-out { animation: none !important; }
        }
      `}</style>

      <div
        onClick={e => e.stopPropagation()}
        className={`relative w-full max-w-5xl max-h-[94vh] overflow-y-auto no-scrollbar bg-[#020806]/95 border border-emerald-700/50 rounded-md shadow-[0_0_80px_rgba(16,185,129,0.18)] ${closing ? "lo-panel-out" : "lo-panel-in"}`}
      >
        <RadarCanvas />

        <button
          onClick={dismiss} aria-label="Close"
          className="absolute top-3 right-3 z-20 text-emerald-700 hover:text-emerald-200 text-lg leading-none w-7 h-7 flex items-center justify-center rounded-sm border border-emerald-900/60 hover:border-emerald-600/60 transition-colors"
        >×</button>

        <div className="relative z-10 px-5 sm:px-9 py-7 sm:py-9">
          {/* Eyebrow */}
          <div className="lo-rise flex items-center gap-2 text-[10px] tracking-[0.4em] text-emerald-600" style={{ animationDelay: "60ms" }}>
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 lo-pulse" />
            INCOMING TRANSMISSION · WAR.GOV/UFO
          </div>

          {/* Hero */}
          <div className="lo-rise mt-3" style={{ animationDelay: "120ms" }}>
            <h1 className="leading-[0.85] font-semibold text-emerald-100">
              <span className="block text-[13px] sm:text-[15px] tracking-[0.5em] text-emerald-500 mb-1">PURSUE CONSOLE</span>
              <span className="block text-[64px] sm:text-[104px] tracking-tight text-emerald-300" style={{ textShadow: "0 0 40px rgba(52,211,153,0.45)" }}>
                2.0<span className="text-amber-300">.</span>
              </span>
            </h1>
            <p className="mt-3 max-w-2xl text-[12px] sm:text-[13px] leading-relaxed text-emerald-400">
              The disclosure drop is <span className="text-emerald-100">live</span>. Declassified sensor footage,
              full-text reading mode, the entity-network graph, semantic search — all unlocked.
              Start with the clips the analysts couldn't explain.
            </p>
          </div>

          {/* Featured player */}
          <div className="lo-rise mt-6 grid lg:grid-cols-[1.6fr_1fr] gap-5" style={{ animationDelay: "200ms" }}>
            <div>
              <div className="relative aspect-video w-full overflow-hidden rounded-sm border border-emerald-700/40 bg-black">
                <iframe
                  key={swapKey}
                  className="lo-swap absolute inset-0 w-full h-full"
                  src={`https://www.dvidshub.net/video/embed/${clip.videoId}`}
                  title={`${clip.code} — ${clip.tag}`}
                  allow="autoplay; fullscreen; picture-in-picture"
                  allowFullScreen
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                />
              </div>
              <div key={`meta-${swapKey}`} className="lo-swap mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className={`text-[9px] tracking-[0.25em] px-1.5 py-0.5 border rounded-sm ${FLAG_COLOR[clip.flag]}`}>{clip.flag.toUpperCase()}</span>
                <span className="text-[12px] tracking-[0.18em] text-emerald-200">{clip.code} · {clip.tag}</span>
                <span className="text-[10px] tracking-widest text-emerald-600">{clip.loc}</span>
                <a
                  href={`https://www.dvidshub.net/video/${clip.videoId}`}
                  target="_blank" rel="noopener noreferrer"
                  className="text-[10px] tracking-widest text-emerald-500 hover:text-emerald-200 underline underline-offset-2 ml-auto"
                >WATCH ON DVIDS ↗</a>
              </div>
              <p key={`line-${swapKey}`} className="lo-swap mt-1.5 text-[12px] leading-relaxed text-emerald-400">{clip.line}</p>
            </div>

            {/* Clip selector */}
            <div className="flex flex-col gap-1.5">
              <div className="text-[9px] tracking-[0.3em] text-emerald-700 mb-0.5">▌ DECLASSIFIED REEL · {CLIPS.length}</div>
              <div className="flex flex-col gap-1.5 max-h-[340px] overflow-y-auto no-scrollbar pr-0.5">
                {CLIPS.map((c, i) => (
                  <button
                    key={c.videoId}
                    onClick={() => pick(i)}
                    className={`lo-card text-left px-3 py-2 rounded-sm border bg-emerald-950/10 ${
                      i === active
                        ? "border-emerald-500/70 bg-emerald-900/25 shadow-[0_0_18px_rgba(16,185,129,0.2)]"
                        : "border-emerald-900/50 hover:border-emerald-700/60 hover:bg-emerald-950/30"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] ${i === active ? "text-amber-300" : "text-emerald-600"}`}>{i === active ? "▶" : "▷"}</span>
                      <span className={`text-[11px] tracking-[0.14em] truncate ${i === active ? "text-emerald-100" : "text-emerald-300"}`}>{c.tag}</span>
                    </div>
                    <div className="mt-0.5 pl-[18px] text-[9px] tracking-widest text-emerald-700">{c.code} · {c.loc}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* CTA */}
          <div className="lo-rise mt-7 flex flex-col sm:flex-row items-center gap-3" style={{ animationDelay: "300ms" }}>
            <button
              onClick={dismiss}
              className="lo-cta w-full sm:w-auto px-7 py-2.5 rounded-sm bg-emerald-400 text-[#020806] text-[12px] font-semibold tracking-[0.25em] hover:bg-emerald-300"
            >ENTER CONSOLE →</button>
            <span className="text-[9px] tracking-[0.25em] text-emerald-700">ALL CASES UNRESOLVED · RELEASE 01 · MAY 8 2026</span>
            <button onClick={dismiss} className="text-[9px] tracking-[0.25em] text-emerald-800 hover:text-emerald-500 sm:ml-auto">SKIP INTRO</button>
          </div>
        </div>
      </div>
    </div>
  );
}
