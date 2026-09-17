# 2026-09-17 감사 대응 — 청산 상수 제거와 컨플루언스 상위 시간축 게이트 방향 전환

프로덕션 DB(1Hour 구간 13세션, 1,402틱) + FMP 1년치 1시간봉(16종목, 27,190봉) 감사에서 나온
수정 요소 전체와, 각각을 어떻게 처리했는지 적는다. **한 것만이 아니라 하지 않은 것과 그 이유까지**
남기는 것이 이 문서의 목적이다 — 이 저장소의 실패는 늘 "각각 정당한 변경의 곱을 아무도 안 잰 것"이었다.

## 0. 출발점

- 체결 7회전 **0승**, −$472.79 (전부 `dry_run`). 마지막 체결 2026-09-02.
- v0.28.6(저항선 근접 수정) 이후 10세션 체결 0건 — 그 수정은 프로덕션에서 한 번도 실행된 적 없다.
- 매수 임계 돌파 45틱 중 전 게이트 통과 **1틱(2.2%)**.

## 1. 수정 요소 전체와 처분

| # | 발견 | 처분 | 어디 |
|---|---|---|---|
| 1 | 목표가 근접 익절(규칙 5b)이 v0.30.0부터 **537/537틱에서 참** — 1틱 청산 100% | **수정**: 4.5의 폴백으로 | trader #68 |
| 2 | `firstUpsideExit`이 서지 않을 트리거(목표가 95%)를 보상 상한으로 셈 | **수정**: 같은 폴백 규칙 미러 | trader #68 |
| 3 | "사자마자 청산" 부류가 세 번째 — 매번 몇 주 뒤 감사로 발견 | **가드 추가**: `entry_exit_standing` | trader #68 |
| 4 | 컨플루언스 진입 트리거에 우위 없음(1년 백테스트 승률 39~45%). 원인은 **상위 시간축 게이트의 부호** | **수정**: core에 `htfMode` 옵션, trader 기본 `notUptrend` | core #212 / 이 PR |
| 5 | 게이트 프롬프트가 적용되지 않은 조건을 성립 사유로 적음("거래량 확인", "30분봉") | **수정**: `params`에서 생성 | 이 PR |
| 6 | 문서 드리프트 — 기술 축 모델, 임계 꼬리 비율, `requireVolume` 기본값 | **수정** | trader #68 / 이 PR |
| 7 | 매수 65 / 매도 40이 더는 대칭 꼬리가 아님(≥65 3.2%, ≤40 12.7%, 매도 신호 21.8%) | **보류** — 전진 수익률이 어느 쪽 이동도 지지하지 않는다. 문서에 실측값만 기록 | — |
| 8 | `entryRecommendation`이 상수(`enter` 5/1,111, v4.1은 `wait` 136/136) → 기술 축 −6 상수 감점 | **보류** — 빼면 분포 +1.4점, 매도도 어려워진다(원칙 7). core 프롬프트의 `enter` 기준 문제라 siglens 제품 프롬프트까지 움직인다 | — |
| 9 | 진입 게이트 3종(`entry_out_of_zone`/`no_stop_room`/`poor_rr`) 완화 | **기각** — 막힌 44틱을 실제 청산 체인으로 돌리면 −0.58%/승률 38%. 게이트는 이번에도 옳았다 | — |
| 10 | 규칙 3(추세 bearish 청산)에 2연속 요구 | **기각** — 리플레이 −0.371% → −0.422% | — |
| 11 | `confluence_min` 2.0 / 3.0, `fresh`·`close > MA50` 제거 | **기각** — 기준선과 구분되지 않음 | — |
| 12 | 청산 기하(익절 +0.8% / 손절 −0.9%)가 우위의 시간 지평(1~2일)보다 짧다 | **미착수** — §5 | — |
| 13 | 09-14 technical 전 심볼 900초 타임아웃 2연속 | **부수 해소 기대** — core 1.7.0의 DeepSeek 스트림 무응답 감시(90초)가 이번 의존성 상향에 포함 | 이 PR |

## 2. 규칙 5b — 신호가 아니라 상수 (#1~#3)

