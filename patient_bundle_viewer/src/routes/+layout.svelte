<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<meta
		name="description"
		content="Patient-focused FHIR bundle viewer with actionable insights, metrics, and linked resource navigation."
	/>
</svelte:head>

{@render children()}
