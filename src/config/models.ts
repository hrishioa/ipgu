/**
 * Defines cost structure for LLM models.
 * Costs are typically per million tokens.
 */
export interface ModelCost {
  inputCostPerMillionTokens: number;
  outputCostPerMillionTokens: number;
}

/**
 * Known model costs (USD per 1 million tokens).
 * Add or update models here as needed.
 * Model names should ideally match the identifiers used in the config/API calls.
 */
export const MODEL_COSTS: Record<string, ModelCost> = {
  // Claude Models (Add variations as needed)
  "claude-sonnet-4-5": {
    // Claude Sonnet 4.5 (latest)
    inputCostPerMillionTokens: 3,
    outputCostPerMillionTokens: 15,
  },
  "claude-3-5-sonnet-20240620": {
    // Matches Anthropic identifier
    inputCostPerMillionTokens: 3,
    outputCostPerMillionTokens: 15,
  },
  "claude-3-opus-20240229": {
    inputCostPerMillionTokens: 15,
    outputCostPerMillionTokens: 75,
  },
  "claude-3-sonnet-20240229": {
    // Older Sonnet
    inputCostPerMillionTokens: 3,
    outputCostPerMillionTokens: 15,
  },
  "claude-3-haiku-20240307": {
    inputCostPerMillionTokens: 0.25,
    outputCostPerMillionTokens: 1.25,
  },

  // Gemini Models (Use API identifiers)
  // Note: Gemini 1.5 pricing might vary based on context size/modality later
  "gemini-2.5-pro": {
    // Gemini 2.5 Pro (latest stable)
    inputCostPerMillionTokens: 1.25,
    outputCostPerMillionTokens: 10.0,
  },
  "gemini-1.5-pro-latest": {
    // Standard context pricing, adjust if using 1M context
    inputCostPerMillionTokens: 3.5,
    outputCostPerMillionTokens: 10.5,
  },
  "gemini-1.5-flash-latest": {
    inputCostPerMillionTokens: 0.35,
    outputCostPerMillionTokens: 1.05, // Check exact output cost for flash based on usage
  },
  // Your specific models - double check official names/costs
  "gemini-2.5-pro-preview-03-25": {
    // Hypothetical/Custom name?
    inputCostPerMillionTokens: 1.25, // As provided
    outputCostPerMillionTokens: 10.0, // As provided
  },
  "gemini-2.5-flash-preview-04-17": {
    // Hypothetical/Custom name?
    inputCostPerMillionTokens: 0.15, // As provided
    outputCostPerMillionTokens: 3.5, // As provided
  },
  "gemini-2.0-flash": {
    // Hypothetical/Custom name?
    inputCostPerMillionTokens: 0.1, // As provided
    outputCostPerMillionTokens: 0.4, // As provided
  },

  // Add other models as needed
};

/**
 * Calculates the cost of an LLM call.
 *
 * @param modelName The identifier of the model used.
 * @param inputTokens Number of input tokens.
 * @param outputTokens Number of output tokens.
 * @returns The calculated cost in USD, or 0 if model/tokens unknown.
 */
export function calculateCost(
  modelName: string,
  inputTokens?: number,
  outputTokens?: number
): number {
  const costs = MODEL_COSTS[modelName];
  if (!costs || inputTokens === undefined || outputTokens === undefined) {
    // Log warning if trying to calculate cost for unknown model or missing tokens
    if (!costs && (inputTokens || outputTokens)) {
      console.warn(`[CostCalc] Cost data not found for model: ${modelName}`);
    }
    return 0;
  }

  const inputCost = (inputTokens / 1_000_000) * costs.inputCostPerMillionTokens;
  const outputCost =
    (outputTokens / 1_000_000) * costs.outputCostPerMillionTokens;

  return inputCost + outputCost;
}
