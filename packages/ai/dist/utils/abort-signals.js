export function combineAbortSignals(signals) {
    const activeSignals = signals.filter((signal) => signal !== undefined);
    if (activeSignals.length === 0) {
        return { cleanup: () => { } };
    }
    if (activeSignals.length === 1) {
        return { signal: activeSignals[0], cleanup: () => { } };
    }
    const controller = new AbortController();
    const listeners = [];
    const abort = (signal) => {
        if (!controller.signal.aborted) {
            controller.abort(signal.reason);
        }
    };
    for (const signal of activeSignals) {
        if (signal.aborted) {
            abort(signal);
            break;
        }
        const listener = () => abort(signal);
        signal.addEventListener("abort", listener, { once: true });
        listeners.push({ signal, listener });
    }
    return {
        signal: controller.signal,
        cleanup: () => {
            for (const { signal, listener } of listeners) {
                signal.removeEventListener("abort", listener);
            }
        },
    };
}

/** Standard abort error used by provider streams. */
export function createAbortError(message = "Request was aborted") {
    const err = new Error(message);
    err.name = "AbortError";
    return err;
}

/**
 * Race an async iterable against AbortSignal.
 * Forces Stop to tear down mid-SSE even when a proxy ignores HTTP cancellation.
 */
export async function* abortableAsyncIterable(source, signal) {
    if (!signal) {
        yield* source;
        return;
    }
    if (signal.aborted) {
        throw createAbortError();
    }
    const iterator = source[Symbol.asyncIterator]();
    const pending = {};
    const onAbort = () => {
        try {
            void iterator.return?.();
        }
        catch {
            // best-effort cancel
        }
        pending.reject?.(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
        while (true) {
            if (signal.aborted)
                throw createAbortError();
            const next = await Promise.race([
                iterator.next(),
                new Promise((_, reject) => {
                    pending.reject = reject;
                    if (signal.aborted)
                        reject(createAbortError());
                }),
            ]);
            pending.reject = undefined;
            if (next.done)
                return;
            yield next.value;
        }
    }
    finally {
        signal.removeEventListener("abort", onAbort);
    }
}
//# sourceMappingURL=abort-signals.js.map