`currentPrice >= targetPrice * 0.95`. `targetPrice`는 `priceTargets.bullish`의 **첫** 목표 =
현재가에서 가장 가까운 목표다. `* 0.95`는 목표가 +5.26% 안쪽이면 항상 참인데, 장중 분석의
목표는 피보나치·이평 레벨이라 현재가 대비 중앙 +0.80%, 최대 +4.69%다.

| | 목표가 존재 | 조건이 참 |
|---|---|---|
| ~09-10 (`deepseek-v4-flash`) | 0 / 862 | 0% |
| 09-10~ (v0.30.0, core 1.0.x 스키마 강제) | 537 / 540 | **537 / 537** |

구 모델이 목표가를 한 번도 내지 않아 잠들어 있던 규칙을 스키마 강제가 깨웠다. 첫 목표가는
77%의 틱에서 `aiTakeProfit`과 같은 가격이라 "도달"은 4.5가 이미 잡는다 → 규칙 5와 똑같이
`!params.aiTakeProfit &&`.

**가드(`entry_exit_standing`)는 관측 장치다.** 실측 매수 신호 45틱에서 새로 막는 틱은 0건이다
(서 있던 16건은 전부 레벨 가드가 먼저 잡았다). 그래도 두는 이유: 이 부류의 증상은 10분 간격
체결 한 쌍뿐이라 세 번 모두 감사로만 발견됐다. 이제는 규칙 이름이 찍힌 행으로 쌓인다.

수정 후 평균은 **나빠진다**(추세 비약세 243틱: −0.022% → −0.371%). 10분 청산은 매매를 하지
않는 것이었고, 고치면 우위 없는 진입을 실제로 들고 가기 때문이다. 그 진입 쪽이 §3이다.

## 3. 상위 시간축 게이트 — 부호가 반대였다 (#4)

### 3.1 무엇을 쟀나

종전 게이트("일봉이 상승일 때만 진입")는 추론과 손실 3건 차단으로 들어왔고 **전진 수익률을
잰 적이 없다.** 이번에 쟀다.

- 16종목: 관심 4(NVDA·TSLA·PLTR·IONQ) + 대조 12(AMD·AAPL·MSFT·META·AMZN·GOOGL·AVGO·COIN·MSTR·SMCI·RKLB·HOOD)
- 2025-09 ~ 2026-09, FMP 1시간 **완성봉** 27,190개, 슬라이딩 600봉(프로덕션 룩백 120일과 같은 규모)
- core `evaluateConfluence` 그대로, 프로덕션 파라미터(min 2.5 / exitMin 1.5 / span 15 / expected 0.5 / htf 1Day)
- 재계산 검증: 프로덕션에 저장된 스냅샷 468개와 대조해 entryTrigger 99.4% / exitTrigger 95.3% / htfTrend 97.9% 일치
- 초과수익 = 전진 수익률 − 그 심볼의 1년 평균. **심볼·일 첫 트리거만** 센 독립 표본

### 3.2 결과 (진입 창 봉, ET 10:30~13:30 개시봉)

| 상위 추세 조건 | n | +1일 초과 평균 (중앙) | t | +2일 | 원수익 승률 | 심볼 1개 제외 범위 |
|---|---|---|---|---|---|---|
| 상승 요구 (종전) | 230 | **−0.54%** (−0.54) | −2.1 | −1.03% (t −3.1) | 45% | −0.69 ~ −0.44 |
| 게이트 off | 641 | +0.10% (−0.10) | 0.6 | −0.01% | 49% | +0.07 ~ +0.15 |
| **상승 제외** | 413 | **+0.45%** (−0.01) | 2.2 | +0.51% | 51% | +0.41 ~ +0.52 |
| 하락만 | 148 | +0.44% (+0.20) | 1.4 | +0.87% | 58% | +0.26 ~ +0.54 |

