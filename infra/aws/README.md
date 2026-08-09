# infra/aws — siglens-trader

단일 EC2 + Cloudflare Tunnel. ALB/ASG 없음 (단일 사용자·CF Access 뒤·대부분 유휴).
설계 근거: [`docs/specs/2026-07-19-vercel-to-aws-migration-design.md`](../../docs/specs/2026-07-19-vercel-to-aws-migration-design.md).

```
Cloudflare (auto-trade.siglens.io, Access) → Tunnel → EC2 t4g.small → Docker :3000
                                                        ├ Hono (SPA + /api)
                                                        └ node-cron ×6
```

## 스크립트

| 스크립트 | 언제 | 하는 일 |
|---|---|---|
| `provision-iam.sh` | 최초 1회 | EC2 인스턴스 롤 + GitHub OIDC 배포 롤 |
| `params.sh <env-file>` | 시크릿 변경 시 | env 파일 → SSM `/siglens-trader/*` (SecureString) |
| `provision.sh <tag>` | 최초 1회 | ECR·SG(인바운드 0)·로그·알람·EC2 기동 |
| `deploy.sh <tag>` | 배포마다 | SSM으로 pull + restart + health 검증 |
| `user-data.sh` | (부팅 시 자동) | docker/cloudflared 설치, SSM env fetch, systemd 유닛 |

## 최초 셋업

```bash
export AWS_REGION=ap-northeast-2
infra/aws/provision-iam.sh                 # 출력된 CI 롤 ARN을 GitHub secret AWS_DEPLOY_ROLE_ARN에 등록
infra/aws/params.sh .env.production        # TUNNEL_TOKEN 포함
# 이미지가 ECR에 최소 1개 있어야 한다 (deploy.yml 태그 푸시 또는 수동 push)
infra/aws/provision.sh 0.11.0
```

Cloudflare Tunnel: Zero Trust → Networks → Tunnels에서 터널 생성 → 토큰을
`params.sh`로 SSM `/siglens-trader/TUNNEL_TOKEN`에 넣고 → public hostname
`auto-trade.siglens.io` → `http://localhost:3000` 매핑. 기존 Access 애플리케이션은 그대로 앞단 인증.

## 운영

```bash
infra/aws/deploy.sh 0.11.1                 # 배포 (CI가 태그 푸시 시 자동 실행)
aws logs tail /siglens-trader/app --follow # 로그
aws ssm start-session --target $(aws ec2 describe-instances \
  --filters Name=tag:Name,Values=siglens-trader Name=instance-state-name,Values=running \
  --query 'Reservations[].Instances[].InstanceId' --output text)   # 접속(SSH 없음)
```

**롤백**: 이전 태그로 `deploy.sh <이전-태그>` (ECR lifecycle이 최근 3개만 보관).

**알람**(SNS `siglens-trader-alerts`): 인스턴스 상태 체크 실패, cron 실패 로그(`[cron:*] failed`).
cron 실패는 박스가 정상이어도 매매가 멈추는 유일한 경로라 별도 알람을 둔다.

## 주의

- 인바운드 규칙 없음 — 포트를 열지 말 것. 외부 노출은 Tunnel이 전담한다.
- 시크릿은 SSM에만. 컨테이너는 부팅/재시작마다 `/run/siglens-trader/env`로 다시 받는다
  (`/run`은 tmpfs라 재부팅 시 사라짐).
- 메모리 상한 2층: 컨테이너 1.5g / Node 힙 1024MB. 힙 상한이 더 낮아야 OOM이
  로그에 남는다(커널 OOM killer는 조용히 죽인다). worker 제거 후 분석이 인프로세스로
  돌기 때문에 필요. 상한에 자주 닿으면 t4g.medium으로 올린다.
- 단일 인스턴스 = SPOF. 인스턴스가 죽으면 cron도 멈춘다(알람으로 감지).
