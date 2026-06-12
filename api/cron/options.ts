import { createAnalysisCronHandler } from './_run-analysis-cron.js';
import { runOptionsAnalysis } from '../../lib/analysis/run-options.js';

export const GET = createAnalysisCronHandler('options', runOptionsAnalysis);