- 종전 게이트는 관심 4종목(−0.41%)과 대조 12종목(−0.40%)에서 같은 크기로 음수, 16종목 중 13종목 음수.
- 컨플루언스와 무관하게도 같은 방향: 일봉 `uptrend` 상태 뒤 +1일 초과 −0.19%(양수 3/16), `downtrend` 뒤 +0.18%(15/16).
- 대조: 강세 계열이 **없는**(`bw < 1`) 하락 추세 봉은 +0.01% — 하락 추세 효과만으로는 설명되지 않고, 컨플루언스 × 비상승의 곱이 값을 한다.
- `fresh`·`close > MA50`은 유의한 차이를 만들지 않았다 → 건드리지 않는다.

해석: 1시간봉 강세 컨플루언스는 이미 뻗은 일봉 위에서는 **늦은 추격**이고, 그렇지 않은
자리에서는 **반등 확인**으로 작동한다. 프로덕션 13세션의 매수 신호가 +30분 +0.10%(승률 62%)
뒤 +120분 −0.20%, D+1 −1.61%로 되돌려진 것, LLM 분석 원문이 "허스트 0.36 — 평균 회귀 우위,
추격 금지"라고 적던 것과 같은 그림이다.

### 3.3 설계

- **core**: `EvaluateConfluenceOptions.htfMode: 'uptrend' | 'notUptrend'`. 기본값은 `'uptrend'`
  그대로 — siglens 일봉 백테스트와 다른 소비자를 같이 움직이지 않는다. 적용 모드는
  `params.htfMode`에 기록(구 스냅샷엔 없으므로 optional, 부재 = `uptrend`). 판정 불가(`null`)는
  두 모드 모두 통과, 청산 트리거는 모드와 무관.
- **trader**: `DEFAULT_HTF_MODE = 'notUptrend'`. 설정 키 `confluence_htf_mode`(열거값만 허용)로
  재배포 없이 되돌린다. 손상된 설정 행은 넘기지 않아 trader 기본 모드가 적용된다.
- **`하락만`이 아니라 `상승 제외`를 고른 이유**: 표본이 3배(413 vs 148)이고 심볼 제외 범위가
  좁다. `하락만`은 중앙값·승률이 더 좋지만 n=148에 관심 4종목 편중(+1.85% vs 대조 +0.24%)이 크다.

### 3.4 원칙 7 · 11 선언

- **원칙 7**: 진입 전용 변경이다. 청산 트리거·청산 체인은 건드리지 않았다.
- **원칙 11 (결합 효과)**: 조임이 아니라 방향 전환이다 — 관심 4종목 트리거 심볼·일은 1년에
  54 → 104(월 8~15). 다만 국면을 탄다: 하락 테이프였던 2026-09의 13세션은 종전 6 → 새 모드
  **0**이고, 프로덕션 1,402틱을 모드만 바꿔 재채점하면 매수 신호 45 → 31틱, 전 게이트 통과
  1 → 0틱이다(재채점은 프로덕션 총점과 1,402/1,402 일치로 검증). 종전 모드도 2026-01·02·07이
  0이었다. **배포 직후 신호가 없는 것은 고장이 아니다.**

### 3.5 한계 — 확실한 것과 덜 확실한 것

- **확실**: 종전 방향은 해롭다(독립 표본 t −2.1/−3.1, 어느 심볼을 빼도 음수, 두 종목군 동일).
- **덜 확실**: 새 방향이 이롭다. 평균 +0.45%에 중앙값 ≈ 0 — 우측 꼬리에서 온다. 기간 3등분 중
  한 구간은 −0.10%였다.
- 1년·단일 국면 공유. 완성봉 기준인데 프로덕션은 형성 중 봉을 본다.
- 게이트 프롬프트에도 이 수치를 "약한 우위이지 확신의 근거가 아니다"로 그대로 적었다.

## 4. 게이트 프롬프트 (#5)

성립 사유를 하드코딩하지 않고 스냅샷 `params`에서 만든다: 상위 추세 절은 게이트가 적용됐을 때만,
모드에 따라 `상위 추세 상승` / `상위 추세 비상승`; `거래량 확인`은 실제로 요구됐을 때만. 출처
줄은 "수정본은 검증된 적 없다" 대신 §3.2의 수치를 과장 없이 싣는다. 펜스 안에는 여전히 사실만 둔다.

## 5. 남은 과제 — 청산 기하

