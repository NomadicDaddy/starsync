/**
 * Retry helper for GitHub API operations.
 *
 * Retries transient server errors (5xx, 429) up to a configurable maximum,
 * honoring the Retry-After / X-RateLimit-Reset header values when present.
 *
 * Authentication (401), authorization (403 non-rate-limit), validation (422),
 * and not-found (404) errors are never retried — they fail immediately.
 */

interface RateLimitInfo {
	retryAfterMs?: number;
}

/**
 * Extracts a retry delay from a GitHub API error response.
 *
 * Checks these headers (in priority order):
 * 1. `retry-after` (seconds)
 * 2. `x-ratelimit-reset` (epoch seconds)
 *
 * Returns undefined when no server-provided timing is available.
 */
const extractRetryDelay = (headers: Record<string, string | undefined>): RateLimitInfo => {
	const retryAfter = headers['retry-after'] ?? headers['Retry-After'];
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds) && seconds > 0) {
			return { retryAfterMs: seconds * 1000 };
		}
	}

	const rateLimitReset = headers['x-ratelimit-reset'] ?? headers['X-RateLimit-Reset'];
	if (rateLimitReset) {
		const resetEpoch = Number(rateLimitReset);
		if (Number.isFinite(resetEpoch) && resetEpoch > 0) {
			const now = Math.floor(Date.now() / 1000);
			const delayMs = Math.max(0, (resetEpoch - now) * 1000);
			if (delayMs > 0) {
				return { retryAfterMs: delayMs };
			}
		}
	}

	return {};
};

/**
 * Determines whether a GitHub API error status code is worth retrying.
 *
 * Retriable: 500, 502, 503, 504, 429 (rate limit).
 * Non-retriable: 401, 403 (non-rate-limit), 404, 422, and all other 4xx.
 */
const isRetriableStatus = (status: number): boolean =>
	status === 429 || status === 500 || status === 502 || status === 503 || status === 504;

/**
 * Extracts the HTTP status code from an Octokit/RequestError.
 *
 * Octokit errors carry a `.status` number property.
 */
const extractStatus = (err: unknown): number | undefined => {
	if (typeof err === 'object' && err !== null) {
		const status = (err as { status?: unknown }).status;
		if (typeof status === 'number') return status;
	}
	return undefined;
};

/**
 * Extracts response headers from an Octokit/RequestError.
 */
const extractHeaders = (err: unknown): Record<string, string | undefined> => {
	if (typeof err === 'object' && err !== null) {
		const headers = (err as { headers?: Record<string, string | undefined> }).headers;
		if (headers && typeof headers === 'object') return headers;
		const response = (err as { response?: { headers?: Record<string, string | undefined> } })
			.response;
		if (response?.headers && typeof response.headers === 'object') return response.headers;
	}
	return {};
};

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

export interface RetryOptions {
	maxRetries: number;
}

/**
 * Executes an async function with bounded retry logic for transient failures.
 *
 * - Authentication, authorization, validation, and not-found errors fail
 *   immediately (no retries).
 * - Transient server errors (5xx, 429) are retried up to `maxRetries` times.
 * - Honors server-provided retry timing when available.
 *
 * @param fn The operation to execute. Receives the current attempt number (0-based).
 * @param options Retry configuration.
 * @throws The last error if all retries are exhausted or the error is non-retriable.
 */
export const withApiRetry = async <T>(
	fn: (attempt: number) => Promise<T>,
	options: RetryOptions
): Promise<T> => {
	let lastError: unknown;

	for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
		try {
			return await fn(attempt);
		} catch (err) {
			lastError = err;

			const status = extractStatus(err);
			if (status === undefined || !isRetriableStatus(status)) {
				throw err;
			}

			if (attempt >= options.maxRetries) {
				throw err;
			}

			const headers = extractHeaders(err);
			const { retryAfterMs } = extractRetryDelay(headers);
			const delay = retryAfterMs ?? (attempt + 1) * 1000;
			await sleep(delay);
		}
	}

	throw lastError;
};
