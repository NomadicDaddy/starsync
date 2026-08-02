import type { Subcommand } from './cli-utils.ts';

import { sanitizeMessage } from './secret-safety.ts';

const REPORT_SCHEMA_VERSION = 2 as const;

export type CheckoutLifecycle = 'active' | 'blocked' | 'retained';
export type CommandExitCode = 0 | 1 | 130 | 2;
export type CommandOutcome = 'added' | 'current' | 'failed' | 'skipped' | 'updated';
export type FindingSeverity = 'error' | 'info' | 'warning';

export type RenameClassification = 'blocked' | 'current' | 'failed' | 'pending';

export interface RenamePreview {
	classification: RenameClassification;
	proposedName: null | string;
	repositoryId: null | number;
	repositorySlug: null | string;
}

export interface Finding {
	code: string;
	message: string;
	severity: FindingSeverity;
}

export interface CheckoutReport {
	findings: Finding[];
	lifecycle: CheckoutLifecycle | null;
	name: string;
	outcome: CommandOutcome;
	pendingRename: boolean;
	plannedOutcome?: Exclude<CommandOutcome, 'failed' | 'skipped'>;
	rename?: RenamePreview;
}

interface CheckoutSummary {
	active: number;
	blocked: number;
	pendingRename: number;
	retained: number;
}

interface FindingSummary {
	error: number;
	info: number;
	warning: number;
}

interface OutcomeSummary {
	added: number;
	current: number;
	failed: number;
	skipped: number;
	updated: number;
}

export interface CommandReport {
	checkouts: CheckoutReport[];
	command: Subcommand;
	dryRun: boolean;
	exitCode: CommandExitCode;
	findings: Finding[];
	helpText?: string;
	interrupted: boolean;
	schemaVersion: typeof REPORT_SCHEMA_VERSION;
	summary: {
		checkouts: CheckoutSummary;
		findings: FindingSummary;
		outcomes: OutcomeSummary;
	};
	targetPath: null | string;
}

interface CreateCommandReportOptions {
	checkouts?: CheckoutReport[];
	command: Subcommand;
	dryRun?: boolean;
	exitCode: CommandExitCode;
	findings?: Finding[];
	helpText?: string;
	interrupted?: boolean;
	targetPath?: null | string;
}

export interface CommandReporter {
	diagnostic: (message: string) => void;
	emit: (report: CommandReport) => void;
	progress: (message: string) => void;
}

const countValues = <T extends string>(values: T[], keys: readonly T[]): Record<T, number> => {
	const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
	for (const value of values) counts[value]++;
	return counts;
};

export const createFinding = (
	severity: FindingSeverity,
	code: string,
	message: string
): Finding => ({ code, message, severity });

export const createCommandReport = (options: CreateCommandReportOptions): CommandReport => {
	const checkouts = options.checkouts ?? [];
	const findings = options.findings ?? [];
	const allFindings = [...findings, ...checkouts.flatMap((checkout) => checkout.findings)];
	const lifecycleValues = checkouts
		.map((checkout) => checkout.lifecycle)
		.filter((lifecycle): lifecycle is CheckoutLifecycle => lifecycle !== null);
	const lifecycleCounts = countValues(lifecycleValues, ['active', 'blocked', 'retained']);
	const findingCounts = countValues(
		allFindings.map((finding) => finding.severity),
		['error', 'info', 'warning']
	);
	const outcomeCounts = countValues(
		checkouts.map((checkout) => checkout.outcome),
		['added', 'current', 'failed', 'skipped', 'updated']
	);

	return {
		checkouts,
		command: options.command,
		dryRun: options.dryRun ?? false,
		exitCode: options.exitCode,
		findings,
		...(options.helpText === undefined ? {} : { helpText: options.helpText }),
		interrupted: options.interrupted ?? false,
		schemaVersion: REPORT_SCHEMA_VERSION,
		summary: {
			checkouts: {
				...lifecycleCounts,
				pendingRename: checkouts.filter((checkout) => checkout.pendingRename).length,
			},
			findings: findingCounts,
			outcomes: outcomeCounts,
		},
		targetPath: options.targetPath ?? null,
	};
};

