import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
    RawFmpProfile,
    RawFmpKeyMetricsTtm,
    RawFmpRatiosTtm,
    RawFmpStockPeer,
    RawFmpGradesEvent,
    RawFmpGradesConsensus,
    RawFmpPriceTargetConsensus,
    RawFmpEarningsReport,
    RawFmpFinancialScore,
    RawFmpIncomeGrowth,
    RawFmpCashFlowStatement,
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
});
