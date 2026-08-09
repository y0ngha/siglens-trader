#!/usr/bin/env bash
set -euo pipefail

APP=siglens-trader
AWS_REGION="${AWS_REGION:-ap-northeast-2}"
SSM_PREFIX="/$APP"
export AWS_REGION

log() { echo "[infra] $*"; }
require() { command -v "$1" >/dev/null || { echo "need $1"; exit 1; }; }
account_id() { aws sts get-caller-identity --query Account --output text; }
ecr_host() { echo "$(account_id).dkr.ecr.$AWS_REGION.amazonaws.com"; }

# Print the id of the single EC2 instance tagged for this app, or empty if none is running.
instance_id() {
    aws ec2 describe-instances \
        --filters "Name=tag:Name,Values=$APP" "Name=instance-state-name,Values=pending,running" \
        --query 'Reservations[].Instances[].InstanceId' --output text
}
