#!/usr/bin/env zsh
# Shared helpers for vscode_worktrees mise tasks.

set -euo pipefail

# Restore the directory the user invoked `mise run` from.
[[ -n "${MISE_ORIGINAL_CWD:-}" ]] && cd "$MISE_ORIGINAL_CWD"

autoload -U colors && colors 2>/dev/null || true

header() { print -P "%B%F{white}$1%f%b"; }
info()   { print -P "%F{cyan}$1%f"; }
success(){ print -P "%F{green}✓%f $1"; }
warn()   { print -P "%F{yellow}⚠ $1%f" >&2; }
error()  { print -P "%F{red}✗ $1%f" >&2; }
dim()    { print -P "%F{8}$1%f"; }
