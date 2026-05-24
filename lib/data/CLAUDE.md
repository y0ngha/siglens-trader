# lib/data/ — Infrastructure (Market Data Adapters)

Fetches market data from external providers. Adapted from siglens app's infrastructure layer.

## Files

| File | Responsibility |
|------|---------------|
| `fmp-http.ts` | Generic FMP HTTP client. Uses `readFmpConfig()` from siglens-core for API key. |
| `fmp-types.ts` | Raw FMP response interfaces (all `Raw*` types) |
| `fmp-fundamental.ts` | `FmpFundamentalClient` — implements siglens-core's `FundamentalDataProvider` port |
| `fmp-news.ts` | `FmpNewsClient` — news articles + earnings reports. Handles ET timezone normalization. |
| `yahoo-normalize.ts` | Pure normalization functions for Yahoo Finance options data |
| `yahoo-options.ts` | `fetchOptionsSnapshot()` — fetches + normalizes options chain via yahoo-finance2 |

## Data Sources

| Provider | Data | Env Var |
|----------|------|---------|
| FMP | Prices, bars, news, fundamentals, earnings | `FMP_API_KEY` |
| Yahoo Finance | Options chains (OI, IV, strikes) | None (public API via yahoo-finance2) |

## Rules

- These adapters are copied from siglens app — do NOT refactor the shared logic back into siglens-core (it's infrastructure, not domain).
- `fmpGet()` always appends `apikey` automatically.
- FMP dates are Eastern time (no timezone in response) — `normalizeFmpPublishedDate()` handles conversion.
- Yahoo options API may be deprecated (`yahoo-finance2` types show deprecation warning) — works at runtime.

## Testing

Tested with mocked `fmpGet` and `yahoo-finance2`. Pure normalizers tested with real inputs.
