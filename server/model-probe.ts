/** Provider-aware model catalog probing for connection setup. */

export type ModelProbeResult = {
	ok: boolean;
	status: number;
	detail: string;
	ids: string[];
	models: ProbedModel[];
};

export type ProbedModel = {
	id: string;
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	input?: Array<"text" | "image">;
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

	if (api === "openai-codex-responses") {
		if (key) {
			headers.authorization = `Bearer ${key}`;
			const accountId = accountIdFromJwt(key);
			if (accountId) headers["chatgpt-account-id"] = accountId;
		}
		const clientVersion = process.env.LIYUAN_CODEX_CLIENT_VERSION?.trim() || "0.145.0";
		headers.accept = "application/json";
		headers.originator = "codex_cli_rs";
		headers["user-agent"] = `liyuan/${clientVersion}`;
		const codexBase = base.endsWith("/codex") ? base : `${base}/codex`;
		return { url: `${codexBase}/models?client_version=${encodeURIComponent(clientVersion)}`, headers };
	}

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

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function accountIdFromJwt(token: string): string | undefined {
	try {
		const payload = token.split(".")[1];
		if (!payload) return undefined;
		const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
		const auth = decoded["https://api.openai.com/auth"];
		if (!auth || typeof auth !== "object") return undefined;
		const id = (auth as Record<string, unknown>).chatgpt_account_id;
		return typeof id === "string" && id.trim() ? id.trim() : undefined;
	} catch {
		return undefined;
	}
}

function normalizeProbeModel(raw: Record<string, unknown>, api?: string): ProbedModel | null {
	if (api === "openai-codex-responses") {
		if (raw.supported_in_api === false || raw.visibility === "hide") return null;
	}
	if (
		api === "google-generative-ai" &&
		Array.isArray(raw.supportedGenerationMethods) &&
		!raw.supportedGenerationMethods.includes("generateContent")
	) {
		return null;
	}

	const id = normalizeModelId(raw.slug ?? raw.id ?? raw.name, api);
	if (!id) return null;
	const displayName = String(raw.display_name ?? raw.displayName ?? (raw.slug ? raw.name : undefined) ?? "").trim();
	const reasoningEfforts = raw.supported_reasoning_efforts ?? raw.supportedReasoningEfforts;
	const inputModalities = raw.input_modalities ?? raw.inputModalities;
	const input = Array.isArray(inputModalities)
		? (["text", ...(inputModalities.includes("image") ? ["image"] : [])] as Array<"text" | "image">)
		: undefined;
	const contextWindow = positiveNumber(raw.context_window ?? raw.contextWindow ?? raw.inputTokenLimit);
	const maxTokens = positiveNumber(raw.max_output_tokens ?? raw.maxTokens ?? raw.outputTokenLimit);
	const reasoning = Array.isArray(reasoningEfforts) ? reasoningEfforts.length > 0 : raw.reasoning === true ? true : undefined;

	return {
		id,
		...(displayName && displayName !== id ? { name: displayName } : {}),
		...(reasoning !== undefined ? { reasoning } : {}),
		...(contextWindow ? { contextWindow } : {}),
		...(maxTokens ? { maxTokens } : {}),
		...(input ? { input } : {}),
	};
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
				models: [],
			};
		}
		const json = (await response.json()) as {
			data?: Array<Record<string, unknown>>;
			models?: Array<Record<string, unknown>>;
		};
		const list = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
		const models = list
			.map((model) => normalizeProbeModel(model, api))
			.filter((model): model is ProbedModel => model !== null);
		const ids = models.map((model) => model.id);
		return {
			ok: true,
			status: response.status,
			detail: ids.length
				? `连通（HTTP ${response.status}，${ids.length} 个模型）`
				: `连通（HTTP ${response.status}，模型清单为空）`,
			ids,
			models,
		};
	} catch (error) {
		return {
			ok: false,
			status: 0,
			detail: error instanceof Error ? error.message : String(error),
			ids: [],
			models: [],
		};
	}
}
