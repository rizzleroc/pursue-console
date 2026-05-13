#!/usr/bin/env python3
"""Quick diagnostic: how much of the embedded corpus is OCR noise?"""
import json, re, statistics as st
from pathlib import Path
from urllib.request import urlretrieve

ROOT = Path(__file__).resolve().parent.parent

# Use a bundled wordlist if available, else fetch a small one.
words_path = ROOT / "scripts" / ".words.txt"
if not words_path.exists():
    # Public-domain ~10K most common English words
    print("[diag] fetching wordlist…")
    urlretrieve("https://raw.githubusercontent.com/first20hours/google-10000-english/master/google-10000-english.txt", words_path)
common = {w.strip().lower() for w in words_path.read_text().splitlines() if len(w.strip()) >= 3}
print(f"[diag] wordlist size: {len(common)}")

def quality(text):
    toks = re.findall(r"[A-Za-z']+", text)
    if len(toks) < 5: return None
    real = sum(1 for t in toks if 3 <= len(t) <= 20 and t.lower() in common)
    return real / len(toks)

meta = json.load(open(ROOT / "public/embeddings-meta.json"))
manifest = json.load(open(ROOT / "public/text/manifest.json"))
ocr_ids = {k for k,v in manifest.items() if v["source"] == "ocr"}

scores_ocr, scores_pdf = [], []
sample_bad, sample_good = [], []
for m in meta:
    if m["kind"] == "meta": continue
    q = quality(m["snippet"])
    if q is None: continue
    if m["eventId"] in ocr_ids:
        scores_ocr.append(q)
        if q < 0.20 and len(sample_bad) < 4:
            sample_bad.append((m["eventId"], m["page"], q, m["snippet"]))
    else:
        scores_pdf.append(q)
        if q > 0.65 and len(sample_good) < 3:
            sample_good.append((m["eventId"], m["page"], q, m["snippet"]))

print(f"\nPDFjs chunks (n={len(scores_pdf)}):  median q={st.median(scores_pdf):.2f}  mean={st.mean(scores_pdf):.2f}")
print(f"OCR   chunks (n={len(scores_ocr)}):  median q={st.median(scores_ocr):.2f}  mean={st.mean(scores_ocr):.2f}")
qts = [round(q,2) for q in st.quantiles(scores_ocr, n=4)]
print(f"  OCR quartiles (25/50/75): {qts}")
print(f"  OCR q<0.20: {sum(1 for x in scores_ocr if x<.20)}    q<0.30: {sum(1 for x in scores_ocr if x<.30)}    q<0.40: {sum(1 for x in scores_ocr if x<.40)}    q<0.50: {sum(1 for x in scores_ocr if x<.50)}")

print(f"\n=== CLEAN pdfjs samples (q > 0.65) ===")
for eid,p,q,s in sample_good:
    print(f"\n  [{eid}:p{p}  q={q:.2f}]\n  {s[:180]}")

print(f"\n=== JUNK OCR samples (q < 0.20) ===")
for eid,p,q,s in sample_bad:
    print(f"\n  [{eid}:p{p}  q={q:.2f}]\n  {s[:180]}")
