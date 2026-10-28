#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target="$script_dir/.env"

if [ -e "$target" ]; then
  printf '%s\n' "Using existing $target"
  exit 0
fi

command -v openssl >/dev/null 2>&1 || {
  printf '%s\n' "openssl is required to generate local development credentials" >&2
  exit 1
}

umask 077
nats_password=$(openssl rand -hex 24)
postgres_password=$(openssl rand -hex 24)
cat > "$target" <<EOF
NATS_USERNAME=meshmind
NATS_PASSWORD=$nats_password
POSTGRES_USER=meshmind
POSTGRES_PASSWORD=$postgres_password
EOF
chmod 600 "$target"
printf '%s\n' "Created $target with permissions 0600"
printf '%s\n' "Keep this file local; it is ignored by Git."
