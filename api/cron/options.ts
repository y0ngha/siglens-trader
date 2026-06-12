import { createAnalysisCronHandler } from './_run-analysis-cron.js';
import { runOptionsAnalysis } from '../../lib/analysis/run-options.js';

export default createAnalysisCronHandler('options', runOptionsAnalysis);
