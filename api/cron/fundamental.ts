import { createAnalysisCronHandler } from './_run-analysis-cron';
import { runFundamentalAnalysis } from '../../lib/analysis/run-fundamental';

export default createAnalysisCronHandler('fundamental', runFundamentalAnalysis);
