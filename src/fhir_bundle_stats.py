#!/usr/bin/env python3
"""Compute basic stats for a directory of FHIR bundle JSON files."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class BundleStats:
    file_count: int = 0
    total_lines: int = 0
    total_resources: int = 0
    resource_type_counts: Counter[str] = field(default_factory=Counter)

    @property
    def average_lines(self) -> float:
        return self.total_lines / self.file_count if self.file_count else 0.0

    @property
    def average_resources(self) -> float:
        return self.total_resources / self.file_count if self.file_count else 0.0


def count_lines(raw: bytes) -> int:
    if not raw:
        return 0
    newline_count = raw.count(b"\n")
    return newline_count if raw.endswith(b"\n") else newline_count + 1


def count_resources(raw: bytes) -> tuple[int, Counter[str]]:
    try:
        bundle = json.loads(raw)
    except json.JSONDecodeError:
        return 0, Counter()

    entry = bundle.get("entry")
    if not isinstance(entry, list):
        return 0, Counter()

    counts: Counter[str] = Counter()
    for item in entry:
        if not isinstance(item, dict):
            counts["(invalid_entry)"] += 1
            continue
        resource = item.get("resource")
        if isinstance(resource, dict):
            resource_type = resource.get("resourceType")
            if isinstance(resource_type, str) and resource_type:
                counts[resource_type] += 1
            else:
                counts["(missing_resourceType)"] += 1
        else:
            counts["(missing_resource)"] += 1
    return len(entry), counts


def collect_stats(bundle_dir: Path) -> BundleStats:
    stats = BundleStats()
    for path in bundle_dir.iterdir():
        if not path.is_file() or path.suffix.lower() != ".json":
            continue
        raw = path.read_bytes()
        stats.file_count += 1
        stats.total_lines += count_lines(raw)
        resource_count, resource_type_counts = count_resources(raw)
        stats.total_resources += resource_count
        stats.resource_type_counts.update(resource_type_counts)
    return stats


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compute file count, average line count, and resource counts for FHIR bundles."
    )
    parser.add_argument(
        "bundle_dir",
        nargs="?",
        default="data/fhir_bundles",
        help="Directory containing bundle JSON files (default: data/fhir_bundles)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    bundle_dir = Path(args.bundle_dir)
    if not bundle_dir.exists():
        raise SystemExit(f"Directory not found: {bundle_dir}")
    if not bundle_dir.is_dir():
        raise SystemExit(f"Not a directory: {bundle_dir}")

    stats = collect_stats(bundle_dir)
    print(f"directory: {bundle_dir}")
    print(f"file_count: {stats.file_count}")
    print(f"total_lines: {stats.total_lines}")
    print(f"average_lines: {stats.average_lines:.2f}")
    print(f"total_resources: {stats.total_resources}")
    print(f"average_resources: {stats.average_resources:.2f}")
    print("resource_type_counts:")
    for resource_type, count in sorted(
        stats.resource_type_counts.items(), key=lambda item: (-item[1], item[0])
    ):
        print(f"  {resource_type}: {count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
