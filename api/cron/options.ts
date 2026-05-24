import { createAnalysisCronHandler } from './_run-analysis-cron';
import { runOptionsAnalysis } from '../../lib/analysis/run-options';

export default createAnalysisCronHandler('options', runOptionsAnalysis);
