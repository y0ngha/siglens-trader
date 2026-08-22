/**
 * 지표 컨플루언스 — **core 재수출**.
 *
 * 룰과 채점은 siglens-core의 `domain/signals/confluence`가 소유한다. 여기 있던 구현은
 * siglens 백테스트 스크립트의 룰을 읽고 다시 짠 것이었고, 코드로 연결된 데가 없어
 * 한쪽만 바뀌면 조용히 갈라졌다. 이제 백테스트와 실거래가 같은 함수를 부른다.
 *
 * **레이어 규칙의 명시적 예외다.** `lib/strategy/`는 "외부 패키지 import 없음"이 원칙인데
 * 이 파일만 `@y0ngha/siglens-core`를 가져온다. 규칙의 목적은 이 계층을 **순수하게** 유지해
 * 테스트 가능하게 두는 것이고, core의 `domain/`은 그 자체가 "zero I/O, zero side effects"를
 * 헌장으로 갖는 계층이라 목적에 어긋나지 않는다 — 순수 도메인 로직이 패키지로 호스팅된
 * 것뿐이다. 시계를 읽는 봉 신선도 검사 같은 비순수 부분은 일부러 `lib/analysis/` 쪽에
 * 남겼다. 루트 CLAUDE.md와 `lib/strategy/CLAUDE.md`에 같은 예외가 적혀 있다.
 *
 * **실제로 쓰이는 것만 재수출한다.** 상수·헬퍼 전체를 통과시키던 배럴이었는데 14개 중
 * 10개는 소비자가 없었다. 필요해지면 그때 core에서 직접 가져오면 된다 —
 * `lib/analysis/confluence.ts`가 `evaluateConfluence`를 그렇게 쓴다.
 */
export { CONFLUENCE_MIN_BARS, isConfluenceExit, scoreConfluence } from '@y0ngha/siglens-core';

export type { ConfluenceSnapshot } from '@y0ngha/siglens-core';
