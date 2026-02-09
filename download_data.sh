#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="https://physionet.org/files/mimic-iv-fhir-demo/2.1.0/"
OUT_DIR="${ROOT_DIR}/data/fhir_resources"
BUNDLE_DIR="${ROOT_DIR}/data/fhir_bundles"
TMP_ROOT="${ROOT_DIR}/physionet.org"

cd "${ROOT_DIR}"

mkdir -p "${OUT_DIR}"
mkdir -p "${BUNDLE_DIR}"

run_bundle_stats() {
  echo "[6/6] Computing bundle stats"
  python3 "${ROOT_DIR}/src/fhir_bundle_stats.py" "${BUNDLE_DIR}"
}

if compgen -G "${OUT_DIR}"/*.ndjson > /dev/null && compgen -G "${BUNDLE_DIR}"/*.bundle.json > /dev/null; then
  echo "Data already exists in ${OUT_DIR} and ${BUNDLE_DIR}. Skipping download/build."
  echo "Delete existing files if you want to rebuild from scratch."
  run_bundle_stats
  exit 0
fi

echo "[1/6] Downloading (resume enabled) from: ${URL}"
wget -r -N -c -np "${URL}"

SRC_DIR="${TMP_ROOT}/files/mimic-iv-fhir-demo/2.1.0"
FHIR_DIR="${SRC_DIR}/fhir"

if [[ ! -d "${FHIR_DIR}" ]]; then
  echo "ERROR: Expected directory not found: ${FHIR_DIR}" >&2
  exit 1
fi

echo "[2/6] Copying files into ${OUT_DIR}"
# Copy all FHIR ndjson.gz + index.html (and anything else in fhir/)
cp -a "${FHIR_DIR}/." "${OUT_DIR}/"
rm -f "${OUT_DIR}/index.html"

echo "[3/6] Unzipping *.ndjson.gz in ${OUT_DIR}"
shopt -s nullglob
for f in "${OUT_DIR}"/*.ndjson.gz; do
  echo "  - ${f}"
  gunzip -f "${f}"
done
shopt -u nullglob

echo "[4/6] Removing downloaded tree: ${TMP_ROOT}"
rm -rf "${TMP_ROOT}"

echo "[5/6] Building per-patient bundles"
python3 "${ROOT_DIR}/src/build_patient_bundles.py" \
  --input-dir "${OUT_DIR}" \
  --output-dir "${BUNDLE_DIR}"

run_bundle_stats

echo "----------------------------------------"
echo "Unzipped NDJSON files are in: ${OUT_DIR}"
echo "Per-patient bundles are in: ${BUNDLE_DIR}"
echo "----------------------------------------"
