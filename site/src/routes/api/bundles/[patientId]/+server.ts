import { json } from '@sveltejs/kit';
import { loadBundleByPatientId, validatePatientId } from '$lib/server/bundle-store';

export async function GET({ params }) {
	const { patientId } = params;
	if (!validatePatientId(patientId)) {
		return json({ error: 'Invalid patient id.' }, { status: 400 });
	}

	try {
		const bundle = await loadBundleByPatientId(patientId);
		return json({ bundle });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to load bundle';
		const status = message.toLowerCase().includes('enoent') ? 404 : 500;
		return json({ error: message }, { status });
	}
}
