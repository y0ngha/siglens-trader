import { createAnalysisCronHandler } from './_run-analysis-cron';
import { runTechnicalAnalysis } from '../../lib/analysis/run-technical';

export default createAnalysisCronHandler('technical', runTechnicalAnalysis);