const writeFinding = (finding: Finding): void => {
	const message = `${finding.severity.toUpperCase()} [${finding.code}]: ${finding.message}`;
	if (finding.severity === 'error') {
		console.error(message);
	} else if (finding.severity === 'warning') {
		console.warn(message);
	} else {
		console.log(message);
	}
};

const shouldRenderCheckout = (report: CommandReport, checkout: CheckoutReport): boolean =>
	report.command !== 'sync' ||
	['failed', 'skipped'].includes(checkout.outcome) ||
	checkout.findings.some((finding) => finding.severity !== 'info');

const renderHumanReport = (report: CommandReport): void => {
	if (report.helpText !== undefined) {
		console.log(report.helpText);
	}

	for (const finding of report.findings) writeFinding(finding);
	for (const checkout of report.checkouts) {
		if (!shouldRenderCheckout(report, checkout)) continue;
		const lifecycle = checkout.lifecycle === null ? 'not-created' : checkout.lifecycle;
		const planned = checkout.plannedOutcome ? `, planned ${checkout.plannedOutcome}` : '';
		const pendingRename = checkout.pendingRename ? ', pending rename' : '';
		const rename = checkout.rename
			? `, rename ${checkout.rename.classification}` +
				` (identity ${checkout.rename.repositoryId ?? 'unresolved'}, ` +
				`slug ${checkout.rename.repositorySlug ?? 'unresolved'}, ` +
				`proposed ${checkout.rename.proposedName ?? 'unresolved'})`
			: '';
		console.log(
			`- ${checkout.name}: ${lifecycle}, ${checkout.outcome}${planned}${pendingRename}${rename}`
		);
		for (const finding of checkout.findings) writeFinding(finding);
	}

	if (report.helpText === undefined) {
		const { checkouts } = report.summary;
		const { outcomes } = report.summary;
		console.log(
			`${report.command} complete. Added: ${outcomes.added}. Updated: ${outcomes.updated}. ` +
				`Current: ${outcomes.current}. Skipped: ${outcomes.skipped}. Failed: ${outcomes.failed}.`
		);
		console.log(
			`Checkout lifecycle. Active: ${checkouts.active}. Retained: ${checkouts.retained}. ` +
				`Blocked: ${checkouts.blocked}. Pending rename: ${checkouts.pendingRename}.`
		);
		if (report.command === 'sync') {
			const succeeded = outcomes.added + outcomes.updated + outcomes.current;
			console.log(`Succeeded: ${succeeded}. Failed: ${outcomes.failed}.`);
		}
	}
};

const writeJsonDiagnostics = (report: CommandReport): void => {
	const findings = [
		...report.findings,
		...report.checkouts.flatMap((checkout) => checkout.findings),
	];
	for (const finding of findings) {
		if (finding.severity !== 'info') {
			console.error(
				`${finding.severity.toUpperCase()} [${finding.code}]: ${finding.message}`
			);
		}
	}
};

const sanitizeOutputValue = (value: unknown): unknown => {
	if (typeof value === 'string') return sanitizeMessage(value);
	if (Array.isArray(value)) return value.map(sanitizeOutputValue);
	if (value === null || typeof value !== 'object') return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, nestedValue]) => [key, sanitizeOutputValue(nestedValue)])
	);
};

const sanitizeReport = (report: CommandReport): CommandReport =>
	sanitizeOutputValue(report) as CommandReport;

export const createCommandReporter = (json: boolean): CommandReporter => ({
	diagnostic: (message) => console.error(sanitizeMessage(message)),
	emit: (report) => {
		const sanitizedReport = sanitizeReport(report);
		if (json) {
			writeJsonDiagnostics(sanitizedReport);
			console.log(JSON.stringify(sanitizedReport));
		} else {
			renderHumanReport(sanitizedReport);
		}
	},
	progress: (message) => {
		if (json) {
			console.error(sanitizeMessage(message));
		} else {
			console.log(sanitizeMessage(message));
		}
	},
});
