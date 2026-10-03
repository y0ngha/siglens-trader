import type { PoolConfig } from 'pg';

/**
 * `DATABASE_URL` → `pg` Pool 옵션.
 *
 * `pg`(8.x, pg-connection-string 2.x)의 TLS 동작은 URL에 무엇이 적혀 있느냐에 따라 갈린다.
 * - `sslmode`가 **없으면** TLS 자체를 켜지 않는다(평문). RDS는 `rds.force_ssl=1`이 기본이라 접속이 거부되고,
 *   Neon에서도 평문 접속이 되는 설정이면 조용히 무방비가 된다.
 * - `sslmode=require|prefer|verify-ca`는 **`verify-full`의 별칭**으로 처리된다(인증서 + 호스트명 검증).
 *   libpq 의미가 아니라서 "require = 암호화만"이라 믿고 쓰면 오해가 생기고, 매 프로세스마다
 *   `SECURITY WARNING` 경고가 출력된다. v3.0.0에서는 libpq 의미(검증 없음)로 바뀐다고 예고돼 있다.
 * - URL의 ssl 관련 값은 `config.ssl`보다 **우선**한다(`Object.assign({}, config, parse(url))`).
 *
 * 그래서 원격 호스트는 URL의 `sslmode` 계열을 걷어내고 `ssl: { rejectUnauthorized: true }`를 명시한다.
 * 어떤 URL 표기를 받아도 결과가 "검증하는 TLS"로 같고, 주의 문구도 뜨지 않으며, 버전이 올라도 의미가 안 바뀐다.
 * 검증용 CA는 Node 기본 루트 저장소 + `NODE_EXTRA_CA_CERTS`(RDS는 Dockerfile이 번들을 깔아 둔다)다.
 *
 * 로컬 호스트는 URL을 **그대로** 둔다 — `sslmode`도 pg 기본 해석을 따른다. SSM 터널(`localhost:6543` → RDS)로
 * 붙을 때 RDS 인증서는 호스트명 `localhost`와 맞지 않으므로 `sslmode=require`(= verify-full)는 실패한다.
 * 그 경우 URL에 `sslmode=no-verify`를 쓴다(암호화는 하되 검증 안 함). `sslmode=disable`은 RDS force_ssl이 거부한다.
 *
 * `channel_binding`은 건드리지 않는다. Neon 콘솔 URL에 붙어 있지만 pg는 시작 파라미터를 화이트리스트로만 보내고
 * (user/database/application_name/…) 이 키는 거기 없어 서버에 전달되지 않는다. 채널 바인딩은 클라이언트 옵션
 * `enableChannelBinding`을 켜야만 쓰이며 기본은 꺼짐(SCRAM-SHA-256)이다 — URL에 있어도 접속에 영향이 없다.
 */

/** 로컬 호스트는 URL을 그대로 쓴다(개발·CI의 docker Postgres는 TLS가 없다). */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** 원격 호스트에서 URL로 TLS 정책을 바꾸지 못하게 걷어낼 쿼리 키. */
const SSL_QUERY_KEYS = new Set(['ssl', 'sslmode', 'sslnegotiation', 'uselibpqcompat']);

/** TLS를 끄거나 검증을 건너뛰는 sslmode — 원격 호스트에서는 거부한다. */
const INSECURE_SSLMODES = new Set(['disable', 'no-verify']);

function hostnameOf(url: string): string | null {
    try {
        const raw = new URL(url).hostname.replace(/^\[(.+)\]$/, '$1');
        // `postgres://%2Fvar%2Frun%2Fpostgresql/db` — 소켓 경로를 호스트 자리에 인코딩한 표기.
        return decodeURIComponent(raw).toLowerCase();
    } catch {
        // 파싱 실패는 안전한 쪽(원격 취급 → TLS 강제)으로 기운다.
        return null;
    }
}

/** pg-connection-string은 이 쿼리 키 값을 URL 호스트보다 **우선**해 접속 대상으로 쓴다. */
const HOST_QUERY_KEYS = new Set(['host', 'hostaddr']);

/** 로컬 호스트이거나 유닉스 소켓 경로(`/…`)면 네트워크를 타지 않는다. */
function isLocalHost(host: string): boolean {
    return LOCAL_HOSTS.has(host) || host.startsWith('/');
}

