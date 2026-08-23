export const isRetryableStatus = (status: number): boolean => status === 408 || status === 429 || status >= 500;

export type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface RetryOptions {
	attempts?: number;
	fetch?: Fetch;
	onRetry?: (attempt: number, attempts: number) => void;
	sleep?: (milliseconds: number) => Promise<void>;
}

const sleep = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

export const requestWithRetry = async (
	input: string | URL,
	init?: RequestInit,
	options: RetryOptions = {},
): Promise<Response> => {
	const attempts = options.attempts ?? 3;
	const fetch = options.fetch ?? globalThis.fetch;
	let lastError: unknown;
	let lastResponse: Response | undefined;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const response = await fetch(input, init);
			if (response.ok || !isRetryableStatus(response.status)) return response;
			lastResponse = response;
			lastError = new Error(`HTTP ${response.status}`);
		} catch (error) {
			lastError = error;
		}
		if (attempt < attempts) {
			options.onRetry?.(attempt, attempts);
			await (options.sleep ?? sleep)(attempt * 1000);
		}
	}
	if (lastResponse !== undefined) return lastResponse;
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
};
