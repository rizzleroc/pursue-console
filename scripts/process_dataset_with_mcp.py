#!/usr/bin/env python3
"""Denis's UFO-USA OCR process, routed through the local pursue-vision-mcp daemon.

Same CSV manifest, same per-page rendering, same prompt, same YAML+Markdown
output as scripts/process_dataset_with_gemini.py — but instead of calling
generativelanguage.googleapis.com directly, this posts each rendered page
image to the daemon's /chat-with-files endpoint at http://127.0.0.1:9223.
The daemon drives the maintainer's logged-in Gemini tab via CDP, which is
how the volunteer flow already operates.

Why this exists: the Gemini API path needs an API key and outbound to
generativelanguage.googleapis.com. The maintainer's running MCP daemon
already has an authenticated Gemini session, so this script reuses that
without needing a separate key.

Run on the maintainer's laptop (the daemon must be reachable on
127.0.0.1:9223). The Claude Code sandbox can't run this either — the
daemon is on the maintainer's machine, not the container.

Usage (PowerShell):
    npm start --prefix pursue-vision-mcp        # in another terminal
    python scripts\\process_dataset_with_mcp.py `
      --metadata config\\release_2_manifest.csv `
      --downloads-dir . `
      --output-dir data-raw\\war-gov\\release_2\\converted `
      --workers 2
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# Reuse Denis's helpers — keeps the OCR process (prompt, format, CSV
# parsing, slug rules) bit-for-bit identical to the upstream mirror's.
sys.path.insert(0, str(Path(__file__).parent))
from process_dataset_with_gemini import (  # noqa: E402
    Asset,
    DEFAULT_PROMPT,
    append_jsonl,
    atomic_write_text,
    build_markdown_file,
    load_image_asset,
    page_output_path,
    public_dataset_path,
    read_local_assets,
    read_metadata_assets,
    read_pdf_manifest_assets,
    render_pdf_page,
    selected_pages,
)


DEFAULT_DAEMON = "http://127.0.0.1:9223"
DEFAULT_TOKEN_PATH = Path.home() / ".pursue-vision-token"
DEFAULT_PROVIDER = "gemini"
DEFAULT_WORKERS = 2  # the daemon serializes per-provider anyway
DEFAULT_RETRIES = 2
DEFAULT_RETRY_SLEEP = 5.0


def load_token(token_path: Path) -> str:
    env = os.environ.get("PURSUE_VISION_TOKEN")
    if env:
        return env.strip()
    if not token_path.exists():
        raise SystemExit(
            f"no token at {token_path} and PURSUE_VISION_TOKEN unset — "
            "is the daemon running? (`npm start --prefix pursue-vision-mcp`)"
        )
    return token_path.read_text(encoding="utf-8").strip()


def mcp_chat_with_files(
    daemon: str,
    token: str,
    *,
    provider: str,
    file_path: Path,
    prompt: str,
    timeout_ms: int,
) -> str:
    """POST one image to the daemon and return the model's text reply.

    Mirrors the JS callDaemon() in scripts/volunteer.mjs:316. Response
    shape is { text | result.text | output } — accept whichever is set.
    """
    body = json.dumps({
        "provider": provider,
        "filePaths": [str(file_path)],
        "prompt": prompt,
        "freshChat": True,
        "timeoutMs": timeout_ms,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{daemon.rstrip('/')}/chat-with-files",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout_ms / 1000 + 10) as r:
        payload = json.loads(r.read().decode("utf-8"))
    text = payload.get("text") or (payload.get("result") or {}).get("text") or payload.get("output") or ""
    if not text.strip():
        raise RuntimeError(f"daemon returned empty text (payload keys: {list(payload.keys())})")
    return text


def mcp_page_markdown(
    *,
    daemon: str,
    token: str,
    provider: str,
    prompt: str,
    image_bytes: bytes,
    mime_type: str,
    stage_dir: Path,
    page_label: str,
    retries: int,
    retry_sleep: float,
    timeout_ms: int,
) -> str:
    """Stage the image to a temp file (the daemon wants a path), call MCP."""
    suffix = ".png" if mime_type.endswith("png") else ".jpg"
    stage_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        prefix=f"{page_label}-", suffix=suffix, dir=stage_dir, delete=False
    ) as fh:
        fh.write(image_bytes)
        staged = Path(fh.name)
    try:
        for attempt in range(retries + 1):
            try:
                return mcp_chat_with_files(
                    daemon, token,
                    provider=provider,
                    file_path=staged,
                    prompt=prompt,
                    timeout_ms=timeout_ms,
                )
            except (urllib.error.HTTPError, urllib.error.URLError, RuntimeError) as exc:
                if attempt >= retries:
                    raise
                wait = retry_sleep * (2 ** attempt)
                print(f"    ↻ MCP retry {attempt+1}/{retries} in {wait:.0f}s — {exc}")
                time.sleep(wait)
        raise RuntimeError("unreachable")
    finally:
        try: staged.unlink()
        except OSError: pass


def build_prompt_for(asset: Asset, page_number: int, page_count: int) -> str:
    """Same prompt as Denis's gemini path (build_prompt() in his script)."""
    context = [
        DEFAULT_PROMPT.strip(),
        "",
        f"Document title: {asset.title}",
        f"Source file: {asset.local_path.name}",
        f"Page: {page_number} of {page_count}",
    ]
    if asset.agency: context.append(f"Agency: {asset.agency}")
    if asset.release_date: context.append(f"Release date: {asset.release_date}")
    if asset.description: context.append(f"Dataset description: {asset.description}")
    return "\n".join(context)


