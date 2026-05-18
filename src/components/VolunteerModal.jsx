import React from "react";

// The primary CTA of the entire site. Two paths: machine OCR (volunteer
// script does the work) or hand-typed (you literally type a page out).
// Both produce PRs that go through the same validator.

export default function VolunteerModal({ open, onClose }) {
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

        <div className="px-5 py-4 space-y-5 text-emerald-300 text-[12px] leading-relaxed">
          <p className="text-emerald-200">
            Two ways to help, both go through the same validator and land in the search index.
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

          <p className="text-emerald-700 text-[10px] font-mono">
            Every contribution gets credited to your handle in the corpus DB. You stay in your own GitHub account; no central server holds your work.
          </p>
        </div>
      </div>
    </div>
  );
}
