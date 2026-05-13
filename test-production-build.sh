#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/scripts/shell/test-production-build.sh" "$@"
