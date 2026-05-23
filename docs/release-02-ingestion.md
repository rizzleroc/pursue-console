# Release 02 ingestion — Denis-process flow

Follows [DenisSergeevitch/UFO-USA](https://github.com/DenisSergeevitch/UFO-USA)'s
exact OCR pipeline (vendored at `scripts/process_dataset_with_gemini.py`) to
convert each release-02 PDF page into Markdown via `gemini-3.1-flash-lite`.

**Why on your laptop:** the script calls `generativelanguage.googleapis.com`,
which is blocked from the Claude Code remote container. Your home network can
reach it.

## Prereqs

1. **Python 3.10+** and **pip** on your laptop.
2. A **Gemini API key** from <https://aistudio.google.com/apikey>. The free
   tier is enough for release-02 (≈125 pages total).
3. The 6 release-02 PDFs already at the repo root (committed in
   `2bb980989` and `f8f5cd7fc`).

## Steps

```powershell
# in the repo root on your laptop:
cd F:\toxicavenger\disclosure\pursue-console
git checkout main
git pull origin main

# one-time deps:
python -m pip install -r scripts\process_dataset_with_gemini.requirements.txt

# set your key (PowerShell):
$env:GEMINI_API_KEY = "your-key-here"

# dry-run first to confirm all 6 PDFs are picked up:
python scripts\process_dataset_with_gemini.py `
  --metadata config\release_2_manifest.csv `
  --downloads-dir . `
  --output-dir data-raw\war-gov\release_2\converted `
  --dry-run

# expected: 6 assets listed, total ≈128 pages

# real run:
python scripts\process_dataset_with_gemini.py `
  --metadata config\release_2_manifest.csv `
  --downloads-dir . `
  --output-dir data-raw\war-gov\release_2\converted `
  --workers 4
```

Output: per-page Markdown files at
`data-raw/war-gov/release_2/converted/<NNN>-<slugged-title>/page-<NNNN>.md`,
each with YAML frontmatter matching Denis's format (source_title, source_url,
page, page_count, model, generated_at).

A `manifest.jsonl` file is also written under `converted/` recording every
page processed — same schema as Denis's `converted/manifest.jsonl`.

## After the script finishes

```powershell
git add data-raw\war-gov\release_2\converted
git commit -m "release-02: Gemini vision-OCR transcripts (Denis process)"
git push origin main
```

Then ping the Claude Code session — the markdown files don't need network to
process from there. The integration step (adapter from Denis's per-page MD
into `data-raw/.vision-cache/<id>/p<NNN>.txt` so `build-text-files.mjs` reads
them, plus event entries in `src/data/events.js`) gets done in-session.

## Troubleshooting

- **`asset not downloaded`** for one of the 6 rows — means the script's
  filename-normalizer didn't match. Check that the file is at the path in
  `--downloads-dir` (the script recurses). Both `CIA-UAP-D001_Intelligence_Information_Report_USSR_1973.pdf`
  and `cia-uap-d001-intelligence-information-report-ussr-1973.pdf` normalize to
  the same key, so case/underscore/hyphen differences don't matter.
- **HTTP 429** — Gemini rate-limited you. The script's `--rpm` defaults to
  10,000; the free tier caps at ~15 RPM. Re-run with `--rpm 12 --workers 2`.
- **`google-genai` install fails** — older `pip` versions choke on the
  namespace package; `python -m pip install --upgrade pip` first.
