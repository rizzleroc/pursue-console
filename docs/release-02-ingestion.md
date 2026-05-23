# Release 02 ingestion — Denis-process flow

Per-page vision OCR of the 6 release-02 PDFs into Markdown, following
[DenisSergeevitch/UFO-USA](https://github.com/DenisSergeevitch/UFO-USA)'s
exact prompt + output format. Two backends are vendored; pick whichever
fits your setup.

| Backend | Script | Needs | OCR provider |
| --- | --- | --- | --- |
| **MCP daemon** (recommended) | `scripts/process_dataset_with_mcp.py` | The local pursue-vision-mcp daemon running with a logged-in Gemini tab | Whatever the daemon is wired to (Gemini, ChatGPT, Claude) |
| **Gemini API** (Denis's exact script) | `scripts/process_dataset_with_gemini.py` | `GEMINI_API_KEY` from <https://aistudio.google.com/apikey> | `gemini-3.1-flash-lite` |

Both backends produce identical per-page `.md` files with the same YAML
frontmatter — `manifest.jsonl` records every page in either flow. The MCP
backend reuses Denis's CSV reader, PDF renderer, prompt, slug rules, and
output writers via Python import (`scripts/process_dataset_with_mcp.py`
only swaps the LLM call); both can be cross-checked against each other.

## Why on your laptop, not in this sandbox

- The Gemini API path needs `generativelanguage.googleapis.com` — blocked
  here by the network policy.
- The MCP path talks to `http://127.0.0.1:9223`, which is *your* loopback,
  not this container's. The daemon and its CDP-attached Chrome live on
  your machine.

## Prereqs

1. **Python 3.10+** and `pip`.
2. The 6 release-02 PDFs at the repo root (already committed in `2bb980989`
   and `f8f5cd7fc`).
3. Either:
   - **MCP backend:** the pursue-vision-mcp daemon running with a Gemini tab
     logged in (`npm start --prefix pursue-vision-mcp`), or
   - **Gemini API backend:** a `GEMINI_API_KEY` env var set.

## Run — MCP backend (recommended)

```powershell
# in the repo root on your laptop:
cd F:\toxicavenger\disclosure\pursue-console
git checkout main
git pull origin main

# one-time deps (~30 MB):
python -m pip install -r scripts\process_dataset_with_mcp.requirements.txt

# in a separate terminal, start the daemon:
npm start --prefix pursue-vision-mcp

# back in the first terminal — dry-run first to confirm all 6 PDFs are picked up:
python scripts\process_dataset_with_mcp.py `
  --metadata config\release_2_manifest.csv `
  --downloads-dir . `
  --output-dir data-raw\war-gov\release_2\converted `
  --dry-run

# expected: 6 assets listed, total ≈128 pages

# real run (defaults: provider=gemini, workers=2):
python scripts\process_dataset_with_mcp.py `
  --metadata config\release_2_manifest.csv `
  --downloads-dir . `
  --output-dir data-raw\war-gov\release_2\converted
```

Token: the script reads `~/.pursue-vision-token` (the daemon writes this on
startup). Override with `--token-file` or the `PURSUE_VISION_TOKEN` env var.

Provider: `--provider gemini` (default) | `chatgpt` | `claude` — picks which
of the three logged-in tabs the daemon drives.

## Run — Gemini API backend (Denis's exact script)

```powershell
python -m pip install -r scripts\process_dataset_with_gemini.requirements.txt
$env:GEMINI_API_KEY = "your-key-here"

python scripts\process_dataset_with_gemini.py `
  --metadata config\release_2_manifest.csv `
  --downloads-dir . `
  --output-dir data-raw\war-gov\release_2\converted `
  --workers 4
```

## Output

Per-page Markdown at
`data-raw/war-gov/release_2/converted/<NNN>-<slugged-title>/page-<NNNN>.md`,
each with YAML frontmatter (source_title, source_url, page, page_count,
model, generated_at). A `manifest.jsonl` records every page processed —
same schema as Denis's `converted/manifest.jsonl`.

## After the script finishes

```powershell
git add data-raw\war-gov\release_2\converted
git commit -m "release-02: Gemini vision-OCR transcripts (Denis process via MCP)"
git push origin main
```

Ping the Claude Code session — the markdown files don't need network to
process from there. The integration step (adapter from Denis's per-page MD
into `data-raw/.vision-cache/<id>/p<NNN>.txt` so `build-text-files.mjs` reads
them, plus event entries in `src/data/events.js`) gets done in-session.

## Troubleshooting

- **`asset not downloaded`** for one of the 6 rows — the filename-normalizer
  didn't match. Both `CIA-UAP-D001_Intelligence_Information_Report_USSR_1973.pdf`
  and `cia-uap-d001-intelligence-information-report-ussr-1973.pdf` normalize to
  the same key, so case/underscore/hyphen differences don't matter — but the
  PDF must be somewhere under `--downloads-dir` (recursively).
- **MCP `unauthorized — bearer token at ...`** — the daemon's token file
  differs from what the script reads. Either: set `PURSUE_VISION_TOKEN` to
  match, or run `--token-file <path-the-daemon-printed-on-startup>`.
- **MCP `daemon returned empty text`** — the logged-in tab refused or
  returned a blank reply. Open the monitor dashboard at
  http://127.0.0.1:9224/ to see what the driver is doing; sometimes the
  Gemini tab needs a manual reload after a long idle.
- **MCP `forbidden path`** — the script stages page images at
  `~/.pursue-vision-staging/release-02/`. If `HOME` resolves somewhere
  outside the daemon's allowlist, override with `XDG_CACHE_HOME` or run
  the script from inside the repo (cwd is also on the allowlist).
- **Gemini API HTTP 429** — free tier caps at ~15 RPM. Re-run with
  `--rpm 12 --workers 2`.
