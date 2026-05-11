import React, { useEffect, useState } from "react";

// READING MODE — embeds the actual PDF from war.gov inside the app.
// The browser's built-in PDF viewer (and pdfjs in supporting browsers)
// handles fonts, scans, JBig2 images, scaling — everything OCR struggles with.
// If war.gov sends X-Frame-Options: DENY we surface a clean "open at war.gov"
// fallback. Either way, the user always has a one-click escape hatch.
//
// For photo-set / handwritten / sketch records we explicitly note the doc
// kind so the reader's expectations are calibrated before they look.

const DOC_TYPE_NOTE = {
  photoset:    { label: "PHOTOGRAPH SET",      body: "This record is a collection of still images. There is no narrative text to transcribe — the photographs themselves are the evidence. View them in the embedded PDF below." },
  handwritten: { label: "HANDWRITTEN",         body: "This record is handwritten and not machine-transcribed. View the original below to read it." },
  sketch:      { label: "COMPOSITE / SKETCH",  body: "This record is or contains a sketch / composite drawing. The image is the primary content." },
  annotated:   { label: "ANNOTATED IMAGE",     body: "A still image with operator annotations. View it below." },
  mixed:       { label: "MIXED (TEXT + IMAGE)",body: "Mix of typed text and image content. The PDF below shows the original." },
};

export default function ReadingMode({ event, onClose }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);

    // If the iframe never sets onload within 8s, assume it's blocked.
    const timer = setTimeout(() => { if (!loaded) setFailed(true); }, 8000);
    return () => { window.removeEventListener("keydown", onKey); clearTimeout(timer); };
  }, [event.id, loaded, onClose]);

  const dt = event.docType ? DOC_TYPE_NOTE[event.docType] : null;
  const sourceUrl = event.url;

  return (
    <div className="fixed inset-0 z-[60] bg-[#020806]/95 backdrop-blur-sm flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-3 sm:px-6 py-3 border-b border-emerald-700/40 flex-wrap">
        <button onClick={onClose} className="font-mono text-[11px] text-emerald-500 hover:text-amber-400 tracking-wider">◀ CLOSE</button>
        <div className="font-mono text-[10px] text-emerald-700">▌ READING MODE</div>
        <div className="font-mono text-[11px] text-emerald-300 flex-1 min-w-0 truncate">{event.title}</div>
        {sourceUrl && (
          <a href={sourceUrl} target="_blank" rel="noopener noreferrer"
            className="font-mono text-[10px] text-amber-300 hover:text-amber-100 px-2 py-1 border border-amber-400/40 rounded-sm tracking-wider">
            OPEN AT WAR.GOV ↗
          </a>
        )}
      </div>

      {/* Doc-type note */}
      {dt && (
        <div className="px-3 sm:px-6 py-2 border-b border-emerald-700/20 bg-amber-400/5">
          <div className="max-w-3xl mx-auto font-mono text-[11px] text-amber-300">
            <span className="text-amber-400 tracking-widest">▌ {dt.label}</span>
            <span className="ml-2 text-emerald-300/80">— {dt.body}</span>
          </div>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-hidden bg-black/40 relative">
        {!sourceUrl ? (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div className="max-w-md text-center font-mono text-[12px] text-emerald-600 leading-relaxed">
              <div className="text-amber-400 tracking-widest mb-3">▌ NO PDF FOR THIS RECORD</div>
              This entry references a video, image set, or summary that has no associated PDF in Release 01. See the dossier for primary-source links.
            </div>
          </div>
        ) : (
          <>
            <iframe
              key={event.id}
              src={sourceUrl}
              title={event.title}
              onLoad={() => setLoaded(true)}
              className="w-full h-full border-0 bg-white"
            />
            {failed && !loaded && (
              <div className="absolute inset-0 flex items-center justify-center p-6 bg-[#020806]/95 backdrop-blur-sm">
                <div className="max-w-md text-center font-mono text-[12px] text-emerald-300 leading-relaxed">
                  <div className="text-amber-400 tracking-widest mb-3">▌ EMBED BLOCKED</div>
                  war.gov is not allowing this PDF to be embedded from another site. Open it directly:
                  <div className="mt-4">
                    <a href={sourceUrl} target="_blank" rel="noopener noreferrer"
                      className="inline-block px-4 py-2 border border-amber-400/60 bg-amber-400/10 text-amber-200 tracking-widest hover:bg-amber-400/20 rounded-sm">
                      OPEN AT WAR.GOV ↗
                    </a>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
