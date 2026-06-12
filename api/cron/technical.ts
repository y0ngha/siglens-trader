import { createAnalysisCronHandler } from './_run-analysis-cron.js';
import { runTechnicalAnalysis } from '../../lib/analysis/run-technical.js';

export default createAnalysisCronHandler('technical', runTechnicalAnalysis);
