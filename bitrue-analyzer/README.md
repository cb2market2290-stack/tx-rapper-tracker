# Project: Bitrue Micro-Cap Analyzer

## What it is
A live crypto scanning app that connects to Bitrue's public API and identifies ultra-low-price coins with strong 1000x weekly potential.

## Goal
Find coins priced around 0.00000000001 USDT that have strong potential to reach 0.00001 USDT within a week — a ~1,000,000x move. Wealth creation through early micro-cap detection.

## Status
- [x] App built and running (Claude artifact)
- [ ] Add historical price data (7-day OHLCV per coin)
- [ ] Add wallet/portfolio tracker
- [ ] Add price alert system (notify when coin hits 10x)
- [ ] Add auto-refresh every 5 minutes
- [ ] Build mobile-friendly version
- [ ] Add Bitrue direct buy link per coin

## How it works
1. Hits Bitrue public API: https://openapi.bitrue.com/api/v1/ticker/24hr
2. Filters all USDT pairs for coins priced between 0.000000000001 and 0.0000001
3. Scores each coin 0-100 based on:
   - 24h price momentum
   - Trading volume
   - Distance to 0.00001 target
   - Volatility (high-low spread)
4. Labels coins: Fire / Strong / Watch / Weak
5. Shows multiplier needed to hit target price

## Scoring System
| Signal | Score | Meaning |
|--------|-------|---------|
| Fire   | 70+   | Multiple strong signals — high conviction |
| Strong | 50-69 | Solid momentum and volume |
| Watch  | 30-49 | In range, worth monitoring |
| Weak   | <30   | In price range but no momentum |

## Target
- Entry price: ~0.00000000001 USDT
- Target price: 0.00001 USDT
- Timeframe: 1 week
- Exchange: Bitrue

## API Used
- Bitrue Spot API (public, no key required for market data)
- Base URL: https://openapi.bitrue.com
- Endpoint: /api/v1/ticker/24hr

## Notes for AI
- cb2market wants to find wealth-generating micro-cap opportunities
- This is a live tool — scan fresh data before making any decisions
- Next version should include on-chain data and social sentiment scoring
- Consider adding CoinGecko or CoinMarketCap data for cross-reference
