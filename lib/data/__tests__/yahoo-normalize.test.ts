import { describe, it, expect } from 'vitest';
import {
    normalizeYahooContract,
    normalizeYahooExpiration,
    normalizeYahooSnapshot,
} from '../yahoo-normalize';
import type { YahooCallOrPut, YahooOption, YahooOptionsResult } from '../yahoo-normalize';

function makeContract(overrides: Partial<YahooCallOrPut> = {}): YahooCallOrPut {
    return {
        contractSymbol: 'AAPL250620C00150000',
        strike: 150,
        lastPrice: 5.5,
        change: 0.3,
        volume: 1200,
        openInterest: 5000,
        bid: 5.4,
        ask: 5.6,
        contractSize: 'REGULAR',
        expiration: new Date('2025-06-20T00:00:00.000Z'),
        lastTradeDate: new Date('2025-06-01T15:00:00.000Z'),
        impliedVolatility: 0.35,
        inTheMoney: true,
        ...overrides,
    };
}

describe('normalizeYahooContract', () => {
    it('maps all fields correctly', () => {
        const contract = makeContract();
        const result = normalizeYahooContract(contract);

        expect(result).toEqual({
            contractSymbol: 'AAPL250620C00150000',
            strike: 150,
            lastPrice: 5.5,
            bid: 5.4,
            ask: 5.6,
            volume: 1200,
            openInterest: 5000,
            impliedVolatility: 0.35,
            inTheMoney: true,
        });
    });

    it('defaults volume to 0 when undefined', () => {
        const contract = makeContract({ volume: undefined });
        const result = normalizeYahooContract(contract);

        expect(result.volume).toBe(0);
    });

    it('defaults openInterest to 0 when undefined', () => {
        const contract = makeContract({ openInterest: undefined });
        const result = normalizeYahooContract(contract);

        expect(result.openInterest).toBe(0);
    });

    it('defaults bid/ask to null when undefined', () => {
        const contract = makeContract({ bid: undefined, ask: undefined });
        const result = normalizeYahooContract(contract);

        expect(result.bid).toBeNull();
        expect(result.ask).toBeNull();
    });

    it('preserves inTheMoney boolean', () => {
        const itm = normalizeYahooContract(makeContract({ inTheMoney: true }));
        const otm = normalizeYahooContract(makeContract({ inTheMoney: false }));

        expect(itm.inTheMoney).toBe(true);
        expect(otm.inTheMoney).toBe(false);
    });
});

describe('normalizeYahooExpiration', () => {
    it('sorts contracts by strike ascending', () => {
        const option: YahooOption = {
            expirationDate: new Date('2025-06-20T00:00:00.000Z'),
            hasMiniOptions: false,
            calls: [
                makeContract({ strike: 160 }),
                makeContract({ strike: 140 }),
                makeContract({ strike: 150 }),
            ],
            puts: [makeContract({ strike: 155 }), makeContract({ strike: 145 })],
        };
        const now = new Date('2025-06-01T16:00:00.000Z');

        const result = normalizeYahooExpiration(option, now);

        expect(result.calls.map((c) => c.strike)).toEqual([140, 150, 160]);
        expect(result.puts.map((p) => p.strike)).toEqual([145, 155]);
    });

    it('calculates DTE correctly', () => {
        const option: YahooOption = {
            expirationDate: new Date('2025-06-20T00:00:00.000Z'),
            hasMiniOptions: false,
            calls: [makeContract()],
            puts: [],
        };
        // June 1 ET → June 20 expiration = 19 days
        const now = new Date('2025-06-01T16:00:00.000Z');

        const result = normalizeYahooExpiration(option, now);

        expect(result.daysToExpiration).toBe(19);
    });

    it('returns DTE of 0 for expired options', () => {
        const option: YahooOption = {
            expirationDate: new Date('2025-05-30T00:00:00.000Z'),
            hasMiniOptions: false,
            calls: [makeContract()],
            puts: [],
        };
        const now = new Date('2025-06-01T16:00:00.000Z');

        const result = normalizeYahooExpiration(option, now);

        expect(result.daysToExpiration).toBe(0);
    });

    it('formats expirationDate as YYYY-MM-DD string', () => {
        const option: YahooOption = {
            expirationDate: new Date('2025-07-18T00:00:00.000Z'),
            hasMiniOptions: false,
            calls: [],
            puts: [],
        };
        const now = new Date('2025-06-01T12:00:00.000Z');

        const result = normalizeYahooExpiration(option, now);

        expect(result.expirationDate).toBe('2025-07-18');
    });
});

describe('normalizeYahooSnapshot', () => {
    it('sorts chains by expirationDate ascending', () => {
        const response: YahooOptionsResult = {
            underlyingSymbol: 'AAPL',
            expirationDates: [],
            strikes: [],
            hasMiniOptions: false,
            quote: { regularMarketPrice: 195.5 },
            options: [
                {
                    expirationDate: new Date('2025-08-15T00:00:00.000Z'),
                    hasMiniOptions: false,
                    calls: [makeContract()],
                    puts: [],
                },
                {
                    expirationDate: new Date('2025-06-20T00:00:00.000Z'),
                    hasMiniOptions: false,
                    calls: [makeContract()],
                    puts: [],
                },
                {
                    expirationDate: new Date('2025-07-18T00:00:00.000Z'),
                    hasMiniOptions: false,
                    calls: [makeContract()],
                    puts: [],
                },
            ],
        };
        const now = new Date('2025-06-01T12:00:00.000Z');

        const result = normalizeYahooSnapshot(response, now);

        expect(result.chains.map((c) => c.expirationDate)).toEqual([
            '2025-06-20',
            '2025-07-18',
            '2025-08-15',
        ]);
    });

    it('sets symbol and underlyingPrice from response', () => {
        const response: YahooOptionsResult = {
            underlyingSymbol: 'TSLA',
            expirationDates: [],
            strikes: [],
            hasMiniOptions: false,
            quote: { regularMarketPrice: 250.0 },
            options: [],
        };
        const now = new Date('2025-06-01T12:00:00.000Z');

        const result = normalizeYahooSnapshot(response, now);

        expect(result.symbol).toBe('TSLA');
        expect(result.underlyingPrice).toBe(250.0);
    });

    it('defaults underlyingPrice to 0 when regularMarketPrice is missing', () => {
        const response: YahooOptionsResult = {
            underlyingSymbol: 'GME',
            expirationDates: [],
            strikes: [],
            hasMiniOptions: false,
            quote: {},
            options: [],
        };
        const now = new Date('2025-06-01T12:00:00.000Z');

        const result = normalizeYahooSnapshot(response, now);

        expect(result.underlyingPrice).toBe(0);
    });

    it('includes capturedAt as ISO string', () => {
        const response: YahooOptionsResult = {
            underlyingSymbol: 'SPY',
            expirationDates: [],
            strikes: [],
            hasMiniOptions: false,
            quote: { regularMarketPrice: 530 },
            options: [],
        };
        const now = new Date('2025-06-01T14:30:00.000Z');

        const result = normalizeYahooSnapshot(response, now);

        expect(result.capturedAt).toBe('2025-06-01T14:30:00.000Z');
    });
});
