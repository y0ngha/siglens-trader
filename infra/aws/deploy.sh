#!/usr/bin/env bash
# Ship an image tag to the running instance: repoint the pinned tag, pull, restart, verify.
# Runs over SSM (no inbound access to the box), so it works from CI and from a laptop.
#   usage: infra/aws/deploy.sh <image-tag>
source "$(dirname "$0")/lib.sh"
require aws

TAG="${1:?usage: deploy.sh <image-tag>}"
IID=$(instance_id)
[ -n "$IID" ] && [ "$IID" != "None" ] || { echo "no running $APP instance"; exit 1; }
IMAGE="$(ecr_host)/$APP:$TAG"
log "deploying $IMAGE to $IID"

# The health check runs on the box (port 3000 is not reachable from anywhere else) and its
# exit status decides the deploy result: a container that pulls but fails to serve is a
# failed deploy, not a successful one.
CMD_ID=$(aws ssm send-command --instance-ids "$IID" \
    --document-name AWS-RunShellScript \
    --comment "deploy $APP:$TAG" \
    --parameters "commands=[
      'set -euo pipefail',
      'aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $(ecr_host)',
      'docker pull $IMAGE',
      'echo $IMAGE > /etc/$APP.image',
      'systemctl restart $APP.service',
      'for i in \$(seq 1 30); do sleep 2; if curl -fsS localhost:3000/api/health >/dev/null; then echo healthy; exit 0; fi; done; echo unhealthy; journalctl -u $APP.service -n 50 --no-pager; exit 1'
    ]" \
    --query Command.CommandId --output text)

log "ssm command $CMD_ID — waiting"
for _ in $(seq 1 60); do
    sleep 5
    STATUS=$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$IID" \
        --query Status --output text 2>/dev/null || echo Pending)
    case "$STATUS" in
    Success)
        log "deployed $TAG"
        exit 0
        ;;
    Failed | Cancelled | TimedOut)
        log "deploy $STATUS"
        aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$IID" \
            --query 'StandardErrorContent' --output text | tail -30
        exit 1
        ;;
    esac
done

log "timed out waiting on $CMD_ID"
exit 1
