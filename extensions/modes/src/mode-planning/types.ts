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
