#!/usr/bin/env bash
set -euo pipefail

plannotator_dir="/home/zshen/.pi/agent/git/github.com/backnotprop/plannotator"
current_dir="$(pwd -P)"
resolved_plannotator_dir="$(readlink -f "$plannotator_dir" 2>/dev/null || printf '%s' "$plannotator_dir")"

if [ "${1-}" = "install" ] && [ "$current_dir" = "$resolved_plannotator_dir" ]; then
  exec nix shell nixpkgs#bun nixpkgs#nodejs -c sh -c 'bun install && bun run build:pi'
fi

exec nix shell nixpkgs#nodejs -c npm "$@"
