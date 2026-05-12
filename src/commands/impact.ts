import { runTrace } from './trace.js';
import type { TraceOptions } from './trace.js';

export type ImpactOptions = Omit<TraceOptions, 'impact'>;

export async function runImpact(symbol: string | undefined, options: ImpactOptions): Promise<void> {
  await runTrace(symbol, { ...options, impact: true });
}
