#!/usr/bin/env bash
# EC2 boot script: install docker/jq/cloudflared -> fetch env from SSM -> pull image from ECR
# -> run the app and the Cloudflare Tunnel as systemd units.
# `__IMAGE_TAG__` is substituted with the real tag by provision.sh.
set -euxo pipefail
REGION=__REGION__
APP=siglens-trader
IMAGE_TAG=__IMAGE_TAG__

dnf install -y docker jq amazon-cloudwatch-agent
systemctl enable --now docker

# cloudflared is the only ingress: it dials out to Cloudflare, so the instance needs no
# inbound ports, no Elastic IP and no origin certificate.
rpm --import https://pkg.cloudflare.com/cloudflare-main.gpg || true
cat >/etc/yum.repos.d/cloudflared.repo <<'REPO'
[cloudflared]
name=cloudflared
baseurl=https://pkg.cloudflare.com/cloudflared/rpm
enabled=1
gpgcheck=0
REPO
dnf install -y cloudflared

cat >/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<'CWCFG'
{
  "agent": { "metrics_collection_interval": 60, "run_as_user": "root" },
  "metrics": {
    "namespace": "CWAgent",
    "append_dimensions": { "InstanceId": "${aws:InstanceId}" },
    "metrics_collected": {
      "disk": { "measurement": ["used_percent"], "resources": ["/"], "metrics_collection_interval": 60 },
      "mem": { "measurement": ["mem_used_percent"], "metrics_collection_interval": 60 }
    }
  }
}
CWCFG
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
    -a fetch-config -m ec2 -s \
    -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --region "$REGION")
ECR="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"

# /run is tmpfs and is wiped on reboot, so the fetch runs as ExecStartPre on every start
# rather than only at cloud-init time. JSON+jq (not `--output text`) because values may
# contain tabs/newlines that would corrupt a tab-split parse.
cat >/usr/local/bin/${APP}-fetch-env.sh <<FETCH
#!/usr/bin/env bash
set -euo pipefail
mkdir -p /run/$APP
aws ssm get-parameters-by-path --region "$REGION" --path "/$APP/" --with-decryption --output json \
  | jq -r '.Parameters[] | "\(.Name | ltrimstr("/$APP/"))=\(.Value)"' > /run/$APP/env
echo "NODE_ENV=production" >> /run/$APP/env
chmod 600 /run/$APP/env
FETCH
chmod +x /usr/local/bin/${APP}-fetch-env.sh
/usr/local/bin/${APP}-fetch-env.sh

# Image tag is pinned per deploy; deploy.sh rewrites /etc/siglens-trader.image and restarts.
echo "$ECR/$APP:$IMAGE_TAG" >/etc/${APP}.image

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ECR"
docker pull "$(cat /etc/${APP}.image)"

LOG_GROUP="/$APP/app"
aws logs create-log-group --log-group-name "$LOG_GROUP" --region "$REGION" 2>/dev/null || true
INSTANCE_ID=$(cloud-init query instance_id 2>/dev/null || echo unknown)

# Memory ceilings: analysis (LLM calls + bars/indicators) runs in-process since the worker
# was removed, on a 2GiB t4g.small. The Node heap cap sits BELOW the container limit on
# purpose — hitting the heap cap logs "JavaScript heap out of memory", whereas hitting the
# container limit gets the process killed silently by the kernel OOM killer.
cat >/etc/systemd/system/${APP}.service <<UNIT
[Unit]
Description=$APP
After=docker.service
Requires=docker.service
StartLimitIntervalSec=120
StartLimitBurst=5
[Service]
TimeoutStopSec=40
ExecStartPre=/usr/local/bin/${APP}-fetch-env.sh
ExecStartPre=-/usr/bin/docker rm -f $APP
ExecStart=/bin/sh -c '/usr/bin/docker run --rm --name $APP -p 3000:3000 \
  --memory=1.5g --memory-swap=1.5g -e NODE_OPTIONS=--max-old-space-size=1024 \
  --env-file /run/$APP/env --security-opt no-new-privileges:true \
  --log-driver awslogs --log-opt awslogs-region=$REGION --log-opt awslogs-group=$LOG_GROUP \
  --log-opt awslogs-stream=$INSTANCE_ID --log-opt awslogs-create-group=true \
  \$(cat /etc/${APP}.image)'
ExecStop=/usr/bin/docker stop -t 30 $APP
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT

# The tunnel token is stored in SSM alongside the app config.
cat >/etc/systemd/system/cloudflared.service <<TUNNEL
[Unit]
Description=Cloudflare Tunnel
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/bin/sh -c '/usr/bin/cloudflared tunnel --no-autoupdate run --token \$(aws ssm get-parameter --region $REGION --name /$APP/TUNNEL_TOKEN --with-decryption --query Parameter.Value --output text)'
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
TUNNEL

systemctl daemon-reload
systemctl enable --now ${APP}.service
systemctl enable --now cloudflared.service
