/// <reference types="vite/client" />

/**
 * 빌드 시점에 주입되는 SPA 번들 버전 (`vite.config.ts`의 `define`).
 *
 * 서버 버전(`/api/health`의 `version`)과 **따로** 존재해야 한다 — 새 서버에 옛 번들이
 * 캐시로 붙어 있는 상태를 구분하려는 것이 목적이기 때문이다.
 */
declare const __APP_VERSION__: string;
