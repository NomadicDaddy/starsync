#!/usr/bin/env bun

import { runStarsync } from './index.ts';

try {
	process.exit(await runStarsync());
} catch (err) {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`Unexpected error: ${message}`);
	process.exit(1);
}