/** URL 호스트 + `host`/`hostaddr` 쿼리 값(쉼표 구분 목록 포함). 비어 있는 항목은 뺀다. */
function effectiveHosts(url: string): string[] | null {
    const urlHost = hostnameOf(url);
    if (urlHost === null) return null;

    const hosts = urlHost === '' ? [] : [urlHost];
    const qIndex = url.indexOf('?');
    if (qIndex !== -1) {
        for (const pair of url.slice(qIndex + 1).split('&')) {
            if (pair === '' || !HOST_QUERY_KEYS.has(queryKey(pair))) continue;
            for (const value of queryValue(pair).split(',')) {
                if (value !== '') hosts.push(value);
            }
        }
    }
    return hosts;
}

/**
 * 접속 대상이 **전부** 로컬 호스트/소켓일 때만 로컬이다. URL 호스트가 `localhost`여도
 * `?host=x.rds.amazonaws.com`이 붙으면 pg는 쿼리 값으로 접속하므로 원격으로 본다.
 * 호스트가 하나도 없으면(`postgres:///db`) pg 기본값(로컬 소켓/localhost)이다.
 */
export function isLocalDatabaseUrl(url: string): boolean {
    const hosts = effectiveHosts(url);
    return hosts !== null && hosts.every(isLocalHost);
}

function queryKey(pair: string): string {
    const raw = pair.split('=')[0];
    try {
        return decodeURIComponent(raw).toLowerCase();
    } catch {
        return raw.toLowerCase();
    }
}

function queryValue(pair: string): string {
    const raw = pair.slice(pair.indexOf('=') + 1);
    try {
        return decodeURIComponent(raw).toLowerCase();
    } catch {
        return raw.toLowerCase();
    }
}

/**
 * 쿼리 문자열만 문자열 연산으로 걸러낸다 — `URL`로 재직렬화하면 비밀번호의 퍼센트 인코딩이 달라질 수 있다.
 * 반환: 걸러낸 URL과, 걸러낸 쿼리 항목 중 안전하지 않은 sslmode 값.
 */
function stripSslQuery(url: string): { url: string; insecureMode: string | null } {
    const qIndex = url.indexOf('?');
    if (qIndex === -1) return { url, insecureMode: null };

    const base = url.slice(0, qIndex);
    const pairs = url.slice(qIndex + 1).split('&');
    const kept: string[] = [];
    let insecureMode: string | null = null;

    for (const pair of pairs) {
        if (pair === '') continue;
        const key = queryKey(pair);
        if (!SSL_QUERY_KEYS.has(key)) {
            kept.push(pair);
            continue;
        }
        if (key === 'sslmode' && INSECURE_SSLMODES.has(queryValue(pair))) {
            insecureMode = queryValue(pair);
        }
    }
    return { url: kept.length > 0 ? `${base}?${kept.join('&')}` : base, insecureMode };
}

/**
 * 풀 공통 하드닝 — 로컬·원격 모두, 앱 서버와 CLI 스크립트 모두 쓴다.
 * - `connectionTimeoutMillis`: 기본값은 무제한이다. private RDS의 failover·보안 그룹 변경으로 SYN이 응답 없이
 *   버려지면 연결 시도가 OS TCP 타임아웃(분 단위)까지 걸려 풀 슬롯을 붙잡는다. 10초 안에 실패시켜 슬롯을 돌려받는다.
 *   pg-pool은 연결 시도와 "풀이 가득 차 빈 슬롯을 기다리는 시간"에 같은 한도를 쓴다(따로 둘 수 없다).
 *   풀 10개가 10초 넘게 전부 잡혀 있는 경우는 사실상 DB 정지·불통뿐이라, 무한 대기(크론 Redis 락을 쥔 채
 *   멈춤) 대신 10초 뒤 실패시키는 편이 안전하다. 단 쿼리 자체의 실행 시간은 이 한도가 묶지 않는다.
 * - `keepAlive` + `keepAliveInitialDelayMillis`: 오래 체크아웃된 연결이 NAT/방화벽·failover로 조용히 죽은 것을
 *   30초 뒤부터 감지한다. 지연을 주지 않으면 OS 기본값(Linux 7200초)이라 사실상 효과가 없다.
 *   (유휴 연결은 pg-pool 기본 idleTimeoutMillis 10초로 먼저 정리된다.)
 */
const POOL_HARDENING = {
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 30_000,
} as const;

export function buildPoolConfig(url: string): PoolConfig {
    if (isLocalDatabaseUrl(url)) return { connectionString: url, ...POOL_HARDENING };

    const { url: stripped, insecureMode } = stripSslQuery(url);
    if (insecureMode) {
        throw new Error(
            `DATABASE_URL: sslmode=${insecureMode} is not allowed for a non-local host (TLS with certificate verification is always used)`,
        );
    }
    return { connectionString: stripped, ssl: { rejectUnauthorized: true }, ...POOL_HARDENING };
}
