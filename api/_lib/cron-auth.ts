import crypto from 'node:crypto';

/**
 * `Authorization: Bearer <CRON_SECRET>` 검증.
 *
 * 상수 시간 비교를 쓴다 — 이 헤더 하나가 실주문 트리거 권한이라, 원격 타이밍 공격의
 * 실현성이 낮다는 것과 별개로 문자열 조기 종료 비교를 남길 이유가 없다.
 * `CRON_SECRET` 미설정은 fail-closed(false).
 */
export function verifyCronSecret(req: Request): boolean {
    const secret = process.env.CRON_SECRET;
    if (!secret) return false;
    const auth = req.headers.get('authorization');
    if (!auth) return false;
    const expected = Buffer.from(`Bearer ${secret}`);
    const actual = Buffer.from(auth);
    // timingSafeEqual은 길이가 다르면 던진다. 길이 자체는 비밀이 아니다.
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
}
