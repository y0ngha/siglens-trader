import { useQuery } from '@tanstack/react-query';

interface HealthResponse {
    version?: unknown;
}

/**
 * 배포 버전 표시 — **번들과 서버를 따로** 보여준다.
 *
 * 하나만 보여주면 정작 알고 싶은 것을 못 판별한다. 캐시 문제의 형태가 "새 서버에 옛 SPA가
 * 붙어 있는 상태"라, 서버 버전만 최신으로 뜨면 오히려 배포가 반영됐다고 오인하게 된다.
 * 두 값이 다르면 브라우저가 옛 번들을 들고 있다는 뜻이고, 그게 새로고침해야 한다는 신호다.
 *
 * 번들 버전은 빌드 시점에 박히고(`__APP_VERSION__`), 서버 버전은 `/api/health`가 컨테이너의
 * `APP_VERSION`을 낸다. 둘의 출처가 달라야 비교가 성립한다.
 */
export function VersionBadge() {
    const { data: serverVersion } = useQuery({
        queryKey: ['health-version'],
        queryFn: async ({ signal }) => {
            // 무인증 경로(얕은 헬스체크)라 로그인 전에도 뜬다.
            const res = await fetch('/api/health', { signal });
            if (!res.ok) return null;
            const json = (await res.json()) as HealthResponse;
            return typeof json.version === 'string' ? json.version : null;
        },
        // 배포는 드물고 이 값은 화면 장식이라, 폴링으로 서버를 두드릴 이유가 없다.
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnWindowFocus: false,
        retry: false,
    });

    const bundle = __APP_VERSION__;
    // 서버가 응답하기 전(undefined)과 버전을 모르는 상태(null/'unknown')는 다르다 —
    // 전자에서 불일치를 표시하면 로딩 중에 매번 경고가 깜빡인다.
    const stale =
        typeof serverVersion === 'string' &&
        serverVersion !== 'unknown' &&
        serverVersion !== bundle;

    return (
        <p className="mt-3 text-[10px] leading-4 text-neutral-600 sm:text-[11px]">
            <span title="브라우저가 들고 있는 SPA 번들 버전">앱 {bundle}</span>
            {typeof serverVersion === 'string' && (
                <>
                    <span className="mx-1.5 text-neutral-700">·</span>
                    <span title="서버 컨테이너의 이미지 태그">서버 {serverVersion}</span>
                </>
            )}
            {stale && (
                <span className="ml-1.5 text-amber-500" role="status">
                    (새로고침 필요 — 옛 번들이 캐시돼 있습니다)
                </span>
            )}
        </p>
    );
}
