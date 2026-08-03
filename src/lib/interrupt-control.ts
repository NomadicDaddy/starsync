interface InterruptReporter {
	diagnostic: (message: string) => void;
}

export interface InterruptControl {
	dispose: () => void;
	signal: AbortSignal;
}

export const createInterruptControl = (
	reporter: InterruptReporter,
	firstMessage: string,
): InterruptControl => {
	const controller = new AbortController();
	let interruptionLevel = 0;
	const handler = () => {
		interruptionLevel++;
		if (interruptionLevel === 1) {
			reporter.diagnostic(firstMessage);
			controller.abort();
		} else {
			reporter.diagnostic('Second interrupt — stopping immediately.');
			process.exit(130);
		}
	};
	process.on('SIGINT', handler);
	return {
		dispose: () => process.removeListener('SIGINT', handler),
		signal: controller.signal,
	};
};
