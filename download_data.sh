#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="https://physionet.org/files/mimic-iv-fhir-demo/2.1.0/"
OUT_DIR="${ROOT_DIR}/data/fhir_resources"
TMP_ROOT="${ROOT_DIR}/physionet.org"

cd "${ROOT_DIR}"

mkdir -p "${OUT_DIR}"

echo "[1/5] Downloading (resume enabled) from: ${URL}"
wget -r -N -c -np "${URL}"

SRC_DIR="${TMP_ROOT}/files/mimic-iv-fhir-demo/2.1.0"
FHIR_DIR="${SRC_DIR}/fhir"

if [[ ! -d "${FHIR_DIR}" ]]; then
  echo "ERROR: Expected directory not found: ${FHIR_DIR}" >&2
  exit 1
fi

echo "[2/5] Copying files into ${OUT_DIR}"
# Copy all FHIR ndjson.gz + index.html (and anything else in fhir/)
cp -a "${FHIR_DIR}/." "${OUT_DIR}/"
rm -f "${OUT_DIR}/index.html"

echo "[3/5] Unzipping *.ndjson.gz in ${OUT_DIR}"
shopt -s nullglob
for f in "${OUT_DIR}"/*.ndjson.gz; do
  echo "  - ${f}"
  gunzip -f "${f}"
done
shopt -u nullglob

echo "[4/5] Removing downloaded tree: ${TMP_ROOT}"
rm -rf "${TMP_ROOT}"

echo "[5/5] Building per-patient bundles"
python3 "${ROOT_DIR}/src/build_patient_bundles.py" \
  --input-dir "${OUT_DIR}" \
  --output-dir "${ROOT_DIR}/data/fhir_bundles"

echo "----------------------------------------"
echo "Unzipped NDJSON files are in: ${OUT_DIR}"
echo "Per-patient bundles are in: ${ROOT_DIR}/data/fhir_bundles"
echo "----------------------------------------"
