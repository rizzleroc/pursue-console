// Highlight occurrences of query terms inside a plaintext block. Returns
// an array of React nodes (plain spans + <mark> for hits) so it can be
// dropped straight into JSX.
//
// `qTerms` is an array of lowercase tokens — the same shape Semantic
// Search produces from `committed.toLowerCase().split(/\s+/).filter(t => t.length >= 3)`.
// When the array is empty the original text is returned unchanged so
// callers can use this unconditionally.
import React from "react";

export function highlightQuery(text, qTerms) {
  if (!qTerms || !qTerms.length || !text) return text;
  try {
    const safe = qTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const re = new RegExp(`(${safe})`, "ig");
    return text.split(re).map((s, i) =>
      re.test(s)
        ? <mark key={i} className="bg-amber-400/40 text-amber-100 px-0.5 rounded-sm">{s}</mark>
        : <span key={i}>{s}</span>
    );
  } catch {
    return text;
  }
}
