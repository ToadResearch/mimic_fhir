#!/usr/bin/env python3
import argparse
import json
import sys
from collections import defaultdict, deque
from pathlib import Path
from urllib.parse import urlparse


def iter_ndjson(path):
    with path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_no}: invalid JSON: {exc}") from exc


def extract_reference_strings(value, out):
    if isinstance(value, dict):
        for key, val in value.items():
            if key == "reference" and isinstance(val, str):
                out.append(val)
            else:
                extract_reference_strings(val, out)
    elif isinstance(value, list):
        for item in value:
            extract_reference_strings(item, out)


def parse_reference(reference):
    if not reference or not isinstance(reference, str):
        return None
    if reference.startswith("#") or reference.startswith("urn:uuid:"):
        return None
    reference = reference.split("#", 1)[0]
    if "://" in reference:
        path = urlparse(reference).path
        parts = [part for part in path.split("/") if part]
    else:
        parts = [part for part in reference.split("/") if part]
    if not parts:
        return None
    if "_history" in parts:
        idx = parts.index("_history")
        if idx < 2:
            return None
        return parts[idx - 2], parts[idx - 1]
    if len(parts) < 2:
        return None
    return parts[-2], parts[-1]


def load_resources(input_dir):
    resources_by_key = {}
    resource_refs = {}
    patient_resources = defaultdict(set)
    patients_seen = set()

    ndjson_paths = sorted(input_dir.glob("*.ndjson"))
    if not ndjson_paths:
        raise FileNotFoundError(f"No .ndjson files found in {input_dir}")

    for path in ndjson_paths:
        resource_count = 0
        for resource in iter_ndjson(path):
            if not isinstance(resource, dict):
                continue
            resource_count += 1
            resource_type = resource.get("resourceType")
            resource_id = resource.get("id")
            if not resource_type or not resource_id or not isinstance(resource_id, str):
                continue
            key = (resource_type, resource_id)
            resources_by_key[key] = resource

            ref_strings = []
            extract_reference_strings(resource, ref_strings)
            refs = []
            patient_ids = set()
            for ref in ref_strings:
                ref_key = parse_reference(ref)
                if not ref_key:
                    continue
                refs.append(ref_key)
                if ref_key[0] == "Patient":
                    patient_ids.add(ref_key[1])
            resource_refs[key] = refs

            if resource_type == "Patient":
                patients_seen.add(resource_id)
                patient_resources[resource_id].add(key)
            for patient_id in patient_ids:
                patient_resources[patient_id].add(key)
        print(f"Loaded {path.name}: {resource_count} resources")

    return resources_by_key, resource_refs, patient_resources, patients_seen


def expand_references(patient_id, initial_keys, resource_refs, resources_by_key):
    included = set(initial_keys)
    queue = deque(initial_keys)
    while queue:
        key = queue.popleft()
        for ref_key in resource_refs.get(key, []):
            ref_type, ref_id = ref_key
            if ref_type == "Patient" and ref_id != patient_id:
                continue
            if ref_key in resources_by_key and ref_key not in included:
                included.add(ref_key)
                queue.append(ref_key)
    return included


def build_bundle(patient_id, included_keys, resources_by_key):
    def sort_key(key):
        resource_type, resource_id = key
        if resource_type == "Patient" and resource_id == patient_id:
            return (0, "", "")
        return (1, resource_type, resource_id)

    entries = []
    for key in sorted(included_keys, key=sort_key):
        resource = resources_by_key[key]
        entries.append(
            {
                "fullUrl": f"{key[0]}/{key[1]}",
                "resource": resource,
            }
        )

    return {
        "resourceType": "Bundle",
        "type": "collection",
        "id": f"bundle-{patient_id}",
        "entry": entries,
    }


def main():
    parser = argparse.ArgumentParser(
        description=(
            "Build per-patient FHIR bundles from NDJSON resources in data/fhir_resources."
        )
    )
    parser.add_argument(
        "--input-dir",
        default="data/fhir_resources",
        help="Directory containing NDJSON FHIR resources.",
    )
    parser.add_argument(
        "--output-dir",
        default="data/fhir_bundles",
        help="Directory to write per-patient bundle JSON files.",
    )
    parser.add_argument(
        "--patient-id",
        action="append",
        dest="patient_ids",
        help="Limit output to a specific patient id (repeatable).",
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    input_dir = Path(args.input_dir)
    output_dir = Path(args.output_dir)
    if not input_dir.is_absolute():
        input_dir = (repo_root / input_dir).resolve()
    if not output_dir.is_absolute():
        output_dir = (repo_root / output_dir).resolve()

    resources_by_key, resource_refs, patient_resources, patients_seen = load_resources(
        input_dir
    )

    output_dir.mkdir(parents=True, exist_ok=True)

    if args.patient_ids:
        patients_to_build = [pid for pid in args.patient_ids if pid in patients_seen]
        missing = [pid for pid in args.patient_ids if pid not in patients_seen]
        for pid in missing:
            print(f"Skipping {pid}: Patient resource not found.", file=sys.stderr)
    else:
        patients_to_build = sorted(patients_seen)

    if not patients_to_build:
        print("No patient bundles to build.", file=sys.stderr)
        return 1

    total_patients = len(patients_to_build)
    for index, patient_id in enumerate(patients_to_build, 1):
        patient_key = ("Patient", patient_id)
        if patient_key not in resources_by_key:
            print(f"Skipping {patient_id}: Patient resource missing.", file=sys.stderr)
            continue
        initial_keys = set(patient_resources.get(patient_id, set()))
        initial_keys.add(patient_key)
        included_keys = expand_references(
            patient_id, initial_keys, resource_refs, resources_by_key
        )
        bundle = build_bundle(patient_id, included_keys, resources_by_key)
        output_path = output_dir / f"Patient-{patient_id}.bundle.json"
        with output_path.open("w", encoding="utf-8") as handle:
            json.dump(bundle, handle, ensure_ascii=True, indent=2)
            handle.write("\n")
        print(
            f"({index}/{total_patients}) Wrote {output_path} "
            f"({len(bundle['entry'])} entries)"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
