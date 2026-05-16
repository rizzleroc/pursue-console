# SQL Migration Roadmap (Phase 2)

This document scopes the work to consolidate the corpus's many static JSON artifacts into a single in-browser SQLite database. **Not built yet** — this is a spec so the work has a known shape when we pick it up.

## Why move to SQL

Today we ship ~10 separate JSON/binary files into `public/`:

| File | Bytes | Holds |
|---|---:|---|
| `embeddings.bin` | ~1.5 MB | 384-D float32 vectors |
| `embeddings-meta.json` | ~300 KB | per-chunk metadata |
| `embeddings-info.json` | ~600 B | corpus stats |
| `search-index.json` | ~2.2 MB | MiniSearch index |
| `dossier-extracts.json` | ~240 KB | per-doc profiles + excerpts |
| `patterns.json` | ~35 KB | aggregated signatures |
| `event-similarity.json` | ~22 KB | top-K semantic neighbors |
| `visuals.json` | varies | per-page visual descriptions |
| `work-available.json` | ~7 KB | pages queued for OCR |
| `live-feed.json` | ~95 KB | recent transcription stream |
| `corpus-version.json` | ~1 KB | freshness manifest |

Each view fetches its relevant subset. Cross-view queries ("show me COMETA pages whose top semantic neighbor is FBI-Vault and whose visuals include a sketch") aren't possible without loading multiple files and joining client-side. Adding a new derived field means another file, another script in the rebuild chain, another fetch in each view.

A single SQLite file would:
- Replace 10 fetches with 1
- Enable real JOINs across all relations
- Compress better (multi-file aggregate compresses worse than one B-tree)
- Give us indexed lookups instead of in-memory `Array.find`
- Make backups + diffs more meaningful (1 file to diff, not 10)

## What it'd look like

### Schema sketch

```sql
-- one row per catalogued event
CREATE TABLE events (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  date         TEXT,
  era          TEXT,
  agency       TEXT,
  loc          TEXT,
  region       TEXT,
  coords_lat   REAL,
  coords_lon   REAL,
  type         TEXT,
  flag         TEXT,
  summary      TEXT,
  note         TEXT,
  url          TEXT,
  doc_type     TEXT,
  redacted     INTEGER DEFAULT 0
);
CREATE TABLE event_tags (
  event_id TEXT, tag TEXT,
  PRIMARY KEY (event_id, tag),
  FOREIGN KEY (event_id) REFERENCES events(id)
);

-- chunk-level corpus (one row per FAISS-indexed chunk)
CREATE TABLE chunks (
  rowid       INTEGER PRIMARY KEY,  -- aligns to embeddings.bin row index
  event_id    TEXT NOT NULL,
  page        INTEGER,
  kind        TEXT,        -- 'meta' | 'page' | 'visual'
  source      TEXT,        -- 'curated' | 'vision' | 'ocr' | 'pdfjs' | 'vision-visual'
  quality     REAL,
  snippet     TEXT,
  body        TEXT,        -- full sentence-window text (was missing before — used to lose to chunks JSON)
  FOREIGN KEY (event_id) REFERENCES events(id)
);
CREATE INDEX idx_chunks_event ON chunks(event_id);
CREATE INDEX idx_chunks_source ON chunks(source);

-- embeddings live in a sidecar BLOB column or stay in embeddings.bin
-- (BLOB column lets us drop the bin file; staying separate keeps SQLite small)
CREATE TABLE chunk_vectors (
  rowid INTEGER PRIMARY KEY,
  vec   BLOB         -- 384 floats * 4 bytes = 1536 bytes
);

-- per-page extracted text (full body, not chunked) — same source the search-
-- index reads from. Lets us do FULL-TEXT MATCH instead of MiniSearch.
CREATE VIRTUAL TABLE pages_fts USING fts5(
  body, event_id, page,
  tokenize = 'porter unicode61 remove_diacritics 1'
);

-- per-page visual descriptions
CREATE TABLE visuals (
  event_id TEXT, page INTEGER, ord INTEGER,
  kind     TEXT, description TEXT,
  PRIMARY KEY (event_id, page, ord),
  FOREIGN KEY (event_id) REFERENCES events(id)
);

-- per-event semantic neighbors (precomputed)
CREATE TABLE event_similarity (
  event_a TEXT, event_b TEXT, cos REAL,
  PRIMARY KEY (event_a, event_b),
  FOREIGN KEY (event_a) REFERENCES events(id),
  FOREIGN KEY (event_b) REFERENCES events(id)
);

-- aggregated patterns (shape, behavior, sensor, entity, date)
CREATE TABLE pattern_terms (
  category TEXT, term TEXT,
  total    INTEGER, doc_count INTEGER,
  PRIMARY KEY (category, term)
);
CREATE TABLE pattern_term_events (
  category TEXT, term TEXT, event_id TEXT, count INTEGER,
  PRIMARY KEY (category, term, event_id)
);

-- work queue + activity log
CREATE TABLE work_queue (
  event_id TEXT, page INTEGER, claimed_by TEXT, claimed_at INTEGER,
  status TEXT,  -- 'open' | 'in-flight' | 'submitted' | 'merged' | 'rejected'
  PRIMARY KEY (event_id, page)
);
CREATE TABLE activity (
  ts INTEGER, kind TEXT, event_id TEXT, page INTEGER, source TEXT, chars INTEGER, snippet TEXT
);
CREATE INDEX idx_activity_ts ON activity(ts);
```

