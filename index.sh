#!/usr/bin/env bash
# present script directory
psd() {
  z="${BASH_SOURCE[0]}"
  if [ -h "$z" ]; then z="$(readlink "$z")"; fi
  cd "$(dirname "$0")" && cd "$(dirname "$z")" && pwd
}


# run command
dp0="$(psd)/"
node "$dp0." "$@"
