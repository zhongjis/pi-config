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

export type PlanTitleSource = "content-h1" | "compat-name" | "explicit-exit" | "legacy-entry" | "cached-state";

export interface ModeState {
	mode: Mode;
	planTitle?: string;
	planTitleSource?: PlanTitleSource;
	planContent?: string;
	planReviewId?: string;
	planReviewPending?: boolean;
	planReviewApproved?: boolean;
	planReviewFeedback?: string;
}
