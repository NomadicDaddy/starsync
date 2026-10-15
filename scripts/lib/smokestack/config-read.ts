/**
 * The reading of `smokestack.json`'s values, shared by the config and the step cache's part of it.
 * Every refusal names the file and the place in it, and is a ConfigError: the run is refused before
 * any step starts.
 */
export const CONFIG_FILE = 'smokestack.json';

export class ConfigError extends Error {}

export function fail(message: string): never {
	throw new ConfigError(`${CONFIG_FILE}: ${message}`);
}

export function asObject(
	raw: unknown,
	where: string,
	allowed: readonly string[],
): Record<string, unknown> {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		fail(`${where} must be an object.`);
	}
	const object = raw as Record<string, unknown>;
	for (const key of Object.keys(object)) {
		if (!allowed.includes(key)) fail(`${where} has an unknown key '${key}'.`);
	}
	return object;
}

export function asText(raw: unknown, where: string): string {
	if (typeof raw !== 'string' || raw.trim().length === 0) {
		fail(`${where} must be a non-empty string.`);
	}
	return raw;
}

/** A list of non-empty strings. Absent is an empty list; present and empty is refused. */
export function asTextList(raw: unknown, where: string): string[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw) || raw.length === 0) fail(`${where} must be a non-empty list.`);
	return raw.map((item, index) => asText(item, `${where}[${index}]`));
}