같은 1년 표본에서 "익절 +0.8% / 손절 −0.9% 선착, 14봉 컷"(AI 계획 중앙값)의 **기준선 기대값이
−0.095%/거래**(승률 47%)다. 가장 좋은 진입 버킷(강세 계열 ≥ 2.5 & 일봉 하락)을 얹어도 −0.03%로
0을 못 넘는다. 우위는 +1~2일 드리프트(+0.4~0.8%)에 있는데 계획은 1~2시간 안에 ±0.8%에서 끝난다 —
2026-08-28에 정렬한 "세 시계"가 다시 어긋난다. +2%/−1%면 +0.11%, +3%/−1.5%면 +0.17%/거래였다.
진입 방향을 고친 효과를 먼저 관측한 뒤(변수 하나씩), `aiTakeProfit`을 첫 익절가가 아니라 사다리의
먼 값으로 읽는 안을 같은 방식으로 잰다.

## 6. 재현

봉은 `lib/data/fmp-market-data-provider.ts`로 받는다(`historical-chart/1hour`는 요청당 범위 제한이
있어 30일 창으로 쪼갠다). 스냅샷 생성이 무겁다(종목당 ~2.5분) — 봉마다 600봉 지표 재계산 × 2.

<details><summary>스냅샷 생성 (tsx)</summary>

```ts
// 봉마다 컨플루언스 스냅샷 전체를 저장한다 (htf on). 변형은 오프라인에서 목록으로 재계산.
import { readFileSync, writeFileSync } from 'node:fs';
import { evaluateConfluence } from './core.mts';
const S = process.argv[2], symbols = process.argv[3].split(',');
const all = { ...JSON.parse(readFileSync(`${S}/bars1h.json`, 'utf8')), ...JSON.parse(readFileSync(`${S}/bars1h-oos.json`, 'utf8')) };
const isoDay = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
for (const symbol of symbols) {
    const { h1, d1 } = all[symbol]; const rows: any[] = [];
    for (let i = 130; i < h1.length; i++) {
        const win = h1.slice(Math.max(0, i - 599), i + 1);
        const day = isoDay(h1[i].time);
        const todays: any[] = []; for (let j = i; j >= 0 && isoDay(h1[j].time) === day; j--) todays.unshift(h1[j]);
        const dToday = { time: Date.parse(day + 'T00:00:00Z') / 1000, open: todays[0].open, high: Math.max(...todays.map((b) => b.high)), low: Math.min(...todays.map((b) => b.low)), close: h1[i].close, volume: todays.reduce((s, b) => s + b.volume, 0) };
        const s = evaluateConfluence(win, { timeframe: '1Hour', htfBars: [...d1.filter((b: any) => isoDay(b.time) < day), dToday], htfLabel: '1Day', min: 2.5, exitMin: 1.5, span: 15, expectedWeight: 0.5, requireVolume: false });
        if (!s) continue;
        const f: any = {}; for (const k of [1, 2, 4, 7, 14, 21]) f['f' + k] = h1[i + k] ? (h1[i + k].close / h1[i].close - 1) * 100 : null;
        // 경로: 이후 14봉의 최고/최저 (익절·손절 선착 판정용)
        const path = h1.slice(i + 1, i + 15).map((b: any) => [+(b.high / h1[i].close - 1).toFixed(5), +(b.low / h1[i].close - 1).toFixed(5), +(b.close / h1[i].close - 1).toFixed(5)]);
        rows.push({ symbol, time: h1[i].time, close: s.close, ma50: s.ma50, bull: s.bullish, bear: s.bearish, fb: s.freshBullish, fr: s.freshBearish, htf: s.htfTrend, e: s.entryTrigger, x: s.exitTrigger, ...f, path });
    }
    writeFileSync(`${S}/snap-${symbol}.json`, JSON.stringify(rows));
    console.log(symbol, rows.length);
}
```

</details>

