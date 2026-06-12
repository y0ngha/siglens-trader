import { createAnalysisCronHandler } from './_run-analysis-cron.js';
import { runFundamentalAnalysis } from '../../lib/analysis/run-fundamental.js';

export default createAnalysisCronHandler('fundamental', runFundamentalAnalysis);