### Build pipeline

Add `scripts/build-corpus-db.mjs` that runs after all the per-artifact builders. It:
1. Opens a fresh `public/corpus.sqlite` (or appends to an existing one)
2. Reads each existing JSON artifact and INSERTs into the corresponding tables
3. Populates `pages_fts` from `public/text/*.txt`
4. (Optional) keeps `embeddings.bin` separate or stuffs into `chunk_vectors`
5. VACUUMs and writes

The legacy JSON files stay too, for one or two deploy cycles, to keep the existing views working while we cut them over.

### Runtime layer

```
src/lib/corpusDb.js
  • Loads public/corpus.sqlite via sql.js (~1 MB WASM)
  • Exports: queryEvents, queryChunks, fullTextSearch, semanticNeighbors, etc.
  • Cached at module level — fetched once per session
```

Views migrate one-by-one to use `corpusDb` instead of fetching individual JSONs. SemanticSearchView keeps its own embeddings.bin path until the chunk_vectors BLOB approach proves out.

### Bundle cost

- `sql.js`: ~1.2 MB (only loaded when a view that uses the DB renders)
- `corpus.sqlite`: estimated 6-10 MB at current corpus size, compresses to ~3-4 MB gz

vs current: ~5 MB of JSON + 1.5 MB binary, both uncompressed served. About the same total bytes, **half the round trips**, and a real query language at the end of it.

## What this enables

Concretely:

- **Cross-view queries** in DossierView: "show this event's chunks where source=vision AND quality > 0.7 AND any visual kind=photo"
- **FTS5 in SearchView**: phrase queries, NEAR, OR/AND syntax, snippets with auto-highlight. No more MiniSearch.
- **One refresh** across all data instead of N polling intervals
- **Backup is a single 4 MB file** instead of 10 separate artifacts
- **Diffs are meaningful**: `sqldiff old.sqlite new.sqlite` tells you exactly which pages got new transcriptions

## When to do it

Trigger criteria for starting:
- Corpus crosses 2000 chunks (currently ~970 — comfortably in JSON territory)
- A view needs a JOIN that's painful in JSON (we have a few candidate queries today — not blocking but they'd be nice)
- We want full-text search with FTS5-quality (phrase, NEAR, AND/OR) — MiniSearch is OK but not great at this

Estimated effort: ~2 days of careful work. The schema is straightforward; the cutover is the risk (views need to keep working through it).

## What this is NOT

- Not a server-side database. Stays static. SQL.js runs in the browser.
- Not a replacement for the build-time scripts. They still produce the source-of-truth artifacts; this just consolidates them into one queryable shape.
- Not blocking anything we're doing now. Current JSON architecture is fine at this scale.