<details><summary>독립 표본 비교 (tsx)</summary>

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { confluenceFamilyWeight } from './core.mts';
const S = process.argv[2];
let rows: any[] = [];
for (const f of readdirSync(S).filter((f) => /^snap-[A-Z]+\.json$/.test(f))) rows.push(...JSON.parse(readFileSync(`${S}/${f}`, 'utf8')));
const H = ['f4', 'f7', 'f14'];
const mean: Record<string, Record<string, number>> = {};
for (const r of rows) { const m = (mean[r.symbol] ??= {}); for (const h of H) if (r[h] != null) { m[h + 's'] = (m[h + 's'] ?? 0) + r[h]; m[h + 'n'] = (m[h + 'n'] ?? 0) + 1; } }
for (const r of rows) { r.bw = confluenceFamilyWeight(r.bull, 0.5); r.rw = confluenceFamilyWeight(r.bear, 0.5); r.above = r.ma50 != null && r.close > r.ma50; r.fresh = r.fb.length >= 1; r.hm = new Date(r.time * 1000).toLocaleTimeString('sv', { timeZone: 'America/New_York' }).slice(0, 5); for (const h of H) r['x' + h] = r[h] == null ? null : r[h] - mean[r.symbol][h + 's'] / mean[r.symbol][h + 'n']; }
const inWin = (r: any) => ['10:30', '11:30', '12:30', '13:30'].includes(r.hm);
const dayKey = (r: any) => r.symbol + new Date(r.time * 1000).toISOString().slice(0, 10);
const firstPerDay = (xs: any[]) => { const seen = new Set(); return [...xs].sort((a, b) => a.time - b.time).filter((r) => !seen.has(dayKey(r)) && seen.add(dayKey(r))); };
const q = (v: number[], p: number) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor((s.length - 1) * p)]; };
const base = (r: any) => r.bw >= 2.5 && r.fresh && r.above;
const cands: [string, (r: any) => boolean][] = [
    ['C0 현행 htf=up', (r) => base(r) && r.htf === 'uptrend'],
    ['C1 htf off', base],
    ['C2 htf≠up', (r) => base(r) && r.htf !== 'uptrend'],
    ['C3 htf=down', (r) => base(r) && r.htf === 'downtrend'],
    ['C2s htf=sideways', (r) => base(r) && r.htf === 'sideways'],
];
for (const [scope, filt] of [['전체 봉', (_: any) => true], ['진입 창 봉만', inWin]] as const) {
    console.log(`\n## ${scope} — 심볼·일 첫 트리거만 (독립 표본)`);
    for (const [name, f] of cands) {
        const xs = firstPerDay(rows.filter((r) => filt(r) && f(r)));
        const v7 = xs.map((r) => r.xf7).filter((x) => x != null), v14 = xs.map((r) => r.xf14).filter((x) => x != null), raw7 = xs.map((r) => r.f7).filter((x) => x != null);
        const avg = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length; const sd = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + (x - avg(v)) ** 2, 0) / v.length);
        // 심볼 하나씩 빼고 본 +1d 초과 평균의 최소/최대
        const syms = [...new Set(xs.map((r) => r.symbol))]; const loo = syms.map((s) => avg(xs.filter((r) => r.symbol !== s).map((r) => r.xf7).filter((x) => x != null)));
        console.log(`${name.padEnd(18)} n=${String(xs.length).padStart(4)} | +1d 초과 평균 ${avg(v7).toFixed(2)} 중앙 ${q(v7, 0.5).toFixed(2)} t=${(avg(v7) / (sd(v7) / Math.sqrt(v7.length))).toFixed(1)} 원수익 승률 ${((raw7.filter((x) => x > 0).length / raw7.length) * 100).toFixed(0)}% | +2d 평균 ${avg(v14).toFixed(2)} 중앙 ${q(v14, 0.5).toFixed(2)} t=${(avg(v14) / (sd(v14) / Math.sqrt(v14.length))).toFixed(1)} | LOO +1d ${Math.min(...loo).toFixed(2)}~${Math.max(...loo).toFixed(2)}`);
    }
}
```

</details>

`./core.mts`는 스크래치 경로에서 `@y0ngha/siglens-core`를 저장소의 `node_modules`로 해석하기 위한
`createRequire` 브리지다 — 저장소 안에서 돌리면 그냥 패키지를 import하면 된다.
