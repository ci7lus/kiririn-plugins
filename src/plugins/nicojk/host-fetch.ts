function resolveFetchImpl() {
	if (typeof globalThis.fetch === "function") {
		return globalThis.fetch.bind(globalThis);
	}
	throw new Error("No fetch implementation available");
}

export async function hostFetch(input: RequestInfo | URL, init?: RequestInit) {
	return resolveFetchImpl()(input, init);
}

export async function nativeFetch(
	input: RequestInfo | URL,
	init?: RequestInit,
) {
	return resolveFetchImpl()(input, init);
}

export async function hostFetchText(
	input: RequestInfo | URL,
	init?: RequestInit,
) {
	const response = await hostFetch(input, init);
	if (!response.ok) {
		throw new Error(
			`Request failed: ${response.status} ${response.statusText}`,
		);
	}
	return response.text();
}

export async function hostFetchJson<T>(
	input: RequestInfo | URL,
	init?: RequestInit,
) {
	const response = await hostFetch(input, init);
	if (!response.ok) {
		throw new Error(
			`Request failed: ${response.status} ${response.statusText}`,
		);
	}
	return (await response.json()) as T;
}

export async function fetchText(input: RequestInfo | URL, init?: RequestInit) {
	const response = await nativeFetch(input, init);
	if (!response.ok) {
		throw new Error(
			`Request failed: ${response.status} ${response.statusText}`,
		);
	}
	return response.text();
}

export async function fetchJson<T>(
	input: RequestInfo | URL,
	init?: RequestInit,
) {
	const response = await nativeFetch(input, init);
	if (!response.ok) {
		throw new Error(
			`Request failed: ${response.status} ${response.statusText}`,
		);
	}
	return (await response.json()) as T;
}
