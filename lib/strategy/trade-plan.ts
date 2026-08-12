import { safeNumber } from '../validation.js';

/**
 * Fraction (0~1) → order quantity conversion for split entries / split exits.
 *
 * This module is deliberately dumb: it never decides *whether* to trade or *how
 * confident* to be — that judgment happens upstream (rule engine for the trigger,
 * AI gate for the fraction). Here we only turn a ratio into a concrete share count
 * against the budgets/holdings that are actually available, and we do it in a way
 * that can never emit NaN or a non-finite/unsafe quantity no matter how garbled the
 * upstream inputs are.
 */

/** Rule-engine trigger label, useful to callers for the gate prompt and audit log —
 *  `planExit` itself does not read it (see design doc §5.2: no per-trigger floor). */
export type ExitTrigger = 'stop_loss' | 'take_profit' | 'signal_sell';

/**
 * Normalizes an arbitrary value into a 0~1 fraction.
 *
 * Anything that is not a finite number (wrong type, NaN, ±Infinity) falls back to
 * `fallback` rather than propagating garbage — this is the single choke point that
 * keeps AI-supplied `fraction` values from ever reaching the arithmetic below.
 * `fallback` itself is clamped too, so a caller can never smuggle an out-of-range
 * value in through that side door.
 */
export function clampFraction(value: unknown, min: number, fallback: number): number {
    return Math.min(1, Math.max(min, safeNumber(value, fallback)));
}

/**
 * Deterministic 3-rung fallback for entry sizing when the AI gate is off.
 * Not wired into execute.ts today (see design doc §5.3) — turning the gate off is an
 * explicit "run the old fixed-size behavior" choice, so nothing calls this yet. Kept
 * as an exported, tested function for when a non-AI split-entry option is added.
 */
export function fallbackEntryFraction(score: number, buyThreshold: number): number {
    const headroom = Math.max(1, 100 - buyThreshold);
    const conviction = clampFraction((score - buyThreshold) / headroom, 0, 0);
    if (conviction < 1 / 3) return 1 / 3;
    if (conviction < 2 / 3) return 2 / 3;
    return 1;
}

export interface EntryPlanParams {
    price: number;
    fraction: number;
    maxPositionSize: number;
    maxTotalExposure: number;
    /** Total exposure across all symbols (open positions + pending buys). */
    currentExposure: number;
    /** Amount already committed to this symbol. 0 for a brand-new entry. */
    existingSymbolExposure: number;
    /** null/undefined = unknown (dry_run/semi_auto don't know real cash) → unconstrained. */
    availableCash?: number | null;
}

export interface EntryPlan {
    quantity: number;
    /** Budget before `fraction` is applied. */
    fullBudget: number;
    /** Budget after `fraction` is applied. */
    trancheBudget: number;
    limitedBy: 'symbol' | 'total' | 'cash' | 'none';
}

export function planEntry(params: EntryPlanParams): EntryPlan {
    const {
        price,
        fraction,
        maxPositionSize,
        maxTotalExposure,
        currentExposure,
        existingSymbolExposure,
        availableCash,
    } = params;

    if (!Number.isFinite(price) || price <= 0) {
        return { quantity: 0, fullBudget: 0, trancheBudget: 0, limitedBy: 'none' };
    }

    // Budget inputs come from config/DB and *should* already be sane finite numbers,
    // but a bad migration or direct DB edit could hand us NaN/Infinity here. Sanitize
    // before the Math.max/min chain below: Math.max(0, NaN) is NaN, and a NaN budget
    // would silently disable the per-symbol / total-exposure circuit breakers instead
    // of tripping them (a NaN comparison is always false, so every "is this the
    // limiting budget" check would just fall through).
    const safeMaxPositionSize = safeNumber(maxPositionSize, 0);
    const safeMaxTotalExposure = safeNumber(maxTotalExposure, 0);
    const safeCurrentExposure = safeNumber(currentExposure, 0);
    const safeExistingSymbolExposure = safeNumber(existingSymbolExposure, 0);

    const symbolBudget = Math.max(0, safeMaxPositionSize - safeExistingSymbolExposure);
    const totalBudget = Math.max(0, safeMaxTotalExposure - safeCurrentExposure);
    const cashBudget = Number.isFinite(availableCash)
        ? Math.max(0, availableCash as number)
        : Infinity;

    const fullBudget = Math.min(symbolBudget, totalBudget, cashBudget);

    // Tie-break priority symbol > total > cash, matching the order the budgets are
    // listed in the design doc (§5.1) — an audit reading "limitedBy: symbol" should
    // stay stable even when two constraints happen to bind at the same value. This is
    // a label only; `fullBudget` above is the actual min, computed independently so a
    // stale/diverging comparison chain here can't desync the two.
    let limitedBy: EntryPlan['limitedBy'];
    if (symbolBudget <= totalBudget && symbolBudget <= cashBudget) {
        limitedBy = 'symbol';
    } else if (totalBudget <= cashBudget) {
        limitedBy = 'total';
    } else {
        limitedBy = 'cash';
    }

    const safeFraction = clampFraction(fraction, 0, 1);
    let trancheBudget = fullBudget * safeFraction;
    let quantity = Math.floor(trancheBudget / price);

    // High-price correction: without this, a tranche on an expensive stock rounds
    // down to 0 shares forever (e.g. $1000 budget * 0.33 fraction / $500 stock = 0),
    // which turns split-entry into "never fills". fraction === 0 is an explicit
    // "hold off this tick" decision from the gate, so it is exempt from the bump.
    if (quantity === 0 && safeFraction !== 0 && fullBudget >= price) {
        quantity = 1;
        // We're no longer executing the fraction-derived slice — realign the reported
        // tranche budget with what actually gets spent, so an audit log never shows
        // e.g. trancheBudget:330 next to quantity:1 (which really cost $500).
        trancheBudget = price * quantity;
    }

    // Final backstop: an absurd-but-finite price (e.g. 1e-300) can push the division
    // above Number.MAX_SAFE_INTEGER before we get here. Refuse to hand back a
    // quantity that can't round-trip through integer arithmetic — no order (0) beats
    // a corrupted share count reaching the broker.
    if (!Number.isSafeInteger(quantity)) {
        quantity = 0;
    }

    return { quantity, fullBudget, trancheBudget, limitedBy };
}

export interface ExitPlanParams {
    positionQuantity: number;
    fraction: number;
    /** Prompt/audit label only — not read by `planExit`. Callers keep it for logging. */
    trigger?: ExitTrigger;
    /** True bypasses `fraction` entirely — see design doc §6 for which triggers set this. */
    hard?: boolean;
}

export function planExit(params: ExitPlanParams): number {
    const { positionQuantity, fraction, hard } = params;

    const total = Number.isFinite(positionQuantity) ? Math.floor(positionQuantity) : 0;
    if (total <= 0) return 0;

    if (hard === true) return total;

    const safeFraction = clampFraction(fraction, 0, 1);

    // Exactly 0 (post-clamp, so a negative fraction lands here too) means "defer this
    // exit" and wins over the >=1 floor below — the gate (or an operator) is
    // explicitly choosing not to sell any of this tick, not rounding down to a tiny
    // sale. Design doc §5.2 deliberately sets no per-trigger floor here: the AI gate
    // has full discretion, backstopped only by the circuit breakers (kill switch,
    // daily loss limit) rather than a hardcoded minimum.
    if (safeFraction === 0) return 0;

    return Math.min(total, Math.max(1, Math.floor(total * safeFraction)));
}
