// Telemetry disabled — ThreatWeaver does not collect any usage data.

export function initTelemetry(): { dispose(): void } {
	return { dispose() {} };
}

export async function resolveUserIdentity(): Promise<void> {}

export function getTelemetry(): undefined { return undefined; }

export function sendEvent(_eventName: string, _properties?: Record<string, string>, _measurements?: Record<string, number>): void {}

export function sendError(_eventName: string, _properties?: Record<string, string>, _measurements?: Record<string, number>): void {}

