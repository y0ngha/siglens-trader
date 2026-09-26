import type { MarketEvent } from '@y0ngha/siglens-core';

/**
 * 실적 발표일 → core `MarketEvent`.
 *
 * **왜 필요한가.** core 1.17.2(p18)는 일봉 "상승 추세 속 눌림" 판독에 룰 엔진 판정
 * `enter`를 싣되, 최근 3세션 안에 실적·가이던스·규제 이벤트가 있으면 그 판정을 보류한다
 * (core `docs/superpowers/specs/2026-09-26-washout-entry-verdict-design.md` §8). 측정은
 * 뉴스성 급락을 다루지 않고, 그런 날이 이 셋업의 큰 실패였다. 이 저장소는 `marketEvents`를
 * 넘기지 않았으므로 실적 급락에도 기술 분석이 "enter"를 적었고, 그 값이 AI 진입 리뷰의
 * 입력(`entry-review.ts`)으로 들어간다.
 *
 * **왜 실적 일정인가.** siglens는 LLM이 분류한 뉴스 카드를 넘기지만, 이 저장소에서 같은 걸
 * 만들려면 뉴스 카드 enrich(LLM 비용)가 기술 분석 앞에 와야 한다. 실적 발표일은 FMP에서 결정론적으로
 * 오고, 게이트가 막으려는 가장 흔한 경우가 실적 급락이다. 방향은 모르므로 `neutral` —
 * core 게이트는 bullish만 제외하므로 실적 창 전체가 "측정 범위 밖"으로 취급된다(스킬의 규칙과 같다).
 *
 * `publishedAt`은 발표일 12:00 UTC로 둔다. 일봉 스탬프는 UTC 자정이라 같은 날짜 봉의 창 안에
 * 들고, 장 전·장 후 발표 모두 그 날짜 또는 다음 날 봉의 3세션 창에 걸린다.
 */

/** core 게이트 창(3세션)보다 넉넉하게 — 주말·휴일을 흡수한다. 더 오래된 발표는 버린다. */
export const EARNINGS_EVENT_LOOKBACK_DAYS = 10;

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param earningsDates - FMP 실적 행의 `earningsDate`(YYYY-MM-DD), 순서 무관.
 * @param now - 기준 시각(테스트 주입용).
 * @returns `now` 기준 최근 {@link EARNINGS_EVENT_LOOKBACK_DAYS}일 ~ 내일 사이 발표일의 이벤트.
 *   형식이 어긋난 날짜는 버린다.
 */
export function earningsToMarketEvents(earningsDates: readonly string[], now: Date): MarketEvent[] {
    const fromMs = now.getTime() - EARNINGS_EVENT_LOOKBACK_DAYS * DAY_MS;
    const toMs = now.getTime() + DAY_MS;
    return earningsDates.flatMap((date) => {
        if (!ISO_DATE.test(date)) return [];
        const publishedAt = new Date(`${date}T12:00:00Z`);
        const at = publishedAt.getTime();
        if (!Number.isFinite(at) || at < fromMs || at > toMs) return [];
        return [{ publishedAt, category: 'earnings', sentiment: 'neutral', impact: 'high' }];
    });
}
