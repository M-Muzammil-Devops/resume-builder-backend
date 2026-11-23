#!/usr/bin/env bash
# Fast staging update: git pull --ff-only both repos, then rebuild / restart only what changed.
# Same as: bash deploy/deploy.sh --pull
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy.sh" --pull "$@"