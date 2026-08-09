#!/usr/bin/env bash
# One-time infrastructure: ECR repo, security group, log group, alarms, and the single EC2
# instance that runs the app. Idempotent — re-running reconciles instead of duplicating.
#   usage: infra/aws/provision.sh <image-tag>     (tag must already exist in ECR)
source "$(dirname "$0")/lib.sh"
require aws

IMAGE_TAG="${1:?usage: provision.sh <image-tag>}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.small}"
EC2_ROLE="$APP-ec2-role"
SG_NAME="$APP-sg"
LOG_GROUP="/$APP/app"

# ---- ECR ---------------------------------------------------------------------
aws ecr describe-repositories --repository-names "$APP" >/dev/null 2>&1 || {
    aws ecr create-repository --repository-name "$APP" \
        --image-scanning-configuration scanOnPush=true >/dev/null
    log "created ecr repo $APP"
}
aws ecr put-lifecycle-policy --repository-name "$APP" --lifecycle-policy-text \
    '{"rules":[{"rulePriority":1,"description":"keep last 3","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":3},"action":{"type":"expire"}}]}' >/dev/null

# ---- Security group: no inbound at all --------------------------------------
# Ingress arrives through the Cloudflare Tunnel, which is an outbound connection from the
# instance. Nothing needs to reach the box from the internet, so there is no ingress rule
# (and therefore no origin certificate, Elastic IP, or CF IP allowlist to maintain).
VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
SG_ID=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$SG_NAME" \
    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null)
if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
    SG_ID=$(aws ec2 create-security-group --group-name "$SG_NAME" \
        --description "$APP (egress only; ingress via Cloudflare Tunnel)" \
        --vpc-id "$VPC_ID" --query GroupId --output text)
    log "created sg $SG_ID"
fi

# ---- Logs + alarms -----------------------------------------------------------
aws logs create-log-group --log-group-name "$LOG_GROUP" 2>/dev/null || true
aws logs put-retention-policy --log-group-name "$LOG_GROUP" --retention-in-days 14

TOPIC_ARN=$(aws sns create-topic --name "$APP-alerts" --query TopicArn --output text)
[ -n "${ALARM_EMAIL:-}" ] && aws sns subscribe --topic-arn "$TOPIC_ARN" \
    --protocol email --notification-endpoint "$ALARM_EMAIL" >/dev/null

# A cron failure is the failure mode that matters here: the box can be healthy while every
# scheduled run errors out, and this is a trading tool, so that must page.
aws logs put-metric-filter --log-group-name "$LOG_GROUP" \
    --filter-name "$APP-cron-failures" --filter-pattern '"[cron:" "failed"' \
    --metric-transformations "metricName=CronFailures,metricNamespace=$APP,metricValue=1,defaultValue=0" >/dev/null
aws cloudwatch put-metric-alarm --alarm-name "$APP-cron-failures" \
    --metric-name CronFailures --namespace "$APP" --statistic Sum \
    --period 900 --evaluation-periods 1 --threshold 0 \
    --comparison-operator GreaterThanThreshold --treat-missing-data notBreaching \
    --alarm-actions "$TOPIC_ARN"

# ---- Instance ----------------------------------------------------------------
EXISTING=$(instance_id)
if [ -n "$EXISTING" ] && [ "$EXISTING" != "None" ]; then
    log "instance already running: $EXISTING (use deploy.sh to ship a new image)"
    exit 0
fi

# Pin the AMI: resolve AL2023 arm64 once and record it, so a later re-provision reproduces
# the same base image instead of silently drifting to whatever is newest.
AMI_FILE="$(dirname "$0")/.ami"
if [ -f "$AMI_FILE" ]; then
    AMI=$(cat "$AMI_FILE")
else
    AMI=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
        --query Parameter.Value --output text)
    echo "$AMI" >"$AMI_FILE"
fi
log "ami $AMI, type $INSTANCE_TYPE"

USER_DATA=$(mktemp)
sed -e "s|__IMAGE_TAG__|$IMAGE_TAG|g" -e "s|__REGION__|$AWS_REGION|g" \
    "$(dirname "$0")/user-data.sh" >"$USER_DATA"

IID=$(aws ec2 run-instances \
    --image-id "$AMI" --instance-type "$INSTANCE_TYPE" \
    --iam-instance-profile "Name=$EC2_ROLE" \
    --security-group-ids "$SG_ID" \
    --metadata-options "HttpTokens=required,HttpPutResponseHopLimit=2" \
    --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":30,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$APP}]" \
    --user-data "file://$USER_DATA" \
    --query 'Instances[0].InstanceId' --output text)
rm -f "$USER_DATA"

log "launched $IID — boot installs docker/cloudflared, fetches SSM env, pulls $IMAGE_TAG"
log "next: create the Cloudflare Tunnel, put its token in $SSM_PREFIX/TUNNEL_TOKEN, then map auto-trade.siglens.io -> http://localhost:3000"

aws cloudwatch put-metric-alarm --alarm-name "$APP-instance-down" \
    --metric-name StatusCheckFailed --namespace AWS/EC2 --statistic Maximum \
    --dimensions "Name=InstanceId,Value=$IID" \
    --period 300 --evaluation-periods 2 --threshold 0 \
    --comparison-operator GreaterThanThreshold --treat-missing-data breaching \
    --alarm-actions "$TOPIC_ARN"
