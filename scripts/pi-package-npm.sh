#!/usr/bin/env bash
set -euo pipefail

node_build_shell=(
  nix shell
  nixpkgs#nodejs
  nixpkgs#python3
  nixpkgs#gnumake
  nixpkgs#gcc
  nixpkgs#pkg-config
)

plannotator_dir="/home/zshen/.pi/agent/git/github.com/backnotprop/plannotator"
current_dir="$(pwd -P)"
resolved_plannotator_dir="$(readlink -f "$plannotator_dir" 2>/dev/null || printf '%s' "$plannotator_dir")"

if [ "${1-}" = "install" ] && [ "$current_dir" = "$resolved_plannotator_dir" ]; then
  exec "${node_build_shell[@]}" nixpkgs#bun -c sh -c 'bun install && bun run build:pi'
fi

exec "${node_build_shell[@]}" -c npm "$@"