def process_asset(
    asset: Asset,
    args: argparse.Namespace,
    token: str,
    stage_dir: Path,
) -> None:
    manifest_path = args.output_dir / "manifest.jsonl"
    suffix = asset.local_path.suffix.lower()

    if suffix == ".pdf":
        import fitz  # PyMuPDF
        doc = fitz.open(asset.local_path)
        page_count = doc.page_count
        page_numbers = selected_pages(page_count, args.pages, args.max_pages_per_doc)
        print(f"{asset.slug}: {len(page_numbers)}/{page_count} pages")
        for n in page_numbers:
            out_path = page_output_path(args.output_dir, asset, n)
            if out_path.exists() and not args.force:
                continue
            page = doc.load_page(n - 1)
            image_bytes = render_pdf_page(
                page, dpi=args.dpi, max_side=args.max_side, jpeg_quality=args.jpeg_quality,
            )
            prompt = build_prompt_for(asset, n, page_count)
            body = mcp_page_markdown(
                daemon=args.daemon, token=token, provider=args.provider,
                prompt=prompt, image_bytes=image_bytes, mime_type="image/jpeg",
                stage_dir=stage_dir,
                page_label=f"{asset.slug}-p{n:04d}",
                retries=args.retries, retry_sleep=args.retry_sleep,
                timeout_ms=args.timeout_ms,
            )
            md = build_markdown_file(
                asset, page_number=n, page_count=page_count,
                model=f"mcp/{args.provider}", body=body,
            )
            out_path.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_text(out_path, md)
            append_jsonl(manifest_path, {
                "asset": asset.slug,
                "source_file": public_dataset_path(asset.local_path),
                "page": n,
                "page_count": page_count,
                "model": f"mcp/{args.provider}",
                "output": str(out_path.relative_to(args.output_dir.parent.parent) if args.output_dir.is_absolute() else out_path),
                "generated_at": datetime.now(timezone.utc).isoformat(),
            })
            if args.sleep > 0:
                time.sleep(args.sleep)
        doc.close()
    else:
        # Image-only assets (jpg/png) — single "page".
        image_bytes, mime_type = load_image_asset(
            asset.local_path, max_side=args.max_side, jpeg_quality=args.jpeg_quality,
        )
        out_path = page_output_path(args.output_dir, asset, 1)
        if out_path.exists() and not args.force:
            return
        prompt = build_prompt_for(asset, 1, 1)
        body = mcp_page_markdown(
            daemon=args.daemon, token=token, provider=args.provider,
            prompt=prompt, image_bytes=image_bytes, mime_type=mime_type,
            stage_dir=stage_dir,
            page_label=f"{asset.slug}-p0001",
            retries=args.retries, retry_sleep=args.retry_sleep,
            timeout_ms=args.timeout_ms,
        )
        md = build_markdown_file(asset, page_number=1, page_count=1, model=f"mcp/{args.provider}", body=body)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(out_path, md)


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--metadata", type=Path, default=Path("config/release_2_manifest.csv"))
    p.add_argument("--pdf-manifest", type=Path, default=None,
                   help="Optional Denis-style pdf_manifest.tsv (used when --metadata is absent).")
    p.add_argument("--downloads-dir", type=Path, default=Path("."))
    p.add_argument("--output-dir", type=Path, default=Path("data-raw/war-gov/release_2/converted"))
    p.add_argument("--daemon", default=os.environ.get("PURSUE_VISION_DAEMON", DEFAULT_DAEMON))
    p.add_argument("--token-file", type=Path, default=DEFAULT_TOKEN_PATH)
    p.add_argument("--provider", default=os.environ.get("MCP_PROVIDER", DEFAULT_PROVIDER),
                   choices=["gemini", "chatgpt", "claude"])
    p.add_argument("--workers", type=int, default=DEFAULT_WORKERS,
                   help="Parallel page workers. The daemon serializes per-provider, so >2 buys little.")
    p.add_argument("--download-missing", action="store_true",
                   help="Download PDFs missing from --downloads-dir using URLs in --metadata.")
    p.add_argument("--local-only", action="store_true",
                   help="Ignore --metadata; process every supported file under --downloads-dir.")
    p.add_argument("--force", action="store_true", help="Re-OCR pages even if output already exists.")
    p.add_argument("--stop-on-error", action="store_true")
    p.add_argument("--dry-run", action="store_true", help="List files/pages without calling the daemon.")
    p.add_argument("--pages", default="", help='Page selection like "1", "1-5", or "1,4,9-12".')
    p.add_argument("--max-docs", type=int, default=0)
    p.add_argument("--max-pages-per-doc", type=int, default=0)
    p.add_argument("--dpi", type=int, default=200)
    p.add_argument("--max-side", type=int, default=3000)
    p.add_argument("--jpeg-quality", type=int, default=85)
    p.add_argument("--sleep", type=float, default=0.0)
    p.add_argument("--retries", type=int, default=DEFAULT_RETRIES)
    p.add_argument("--retry-sleep", type=float, default=DEFAULT_RETRY_SLEEP)
    p.add_argument("--timeout-ms", type=int, default=600_000)
    return p


