import type { Db } from '../../lib/db/index.js';
import { getConfigValue } from '../../lib/db/queries.js';
import { DEFAULT_DIGEST_HOUR, parseDigestHour } from '../../lib/notification/quiet-hours.js';

/**
 * 아침 다이제스트 시각(KST, `config.digest_hour_kst`). 메일을 보내는 모든 경로(dispatcher)와
 * digest 크론이 **같은 값**을 읽어야 한다 — 어긋나면 다이제스트가 이미 지나간 뒤에 큐에 쌓인
 * 메일이 다음 날까지 묶인다. 조회 실패는 기본값(10시)이다: 알림 시각 때문에 크론이 죽으면 안 된다.
 */
export async function readDigestHour(db: Db): Promise<number> {
    try {
        return parseDigestHour(await getConfigValue<number>(db, 'digest_hour_kst'));
    } catch {
        return DEFAULT_DIGEST_HOUR;
    }
}
