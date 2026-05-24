---
name: Refactoring
about: 코드 구조 개선 요청
title: "[Refactor] "
labels: refactoring
assignees: y0ngha

---

## 무엇을 리팩토링하는가

<!-- 대상 파일/모듈과 현재 구조를 간략히 설명 -->

## 왜 리팩토링이 필요한가

<!-- 현재 코드의 문제 유형 (해당 항목 체크) -->

- [ ] 응집도 낮음 (한 모듈에 관련 없는 로직이 섞여 있음)
- [ ] 결합도 높음 (레이어 간 의존 방향이 잘못됨)
- [ ] 도메인 로직이 인프라 레이어에 누수됨
- [ ] 중복 코드 (동일 패턴이 여러 곳에 분산됨)
- [ ] 테스트 불가능한 구조
- [ ] 기타:

## 현재 구조 (AS-IS)

<!-- 어떤 구조로 되어 있는지, 어떤 흐름으로 동작하는지 -->

## 목표 구조 (TO-BE)

<!-- 리팩토링 후 어떤 구조가 되어야 하는지 -->

## 영향 범위

<!-- 리팩토링 대상 레이어 -->

- [ ] `lib/strategy/` (도메인 순수 로직)
- [ ] `lib/analysis/` (siglens-core 연동)
- [ ] `lib/trading/` (토스 API)
- [ ] `lib/data/` (FMP, Yahoo Finance)
- [ ] `lib/notification/` (이메일 알림)
- [ ] `lib/db/` (DB 스키마/쿼리)
- [ ] `api/` (Serverless Functions)
- [ ] `src/` (Dashboard UI)

## 완료 조건

- [ ] 동작 변경 없음 (기존 테스트 전부 통과)
- [ ] 리팩토링 후 테스트 커버리지 유지 또는 향상
