import { json } from '@sveltejs/kit';
import { listBundleMetas } from '$lib/server/bundle-store';

export async function GET() {
	try {
		const bundles = await listBundleMetas();
		return json({ bundles });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to list bundles';
		return json({ error: message }, { status: 500 });
	}
}
