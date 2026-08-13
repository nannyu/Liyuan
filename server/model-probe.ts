/** Provider-aware model catalog probing for connection setup. */

export type ModelProbeResult = {
	ok: boolean;
	status: number;
	detail: string;
	ids: string[];
};

function resolveProbeKey(apiKey?: string): string | undefined {
	if (!apiKey || apiKey === "placeholder") return undefined;
	if (apiKey.startsWith("$")) {
		const name = apiKey.slice(1).replace(/^\{|\}$/g, "");
		const value = process.env[name];
		return value || undefined;
	}
	if (apiKey.startsWith("!")) return undefined;
	return apiKey;
}

function requestFor(baseUrl: string, api?: string, apiKey?: string): { url: string; headers: Record<string, string> } {
	const base = baseUrl.replace(/\/+$/, "");
	const key = resolveProbeKey(apiKey);
	const headers: Record<string, string> = {};

	if (api === "anthropic-messages") {
		if (key) headers["x-api-key"] = key;
		headers["anthropic-version"] = "2023-06-01";
		return { url: `${base.endsWith("/v1") ? base : `${base}/v1`}/models?limit=1000`, headers };
	}

	if (api === "google-generative-ai") {
		if (key) headers["x-goog-api-key"] = key;
		return { url: `${base}/models?pageSize=1000`, headers };
	}

	if (key) headers.authorization = `Bearer ${key}`;
	return { url: `${base}/models`, headers };
}

function normalizeModelId(value: unknown, api?: string): string {
	const id = String(value ?? "").trim();
	return api === "google-generative-ai" ? id.replace(/^models\//, "") : id;
}

export async function probeModelsEndpoint(baseUrl: string, apiKey?: string, api?: string): Promise<ModelProbeResult> {
	const { url, headers } = requestFor(baseUrl, api, apiKey);
	try {
		const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
		if (!response.ok) {
			return {
				ok: false,
				status: response.status,
				detail: (await response.text()).slice(0, 300) || `HTTP ${response.status}`,
				ids: [],
			};
		}
		const json = (await response.json()) as {
			data?: Array<{ id?: unknown; name?: unknown }>;
			models?: Array<{ id?: unknown; name?: unknown }>;
		};
		const list = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
		const ids = list.map((model) => normalizeModelId(model.id ?? model.name, api)).filter(Boolean);
		return {
			ok: true,
			status: response.status,
			detail: ids.length
				? `连通（HTTP ${response.status}，${ids.length} 个模型）`
				: `连通（HTTP ${response.status}，模型清单为空）`,
			ids,
		};
	} catch (error) {
		return {
			ok: false,
			status: 0,
			detail: error instanceof Error ? error.message : String(error),
			ids: [],
		};
	}
}
