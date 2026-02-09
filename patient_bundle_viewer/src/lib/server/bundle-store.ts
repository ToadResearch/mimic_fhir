import { access, readFile, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import type { BundleMeta, FhirBundle } from '$lib/fhir/types';

const BUNDLE_FILE_REGEX = /^Patient-([A-Za-z0-9-]+)\.bundle\.json$/;

const BUNDLE_DIR_CANDIDATES = [
	() => process.env.FHIR_BUNDLE_DIR,
	() => resolve(process.cwd(), 'data', 'fhir_bundles'),
	() => resolve(process.cwd(), '..', 'data', 'fhir_bundles'),
	() => resolve(process.cwd(), '..', '..', 'data', 'fhir_bundles')
];

let cachedBundleDir: string | null = null;

async function canReadDirectory(path: string): Promise<boolean> {
	try {
		await access(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

export async function resolveBundleDirectory(): Promise<string> {
	if (cachedBundleDir) {
		return cachedBundleDir;
	}

	for (const candidateFactory of BUNDLE_DIR_CANDIDATES) {
		const candidate = candidateFactory();
		if (!candidate) {
			continue;
		}
		if (await canReadDirectory(candidate)) {
			cachedBundleDir = candidate;
			return candidate;
		}
	}

	throw new Error(
		'Could not locate fhir_bundles directory. Set FHIR_BUNDLE_DIR or run from the repository context.'
	);
}

export function validatePatientId(patientId: string): boolean {
	return /^[A-Za-z0-9-]+$/.test(patientId);
}

export async function listBundleMetas(): Promise<BundleMeta[]> {
	const dir = await resolveBundleDirectory();
	const dirEntries = await readdir(dir, { withFileTypes: true });

	const metas = await Promise.all(
		dirEntries
			.filter((entry) => entry.isFile())
			.map(async (entry) => {
				const match = BUNDLE_FILE_REGEX.exec(entry.name);
				if (!match) {
					return null;
				}
				const fullPath = resolve(dir, entry.name);
				const fileStats = await stat(fullPath);
				return {
					patientId: match[1],
					fileName: entry.name,
					fileSizeBytes: fileStats.size,
					modifiedAt: fileStats.mtime.toISOString()
				} satisfies BundleMeta;
			})
	);

	return metas
		.filter((meta): meta is BundleMeta => meta !== null)
		.sort((left, right) => left.patientId.localeCompare(right.patientId));
}

export async function loadBundleByPatientId(patientId: string): Promise<FhirBundle> {
	if (!validatePatientId(patientId)) {
		throw new Error('Invalid patient id format.');
	}

	const dir = await resolveBundleDirectory();
	const bundlePath = resolve(dir, `Patient-${patientId}.bundle.json`);
	const fileContents = await readFile(bundlePath, 'utf8');
	const parsed = JSON.parse(fileContents) as FhirBundle;

	if (parsed.resourceType !== 'Bundle') {
		throw new Error('Target file is not a FHIR Bundle.');
	}

	return parsed;
}
