---
name: Feature request
about: 새로운 기능 구현 요청
title: "[Feature] "
labels: feature
assignees: y0ngha

---

## 구현할 기능

<!-- 무엇을 만들어야 하는지 명확하게 설명 -->

## 왜 필요한가

<!-- 이 기능이 필요한 이유 -->

## 구현 범위

<!-- 어느 레이어에 무엇을 만들어야 하는지 -->

- [ ] `lib/strategy/` (도메인 순수 로직)
- [ ] `lib/analysis/` (siglens-core 연동)
- [ ] `lib/trading/` (토스 API)
- [ ] `lib/data/` (FMP, Yahoo Finance)
- [ ] `lib/notification/` (이메일 알림)
- [ ] `lib/db/` (DB 스키마/쿼리)
- [ ] `api/` (Serverless Functions)
- [ ] `src/` (Dashboard UI)

## 완료 조건

<!-- 이 이슈가 완료되었다고 볼 수 있는 기준 -->

- [ ] 구현 완료
- [ ] 테스트 작성 (`lib/strategy/` 커버리지 100% 유지)
- [ ] 문서 업데이트 (필요한 경우)
