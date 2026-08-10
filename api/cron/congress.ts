import { createAnalysisCronHandler } from './_run-analysis-cron.js';
import { runCongressAnalysis } from '../../lib/analysis/run-congress.js';

export const GET = createAnalysisCronHandler('congress', runCongressAnalysis);
