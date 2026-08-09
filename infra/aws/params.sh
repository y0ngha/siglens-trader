#!/usr/bin/env bash
# Load a local env file into SSM Parameter Store as SecureString under /siglens-trader/*.
# The instance fetches these at container start (see user-data.sh).
#   usage: infra/aws/params.sh .env.production
source "$(dirname "$0")/lib.sh"
require aws

SRC="${1:?usage: params.sh <env-file>}"
# DISABLE_AUTH is a local-dev escape hatch and must never reach the instance;
# TUNNEL_TOKEN is consumed by cloudflared, not the app, but lives in the same store.
EXCLUDE='^(VITE_|DISABLE_AUTH$)'

n=0
while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*# || -z "${line// }" ]] && continue
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    val="${BASH_REMATCH[2]}"
    [[ "$key" =~ $EXCLUDE ]] && continue
    # Drop trailing inline comments (".env.example" documents keys that way), then any
    # whitespace they left behind — a secret with a trailing space fails auth in confusing
    # ways. Quoted values are unquoted last, so spaces inside quotes survive.
    val="${val%%[[:space:]]#*}"
    val="${val%"${val##*[![:space:]]}"}"
    val="${val%\"}"; val="${val#\"}"
    val="${val%\'}"; val="${val#\'}"
    [ -z "$val" ] && { log "skip empty $key"; continue; }
    aws ssm put-parameter --name "$SSM_PREFIX/$key" --type SecureString --value "$val" --overwrite >/dev/null
    n=$((n + 1))
done <"$SRC"

log "loaded $n params into $SSM_PREFIX/*"
