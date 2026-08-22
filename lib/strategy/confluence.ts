/**
 * 지표 컨플루언스 — **core 재수출**.
 *
 * 룰과 채점은 siglens-core의 `domain/signals/confluence`가 소유한다. 여기 있던 구현은
 * siglens 백테스트 스크립트의 룰을 읽고 다시 짠 것이었고, 코드로 연결된 데가 없어
 * 한쪽만 바뀌면 조용히 갈라졌다 — 실제로 SMA(50)은 siglens가 core의 `calculateMA`를
 * 쓰는 동안 이쪽은 직접 구현하고 있었다. 이제 백테스트와 실거래가 같은 함수를 부른다.
 *
 * 이 파일이 남아 있는 이유는 **경계 표시**다. `lib/strategy/`는 순수 도메인 계층이고
 * 다른 레이어가 여기를 통해 컨플루언스를 읽는 관례가 이미 배선돼 있어, 재수출 한 겹이
 * import 경로를 한 곳에 묶어 둔다. 로직은 한 줄도 없다.
 *
 * FMP 봉 조회와 캐싱은 `lib/analysis/confluence.ts`가 맡는다 — 봉 조회는 소비자 책임,
 * 도메인 계산은 core 책임이라는 분업이다.
 */
export {
    CONFLUENCE_EXIT_SCORE,
    CONFLUENCE_EXPECTED_WEIGHT,
    CONFLUENCE_MIN,
    CONFLUENCE_MIN_BARS,
    CONFLUENCE_SHRINK,
    CONFLUENCE_SPAN,
    CONFLUENCE_TREND_MA_PERIOD,
    CONFLUENCE_TRIGGER_SCORE,
    confluenceFamilyWeight,
    evaluateConfluence,
    isConfluenceExit,
    scoreConfluence,
    signalFamily,
    VOLUME_FAMILIES,
} from '@y0ngha/siglens-core';

export type {
    ConfluenceParams,
    ConfluenceSnapshot,
    EvaluateConfluenceOptions,
} from '@y0ngha/siglens-core';
