/**
 * Re-export from shared lib. Local consumers import from here unchanged.
 */
export {
	type ModelCandidate,
	type ModelEntry,
	type ModelRegistry,
	parseModelPattern,
	parseModelChain,
	resolveModel,
	resolveFirstAvailable,
} from "../../lib/model.js";
