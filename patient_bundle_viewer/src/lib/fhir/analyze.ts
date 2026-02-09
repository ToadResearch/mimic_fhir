import type {
	BundleAnalysis,
	BundleMetrics,
	FhirBundle,
	FhirResource,
	Insight,
	PatientSummary,
	ResourceNode,
	TimelineEvent
} from '$lib/fhir/types';

const ABNORMAL_INTERPRETATION_CODES = new Set(['H', 'HH', 'L', 'LL', 'A', 'AA', 'CRIT', 'PANIC']);
const MEDICATION_RESOURCE_TYPES = new Set([
	'MedicationRequest',
	'MedicationAdministration',
	'MedicationDispense',
	'MedicationStatement'
]);

const dateFormatter = new Intl.DateTimeFormat(undefined, {
	year: 'numeric',
	month: 'short',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit'
});

const numberFormatter = new Intl.NumberFormat();

function asObject(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function safeLookupString(object: Record<string, unknown>, key: string): string | null {
	return asString(object[key]);
}

function firstCodingLabel(value: unknown): string | null {
	const object = asObject(value);
	if (!object) {
		return null;
	}

	const text = safeLookupString(object, 'text');
	if (text) {
		return text;
	}

	for (const coding of asArray(object.coding)) {
		const codingObject = asObject(coding);
		if (!codingObject) {
			continue;
		}
		const display = safeLookupString(codingObject, 'display');
		if (display) {
			return display;
		}
		const code = safeLookupString(codingObject, 'code');
		if (code) {
			return code;
		}
	}

	return null;
}

function normalizeReference(reference: string): string | null {
	if (!reference || reference.startsWith('#') || reference.startsWith('urn:uuid:')) {
		return null;
	}

	let candidate = reference.split('#', 1)[0].split('?', 1)[0];

	if (candidate.includes('://')) {
		try {
			candidate = new URL(candidate).pathname;
		} catch {
			const afterScheme = candidate.slice(candidate.indexOf('://') + 3);
			const slashIndex = afterScheme.indexOf('/');
			if (slashIndex === -1) {
				return null;
			}
			candidate = afterScheme.slice(slashIndex);
		}
	}

	const parts = candidate.split('/').filter(Boolean);
	if (parts.length < 2) {
		return null;
	}

	const historyIndex = parts.indexOf('_history');
	if (historyIndex >= 2) {
		return `${parts[historyIndex - 2]}/${parts[historyIndex - 1]}`;
	}

	return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function collectReferences(value: unknown, output: Set<string>): void {
	if (Array.isArray(value)) {
		for (const item of value) {
			collectReferences(item, output);
		}
		return;
	}

	const object = asObject(value);
	if (!object) {
		return;
	}

	for (const [key, nestedValue] of Object.entries(object)) {
		if (key === 'reference') {
			const reference = asString(nestedValue);
			if (!reference) {
				continue;
			}
			const normalized = normalizeReference(reference);
			if (normalized) {
				output.add(normalized);
			}
			continue;
		}

		if (typeof nestedValue === 'object' && nestedValue !== null) {
			collectReferences(nestedValue, output);
		}
	}
}

function extractObservationValue(resource: FhirResource): string | null {
	const valueQuantity = asObject(resource.valueQuantity);
	if (valueQuantity) {
		const numericValue = valueQuantity.value;
		const unit = safeLookupString(valueQuantity, 'unit') ?? safeLookupString(valueQuantity, 'code') ?? '';
		if (typeof numericValue === 'number' || typeof numericValue === 'string') {
			const trimmedUnit = unit ? ` ${unit}` : '';
			return `${numericValue}${trimmedUnit}`;
		}
	}

	return (
		firstCodingLabel(resource.valueCodeableConcept) ??
		asString(resource.valueString) ??
		asString(resource.valueBoolean)
	);
}

function formatPatientName(resource: FhirResource): string {
	const names = asArray(resource.name);
	for (const nameValue of names) {
		const name = asObject(nameValue);
		if (!name) {
			continue;
		}
		const family = safeLookupString(name, 'family');
		const given = asArray(name.given).filter((item): item is string => typeof item === 'string').join(' ');
		const full = `${given} ${family ?? ''}`.trim();
		if (full) {
			return full;
		}
	}

	return resource.id ? `Patient ${resource.id}` : 'Patient';
}

function getResourceLabel(resource: FhirResource): string {
	const type = asString(resource.resourceType) ?? 'Resource';

	if (type === 'Patient') {
		return formatPatientName(resource);
	}

	if (type === 'Observation') {
		const code = firstCodingLabel(resource.code) ?? 'Observation';
		const value = extractObservationValue(resource);
		return value ? `${code} · ${value}` : code;
	}

	if (type === 'Condition' || type === 'Procedure') {
		return firstCodingLabel(resource.code) ?? `${type} ${resource.id ?? ''}`.trim();
	}

	if (type.startsWith('Medication')) {
		return (
			firstCodingLabel(resource.medicationCodeableConcept) ??
			firstCodingLabel(resource.code) ??
			`${type} ${resource.id ?? ''}`.trim()
		);
	}

	if (type === 'Encounter') {
		return (
			firstCodingLabel(resource.class) ??
			firstCodingLabel(asArray(resource.type)[0]) ??
			`${type} ${resource.id ?? ''}`.trim()
		);
	}

	if (type === 'Specimen') {
		return firstCodingLabel(resource.type) ?? `${type} ${resource.id ?? ''}`.trim();
	}

	return (
		firstCodingLabel(resource.code) ??
		firstCodingLabel(resource.type) ??
		firstCodingLabel(resource.category) ??
		`${type} ${resource.id ?? ''}`.trim()
	);
}

function getResourceSubtitle(resource: FhirResource): string {
	const status = asString(resource.status);
	const category = firstCodingLabel(resource.category);
	const encounterRef = asObject(resource.encounter)?.reference;
	const encounter = asString(encounterRef);

	return [status, category, encounter].filter(Boolean).join(' · ');
}

function getPrimaryDate(resource: FhirResource): string | null {
	const directCandidates = [
		asString(resource.effectiveDateTime),
		asString(resource.issued),
		asString(resource.authoredOn),
		asString(resource.recordedDate),
		asString(resource.onsetDateTime),
		asString(resource.abatementDateTime),
		asString(resource.performedDateTime),
		asString(resource.occurrenceDateTime),
		asString(resource.lastOccurrence)
	].filter((value): value is string => Boolean(value));

	if (directCandidates.length > 0) {
		return directCandidates[0];
	}

	for (const field of ['effectivePeriod', 'period', 'performedPeriod', 'occurrencePeriod']) {
		const object = asObject(resource[field]);
		if (!object) {
			continue;
		}
		const start = safeLookupString(object, 'start');
		if (start) {
			return start;
		}
		const end = safeLookupString(object, 'end');
		if (end) {
			return end;
		}
	}

	return null;
}

function parseTimestamp(dateIso: string | null): number | null {
	if (!dateIso) {
		return null;
	}
	const value = Date.parse(dateIso);
	return Number.isNaN(value) ? null : value;
}

function parseResourceNode(resource: FhirResource, fallbackKey: string): ResourceNode {
	const type = asString(resource.resourceType) ?? 'Unknown';
	const id = asString(resource.id) ?? fallbackKey;
	const key = `${type}/${id}`;
	const dateIso = getPrimaryDate(resource);
	const references = new Set<string>();
	collectReferences(resource, references);

	return {
		key,
		type,
		id,
		title: getResourceLabel(resource),
		subtitle: getResourceSubtitle(resource),
		dateIso,
		timestamp: parseTimestamp(dateIso),
		status: asString(resource.status),
		outboundReferences: Array.from(references).sort(),
		resource
	};
}

function isObservationAbnormal(resource: FhirResource): boolean {
	const interpretation = asArray(resource.interpretation);
	for (const candidate of interpretation) {
		const object = asObject(candidate);
		if (!object) {
			continue;
		}

		const text = safeLookupString(object, 'text');
		if (text && /(high|low|abnormal|critical|panic|alert)/i.test(text)) {
			return true;
		}

		for (const codingValue of asArray(object.coding)) {
			const coding = asObject(codingValue);
			if (!coding) {
				continue;
			}

			const code = safeLookupString(coding, 'code');
			if (code && ABNORMAL_INTERPRETATION_CODES.has(code.toUpperCase())) {
				return true;
			}

			const display = safeLookupString(coding, 'display');
			if (display && /(high|low|abnormal|critical|panic|alert)/i.test(display)) {
				return true;
			}
		}
	}

	return false;
}

function buildInsights(metrics: BundleMetrics): Insight[] {
	const insights: Insight[] = [];

	if (metrics.abnormalObservationCount > 0) {
		insights.push({
			id: 'abnormal-observations',
			label: 'Abnormal Clinical Signals',
			severity: 'high',
			message: `${formatNumber(metrics.abnormalObservationCount)} observations are marked abnormal/high/low.`,
			action:
				'Review the most recent abnormal observations and link them to recent medication changes or procedures.'
		});
	}

	if (metrics.activeMedicationRequests >= 12 || metrics.medicationCount >= 250) {
		insights.push({
			id: 'med-burden',
			label: 'Medication Management Load',
			severity: 'medium',
			message: `${formatNumber(metrics.activeMedicationRequests)} active medication requests across ${formatNumber(metrics.medicationCount)} medication-related records.`,
			action:
				'Run a medication reconciliation pass: check duplications, stop reasons, and mismatch between requests and administrations.'
		});
	}

	if (metrics.emergencyEncounterCount >= 2) {
		insights.push({
			id: 'encounter-pattern',
			label: 'Emergency Utilization Pattern',
			severity: 'medium',
			message: `${formatNumber(metrics.emergencyEncounterCount)} emergency encounters detected.`,
			action:
				'Inspect timeline clusters around emergency visits and tie them to conditions, procedures, and discharge medications.'
		});
	}

	if (metrics.isolatedResources > 0) {
		insights.push({
			id: 'data-link-gaps',
			label: 'Reference Link Gaps',
			severity: 'low',
			message: `${formatNumber(metrics.isolatedResources)} resources are isolated from the rest of the graph.`,
			action:
				'Validate reference integrity for isolated records to improve traceability from observations to encounters and treatment context.'
		});
	}

	if (
		metrics.earliestTimestamp !== null &&
		metrics.latestTimestamp !== null &&
		metrics.latestTimestamp - metrics.earliestTimestamp > 1000 * 60 * 60 * 24 * 365 * 2
	) {
		insights.push({
			id: 'longitudinal',
			label: 'Longitudinal Record',
			severity: 'low',
			message: 'Clinical data spans multiple years of care.',
			action:
				'Segment care into episodes (acute, chronic, follow-up) to prioritize what needs immediate review.'
		});
	}

	if (insights.length === 0) {
		insights.push({
			id: 'baseline',
			label: 'Stable Data Profile',
			severity: 'low',
			message: 'No high-risk signal was auto-detected from bundle-level heuristics.',
			action:
				'Use the timeline and linked-resource explorer to drill into encounters with dense observation or medication activity.'
		});
	}

	return insights.slice(0, 5);
}

function derivePatientSummary(nodes: ResourceNode[]): PatientSummary | null {
	const patient = nodes.find((node) => node.type === 'Patient');
	if (!patient) {
		return null;
	}

	return {
		key: patient.key,
		name: formatPatientName(patient.resource),
		gender: asString(patient.resource.gender),
		birthDate: asString(patient.resource.birthDate),
		deceasedDateTime: asString(patient.resource.deceasedDateTime),
		managingOrganization: asString(asObject(patient.resource.managingOrganization)?.reference)
	};
}

export function analyzeBundle(bundle: FhirBundle): BundleAnalysis {
	const entries = Array.isArray(bundle.entry) ? bundle.entry : [];
	const resources: ResourceNode[] = [];
	const resourceIndex = new Map<string, ResourceNode>();
	const typeCounts = new Map<string, number>();
	const inboundReferenceMap = new Map<string, string[]>();

	let abnormalObservationCount = 0;
	let emergencyEncounterCount = 0;
	let activeMedicationRequests = 0;
	let earliestTimestamp: number | null = null;
	let latestTimestamp: number | null = null;
	let totalLinks = 0;

	for (const [index, entry] of entries.entries()) {
		const resource = asObject(entry?.resource);
		if (!resource) {
			continue;
		}

		const node = parseResourceNode(resource as FhirResource, `entry-${index}`);
		resources.push(node);
		resourceIndex.set(node.key, node);

		typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1);

		if (node.timestamp !== null) {
			earliestTimestamp =
				earliestTimestamp === null ? node.timestamp : Math.min(earliestTimestamp, node.timestamp);
			latestTimestamp =
				latestTimestamp === null ? node.timestamp : Math.max(latestTimestamp, node.timestamp);
		}

		if (node.type === 'Observation' && isObservationAbnormal(node.resource)) {
			abnormalObservationCount += 1;
		}

		if (node.type === 'Encounter') {
			const encounterClass = firstCodingLabel(node.resource.class);
			if (encounterClass && /emerg/i.test(encounterClass)) {
				emergencyEncounterCount += 1;
			}
		}

		if (node.type === 'MedicationRequest') {
			const status = (node.status ?? '').toLowerCase();
			if (status === 'active' || status === 'on-hold' || status === 'draft') {
				activeMedicationRequests += 1;
			}
		}
	}

	for (const node of resources) {
		for (const targetKey of node.outboundReferences) {
			totalLinks += 1;
			const inbound = inboundReferenceMap.get(targetKey) ?? [];
			inbound.push(node.key);
			inboundReferenceMap.set(targetKey, inbound);
		}
	}

	const isolatedResources = resources.filter(
		(node) => node.outboundReferences.length === 0 && (inboundReferenceMap.get(node.key)?.length ?? 0) === 0
	).length;

	const timeline: TimelineEvent[] = resources
		.filter((node) => node.timestamp !== null && node.dateIso !== null)
		.map((node) => ({
			resourceKey: node.key,
			type: node.type,
			title: node.title,
			detail: node.subtitle || 'No additional context',
			dateIso: node.dateIso!,
			timestamp: node.timestamp!
		}))
		.sort((left, right) => right.timestamp - left.timestamp)
		.slice(0, 180);

	const metrics: BundleMetrics = {
		totalResources: resources.length,
		uniqueResourceTypes: typeCounts.size,
		observationCount: typeCounts.get('Observation') ?? 0,
		abnormalObservationCount,
		encounterCount: typeCounts.get('Encounter') ?? 0,
		emergencyEncounterCount,
		medicationCount: Array.from(MEDICATION_RESOURCE_TYPES).reduce(
			(total, type) => total + (typeCounts.get(type) ?? 0),
			0
		),
		activeMedicationRequests,
		conditionCount: typeCounts.get('Condition') ?? 0,
		procedureCount: typeCounts.get('Procedure') ?? 0,
		resourceLinks: totalLinks,
		isolatedResources,
		earliestTimestamp,
		latestTimestamp
	};

	return {
		patient: derivePatientSummary(resources),
		metrics,
		typeCounts: Array.from(typeCounts.entries())
			.map(([type, count]) => ({ type, count }))
			.sort((left, right) => right.count - left.count || left.type.localeCompare(right.type)),
		resources: resources.sort((left, right) => {
			if (left.type === 'Patient' && right.type !== 'Patient') {
				return -1;
			}
			if (right.type === 'Patient' && left.type !== 'Patient') {
				return 1;
			}
			if (left.timestamp !== null && right.timestamp !== null) {
				return right.timestamp - left.timestamp;
			}
			return left.key.localeCompare(right.key);
		}),
		resourceIndex,
		inboundReferenceMap,
		timeline,
		insights: buildInsights(metrics)
	};
}

export function formatDateTime(value: string | null): string {
	if (!value) {
		return 'N/A';
	}
	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) {
		return value;
	}
	return dateFormatter.format(new Date(timestamp));
}

export function formatNumber(value: number): string {
	return numberFormatter.format(value);
}

export function formatBytes(value: number): string {
	if (!Number.isFinite(value) || value < 0) {
		return '0 B';
	}

	if (value < 1024) {
		return `${value} B`;
	}

	if (value < 1024 * 1024) {
		return `${(value / 1024).toFixed(1)} KB`;
	}

	if (value < 1024 * 1024 * 1024) {
		return `${(value / (1024 * 1024)).toFixed(1)} MB`;
	}

	return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function getResourceHeadline(resource: ResourceNode | null): string {
	if (!resource) {
		return 'Select a resource';
	}
	return resource.title;
}
