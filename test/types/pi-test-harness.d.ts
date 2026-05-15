declare module "@marcfargas/pi-test-harness" {
	export interface TestSession {
		session: any;
		events: any;
		run(...args: any[]): Promise<void>;
		dispose(): void;
	}

	export interface TestSessionOptions {
		cwd?: string;
		extensions?: string[];
		extensionFactories?: Array<(pi: any) => void>;
		mockTools?: Record<string, unknown>;
		mockUI?: Record<string, unknown>;
		propagateErrors?: boolean;
	}

	export function createTestSession(options?: TestSessionOptions): Promise<TestSession>;
	export function when(description: string, steps: unknown[]): unknown;
	export function calls(toolName: string, params?: Record<string, unknown>): unknown;
	export function says(text: string): unknown;
}
