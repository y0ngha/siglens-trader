/**
 * 배포 직후 사라진 청크를 만나면 **한 번** 새로고침해 새 문서를 받는다.
 *
 * 문제의 형태: 탭을 열어 둔 채 배포가 나가면 브라우저는 옛 `index.html`을 들고 있고, 그
 * 문서가 가리키는 `assets/Status-<해시>.js`는 새 빌드에 없다. 그 상태에서 페이지를
 * 이동하면 `React.lazy`의 `import()`가 실패하고 화면이 빈다 — 사용자가 직접 강력
 * 새로고침을 하기 전까지 복구되지 않는다.
 *
 * **왜 자동인가.** 이 앱은 자동매매 대시보드다. 화면이 빈 동안 운영자는 포지션도 킬
 * 스위치도 볼 수 없는데, 그 원인이 "배포가 나갔다"는 것은 화면에 아무 단서도 남기지
 * 않는다. 새로고침 한 번이면 끝나는 일을 사람이 알아내게 둘 이유가 없다.
 *
 * **왜 한 번뿐인가.** 새로고침 후에도 같은 오류가 나면 그것은 캐시 문제가 아니라 진짜
 * 배포 사고(자산 누락)다. 무한 새로고침은 그 사고를 감추면서 서버만 두드린다. 한 번
 * 시도한 사실을 `sessionStorage`에 남겨 두 번째부터는 오류 화면을 그대로 보여준다 —
 * 탭을 닫으면 지워지므로 다음 배포에서는 다시 한 번 기회를 얻는다.
 */
const RELOAD_FLAG = 'chunk-reload-attempted';

/**
 * 청크 로드 실패인가.
 *
 * 브라우저마다 문구가 다르고(Chrome/Safari/Firefox) 번역되지도 않아 문자열로 판정할
 * 수밖에 없다. 넓게 잡으면 무관한 오류에 새로고침이 걸리므로, 실제로 관측되는 형태만
 * 좁게 나열한다.
 */
function isChunkLoadError(message: string): boolean {
    return (
        message.includes('Failed to fetch dynamically imported module') ||
        message.includes('error loading dynamically imported module') ||
        message.includes('Importing a module script failed')
    );
}

/** 오류가 청크 로드 실패면 한 번 새로고침한다. 시도했으면 `true`. */
function recoverIfChunkError(message: unknown): boolean {
    if (typeof message !== 'string' || !isChunkLoadError(message)) return false;
    // sessionStorage는 사파리 프라이빗 모드 등에서 던질 수 있다. 복구 장치가 스스로
    // 예외를 내면 원래 오류보다 더 나쁜 상태가 되므로 전부 삼킨다.
    try {
        if (sessionStorage.getItem(RELOAD_FLAG)) return false;
        sessionStorage.setItem(RELOAD_FLAG, '1');
    } catch {
        return false;
    }
    console.warn('[chunk] 배포로 청크가 교체된 것으로 보입니다 — 새 문서를 받습니다.');
    window.location.reload();
    return true;
}

/**
 * 청크 오류 자동 복구를 켠다. 앱 렌더 **전에** 부른다.
 *
 * `error`와 `unhandledrejection`을 모두 듣는다 — `React.lazy`의 실패는 렌더 경로에 따라
 * 둘 중 어느 쪽으로도 올라온다.
 */
export function installChunkRecovery(): void {
    window.addEventListener('error', (e) => {
        if (recoverIfChunkError(e.message)) e.preventDefault();
    });
    window.addEventListener('unhandledrejection', (e) => {
        const reason: unknown = e.reason;
        const message =
            reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
        if (recoverIfChunkError(message)) e.preventDefault();
    });
}

/**
 * 정상 부팅을 확인했으니 재시도 표식을 지운다.
 *
 * 지우지 않으면 한 세션에 한 번만 복구할 수 있다. 앱이 실제로 떴다는 것은 그 시점의
 * 문서가 온전하다는 뜻이므로, 다음 배포에서 다시 한 번 복구할 자격이 생긴다.
 */
export function clearChunkRecoveryFlag(): void {
    try {
        sessionStorage.removeItem(RELOAD_FLAG);
    } catch {
        /* 저장소를 못 쓰면 애초에 표식도 없다 */
    }
}
