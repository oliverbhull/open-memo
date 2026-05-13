#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/scripts/shell/deploy-production.sh" "$@"
