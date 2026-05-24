import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
    RawFmpProfile,
    RawFmpKeyMetricsTtm,
    RawFmpRatiosTtm,
    RawFmpStockPeer,
    RawFmpGradesEvent,
    RawFmpGradesConsensus,
    RawFmpPriceTargetConsensus,
    RawFmpPriceTargetSummary,
    RawFmpEarningsReport,
    RawFmpFinancialScore,
    RawFmpIncomeGrowth,
    RawFmpCashFlowStatement,
    RawFmpAnalystEstimate,
    RawFmpSectorPerformance,
} from '../fmp-types';

const mockFmpGet = vi.fn();
vi.mock('../fmp-http', () => ({
    fmpGet: (...args: unknown[]) => mockFmpGet(...args),
}));

describe('FmpFundamentalClient', () => {
    beforeEach(() => {
        mockFmpGet.mockReset();
    });

    describe('getProfile', () => {
        it('maps raw profile to FundamentalProfile', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            const raw: RawFmpProfile[] = [
                {
                    symbol: 'AAPL',
                    companyName: 'Apple Inc.',
                    sector: 'Technology',
                    industry: 'Consumer Electronics',
                    marketCap: 3_000_000_000_000,
                    ceo: 'Tim Cook',
                    website: 'https://apple.com',
                    description: 'Apple designs consumer electronics.',
                },
            ];
            mockFmpGet.mockResolvedValueOnce(raw);

            const result = await client.getProfile('AAPL');

            expect(result).toEqual({
                symbol: 'AAPL',
                companyName: 'Apple Inc.',
                sector: 'Technology',
                industry: 'Consumer Electronics',
                marketCap: 3_000_000_000_000,
                ceo: 'Tim Cook',
                website: 'https://apple.com',
                description: 'Apple designs consumer electronics.',
            });
        });

        it('uses mktCap fallback when marketCap is absent', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            const raw: RawFmpProfile[] = [
                {
                    symbol: 'TSLA',
                    companyName: 'Tesla',
                    sector: 'Automotive',
                    industry: 'EV',
                    mktCap: 500_000_000_000,
                    ceo: 'Elon Musk',
                    website: null,
                    description: null,
                },
            ];
            mockFmpGet.mockResolvedValueOnce(raw);

            const result = await client.getProfile('TSLA');

            expect(result?.marketCap).toBe(500_000_000_000);
        });

        it('returns null for empty array', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            mockFmpGet.mockResolvedValueOnce([]);

            const result = await client.getProfile('UNKNOWN');

            expect(result).toBeNull();
        });

        it('returns null when marketCap is null or non-finite', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            const raw: RawFmpProfile[] = [
                {
                    symbol: 'BAD',
                    companyName: 'Bad Co',
                    sector: 'Test',
                    industry: 'Test',
                    marketCap: null,
                    ceo: null,
                    website: null,
                    description: null,
                },
            ];
            mockFmpGet.mockResolvedValueOnce(raw);

            const result = await client.getProfile('BAD');

            expect(result).toBeNull();
        });
    });

    describe('getKeyMetricsTtm', () => {
        it('combines metrics and ratios into ValuationMetrics', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            const metrics: RawFmpKeyMetricsTtm[] = [
                {
                    peRatioTTM: 25.5,
                    pbRatioTTM: 10.2,
                    evToEBITDATTM: 20.1,
                    epsTTM: 6.5,
                },
            ];
            const ratios: RawFmpRatiosTtm[] = [
                {
                    priceToEarningsRatioTTM: 26.0,
                    priceToSalesRatioTTM: 7.5,
                    priceToBookRatioTTM: 11.0,
                    priceToEarningsGrowthRatioTTM: 2.1,
                    netIncomePerShareTTM: 6.8,
                },
            ];
            // First call: key-metrics-ttm, second: ratios-ttm
            mockFmpGet.mockResolvedValueOnce(metrics).mockResolvedValueOnce(ratios);

            const result = await client.getKeyMetricsTtm('AAPL');

            expect(result).toEqual({
                peRatioTTM: 26.0, // ratios takes priority
                priceToSalesRatioTTM: 7.5,
                pbRatioTTM: 11.0,
                pegRatioTTM: 2.1,
                enterpriseValueOverEBITDATTM: 20.1, // metrics.evToEBITDATTM priority
                epsTTM: 6.8, // ratios.netIncomePerShareTTM priority
            });
        });

        it('returns null when both metrics and ratios are empty', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            mockFmpGet.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

            const result = await client.getKeyMetricsTtm('UNKNOWN');

            expect(result).toBeNull();
        });

        it('handles metrics-only (no ratios) gracefully', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            const metrics: RawFmpKeyMetricsTtm[] = [
                {
                    peRatioTTM: 20.0,
                    epsTTM: 5.0,
                },
            ];
            mockFmpGet.mockResolvedValueOnce(metrics).mockResolvedValueOnce([]);

            const result = await client.getKeyMetricsTtm('TEST');

            expect(result).toEqual({
                peRatioTTM: 20.0,
                priceToSalesRatioTTM: null,
                pbRatioTTM: null,
                pegRatioTTM: null,
                enterpriseValueOverEBITDATTM: null,
                epsTTM: 5.0,
            });
        });
    });

    describe('getStockPeers', () => {
        it('returns peers with valid market cap', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            const raw: RawFmpStockPeer[] = [
                { symbol: 'MSFT', companyName: 'Microsoft', marketCap: 2_500_000_000_000 },
                { symbol: 'GOOG', companyName: 'Alphabet', marketCap: 1_800_000_000_000 },
            ];
            mockFmpGet.mockResolvedValueOnce(raw);

            const result = await client.getStockPeers('AAPL');

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({
                symbol: 'MSFT',
                companyName: 'Microsoft',
                marketCap: 2_500_000_000_000,
            });
        });

        it('filters out peers with null marketCap', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            const raw: RawFmpStockPeer[] = [
                { symbol: 'VALID', companyName: 'Valid Co', marketCap: 1_000_000 },
                { symbol: 'INVALID', companyName: 'Invalid Co', marketCap: null },
            ];
            mockFmpGet.mockResolvedValueOnce(raw);

            const result = await client.getStockPeers('TEST');

            expect(result).toHaveLength(1);
            expect(result[0].symbol).toBe('VALID');
        });

        it('uses mktCap fallback', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            const raw: RawFmpStockPeer[] = [
                { symbol: 'ALT', companyName: 'Alt Co', mktCap: 999_000 },
            ];
            mockFmpGet.mockResolvedValueOnce(raw);

            const result = await client.getStockPeers('X');

            expect(result[0].marketCap).toBe(999_000);
        });
    });

    describe('getGrades', () => {
        it('maps raw grades to GradesEvent with normalized action', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            const raw: RawFmpGradesEvent[] = [
                {
                    symbol: 'AAPL',
                    date: '2025-05-01',
                    gradingCompany: 'Goldman Sachs',
                    previousGrade: 'Neutral',
                    newGrade: 'Buy',
                    action: 'Upgrade',
                },
                {
                    symbol: 'AAPL',
                    date: '2025-04-15',
                    gradingCompany: 'JP Morgan',
                    previousGrade: null,
                    newGrade: 'Overweight',
                    action: 'Initiated Coverage',
                },
                {
                    symbol: 'AAPL',
                    date: '2025-04-10',
                    gradingCompany: 'Unknown',
                    previousGrade: 'Hold',
                    newGrade: 'Hold',
                    action: 'something_new',
                },
            ];
            mockFmpGet.mockResolvedValueOnce(raw);

            const result = await client.getGrades('AAPL');

            expect(result).toHaveLength(3);
            expect(result[0].action).toBe('upgrade');
            expect(result[1].action).toBe('initiated');
            expect(result[2].action).toBe('other');
        });
    });

    describe('getGradesConsensus', () => {
        it('returns consensus breakdown', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            const raw: RawFmpGradesConsensus[] = [
                { strongBuy: 10, buy: 15, hold: 5, sell: 2, strongSell: 1 },
            ];
            mockFmpGet.mockResolvedValueOnce(raw);

            const result = await client.getGradesConsensus('AAPL');

            expect(result).toEqual({
                strongBuy: 10,
                buy: 15,
                hold: 5,
                sell: 2,
                strongSell: 1,
            });
        });

        it('returns null when empty', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            mockFmpGet.mockResolvedValueOnce([]);

            const result = await client.getGradesConsensus('X');

            expect(result).toBeNull();
        });
    });

    describe('getPriceTargetConsensus', () => {
        it('returns mapped price target consensus', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            const raw: RawFmpPriceTargetConsensus[] = [
                { targetHigh: 250, targetLow: 180, targetMedian: 210, targetConsensus: 215 },
            ];
            mockFmpGet.mockResolvedValueOnce(raw);

            const result = await client.getPriceTargetConsensus('AAPL');

            expect(result).toEqual({
                targetHigh: 250,
                targetLow: 180,
                targetMedian: 210,
                targetConsensus: 215,
            });
        });

        it('returns null when empty', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            mockFmpGet.mockResolvedValueOnce([]);

            const result = await client.getPriceTargetConsensus('X');

            expect(result).toBeNull();
        });
    });

    describe('getFinancialScores', () => {
        it('returns altman Z-score and piotroski score', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            const raw: RawFmpFinancialScore[] = [{ altmanZScore: 3.5, piotroskiScore: 7 }];
            mockFmpGet.mockResolvedValueOnce(raw);

            const result = await client.getFinancialScores('AAPL');

            expect(result).toEqual({ altmanZScore: 3.5, piotroskiScore: 7 });
        });

        it('returns null when empty', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            mockFmpGet.mockResolvedValueOnce([]);

            const result = await client.getFinancialScores('X');

            expect(result).toBeNull();
        });
    });

    describe('getIncomeStatementGrowth', () => {
        it('returns revenue and EPS growth', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            const raw: RawFmpIncomeGrowth[] = [{ growthRevenue: 0.15, growthEPS: 0.22 }];
            mockFmpGet.mockResolvedValueOnce(raw);

            const result = await client.getIncomeStatementGrowth('AAPL');

            expect(result).toEqual({ growthRevenue: 0.15, growthEPS: 0.22 });
        });

        it('returns null when empty', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            mockFmpGet.mockResolvedValueOnce([]);

            const result = await client.getIncomeStatementGrowth('X');

            expect(result).toBeNull();
        });
    });

    describe('getCashFlowStatement', () => {
        it('returns operating cash flow', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            const raw: RawFmpCashFlowStatement[] = [{ operatingCashFlow: 100_000_000 }];
            mockFmpGet.mockResolvedValueOnce(raw);

            const result = await client.getCashFlowStatement('AAPL');

            expect(result).toEqual({ operatingCashFlow: 100_000_000 });
        });

        it('returns null when empty', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            mockFmpGet.mockResolvedValueOnce([]);

            const result = await client.getCashFlowStatement('X');

            expect(result).toBeNull();
        });
    });

    describe('getEarningsReport', () => {
        it('returns earnings report with date field', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            const raw: RawFmpEarningsReport[] = [
                {
                    symbol: 'AAPL',
                    date: '2025-07-25',
                    epsActual: 1.5,
                    epsEstimated: 1.4,
                },
            ];
            mockFmpGet.mockResolvedValueOnce(raw);

            const result = await client.getEarningsReport('AAPL');

            expect(result).toEqual({
                symbol: 'AAPL',
                earningsDate: '2025-07-25',
            });
        });

        it('returns null when no earnings data', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            mockFmpGet.mockResolvedValueOnce([]);

            const result = await client.getEarningsReport('X');

            expect(result).toBeNull();
        });
    });

    describe('getRatiosTtm', () => {
        it('combines ratios and metrics fallback', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            const ratios: RawFmpRatiosTtm[] = [
                {
                    returnOnEquityTTM: 0.35,
                    operatingProfitMarginTTM: 0.3,
                    netProfitMarginTTM: 0.25,
                    debtToAssetsRatioTTM: 0.45,
                    currentRatioTTM: 1.5,
                },
            ];
            const metrics: RawFmpKeyMetricsTtm[] = [
                {
                    returnOnEquityTTM: 0.33,
                    returnOnAssetsTTM: 0.2,
                    currentRatioTTM: 1.4,
                },
            ];
            mockFmpGet.mockResolvedValueOnce(ratios).mockResolvedValueOnce(metrics);

            const result = await client.getRatiosTtm('AAPL');

            expect(result).toEqual({
                returnOnEquityTTM: 0.33, // metrics takes priority
                returnOnAssetsTTM: 0.2, // from metrics
                operatingProfitMarginTTM: 0.3,
                netProfitMarginTTM: 0.25,
                debtRatioTTM: 0.45, // debtToAssetsRatioTTM
                currentRatioTTM: 1.5, // ratios currentRatioTTM via fallback logic
            });
        });

        it('returns null when both ratios and metrics are empty', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            mockFmpGet.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

            const result = await client.getRatiosTtm('UNKNOWN');

            expect(result).toBeNull();
        });

        it('handles ratios-only (no metrics) gracefully', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            const ratios: RawFmpRatiosTtm[] = [
                {
                    returnOnEquityTTM: 0.25,
                    returnOnAssetsTTM: 0.12,
                    operatingProfitMarginTTM: 0.18,
                    netProfitMarginTTM: 0.15,
                    debtRatioTTM: 0.3,
                    currentRatioTTM: 2.0,
                },
            ];
            mockFmpGet.mockResolvedValueOnce(ratios).mockResolvedValueOnce([]);

            const result = await client.getRatiosTtm('TEST');

            expect(result).toEqual({
                returnOnEquityTTM: 0.25,
                returnOnAssetsTTM: 0.12,
                operatingProfitMarginTTM: 0.18,
                netProfitMarginTTM: 0.15,
                debtRatioTTM: 0.3,
                currentRatioTTM: 2.0,
            });
        });
    });

    describe('getAnalystEstimates', () => {
        it('returns analyst estimates with epsAvg fallback', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            const raw: RawFmpAnalystEstimate[] = [{ epsAvg: 5.2, revenueAvg: 100_000_000 }];
            mockFmpGet.mockResolvedValueOnce(raw);

            const result = await client.getAnalystEstimates('AAPL');

            expect(result).toEqual({
                estimatedEpsAvg: 5.2,
                estimatedRevenueAvg: 100_000_000,
            });
            expect(mockFmpGet).toHaveBeenCalledWith('analyst-estimates', {
                symbol: 'AAPL',
                period: 'annual',
                page: '0',
                limit: '10',
            });
        });

        it('returns null when empty', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            mockFmpGet.mockResolvedValueOnce([]);

            const result = await client.getAnalystEstimates('X');

            expect(result).toBeNull();
        });

        it('uses estimatedEpsAvg when epsAvg is absent', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            const raw: RawFmpAnalystEstimate[] = [
                { estimatedEpsAvg: 3.8, estimatedRevenueAvg: 50_000_000 },
            ];
            mockFmpGet.mockResolvedValueOnce(raw);

            const result = await client.getAnalystEstimates('TSLA');

            expect(result).toEqual({
                estimatedEpsAvg: 3.8,
                estimatedRevenueAvg: 50_000_000,
            });
        });
    });

    describe('getPriceTargetSummary', () => {
        it('returns rolling average price targets', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            const raw: RawFmpPriceTargetSummary[] = [
                {
                    symbol: 'AAPL',
                    lastMonthCount: 5,
                    lastMonthAvgPriceTarget: 220,
                    lastQuarterCount: 15,
                    lastQuarterAvgPriceTarget: 210,
                    lastYearCount: 40,
                    lastYearAvgPriceTarget: 200,
                    allTimeCount: 100,
                    allTimeAvgPriceTarget: 180,
                    publishers: 'Goldman Sachs',
                },
            ];
            mockFmpGet.mockResolvedValueOnce(raw);

            const result = await client.getPriceTargetSummary('AAPL');

            expect(result).toEqual({
                lastMonth: { avgPriceTarget: 220 },
                lastQuarter: { avgPriceTarget: 210 },
                lastYear: { avgPriceTarget: 200 },
            });
        });

        it('returns null when empty', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            mockFmpGet.mockResolvedValueOnce([]);

            const result = await client.getPriceTargetSummary('X');

            expect(result).toBeNull();
        });
    });

    describe('getSectorPerformanceSnapshot', () => {
        it('returns sector performance entries with valid changes', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            const raw: RawFmpSectorPerformance[] = [
                { sector: 'Technology', changesPercentage: 2.5 },
                { sector: 'Healthcare', averageChange: 1.2 },
                { sector: 'Energy', changesPercentage: null },
            ];
            mockFmpGet.mockResolvedValueOnce(raw);

            const result = await client.getSectorPerformanceSnapshot('2025-05-01');

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({ sector: 'Technology', changesPercentage: 2.5 });
            expect(result[1]).toEqual({ sector: 'Healthcare', changesPercentage: 1.2 });
        });

        it('returns empty array when no valid data', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            const raw: RawFmpSectorPerformance[] = [{ sector: 'Bad', changesPercentage: null }];
            mockFmpGet.mockResolvedValueOnce(raw);

            const result = await client.getSectorPerformanceSnapshot('2025-01-01');

            expect(result).toEqual([]);
        });
    });

    describe('getHistoricalSectorPerformance', () => {
        it('returns empty array (stub)', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();

            const result = await client.getHistoricalSectorPerformance('Technology');

            expect(result).toEqual([]);
        });
    });

    describe('getEarningsReports', () => {
        it('returns multiple earnings report items', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            const raw: RawFmpEarningsReport[] = [
                {
                    symbol: 'AAPL',
                    date: '2025-07-25',
                    epsActual: 1.5,
                    epsEstimated: 1.4,
                    revenueActual: 100_000_000,
                    revenueEstimated: 95_000_000,
                    lastUpdated: '2025-07-26',
                },
                {
                    symbol: 'AAPL',
                    earningsDate: '2025-04-25',
                    eps: 1.3,
                    epsEstimated: 1.2,
                    revenue: 90_000_000,
                    revenueEstimated: 88_000_000,
                },
            ];
            mockFmpGet.mockResolvedValueOnce(raw);

            const result = await client.getEarningsReports('AAPL');

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({
                symbol: 'AAPL',
                earningsDate: '2025-07-25',
                epsActual: 1.5,
                epsEstimated: 1.4,
                revenueActual: 100_000_000,
                revenueEstimated: 95_000_000,
                lastUpdated: '2025-07-26',
                rawPayload: raw[0],
            });
            expect(result[1].earningsDate).toBe('2025-04-25');
            expect(result[1].epsActual).toBe(1.3);
        });

        it('respects custom limit parameter', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            mockFmpGet.mockResolvedValueOnce([]);

            await client.getEarningsReports('AAPL', 3);

            expect(mockFmpGet).toHaveBeenCalledWith('earnings', {
                symbol: 'AAPL',
                limit: '3',
            });
        });

        it('filters out items with no valid date', async () => {
            const { FmpFundamentalClient } = await import('../fmp-fundamental');
            const client = new FmpFundamentalClient();
            const raw: RawFmpEarningsReport[] = [{ symbol: 'BAD' } as RawFmpEarningsReport];
            mockFmpGet.mockResolvedValueOnce(raw);

            const result = await client.getEarningsReports('BAD');

            expect(result).toEqual([]);
        });
    });
});
