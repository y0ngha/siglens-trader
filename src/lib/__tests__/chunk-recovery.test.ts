import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clearChunkRecoveryFlag, installChunkRecovery } from '../chunk-recovery';

const RELOAD_FLAG = 'chunk-reload-attempted';

/** `window.dispatchEvent`로 실제 리스너를 태운다 — 등록 자체가 검증 대상이다. */
function fireError(message: string) {
    return window.dispatchEvent(new ErrorEvent('error', { message, cancelable: true }));
}

function fireRejection(reason: unknown) {
    const e = new Event('unhandledrejection', { cancelable: true }) as Event & { reason?: unknown };
    e.reason = reason;
    return window.dispatchEvent(e);
}

describe('installChunkRecovery', () => {
    let reload: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        // 리스너는 테스트마다 쌓이지만 `sessionStorage` 표식이 한 번만 통과시키므로
        // 호출 횟수 단언은 흔들리지 않는다 — 표식을 매번 비우는 것이 그 전제다.
        sessionStorage.clear();
        reload = vi.fn();
        Object.defineProperty(window, 'location', {
            value: { ...window.location, reload },
            writable: true,
        });
        installChunkRecovery();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        sessionStorage.clear();
    });

    it('청크 로드 실패면 새로고침한다 — 이 모듈의 존재 이유', () => {
        fireError('Failed to fetch dynamically imported module: /assets/Status-abc.js');
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('브라우저별 문구를 모두 잡는다', () => {
        for (const msg of [
            'Failed to fetch dynamically imported module: x',
            'error loading dynamically imported module',
            'Importing a module script failed.',
        ]) {
            sessionStorage.clear();
            reload.mockClear();
            fireError(msg);
            expect(reload, msg).toHaveBeenCalledTimes(1);
        }
    });

    it('Promise rejection 경로도 잡는다 — lazy 실패는 양쪽으로 온다', () => {
        fireRejection(new Error('Failed to fetch dynamically imported module: /assets/x.js'));
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('무관한 오류에는 새로고침하지 않는다', () => {
        fireError('TypeError: undefined is not a function');
        fireRejection(new Error('Network request failed'));
        fireRejection('some string');
        fireRejection(undefined);
        expect(reload).not.toHaveBeenCalled();
    });

    it('한 번만 새로고침한다 — 무한 루프는 진짜 배포 사고를 감춘다', () => {
        fireError('Failed to fetch dynamically imported module: a');
        fireError('Failed to fetch dynamically imported module: b');
        fireError('Failed to fetch dynamically imported module: c');
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('두 번째부터는 오류를 그대로 흘려보낸다 — 오류 화면이 떠야 한다', () => {
        fireError('Failed to fetch dynamically imported module: a');
        // 첫 번째는 preventDefault로 삼킨다(새로고침하므로).
        const secondNotPrevented = fireError('Failed to fetch dynamically imported module: b');
        expect(secondNotPrevented).toBe(true);
    });

    it('정상 부팅을 확인하면 표식을 지운다 — 다음 배포에서 다시 복구할 수 있어야 한다', () => {
        fireError('Failed to fetch dynamically imported module: a');
        expect(sessionStorage.getItem(RELOAD_FLAG)).toBe('1');

        clearChunkRecoveryFlag();
        expect(sessionStorage.getItem(RELOAD_FLAG)).toBeNull();

        reload.mockClear();
        fireError('Failed to fetch dynamically imported module: b');
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('sessionStorage를 못 쓰면 새로고침하지 않는다 — 복구 장치가 더 나쁜 상태를 만들면 안 된다', () => {
        // 사파리 프라이빗 모드 등에서 접근 자체가 던진다. `Storage.prototype`을 스파이하면
        // jsdom의 `sessionStorage`가 자체 속성을 갖고 있어 안 걸리므로 객체를 통째로 바꾼다.
        vi.stubGlobal('sessionStorage', {
            getItem: () => {
                throw new Error('private mode');
            },
            setItem: () => {
                throw new Error('private mode');
            },
            removeItem: () => {
                throw new Error('private mode');
            },
            clear: () => {},
        });

        fireError('Failed to fetch dynamically imported module: a');
        expect(reload).not.toHaveBeenCalled();

        // 표식 지우기도 던지지 않아야 한다 — 앱 부팅 경로에서 불린다.
        expect(() => clearChunkRecoveryFlag()).not.toThrow();
        vi.unstubAllGlobals();
    });
});
