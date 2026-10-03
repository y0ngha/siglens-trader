import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 운영 이미지는 RDS 서버 인증서를 검증한다(`connection-config.ts`) — 번들이 이미지에 안 들어가면 RDS 전환 후
 * 앱이 기동은 되지만 DB에 못 붙는다. 번들이 빠지거나(.dockerignore), 경로가 어긋나거나, 내용이 깨지면 여기서 잡는다.
 * 번들을 교체할 때는 아래 해시와 개수를 함께 올린다(docs/DEPLOYMENT.md §1).
 */
const root = process.cwd();
const BUNDLE_PATH = 'certs/rds-global-bundle.pem';
const BUNDLE_SHA256 = 'fe45bbebf92ad3e27a583bbb2ddd1553c521ed4d49af5514dc0a40372ea5395c';
const BUNDLE_CERT_COUNT = 111;

describe('RDS CA bundle', () => {
    const bundle = readFileSync(resolve(root, BUNDLE_PATH));

    it('is the vendored AWS global bundle (checksum + certificate count)', () => {
        expect(createHash('sha256').update(bundle).digest('hex')).toBe(BUNDLE_SHA256);
        expect(bundle.toString('utf8').match(/BEGIN CERTIFICATE/g)).toHaveLength(BUNDLE_CERT_COUNT);
    });

    it('is copied into the runner image and exported through NODE_EXTRA_CA_CERTS', () => {
        const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8');
        const target = '/etc/ssl/certs/rds-global-bundle.pem';
        expect(dockerfile).toMatch(new RegExp(`^COPY --chmod=0644 ${BUNDLE_PATH} ${target}$`, 'm'));
        expect(dockerfile).toContain(`NODE_EXTRA_CA_CERTS=${target}`);
    });

    it('is not excluded from the Docker build context', () => {
        const patterns = readFileSync(resolve(root, '.dockerignore'), 'utf8')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'));
        expect(patterns).not.toContain('certs');
        expect(patterns).not.toContain('certs/');
        expect(patterns).not.toContain('*.pem');
        expect(patterns).not.toContain('**/*.pem');
        expect(patterns).not.toContain(BUNDLE_PATH);
    });
});
