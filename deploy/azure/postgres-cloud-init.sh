#!/bin/bash
# First-boot setup of the PostgreSQL host (deploy/azure/foundation.bicep). Runs once as root.
# The image is the repository's Dockerfile.postgres (PostgreSQL 17, pgvector, Apache AGE),
# pulled from the deployment's registry with the machine's managed identity. Credentials and
# the server certificate come from the key vault at boot; nothing secret is in this script.
set -euo pipefail
IMAGE='__IMAGE__'
REGISTRY='__REGISTRY__'
VAULT='__VAULT_URI__'
IDENTITY='__IDENTITY_CLIENT_ID__'
DATA=/var/lib/integralflow-postgres
SECRETS=/etc/integralflow-postgres

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends docker.io jq curl ca-certificates

# The data disk is the only disk at LUN 0 on the data-disk controller.
DISK=/dev/disk/azure/scsi1/lun0
for attempt in $(seq 1 60); do [ -e "$DISK" ] && break; sleep 5; done
[ -e "$DISK" ] || { echo 'data disk not attached' >&2; exit 1; }
if ! blkid "$DISK" >/dev/null 2>&1; then mkfs.ext4 -L integralflow-pg "$DISK"; fi
mkdir -p "$DATA"
grep -q 'LABEL=integralflow-pg' /etc/fstab || echo "LABEL=integralflow-pg $DATA ext4 defaults,nofail 0 2" >> /etc/fstab
mountpoint -q "$DATA" || mount "$DATA"
mkdir -p "$DATA/pgdata"

token() {
  curl -fsS -H 'Metadata: true' --max-time 20 \
    "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&client_id=$IDENTITY&resource=$1" | jq -r .access_token
}
# Role assignments can take a few minutes to apply to a new identity.
secret() {
  for attempt in $(seq 1 40); do
    if value=$(curl -fsS --max-time 20 -H "Authorization: Bearer $(token https://vault.azure.net)" "${VAULT}secrets/$1?api-version=7.4" | jq -er .value); then printf '%s' "$value"; return 0; fi
    sleep 15
  done
  echo "secret $1 unavailable" >&2; return 1
}
umask 077
mkdir -p "$SECRETS/initdb"
secret postgres-migrator-password > "$SECRETS/password"
secret postgres-server-cert > "$SECRETS/server.crt"
secret postgres-server-key > "$SECRETS/server.key"
cat > "$SECRETS/initdb/10-databases.sql" <<'SQL'
create database integralflow_control;
create database integralflow_case;
create database integralflow_context;
SQL
# The image runs as the postgres user (UID 999), which must own its data and key files.
chown -R 999:999 "$DATA/pgdata" "$SECRETS"
chmod 0755 "$SECRETS" "$SECRETS/initdb"
chmod 0644 "$SECRETS/initdb/10-databases.sql" "$SECRETS/server.crt"
chmod 0600 "$SECRETS/password" "$SECRETS/server.key"

pull() {
  refresh=$(curl -fsS --max-time 30 "https://$REGISTRY/oauth2/exchange" \
    --data-urlencode grant_type=access_token --data-urlencode "service=$REGISTRY" \
    --data-urlencode "access_token=$(token https://management.azure.com/)" | jq -er .refresh_token) || return 1
  printf '%s' "$refresh" | docker login "$REGISTRY" --username 00000000-0000-0000-0000-000000000000 --password-stdin >/dev/null || return 1
  docker pull "$IMAGE"
}
systemctl enable --now docker
for attempt in $(seq 1 40); do pull && break; sleep 15; done
docker image inspect "$IMAGE" >/dev/null
docker logout "$REGISTRY" >/dev/null 2>&1 || true

docker rm -f integralflow-postgres >/dev/null 2>&1 || true
docker run -d --name integralflow-postgres --restart unless-stopped \
  -p 5432:5432 --shm-size 1g \
  -e POSTGRES_USER=migration_operator -e POSTGRES_PASSWORD_FILE=/run/pg/password -e POSTGRES_DB=postgres \
  -e PGDATA=/var/lib/postgresql/data/pgdata \
  -v "$DATA:/var/lib/postgresql/data" -v "$SECRETS:/run/pg:ro" -v "$SECRETS/initdb:/docker-entrypoint-initdb.d:ro" \
  "$IMAGE" \
  -c ssl=on -c ssl_cert_file=/run/pg/server.crt -c ssl_key_file=/run/pg/server.key \
  -c ssl_min_protocol_version=TLSv1.2 -c max_connections=300 -c password_encryption=scram-sha-256
