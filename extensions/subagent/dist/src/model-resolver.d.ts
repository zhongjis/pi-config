/**
 * Model resolution: exact match ("provider/modelId") with fuzzy fallback.
 */
export interface ModelEntry {
    id: string;
    name: string;
    provider: string;
}
export interface ModelRegistry {
    find(provider: string, modelId: string): any;
    getAll(): any[];
    getAvailable?(): any[];
}
/**
 * Resolve a model string to a Model instance.
 * Tries exact match first ("provider/modelId"), then fuzzy match against all available models.
 * Returns the Model on success, or an error message string on failure.
 */
export declare function resolveModel(input: string, registry: ModelRegistry): any | string;
