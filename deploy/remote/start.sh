#!/usr/bin/env bash
# ExecStart of the silkroad user service: the server of the current release on the repo's pinned Node
# (recorded by install.sh prepare), run as the service's main process so SIGTERM reaches it directly
# and it saves every position before exiting.
set -euo pipefail
REL=$(readlink -f "$HOME/silkroad/current")
# shellcheck disable=SC1091
. "$REL/.deploy-env"
export PATH
cd "$REL/apps/server"
exec "$NODE_BIN" --import tsx src/main.ts
