# res/ — source data & inputs

This directory holds **inputs only** — things a human puts here, never build
outputs. Generated artifacts (`reference.db`, `reference.v*.db.gz`, `cache/`)
live at the repo root and are gitignored.

## Files

- **`Data Spreadsheet for Animal Crossing New Horizons.xlsx`** — the source
  dataset (40 sheets: furniture, clothing, critters, villagers, etc.).
  Origin: copied from `~/Downloads` (2026-08-12). The community spreadsheet
  this derives from is linked in its "Read Me" sheet.
  - Contains **no images** (all Image columns empty; no `xl/media/`).
  - Images are fetched at build time from dodo.ac (see `plan.md` → Images).

## Updating

To refresh the database with a newer version of the spreadsheet:

1. Replace this xlsx (keep the filename).
2. `make build-db` — rebuilds `reference.db` + `reference.v1.db.gz` and
   prints a per-category image hit-rate report.
3. Bump the reference version (filename in `tools/build_db.py`) and publish
   the new `.db.gz` to the server's `data/ref/`.
