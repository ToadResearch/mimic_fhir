<script lang="ts">
	import { onMount, tick } from 'svelte';
	import {
		analyzeBundle,
		formatBytes,
		formatDateTime,
		formatNumber,
		getResourceHeadline
	} from '$lib/fhir/analyze';
	import type { BundleMeta, FhirBundle, ResourceNode } from '$lib/fhir/types';

	const PAGE_SIZE = 80;
	const insightSeverityClass = {
		high: 'border-red-200 bg-red-50/80 text-red-900',
		medium: 'border-amber-200 bg-amber-50/85 text-amber-900',
		low: 'border-teal-200 bg-teal-50/85 text-teal-900'
	} as const;

	let bundleMetas = $state<BundleMeta[]>([]);
	let selectedPatientId = $state('');
	let selectedResourceKey = $state<string | null>(null);
	let selectedResourceTypeFilter = $state('all');
	let patientSearch = $state('');
	let resourceSearch = $state('');
	let currentPage = $state(1);
	let timelineWindowSize = $state(36);

	let loadingList = $state(false);
	let loadingBundle = $state(false);
	let loadError = $state<string | null>(null);
	let bundle = $state<FhirBundle | null>(null);

	let requestToken = 0;
	let resourceHistory = $state<string[]>([]);
	let resourceHistoryCursor = $state(-1);

	const visibleBundles = $derived.by(() => {
		const query = patientSearch.trim().toLowerCase();
		if (!query) {
			return bundleMetas;
		}
		return bundleMetas.filter((bundleMeta) => bundleMeta.patientId.toLowerCase().includes(query));
	});

	const analysis = $derived(bundle ? analyzeBundle(bundle) : null);

	const resourceTypeOptions = $derived.by(() => [
		'all',
		...(analysis?.typeCounts.map((typeCount) => typeCount.type) ?? [])
	]);

	const filteredResources = $derived.by(() => {
		if (!analysis) {
			return [];
		}
		const query = resourceSearch.trim().toLowerCase();
		return analysis.resources.filter((resource) => {
			const matchesType =
				selectedResourceTypeFilter === 'all' || resource.type === selectedResourceTypeFilter;
			if (!matchesType) {
				return false;
			}
			if (!query) {
				return true;
			}
			return (
				resource.key.toLowerCase().includes(query) ||
				resource.title.toLowerCase().includes(query) ||
				resource.subtitle.toLowerCase().includes(query)
			);
		});
	});

	const totalPages = $derived(Math.max(1, Math.ceil(filteredResources.length / PAGE_SIZE)));

	const paginatedResources = $derived.by(() => {
		const start = (currentPage - 1) * PAGE_SIZE;
		return filteredResources.slice(start, start + PAGE_SIZE);
	});

	const selectedResource = $derived.by(() => {
		if (!analysis) {
			return null;
		}
		if (selectedResourceKey && analysis.resourceIndex.has(selectedResourceKey)) {
			return analysis.resourceIndex.get(selectedResourceKey) ?? null;
		}
		return analysis.resources[0] ?? null;
	});

	const canGoBackInResourceHistory = $derived(resourceHistoryCursor > 0);
	const canGoForwardInResourceHistory = $derived(
		resourceHistoryCursor >= 0 && resourceHistoryCursor < resourceHistory.length - 1
	);

	const outboundReferences = $derived.by(() => {
		if (!analysis || !selectedResource) {
			return [];
		}
		return selectedResource.outboundReferences.map((key) => ({
			key,
			node: analysis.resourceIndex.get(key) ?? null
		}));
	});

	const inboundReferences = $derived.by(() => {
		if (!analysis || !selectedResource) {
			return [];
		}
		const inboundKeys = analysis.inboundReferenceMap.get(selectedResource.key) ?? [];
		return inboundKeys
			.map((key) => analysis.resourceIndex.get(key))
			.filter((node): node is ResourceNode => Boolean(node));
	});

	const careSpanDays = $derived.by(() => {
		if (
			analysis?.metrics.earliestTimestamp === null ||
			analysis?.metrics.earliestTimestamp === undefined ||
			analysis.metrics.latestTimestamp === null ||
			analysis.metrics.latestTimestamp === undefined
		) {
			return null;
		}
		const delta = analysis.metrics.latestTimestamp - analysis.metrics.earliestTimestamp;
		return Math.max(0, Math.round(delta / (1000 * 60 * 60 * 24)));
	});

	const visibleTimeline = $derived(analysis?.timeline.slice(0, timelineWindowSize) ?? []);

	const selectedResourceRawJson = $derived(
		selectedResource ? JSON.stringify(selectedResource.resource, null, 2) : ''
	);

	$effect(() => {
		const _resourceSearch = resourceSearch;
		const _selectedResourceTypeFilter = selectedResourceTypeFilter;
		const _selectedPatientId = selectedPatientId;
		void _resourceSearch;
		void _selectedResourceTypeFilter;
		void _selectedPatientId;
		currentPage = 1;
	});

	$effect(() => {
		if (currentPage > totalPages) {
			currentPage = totalPages;
		}
	});

	$effect(() => {
		if (!analysis) {
			selectedResourceKey = null;
			return;
		}
		if (!selectedResourceKey || !analysis.resourceIndex.has(selectedResourceKey)) {
			selectedResourceKey = analysis.resources[0]?.key ?? null;
		}
	});

	onMount(async () => {
		await loadBundleMetas();
	});

	async function loadBundleMetas() {
		loadingList = true;
		loadError = null;
		try {
			const response = await fetch('/api/bundles');
			const payload = (await response.json()) as { bundles?: BundleMeta[]; error?: string };
			if (!response.ok) {
				throw new Error(payload.error ?? 'Unable to load patient bundle index');
			}
			bundleMetas = payload.bundles ?? [];
			if (!bundleMetas.length) {
				throw new Error('No patient bundles found in data/fhir_bundles.');
			}
			if (!selectedPatientId) {
				selectedPatientId = bundleMetas[0].patientId;
				await loadBundle(selectedPatientId);
			}
		} catch (error) {
			loadError = error instanceof Error ? error.message : 'Unknown error while loading bundles';
		} finally {
			loadingList = false;
		}
	}

	async function loadBundle(patientId: string) {
		const currentToken = ++requestToken;
		loadingBundle = true;
		loadError = null;
		try {
			const response = await fetch(`/api/bundles/${patientId}`);
			const payload = (await response.json()) as { bundle?: FhirBundle; error?: string };
			if (!response.ok) {
				throw new Error(payload.error ?? `Unable to load bundle for patient ${patientId}`);
			}
			if (currentToken !== requestToken) {
				return;
			}
			bundle = payload.bundle ?? null;
			selectedResourceTypeFilter = 'all';
			resourceSearch = '';
			currentPage = 1;
			resetResourceHistory();
		} catch (error) {
			loadError = error instanceof Error ? error.message : `Unknown error loading ${patientId}`;
		} finally {
			if (currentToken === requestToken) {
				loadingBundle = false;
			}
		}
	}

	function openPatientBundle(patientId: string) {
		if (patientId === selectedPatientId) {
			return;
		}
		selectedPatientId = patientId;
		void loadBundle(patientId);
	}

	function resetResourceHistory() {
		resourceHistory = [];
		resourceHistoryCursor = -1;
	}

	function recordResourceVisit(nextKey: string) {
		if (!analysis?.resourceIndex.has(nextKey)) {
			return;
		}

		if (resourceHistory.length === 0) {
			if (
				selectedResourceKey &&
				selectedResourceKey !== nextKey &&
				analysis.resourceIndex.has(selectedResourceKey)
			) {
				resourceHistory = [selectedResourceKey, nextKey];
				resourceHistoryCursor = 1;
				return;
			}
			resourceHistory = [nextKey];
			resourceHistoryCursor = 0;
			return;
		}

		const visibleHistory = resourceHistory.slice(0, resourceHistoryCursor + 1);
		const lastVisited = visibleHistory[visibleHistory.length - 1];
		if (lastVisited === nextKey) {
			return;
		}

		resourceHistory = [...visibleHistory, nextKey];
		resourceHistoryCursor = resourceHistory.length - 1;
	}

	async function navigateResourceHistory(direction: -1 | 1) {
		const nextCursor = resourceHistoryCursor + direction;
		if (nextCursor < 0 || nextCursor >= resourceHistory.length) {
			return;
		}

		resourceHistoryCursor = nextCursor;
		const targetKey = resourceHistory[nextCursor];
		await jumpToResource(targetKey, { recordHistory: false });
	}

	async function jumpToResource(key: string, options: { recordHistory?: boolean } = {}) {
		const { recordHistory = true } = options;
		if (recordHistory) {
			recordResourceVisit(key);
		}

		selectedResourceKey = key;

		let filteredIndex = filteredResources.findIndex((resource) => resource.key === key);
		if (
			filteredIndex < 0 &&
			(selectedResourceTypeFilter !== 'all' || resourceSearch.trim().length > 0)
		) {
			selectedResourceTypeFilter = 'all';
			resourceSearch = '';
			await tick();
			filteredIndex = filteredResources.findIndex((resource) => resource.key === key);
		}

		if (filteredIndex >= 0) {
			currentPage = Math.floor(filteredIndex / PAGE_SIZE) + 1;
			return;
		}

		const allResourceIndex = analysis?.resources.findIndex((resource) => resource.key === key) ?? -1;
			currentPage = allResourceIndex >= 0 ? Math.floor(allResourceIndex / PAGE_SIZE) + 1 : 1;
	}
