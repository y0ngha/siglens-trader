#!/usr/bin/env bash
# One-time IAM setup: the EC2 instance role (read secrets, pull images, ship logs, accept
# SSM commands) and the GitHub Actions OIDC deploy role (push images, send deploy commands).
# Idempotent — safe to re-run.
source "$(dirname "$0")/lib.sh"
require aws

ACCOUNT=$(account_id)
EC2_ROLE="$APP-ec2-role"
CI_ROLE="$APP-ci-deploy"
GH_REPO="${GH_REPO:-y0ngha/siglens-trader}"

log "account $ACCOUNT, region $AWS_REGION"

# ---- EC2 instance role -------------------------------------------------------
aws iam get-role --role-name "$EC2_ROLE" >/dev/null 2>&1 || aws iam create-role \
    --role-name "$EC2_ROLE" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null

# SSM agent (needed so deploy.sh can send the pull+restart command) and ECR pull.
aws iam attach-role-policy --role-name "$EC2_ROLE" \
    --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam attach-role-policy --role-name "$EC2_ROLE" \
    --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly

# Secrets are SecureString, so the role needs both SSM read and KMS decrypt. Decrypt is
# scoped to calls made *through* SSM so the role cannot decrypt unrelated ciphertext.
aws iam put-role-policy --role-name "$EC2_ROLE" --policy-name "$APP-runtime" \
    --policy-document "$(
        cat <<JSON
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["ssm:GetParametersByPath","ssm:GetParameters","ssm:GetParameter"],
  "Resource":"arn:aws:ssm:$AWS_REGION:$ACCOUNT:parameter$SSM_PREFIX/*"},
 {"Effect":"Allow","Action":"kms:Decrypt","Resource":"*",
  "Condition":{"StringEquals":{"kms:ViaService":"ssm.$AWS_REGION.amazonaws.com"}}},
 {"Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],
  "Resource":"arn:aws:logs:$AWS_REGION:$ACCOUNT:log-group:/$APP*"}
]}
JSON
    )"

aws iam get-instance-profile --instance-profile-name "$EC2_ROLE" >/dev/null 2>&1 || {
    aws iam create-instance-profile --instance-profile-name "$EC2_ROLE" >/dev/null
    aws iam add-role-to-instance-profile --instance-profile-name "$EC2_ROLE" --role-name "$EC2_ROLE"
}
log "ec2 role ready: $EC2_ROLE"

# ---- GitHub Actions OIDC deploy role ----------------------------------------
OIDC_ARN="arn:aws:iam::$ACCOUNT:oidc-provider/token.actions.githubusercontent.com"
aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" >/dev/null 2>&1 ||
    aws iam create-open-id-connect-provider \
        --url https://token.actions.githubusercontent.com \
        --client-id-list sts.amazonaws.com \
        --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 >/dev/null

# Trust is restricted to tag pushes on this repo — a branch build cannot assume the role.
aws iam get-role --role-name "$CI_ROLE" >/dev/null 2>&1 || aws iam create-role \
    --role-name "$CI_ROLE" \
    --assume-role-policy-document "$(
        cat <<JSON
{"Version":"2012-10-17","Statement":[{
 "Effect":"Allow","Principal":{"Federated":"$OIDC_ARN"},"Action":"sts:AssumeRoleWithWebIdentity",
 "Condition":{"StringEquals":{"token.actions.githubusercontent.com:aud":"sts.amazonaws.com"},
              "StringLike":{"token.actions.githubusercontent.com:sub":"repo:$GH_REPO:ref:refs/tags/v*"}}}]}
JSON
    )" >/dev/null

aws iam put-role-policy --role-name "$CI_ROLE" --policy-name "$APP-deploy" \
    --policy-document "$(
        cat <<JSON
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["ecr:GetAuthorizationToken"],"Resource":"*"},
 {"Effect":"Allow","Action":["ecr:BatchCheckLayerAvailability","ecr:CompleteLayerUpload",
   "ecr:InitiateLayerUpload","ecr:PutImage","ecr:UploadLayerPart","ecr:BatchGetImage"],
  "Resource":"arn:aws:ecr:$AWS_REGION:$ACCOUNT:repository/$APP"},
 {"Effect":"Allow","Action":["ssm:SendCommand"],
  "Resource":["arn:aws:ssm:$AWS_REGION::document/AWS-RunShellScript",
              "arn:aws:ec2:$AWS_REGION:$ACCOUNT:instance/*"]},
 {"Effect":"Allow","Action":["ssm:GetCommandInvocation","ssm:ListCommandInvocations",
   "ec2:DescribeInstances"],"Resource":"*"}
]}
JSON
    )"

log "ci role ready: arn:aws:iam::$ACCOUNT:role/$CI_ROLE"
log "set this as the AWS_DEPLOY_ROLE_ARN GitHub secret"
