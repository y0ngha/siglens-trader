/**
 * Email notification gating.
 *
 * The dashboard exposes a master ON/OFF toggle plus per-event checkboxes
 * (trade_executed, order_pending, stop_loss, error). Crons must consult this
 * config before sending, otherwise the toggle has no effect. This is a pure
 * helper — callers fetch the `notification_config` rows and pass the email row.
 */

export interface EmailGateConfig {
    enabled: boolean;
    events: string[];
}

export type EmailGate = (...eventKeys: string[]) => boolean;

/**
 * Build a gate from the email notification row (or `undefined` if no row exists,
 * which is treated as disabled). The returned predicate is true only when the
 * channel is enabled AND at least one of the given event keys is selected.
 */
export function makeEmailGate(config: EmailGateConfig | undefined): EmailGate {
    const enabled = config?.enabled ?? false;
    const events = new Set(config?.events ?? []);
    return (...eventKeys: string[]) => enabled && eventKeys.some((e) => events.has(e));
}
