import React from "react";
import useCorpusStats from "../hooks/useCorpusStats.js";
import { useT } from "../i18n/context.js";

// The primary CTA of the entire site. The priority ladder up top mirrors
// the HELP view: settle disputes first, then transcribe new pages, then
// (next phase) extract embedded images. After the ladder, the two
// machine-OCR vs hand-typed setup paths.

// Split a translated template on placeholder tokens like {foo} so the
// caller can drop real JSX (links / code spans) into the gaps without
// using dangerouslySetInnerHTML. Tokens are returned interleaved with
// the literal text segments, so the consumer just maps over the result.
function interleave(template, slots) {
  if (typeof template !== "string") return [template];
  const parts = template.split(/(\{\w+\})/g);
  return parts.map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    if (m && Object.prototype.hasOwnProperty.call(slots, m[1])) {
      const node = slots[m[1]];
      return React.isValidElement(node)
        ? React.cloneElement(node, { key: `s-${i}-${m[1]}` })
        : <React.Fragment key={`s-${i}-${m[1]}`}>{node}</React.Fragment>;
    }
    return <React.Fragment key={`t-${i}`}>{part}</React.Fragment>;
  });
}

export default function VolunteerModal({ open, onClose, onViewChange }) {
  const { stats } = useCorpusStats();
  const t = useT();
  const reviewCount = stats?.review?.pagesNeedingReview ?? null;
  if (!open) return null;

  const providerHint = interleave(t("volunteer.path_a_provider_hint"), {
    chatgpt: <code className="text-emerald-300">--provider=chatgpt</code>,
    gemini: <code className="text-emerald-300">--provider=gemini</code>,
    claude: <code className="text-orange-300">--provider=claude</code>,
    claudeLink: <a href="https://claude.ai" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-orange-200">claude.ai</a>,
  });
  const pathBBody = interleave(t("volunteer.path_b_body"), {
    ext: <code className="text-amber-300">.txt</code>,
  });
  const creditNote = interleave(t("volunteer.credit_note"), {
    contributorsLink: <a href="https://github.com/rizzleroc/pursue-console/blob/main/CONTRIBUTORS.md" target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline text-emerald-500">CONTRIBUTORS.md</a>,
    flag: <code>--my-handle</code>,
  });
  const sanityCheck = interleave(t("volunteer.sanity_check"), {
    cmd: <code className="text-amber-300">npm run corpus:setup -- --my-handle=YOU</code>,
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
         onClick={onClose}
         role="dialog" aria-modal="true" aria-labelledby="vol-title">
      <div onClick={e => e.stopPropagation()}
           className="max-w-2xl w-full bg-black border border-amber-700/60 rounded-sm shadow-[0_0_40px_rgba(245,176,66,0.15)] max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-3 border-b border-amber-900/50">
          <h2 id="vol-title" className="font-mono text-[11px] tracking-[0.3em] text-amber-300">{t("volunteer.title")}</h2>
          <button onClick={onClose} aria-label={t("volunteer.close")}
            className="text-amber-700 hover:text-amber-300 font-mono text-sm">×</button>
        </div>

        <div className="px-5 py-4 space-y-4 text-emerald-300 text-[12px] leading-relaxed">
          {/* Priority ladder — same shape, same wording as HELP view */}
          {reviewCount > 0 && (
            <div className="border border-amber-500/60 bg-amber-950/20 rounded-sm p-3">
              <div className="flex items-baseline justify-between mb-1">
                <span className="font-mono text-[10px] tracking-[0.25em] text-amber-300">{t("volunteer.priority1_label")}</span>
                <span className="font-mono text-[18px] tabular-nums text-amber-300">{reviewCount}</span>
              </div>
              <div className="font-mono text-emerald-100 text-[12px]">{t("volunteer.priority1_lead", { count: reviewCount })}</div>
              <div className="font-mono text-emerald-500 text-[11px] mt-1">{t("volunteer.priority1_body")}</div>
              <div className="flex gap-2 mt-2">
                <button onClick={() => { onClose(); onViewChange?.("review"); }}
                  className="font-mono text-[10px] tracking-widest border border-amber-500 text-amber-200 hover:bg-amber-700/30 px-2.5 py-1 rounded-sm">
                  {t("volunteer.priority1_cta")}
                </button>
              </div>
            </div>
          )}
          <div className="font-mono text-[10px] tracking-[0.25em] text-emerald-700">
            {reviewCount > 0 ? t("volunteer.priority2_label_with_review") : t("volunteer.priority2_label_primary")} · {t("volunteer.transcribe_heading")}
          </div>
          <p className="text-emerald-400 text-[11px] -mt-2">
            {t("volunteer.transcribe_lead")}
          </p>

          {/* Machine OCR path */}
          <div className="border border-emerald-900/60 rounded-sm">
            <div className="px-3 py-2 border-b border-emerald-900/40 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span className="font-mono text-[10px] tracking-widest text-emerald-300">{t("volunteer.path_a_label")}</span>
            </div>
            <div className="px-3 py-3 space-y-2">
              <p className="text-emerald-500 text-[11px]">
                {t("volunteer.path_a_body")}
              </p>
              <pre className="bg-black/60 border border-emerald-900/50 rounded-sm p-3 text-emerald-200 text-[11px] overflow-x-auto">
{`git clone --depth 1 https://github.com/rizzleroc/pursue-console
cd pursue-console
npm install --prefix pursue-vision-mcp
npm start --prefix pursue-vision-mcp
npm run volunteer -- --my-handle=YOUR_NAME --slice=20`}
              </pre>
              <p className="text-emerald-700 text-[10px] font-mono">
                {providerHint}
              </p>
              <a href="https://github.com/rizzleroc/pursue-console/blob/main/HOW-CAN-I-HELP.md"
                 target="_blank" rel="noreferrer"
                 className="inline-block font-mono text-[10px] tracking-widest text-emerald-400 hover:text-emerald-200 underline underline-offset-2">
                {t("volunteer.path_a_setup_link")}
              </a>
            </div>
          </div>

          {/* Hand-typed path */}
          <div className="border border-amber-900/60 rounded-sm">
            <div className="px-3 py-2 border-b border-amber-900/40 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              <span className="font-mono text-[10px] tracking-widest text-amber-300">{t("volunteer.path_b_label")}</span>
            </div>
            <div className="px-3 py-3 space-y-2">
              <p className="text-amber-200/90 text-[11px]">
                {pathBBody}
              </p>
              <pre className="bg-black/60 border border-amber-900/50 rounded-sm p-3 text-amber-200 text-[11px] overflow-x-auto">
{`contributions/YOUR_NAME/human/EVENT_ID/p0042.txt`}
              </pre>
              <p className="text-amber-700 text-[10px] font-mono">
                {t("volunteer.path_b_hint")}
              </p>
            </div>
          </div>

          <div className="border border-cyan-700/60 bg-cyan-900/10 rounded-sm p-3">
            <div className="font-mono text-[10px] tracking-[0.25em] text-cyan-300 mb-1">{t("volunteer.priority3_label")}</div>
            <div className="font-mono text-emerald-100 text-[12px]">{t("volunteer.priority3_title")}</div>
            <div className="font-mono text-emerald-400 text-[11px] mt-1">
              {t("volunteer.priority3_body")}
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
              {t("volunteer.priority3_spec_link")}
            </a>
          </div>
          <p className="text-emerald-700 text-[10px] font-mono">
            {creditNote}
          </p>
          <p className="text-emerald-700 text-[10px] font-mono">
            {sanityCheck}
          </p>
        </div>
      </div>
    </div>
  );
}