def main() -> int:
    args = build_arg_parser().parse_args()
    args.output_dir = args.output_dir.resolve()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    if args.local_only:
        assets = read_local_assets(args.downloads_dir)
    elif args.pdf_manifest and args.pdf_manifest.exists():
        assets, skipped = read_pdf_manifest_assets(
            args.pdf_manifest, args.downloads_dir, download_missing=args.download_missing,
        )
    else:
        assets, skipped = read_metadata_assets(
            args.metadata, args.downloads_dir, download_missing=args.download_missing,
        )
        if skipped:
            print(f"\nSkipped {len(skipped)} metadata rows:")
            for s in skipped[:20]:
                print(f"  row {s['row']}: {s['title']!r} — {s['reason']}")

    if args.max_docs > 0:
        assets = assets[: args.max_docs]

    if not assets:
        print("no assets to process — check --metadata / --downloads-dir / --local-only")
        return 1

    if args.dry_run:
        print(f"\nWould process {len(assets)} asset(s) via MCP daemon {args.daemon} (provider={args.provider}):")
        for a in assets:
            if a.local_path.suffix.lower() == ".pdf":
                try:
                    import fitz
                    with fitz.open(a.local_path) as doc:
                        page_count = doc.page_count
                        pages = selected_pages(page_count, args.pages, args.max_pages_per_doc)
                    print(f"  {a.slug}: {a.local_path} ({len(pages)}/{page_count} pages)")
                except Exception as exc:  # noqa: BLE001
                    print(f"  {a.slug}: {a.local_path} (page count error: {exc})")
            else:
                print(f"  {a.slug}: {a.local_path} (image)")
        return 0

    token = load_token(args.token_file)
    stage_dir = Path.home() / ".pursue-vision-staging" / "release-02"
    print(f"\nProcessing {len(assets)} asset(s) via {args.daemon} (provider={args.provider})")

    # Per-asset serial; pages within an asset can parallelize but the
    # daemon's per-provider queue means worker count beyond 2 mostly
    # just adds upload contention. Default to 1 worker for safety.
    errors = 0
    if args.workers <= 1:
        for asset in assets:
            try: process_asset(asset, args, token, stage_dir)
            except Exception as exc:  # noqa: BLE001
                errors += 1
                print(f"  ! {asset.slug} failed: {exc}")
                if args.stop_on_error: raise
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            futs = {pool.submit(process_asset, a, args, token, stage_dir): a for a in assets}
            for fut in concurrent.futures.as_completed(futs):
                a = futs[fut]
                try: fut.result()
                except Exception as exc:  # noqa: BLE001
                    errors += 1
                    print(f"  ! {a.slug} failed: {exc}")
                    if args.stop_on_error:
                        pool.shutdown(wait=False, cancel_futures=True)
                        raise

    return 2 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