</script>

<main class="min-h-screen p-4 md:p-8">
	<div class="mx-auto max-w-[1720px] space-y-6">
		<header
			class="surface-strong rise-in relative overflow-hidden rounded-3xl p-6 md:p-8 lg:p-10 xl:pr-20"
		>
			<div
				class="pointer-events-none absolute -right-16 -top-24 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(244,162,97,0.45),rgba(244,162,97,0.0)_72%)]"
			></div>
			<div
				class="pointer-events-none absolute -left-16 bottom-[-5.4rem] h-52 w-60 rounded-full bg-[radial-gradient(circle,rgba(21,97,109,0.2),rgba(21,97,109,0)_70%)]"
			></div>
			<div class="relative grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-end">
				<div>
					<p class="mb-3 inline-flex items-center gap-2 rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-xs font-bold tracking-[0.2em] text-teal-800 uppercase">
						Patient Bundle Intelligence
					</p>
					<h1 class="max-w-4xl text-balance text-3xl leading-tight font-bold text-slate-900 md:text-5xl">
						FHIR bundle viewer designed for insight, not raw JSON scrolling
					</h1>
					<p class="mt-4 max-w-3xl text-base leading-relaxed text-slate-600 md:text-lg">
						Track clinical signal density, medication complexity, encounter patterns, and reference
						connectivity. Every resource is linkable, searchable, and contextualized against the
						patient timeline.
					</p>
				</div>
				<div class="surface rounded-2xl border border-slate-200 p-4 shadow-sm">
					<p class="text-xs font-semibold tracking-wide text-slate-500 uppercase">Current Bundle</p>
					<p class="mt-2 text-xl font-bold text-slate-900">
						{selectedPatientId ? `Patient ${selectedPatientId}` : 'None selected'}
					</p>
					{#if analysis?.patient}
						<p class="mt-1 text-sm text-slate-600">{analysis.patient.name}</p>
					{/if}
					<button
						class="mt-4 inline-flex w-full items-center justify-center rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
						onclick={() => selectedPatientId && loadBundle(selectedPatientId)}
						disabled={loadingBundle}
					>
						{loadingBundle ? 'Loading Bundle...' : 'Refresh Bundle'}
					</button>
				</div>
			</div>
		</header>

		{#if loadError}
			<div class="rise-in rise-delay-1 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
				{loadError}
			</div>
		{/if}

		<div class="grid gap-5 xl:grid-cols-[19rem_minmax(0,1fr)_24rem]">
			<aside class="surface rise-in rise-delay-1 h-fit rounded-2xl p-4 xl:sticky xl:top-4">
				<div class="flex items-center justify-between">
					<h2 class="text-xl font-bold text-slate-900">Patients</h2>
					<span class="rounded-full bg-slate-900 px-2 py-1 text-xs font-semibold text-white">
						{formatNumber(bundleMetas.length)}
					</span>
				</div>
				<div class="mt-3 space-y-3">
					<input
						bind:value={patientSearch}
						type="search"
						placeholder="Find patient id..."
						class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none ring-0 transition focus:border-teal-400 focus:shadow-[0_0_0_3px_rgba(20,184,166,0.12)]"
					/>
					<div class="max-h-[68vh] space-y-2 overflow-auto pr-1">
						{#if loadingList}
							<p class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
								Loading patient bundles...
							</p>
						{:else}
							{#each visibleBundles as bundleMeta (bundleMeta.patientId)}
								<button
									class={`w-full rounded-xl border px-3 py-2 text-left transition ${
										bundleMeta.patientId === selectedPatientId
											? 'border-teal-300 bg-teal-50 shadow-sm'
											: 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
									}`}
									onclick={() => openPatientBundle(bundleMeta.patientId)}
								>
									<p class="truncate text-sm font-semibold text-slate-900">{bundleMeta.patientId}</p>
									<p class="mt-1 text-xs text-slate-500">
										{formatBytes(bundleMeta.fileSizeBytes)} · {formatDateTime(bundleMeta.modifiedAt)}
									</p>
								</button>
							{/each}
						{/if}
					</div>
				</div>
			</aside>

			<section class="space-y-5">
				{#if !analysis}
					<div class="surface rise-in rise-delay-2 rounded-2xl p-6 text-sm text-slate-600">
						{loadingBundle ? 'Loading bundle data...' : 'Select a patient to start exploring.'}
					</div>
				{:else}
					<section class="rise-in rise-delay-2 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
						<div class="surface rounded-2xl p-4">
							<p class="text-xs font-semibold tracking-wide text-slate-500 uppercase">Resources</p>
							<p class="mt-2 text-3xl font-bold text-slate-900">
								{formatNumber(analysis.metrics.totalResources)}
							</p>
							<p class="mt-1 text-xs text-slate-500">
								{formatNumber(analysis.metrics.uniqueResourceTypes)} distinct resource types
							</p>
						</div>
						<div class="surface rounded-2xl p-4">
							<p class="text-xs font-semibold tracking-wide text-slate-500 uppercase">Clinical Signal</p>
							<p class="mt-2 text-3xl font-bold text-slate-900">
								{formatNumber(analysis.metrics.observationCount)}
							</p>
							<p class="mt-1 text-xs text-slate-500">
								{formatNumber(analysis.metrics.abnormalObservationCount)} marked abnormal
							</p>
						</div>
						<div class="surface rounded-2xl p-4">
							<p class="text-xs font-semibold tracking-wide text-slate-500 uppercase">Medication Load</p>
							<p class="mt-2 text-3xl font-bold text-slate-900">
								{formatNumber(analysis.metrics.medicationCount)}
							</p>
							<p class="mt-1 text-xs text-slate-500">
								{formatNumber(analysis.metrics.activeMedicationRequests)} active requests
							</p>
						</div>
						<div class="surface rounded-2xl p-4">
							<p class="text-xs font-semibold tracking-wide text-slate-500 uppercase">Care Span</p>
							<p class="mt-2 text-3xl font-bold text-slate-900">
								{careSpanDays === null ? 'N/A' : `${formatNumber(careSpanDays)} d`}
							</p>
							<p class="mt-1 text-xs text-slate-500">
								{formatNumber(analysis.metrics.encounterCount)} encounters ·
								{formatNumber(analysis.metrics.emergencyEncounterCount)} emergency
							</p>
						</div>
					</section>

					<section class="rise-in rise-delay-2 surface rounded-2xl p-5">
						<div class="mb-4 flex items-center justify-between">
							<h2 class="text-2xl font-bold text-slate-900">Actionable Insights</h2>
							<span class="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">
								Auto-generated
							</span>
						</div>
						<div class="grid gap-3 md:grid-cols-2">
							{#each analysis.insights as insight (insight.id)}
								<article class={`rounded-2xl border px-4 py-3 ${insightSeverityClass[insight.severity]}`}>
									<div class="flex items-center justify-between">
										<h3 class="font-semibold">{insight.label}</h3>
										<span class="text-xs font-bold tracking-wide uppercase">{insight.severity}</span>
									</div>
									<p class="mt-2 text-sm">{insight.message}</p>
									<p class="mt-2 text-xs opacity-80"><span class="font-semibold">Action:</span> {insight.action}</p>
								</article>
							{/each}
						</div>
					</section>

					<section class="rise-in rise-delay-3 grid gap-5 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
						<div class="surface rounded-2xl p-5">
							<h2 class="text-2xl font-bold text-slate-900">Resource Mix</h2>
							<p class="mt-1 text-sm text-slate-500">
								Distribution of resources in the selected patient bundle
							</p>
							<div class="mt-4 space-y-3">
								{#each analysis.typeCounts as typeCount (typeCount.type)}
									<div>
										<div class="mb-1 flex items-center justify-between text-xs text-slate-600">
											<span>{typeCount.type}</span>
											<span>{formatNumber(typeCount.count)}</span>
										</div>
										<div class="h-2 rounded-full bg-slate-100">
											<div
												class="h-2 rounded-full bg-gradient-to-r from-teal-600 to-sky-400"
												style={`width: ${Math.max(4, (typeCount.count / analysis.metrics.totalResources) * 100)}%`}
											></div>
										</div>
									</div>
								{/each}
							</div>
						</div>

						<div class="surface rounded-2xl p-5">
							<div class="flex items-center justify-between">
								<div>
									<h2 class="text-2xl font-bold text-slate-900">Patient Timeline</h2>
									<p class="mt-1 text-sm text-slate-500">Latest clinically timestamped resources</p>
								</div>
								<select
									bind:value={timelineWindowSize}
									class="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs"
								>
									<option value={24}>24 events</option>
									<option value={36}>36 events</option>
									<option value={72}>72 events</option>
									<option value={120}>120 events</option>
								</select>
							</div>
							<div class="mt-4 max-h-[30rem] space-y-2 overflow-auto pr-1">
								{#each visibleTimeline as event (event.resourceKey)}
									<button
										class={`w-full rounded-xl border px-3 py-2 text-left transition ${
											selectedResourceKey === event.resourceKey
												? 'border-teal-300 bg-teal-50 shadow-sm'
												: 'border-slate-200 bg-white hover:border-teal-300 hover:bg-teal-50'
										}`}
										onclick={() => void jumpToResource(event.resourceKey)}
									>
										<div class="flex items-start justify-between gap-3">
											<div>
												<p class="text-sm font-semibold text-slate-900">{event.title}</p>
												<p class="text-xs text-slate-500">{event.type} · {event.detail}</p>
											</div>
											<p class="text-xs font-medium whitespace-nowrap text-slate-500">
												{formatDateTime(event.dateIso)}
											</p>
										</div>
									</button>
								{/each}
							</div>
						</div>
					</section>

					<section class="rise-in rise-delay-3 surface rounded-2xl p-5">
						<div class="flex flex-wrap items-end justify-between gap-3">
							<div>
								<h2 class="text-2xl font-bold text-slate-900">Linked Resource Explorer</h2>
								<p class="mt-1 text-sm text-slate-500">
									Filter, search, and jump between clinically related resources
								</p>
							</div>
							<div class="flex flex-wrap gap-2">
								<input
									bind:value={resourceSearch}
									type="search"
									placeholder="Search by key, title, status..."
									class="min-w-60 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-teal-400 focus:shadow-[0_0_0_3px_rgba(20,184,166,0.12)]"
								/>
								<select
									bind:value={selectedResourceTypeFilter}
									class="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
								>
									{#each resourceTypeOptions as option}
										<option value={option}>
											{option === 'all' ? 'All resource types' : option}
										</option>
									{/each}
								</select>
							</div>
						</div>

						<div class="mt-4 overflow-x-auto rounded-xl border border-slate-200">
							<table class="min-w-full divide-y divide-slate-200 bg-white text-sm">
								<thead class="bg-slate-50">
									<tr>
										<th class="px-3 py-2 text-left font-semibold text-slate-600">Resource</th>
										<th class="px-3 py-2 text-left font-semibold text-slate-600">Type</th>
										<th class="px-3 py-2 text-left font-semibold text-slate-600">Date</th>
										<th class="px-3 py-2 text-left font-semibold text-slate-600">Links</th>
									</tr>
								</thead>
								<tbody class="divide-y divide-slate-100">
									{#each paginatedResources as resource (resource.key)}
										<tr
											class={`transition ${
												selectedResourceKey === resource.key
													? 'bg-teal-50/80 ring-1 ring-inset ring-teal-300'
													: 'hover:bg-slate-50'
											}`}
										>
											<td class="px-3 py-2">
												<button
													class="text-left"
													onclick={() => void jumpToResource(resource.key)}
												>
													<p class="font-semibold text-slate-900">{resource.title}</p>
													<p class="text-xs text-slate-500">{resource.key}</p>
												</button>
											</td>
											<td class="px-3 py-2 text-slate-700">{resource.type}</td>
											<td class="px-3 py-2 text-slate-600">{formatDateTime(resource.dateIso)}</td>
											<td class="px-3 py-2 text-slate-600">
												{formatNumber(
													resource.outboundReferences.length +
														(analysis.inboundReferenceMap.get(resource.key)?.length ?? 0)
												)}
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>

						<div class="mt-3 flex items-center justify-between text-xs text-slate-500">
							<p>
								Showing {formatNumber(paginatedResources.length)} of {formatNumber(filteredResources.length)}
								filtered resources
							</p>
							<div class="flex items-center gap-2">
								<button
									class="rounded-lg border border-slate-200 bg-white px-2 py-1 disabled:opacity-40"
									disabled={currentPage <= 1}
									onclick={() => (currentPage = Math.max(1, currentPage - 1))}
								>
									Prev
								</button>
								<span>Page {currentPage} / {totalPages}</span>
								<button
									class="rounded-lg border border-slate-200 bg-white px-2 py-1 disabled:opacity-40"
									disabled={currentPage >= totalPages}
									onclick={() => (currentPage = Math.min(totalPages, currentPage + 1))}
								>
									Next
								</button>
							</div>
						</div>
					</section>
				{/if}
			</section>

			<aside class="surface rise-in rise-delay-3 h-fit rounded-2xl p-4 xl:sticky xl:top-4">
				<div class="flex items-center justify-between gap-3">
					<h2 class="text-xl font-bold text-slate-900">Resource Detail</h2>
					<div class="flex items-center gap-2">
						<button
							class="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-sm font-semibold text-slate-700 transition hover:border-teal-300 hover:bg-teal-50 disabled:cursor-not-allowed disabled:opacity-35"
							onclick={() => void navigateResourceHistory(-1)}
							disabled={!canGoBackInResourceHistory}
							title="Back to previous resource"
							aria-label="Back to previous resource"
						>
							←
						</button>
						<button
							class="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-sm font-semibold text-slate-700 transition hover:border-teal-300 hover:bg-teal-50 disabled:cursor-not-allowed disabled:opacity-35"
							onclick={() => void navigateResourceHistory(1)}
							disabled={!canGoForwardInResourceHistory}
							title="Forward to next resource"
							aria-label="Forward to next resource"
						>
							→
						</button>
					</div>
				</div>
				{#if selectedResource}
					<div class="mt-3 space-y-4">
						<div class="rounded-xl border border-slate-200 bg-white p-3">
							<p class="text-xs font-semibold tracking-wide text-slate-500 uppercase">
								{selectedResource.type}
							</p>
							<p class="mt-1 text-base font-semibold text-slate-900">
								{getResourceHeadline(selectedResource)}
							</p>
							<p class="mt-1 text-xs text-slate-500">{selectedResource.key}</p>
							<p class="mt-2 text-xs text-slate-600">{selectedResource.subtitle || 'No subtitle provided'}</p>
							<p class="mt-2 text-xs text-slate-500">Timestamp: {formatDateTime(selectedResource.dateIso)}</p>
						</div>

						<div class="rounded-xl border border-slate-200 bg-white p-3">
							<p class="text-xs font-semibold tracking-wide text-slate-500 uppercase">Outbound References</p>
							<div class="mt-2 flex flex-wrap gap-2">
								{#if outboundReferences.length === 0}
									<span class="text-xs text-slate-500">No outbound references</span>
								{:else}
									{#each outboundReferences as reference (reference.key)}
										<button
												class={`rounded-full border px-2 py-1 text-xs transition ${
													reference.node
														? selectedResourceKey === reference.key
															? 'border-teal-300 bg-teal-100 text-teal-950 ring-1 ring-teal-300'
															: 'border-teal-200 bg-teal-50 text-teal-900 hover:bg-teal-100'
														: 'border-slate-200 bg-slate-50 text-slate-500'
												}`}
												onclick={() => reference.node && void jumpToResource(reference.key)}
												disabled={!reference.node}
											>
											{reference.key}
										</button>
									{/each}
								{/if}
							</div>
						</div>

						<div class="rounded-xl border border-slate-200 bg-white p-3">
							<p class="text-xs font-semibold tracking-wide text-slate-500 uppercase">Inbound References</p>
							<div class="mt-2 max-h-44 space-y-1 overflow-auto pr-1">
								{#if inboundReferences.length === 0}
									<p class="text-xs text-slate-500">No resources reference this record.</p>
								{:else}
									{#each inboundReferences as inbound (inbound.key)}
										<button
											class={`block w-full rounded-lg border px-2 py-1 text-left text-xs transition ${
												selectedResourceKey === inbound.key
													? 'border-teal-300 bg-teal-100 text-teal-950 ring-1 ring-teal-300'
													: 'border-slate-200 bg-slate-50 text-slate-700 hover:border-teal-200 hover:bg-teal-50'
											}`}
											onclick={() => void jumpToResource(inbound.key)}
										>
											<p class="font-semibold">{inbound.title}</p>
											<p class="text-[11px] text-slate-500">{inbound.key}</p>
										</button>
									{/each}
								{/if}
							</div>
						</div>

						<details class="rounded-xl border border-slate-200 bg-white p-3">
							<summary class="cursor-pointer text-xs font-semibold tracking-wide text-slate-600 uppercase">
								Raw JSON
							</summary>
							<pre class="mt-2 max-h-72 overflow-auto rounded-lg bg-slate-950 p-3 text-[11px] leading-relaxed text-slate-100">{selectedResourceRawJson}</pre>
						</details>
					</div>
				{:else}
					<p class="mt-3 text-sm text-slate-500">Select a resource from the explorer to inspect links and details.</p>
				{/if}
			</aside>
		</div>
	</div>
</main>
