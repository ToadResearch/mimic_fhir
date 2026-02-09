export interface BundleMeta {
	patientId: string;
	fileName: string;
	fileSizeBytes: number;
	modifiedAt: string;
}

export interface FhirReference {
	reference?: string;
	display?: string;
}

export interface FhirResource {
	resourceType?: string;
	id?: string;
	[key: string]: unknown;
}

export interface FhirBundleEntry {
	fullUrl?: string;
	resource?: FhirResource;
}

export interface FhirBundle {
	resourceType?: string;
	id?: string;
	type?: string;
	entry?: FhirBundleEntry[];
}

export interface ResourceNode {
	key: string;
	type: string;
	id: string;
	title: string;
	subtitle: string;
	dateIso: string | null;
	timestamp: number | null;
	status: string | null;
	outboundReferences: string[];
	resource: FhirResource;
}

export interface Insight {
	id: string;
	label: string;
	severity: 'high' | 'medium' | 'low';
	message: string;
	action: string;
}

export interface BundleMetrics {
	totalResources: number;
	uniqueResourceTypes: number;
	observationCount: number;
	abnormalObservationCount: number;
	encounterCount: number;
	emergencyEncounterCount: number;
	medicationCount: number;
	activeMedicationRequests: number;
	conditionCount: number;
	procedureCount: number;
	resourceLinks: number;
	isolatedResources: number;
	earliestTimestamp: number | null;
	latestTimestamp: number | null;
}

export interface PatientSummary {
	key: string;
	name: string;
	gender: string | null;
	birthDate: string | null;
	deceasedDateTime: string | null;
	managingOrganization: string | null;
}

export interface TimelineEvent {
	resourceKey: string;
	type: string;
	title: string;
	detail: string;
	dateIso: string;
	timestamp: number;
}

export interface BundleAnalysis {
	patient: PatientSummary | null;
	metrics: BundleMetrics;
	typeCounts: Array<{ type: string; count: number }>;
	resources: ResourceNode[];
	resourceIndex: Map<string, ResourceNode>;
	inboundReferenceMap: Map<string, string[]>;
	timeline: TimelineEvent[];
	insights: Insight[];
}
