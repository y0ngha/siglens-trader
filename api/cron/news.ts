import { createAnalysisCronHandler } from './_run-analysis-cron.js';
import { runNewsAnalysis } from '../../lib/analysis/run-news.js';

export const GET = createAnalysisCronHandler('news', runNewsAnalysis);
