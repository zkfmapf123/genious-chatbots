// $ per 1M tokens
const PRICING: Record<string, { input: number; output: number }> = {
  "gpt-6-luna": { input: 0.10, output: 0.50 },
};

export function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model];
  if (!p) throw new Error(`no pricing for model: ${model}`);
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}
