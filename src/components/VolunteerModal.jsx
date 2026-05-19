import React, { useEffect, useState } from "react";

// The primary CTA of the entire site. The priority ladder up top mirrors
// the HELP view: settle disputes first, then transcribe new pages, then
// (next phase) extract embedded images. After the ladder, the two
// machine-OCR vs hand-typed setup paths.

export default function VolunteerModal({ open, onClose, onViewChange }) {
  const [reviewCount, setReviewCount] = useState(null);
  useEffect(() => {
    if (!open) return;
    fetch(`${import.meta.env.BASE_URL}corpus-stats.json?t=${Date.now()}`)
      .then(r => r.ok ? r.json() : null)
      .then(j => setReviewCount(j?.review?.pagesNeedingReview ?? null))
      .catch(() => {});
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
         onClick={onClose}
         role="dialog" aria-modal="true" aria-labelledby="vol-title">
      <div onClick={e => e.stopPropagation()}
           className="max-w-2xl w-full bg-black border border-amber-700/60 rounded-sm shadow-[0_0_40px_rgba(245,176,66,0.15)] max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-3 border-b border-amber-900/50">
          <h2 id="vol-title" className="font-mono text-[11px] tracking-[0.3em] text-amber-300">+ VOLUNTEER</h2>
          <button onClick={onClose} aria-label="Close"
            className="text-amber-700 hover:text-amber-300 font-mono text-sm">×</button>
        </div>

        <div className="px-5 py-4 space-y-4 text-emerald-300 text-[12px] leading-relaxed">
          {/* Priority ladder — same shape, same wording as HELP view */}
          {reviewCount > 0 && (
            <div className="border border-amber-500/60 bg-amber-950/20 rounded-sm p-3">
              <div className="flex items-baseline justify-between mb-1">
                <span className="font-mono text-[10px] tracking-[0.25em] text-amber-300">PRIORITY 1 · DO THIS FIRST</span>
                <span className="font-mono text-[18px] tabular-nums text-amber-300">{reviewCount}</span>
              </div>
              <div className="font-mono text-emerald-100 text-[12px]">Settle the {reviewCount} disputed pages where Gemini and ChatGPT disagree.</div>
              <div className="font-mono text-emerald-500 text-[11px] mt-1">Read both transcriptions side-by-side, type the correct version. One disputed page resolved = canonical text settled forever.</div>
              <div className="flex gap-2 mt-2">
                <button onClick={() => { onClose(); onViewChange?.("review"); }}
                  className="font-mono text-[10px] tracking-widest border border-amber-500 text-amber-200 hover:bg-amber-700/30 px-2.5 py-1 rounded-sm">
                  OPEN REVIEW QUEUE →
                </button>
              </div>
            </div>
          )}
          <div className="font-mono text-[10px] tracking-[0.25em] text-emerald-700">
            {reviewCount > 0 ? "PRIORITY 2 · ALSO OPEN" : "PRIMARY"} · TRANSCRIBE NEW PAGES
          </div>
          <p className="text-emerald-400 text-[11px] -mt-2">
            Two setup paths below — both go through the same validator and land in the search index.
          </p>

          {/* Machine OCR path */}
          <div className="border border-emerald-900/60 rounded-sm">
            <div className="px-3 py-2 border-b border-emerald-900/40 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span className="font-mono text-[10px] tracking-widest text-emerald-300">PATH A · MACHINE OCR (CHATGPT PLUS REQUIRED)</span>
            </div>
            <div className="px-3 py-3 space-y-2">
              <p className="text-emerald-500 text-[11px]">
                Picks pages off the public queue, transcribes them via your already-logged-in ChatGPT browser, opens a PR. No API key, no payment, ~30 min of mostly-idle compute.
              </p>
              <pre className="bg-black/60 border border-emerald-900/50 rounded-sm p-3 text-emerald-200 text-[11px] overflow-x-auto">
{`git clone --depth 1 https://github.com/rizzleroc/pursue-console
cd pursue-console
npm install --prefix pursue-vision-mcp
npm start --prefix pursue-vision-mcp
npm run volunteer -- --my-handle=YOUR_NAME --slice=20`}
              </pre>
              <a href="https://github.com/rizzleroc/pursue-console/blob/main/HOW-CAN-I-HELP.md"
                 target="_blank" rel="noreferrer"
                 className="inline-block font-mono text-[10px] tracking-widest text-emerald-400 hover:text-emerald-200 underline underline-offset-2">
                full setup guide →
              </a>
            </div>
          </div>

          {/* Hand-typed path */}
          <div className="border border-amber-900/60 rounded-sm">
            <div className="px-3 py-2 border-b border-amber-900/40 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              <span className="font-mono text-[10px] tracking-widest text-amber-300">PATH B · HAND-TYPED (NO TOOLS REQUIRED)</span>
            </div>
            <div className="px-3 py-3 space-y-2">
              <p className="text-amber-200/90 text-[11px]">
                Read a page from the source PDF, type it out word-for-word, save as <code className="text-amber-300">.txt</code>, open a PR. One hand-typed page outranks every machine transcription for that page and is used as <em>gold</em> to calibrate every machine source.
              </p>
              <pre className="bg-black/60 border border-amber-900/50 rounded-sm p-3 text-amber-200 text-[11px] overflow-x-auto">
{`contributions/YOUR_NAME/human/EVENT_ID/p0042.txt`}
              </pre>
              <p className="text-amber-700 text-[10px] font-mono">
                Pick from the REVIEW queue first — those are the pages where machine sources currently disagree, so your eyes pay off most.
              </p>
            </div>
          </div>

          <div className="border border-cyan-700/60 bg-cyan-900/10 rounded-sm p-3">
            <div className="font-mono text-[10px] tracking-[0.25em] text-cyan-300 mb-1">PRIORITY 3 · OPEN NOW</div>
            <div className="font-mono text-emerald-100 text-[12px]">Screenshot the visuals + context</div>
            <div className="font-mono text-emerald-400 text-[11px] mt-1">
              For pages with photographs, hand-drawings, newspaper clippings, maps, or diagrams: capture the page image and write the documentary context (verbatim quotes from the surrounding pages). Two-phase: claim → fill template → commit.
            </div>
            <pre className="bg-black/60 border border-cyan-900/50 rounded-sm p-3 text-cyan-200 text-[11px] overflow-x-auto mt-2">
{`# Claim 5 pages → renders them locally + drops markdown templates
node scripts/volunteer-media.mjs --my-handle=YOU --slice=5

# Fill in Title / Context per page in ~/.pursue-helper/media-staging/
# Then:
node scripts/volunteer-media.mjs --my-handle=YOU --commit`}
            </pre>
            <a href="https://github.com/rizzleroc/pursue-console/blob/main/VISUAL-EXTRACTION-PROCESS.md"
               target="_blank" rel="noreferrer"
               className="inline-block font-mono text-[10px] tracking-widest text-cyan-400 hover:text-cyan-200 underline underline-offset-2 mt-2">
              full visual-extraction spec →
            </a>
          </div>
          <p className="text-emerald-700 text-[10px] font-mono">
            Every contribution gets credited to your handle in <a href="https://github.com/rizzleroc/pursue-console/blob/main/CONTRIBUTORS.md" target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline text-emerald-500">CONTRIBUTORS.md</a> (auto-generated). The handle you pass to <code>--my-handle</code> becomes <strong>public in the corpus DB and in the PR you open</strong> — use whatever you'd want shown. You stay in your own GitHub account; no central server holds your work.
          </p>
          <p className="text-emerald-700 text-[10px] font-mono">
            Before your first run, sanity-check your setup in 30 seconds: <code className="text-amber-300">npm run corpus:setup -- --my-handle=YOU</code>
          </p>
        </div>
      </div>
    </div>
  );
}
