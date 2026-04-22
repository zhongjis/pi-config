export type Mode = "kuafu" | "fuxi" | "houtu";

export type ModePromptMode = "append" | "replace";

export interface ModeConfig {
	body: string;
	promptMode?: ModePromptMode;
	tools?: string[];
	extensions?: string[] | true;
	disallowedTools?: string[];
	allowDelegationTo?: string[];
	disallowDelegationTo?: string[];
	model?: string;
}

export type PlanTitleSource = "content-h1" | "explicit-exit" | "cached-state";

export interface AwaitingUserActionState {
	kind: string;
	suppressContinuationReminder?: boolean;
}

export interface ModeState {
	mode: Mode;
	planTitle?: string;
	planTitleSource?: PlanTitleSource;
	planContent?: string;
	planReviewId?: string;
	planReviewPending?: boolean;
	awaitingUserAction?: AwaitingUserActionState;
	planReviewApproved?: boolean;
	planReviewFeedback?: string;
}

export interface PlanReviewState {
	pendingPlanReviewId: string | undefined;
	planReviewPending: boolean;
	planReviewApproved: boolean;
	planReviewFeedback: string | undefined;
}

export interface PlanEntry {
	title?: string;
	content: string;
	draft: boolean;
}

export interface PlannotatorPlanReviewPayload {
	planContent: string;
	origin?: string;
}

export interface PlannotatorPlanReviewStartResult {
	status: "pending";
	reviewId: string;
}

export interface PlannotatorReviewResultEvent {
	reviewId: string;
	approved: boolean;
	feedback?: string;
}

export type PlannotatorReviewStatusResult =
	| { status: "pending" }
	| ({ status: "completed" } & PlannotatorReviewResultEvent)
	| { status: "missing" };

export type PlannotatorResponse<T> =
	| { status: "handled"; result: T }
	| { status: "unavailable"; error?: string }
	| { status: "error"; error: string };
