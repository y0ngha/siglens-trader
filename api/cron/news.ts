import { createAnalysisCronHandler } from './_run-analysis-cron';
import { runNewsAnalysis } from '../../lib/analysis/run-news';

export default createAnalysisCronHandler('news', runNewsAnalysis);
