import fs from 'node:fs';
import path from 'node:path';

import type { RefreshResult } from './refresh.ts';
import type { CheckoutReport, CommandReport, Finding } from './reporting.ts';

import { inspectArchiveDate, setCheckoutArchiveDate } from './archive-dates.ts';
import { createCommandReport, createFinding } from './reporting.ts';
import { sanitizeMessage } from './secret-safety.ts';

export const getErrorMessage = (err: unknown): string =>
	err instanceof Error ? err.message : String(err);

export const resolveExplicitTarget = (targetPath: string): null | string => {
	const trimmed = targetPath.trim();
	return trimmed ? path.resolve(trimmed) : null;
};

export const checkoutExists = (targetBase: string, name: string): boolean =>
	fs.existsSync(path.join(targetBase, name, '.git'));

export const invalidTargetReport = (command: CommandReport['command']): CommandReport =>
	createCommandReport({
		command,
		exitCode: 2,
		findings: [
			createFinding('error', 'invalid-target', 'targetPath must be a non-empty string.'),
		],
		targetPath: null,
	});

export const interruptedReport = (
	command: CommandReport['command'],
	targetPath: string,
	dryRun = false
): CommandReport =>
	createCommandReport({
		command,
		dryRun,
		exitCode: 130,
		findings: [
			createFinding('warning', 'interrupted', 'Operation was interrupted before it started.'),
		],
		interrupted: true,
		targetPath,
	});

export const missingTokenReport = (
	command: 'migrate' | 'sync' | 'verify',
	targetPath: string,
	message: string,
	dryRun = false
): CommandReport =>
	createCommandReport({
		command,
		dryRun,
		exitCode: 1,
		findings: [createFinding('error', 'missing-token', message)],
		targetPath,
	});

export const operationFailureReport = (
	command: CommandReport['command'],
	targetPath: string,
	code: string,
	message: string,
	dryRun = false
): CommandReport =>
	createCommandReport({
		command,
		dryRun,
		exitCode: 1,
		findings: [createFinding('error', code, message)],
		targetPath,
	});

const refreshIssue = (severity: Finding['severity'], code: string, message: string): Finding[] => [
	createFinding(severity, code, message),
];

const withDefault = (message: string | undefined, fallback: string): string =>
	message === undefined ? fallback : message;

/**
 * Surfaces the note a successful refresh may carry.
 *
 * A refresh succeeds while still declining to overwrite preserved history, so
 * the note reports what the archive kept rather than what it failed to do.
 */
const refreshNote = (result: RefreshResult): Finding[] =>
	result.message === undefined
		? []
		: refreshIssue('warning', 'remote-tags-retained', result.message);

const refreshFinding = (result: RefreshResult): Finding[] => {
	switch (result.outcome) {
		case 'added':
		case 'updated':
			return refreshNote(result);
		case 'blocked':
			return refreshIssue(
				'error',
				'checkout-blocked',
				withDefault(result.message, 'Local state would be overwritten.')
			);
		case 'current':
			return [
				...refreshIssue('info', 'checkout-current', 'Checkout is current.'),
				...refreshNote(result),
			];
		case 'failed':
			return refreshIssue(
				'error',
				'git-operation-failed',
				withDefault(result.message, 'Unknown Git error.')
			);
		case 'retained':
			return refreshIssue(
				'info',
				'checkout-retained',
				'Checkout is no longer starred and was retained.'
			);
		case 'skipped':
			return refreshIssue(
				'warning',
				'operation-skipped',
				withDefault(result.message, 'Operation was skipped.')
			);
	}
};

export const reportRefreshResult = (result: RefreshResult, targetBase: string): CheckoutReport => {
	const existingLifecycle = checkoutExists(targetBase, result.name) ? 'active' : null;
	const lifecycle =
		result.outcome === 'blocked'
			? 'blocked'
			: result.outcome === 'retained'
				? 'retained'
				: ['added', 'current', 'updated'].includes(result.outcome)
					? 'active'
					: existingLifecycle;
	const outcome =
		result.outcome === 'blocked' || result.outcome === 'failed'
			? 'failed'
			: result.outcome === 'retained' || result.outcome === 'skipped'
				? 'skipped'
				: result.outcome;
	return {
		findings: refreshFinding(result),
		lifecycle,
		name: result.name,
		outcome,
		pendingRename: result.pendingRename ?? false,
	};
};

export const maintainCheckoutArchiveDate = async (
	report: CheckoutReport,
	targetPath: string
): Promise<CheckoutReport> => {
	if (!['added', 'current', 'updated'].includes(report.outcome)) return report;
	try {
		const checkoutPath = path.join(targetPath, report.name);
		const state = await inspectArchiveDate(checkoutPath);
		if (!state.needsUpdate) return report;
		setCheckoutArchiveDate(checkoutPath, state.archiveDate);
		return {
			...report,
			findings: [
				...report.findings,
				createFinding(
					'info',
					'archive-date-updated',
					`Folder timestamp was set to Archive Date ${state.archiveDate.toISOString()}.`
				),
			],
		};
	} catch (err) {
		return {
			...report,
			findings: [
				...report.findings,
				createFinding(
					'error',
					'archive-date-update-failed',
					`Git operation succeeded, but the folder timestamp could not be aligned with its Archive Date: ${sanitizeMessage(getErrorMessage(err))}`
				),
			],
		};
	}
};

export const createInterruptedCheckout = (
	name: string,
	lifecycle: CheckoutReport['lifecycle'],
	code: string,
	message: string,
	pendingRename: boolean
): CheckoutReport => ({
	findings: [createFinding('warning', code, message)],
	lifecycle,
	name,
	outcome: 'skipped',
	pendingRename,
});
