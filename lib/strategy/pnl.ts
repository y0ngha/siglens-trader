/**
 * Realized P&L for a long-position sell, rounded to cents.
 * Profit when sellPrice > avgPrice. Quantity is the sold quantity.
 *
 * Rounding to cents (Math.round(...* 100) / 100) prevents floating-point
 * noise accumulation when values are stored and re-read from the DB as
 * numeric strings (e.g. (10.1 - 10) * 3 = 0.30000000000000004 → 0.3).
 */
export function realizedPnlForSell(sellPrice: number, avgPrice: number, quantity: number): number {
    return Math.round((sellPrice - avgPrice) * quantity * 100) / 100;
}
