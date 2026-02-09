# AGENTS.md

This file defines working style and guardrails for agents contributing to this repository.

## Goal

Maintain and improve tooling around MIMIC-IV FHIR demo data:

- Python pipeline to download and transform NDJSON into patient bundles
- Bundle statistics tooling
- Svelte 5 + Tailwind viewer for patient-centric exploration

## Repository Map

- `download_data.sh`: end-to-end data download + bundle build + stats
- `src/build_patient_bundles.py`: builds per-patient FHIR bundles
- `src/fhir_bundle_stats.py`: computes bundle-level metrics
- `data/fhir_resources`: NDJSON source data (large)
- `data/fhir_bundles`: patient bundles (large)
- `site`: Svelte 5 app for interactive analysis

## Viewer Product Notes

### Core capabilities

- Lists patient bundles from `data/fhir_bundles`
- Loads one bundle at a time through API routes
- Surfaces:
  - clinical metrics and care-span summaries
  - actionable insights derived from resource patterns
  - timeline-oriented event feed
  - linked resource graph navigation (inbound + outbound references)
  - searchable/filterable resource explorer
  - detailed resource panel with raw JSON on demand

### Data directory resolution

Viewer API bundle lookup order:

1. `FHIR_BUNDLE_DIR`
2. `./data/fhir_bundles`
3. `../data/fhir_bundles`
4. `../../data/fhir_bundles`

Set `FHIR_BUNDLE_DIR` if your data is elsewhere.

## Style Rules

### General

- Prefer minimal, targeted diffs over broad rewrites.
- Keep behavior backwards-compatible unless asked otherwise.
- Avoid introducing heavy dependencies without clear value.
- Preserve existing CLI flags and output formats when possible.

### Python (`src/*.py`)

- Use standard library first.
- Keep functions small and testable.
- Handle malformed records defensively (never crash on one bad resource).
- Keep output deterministic (sorted where relevant).

### Shell (`*.sh`)

- Use `set -euo pipefail`.
- Quote paths and variables.
- Make scripts idempotent when feasible.
- Avoid destructive operations unless explicitly requested.

### Svelte/Tailwind (`site`)

- Prioritize insight-first UX over raw JSON presentation.
- Keep components readable and split logic into `$lib` helpers when complex.
- Use semantic sections: metrics, insights, timeline, linked resources.
- Maintain responsive behavior for desktop and mobile.

## Data + Performance Constraints

- Data files are large; avoid loading unnecessary files into memory.
- For viewer APIs, load one patient bundle at a time.
- Avoid committing generated data outputs.
- Keep parsing and traversal logic linear where possible.

## Validation Checklist

Run relevant checks after modifications:

### Python / Shell

```sh
python3 -m py_compile src/build_patient_bundles.py src/fhir_bundle_stats.py
bash -n download_data.sh
```

### Viewer

```sh
cd site
npm run check
npm run build
```

## Documentation Rules

- Update root `README.md` when behavior, commands, or folder expectations change.
- Keep `site/README.md` lightweight and point to root docs.

## When Unsure

- Choose clarity over cleverness.
- Add short comments only where logic is non-obvious.
- Surface assumptions explicitly in commit messages or PR summaries.
