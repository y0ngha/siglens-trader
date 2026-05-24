## 관련 이슈

closes #{이슈}

## 구현 내용

{내용}

## 레이어 및 코드 품질 체크

- [ ] CLAUDE.md 레이어 의존 방향 준수
- [ ] `lib/strategy/`: 외부 I/O 없음, 순수 함수만
- [ ] `lib/strategy/`: 외부 라이브러리 import 없음
- [ ] `src/`에서 `lib/` 직접 import 없음 (API 통해서만)
- [ ] 반환 타입 명시
- [ ] `any` 타입 없음
- [ ] 환경변수/시크릿 하드코딩 없음
- [ ] 새 파일에 대응하는 테스트 파일 포함

## 변경 파일 목록

[생성]

[수정] 

## CI Check lists

- [ ] yarn lint
- [ ] yarn typecheck
- [ ] yarn test
- [ ] yarn build
