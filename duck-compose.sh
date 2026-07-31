#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROMPT="${DUCK_PROMPT:-输入消息}"

if { exec 3<>/dev/tty; } 2>/dev/null; then
  if command -v dialog >/dev/null 2>&1 \
    && [[ "${TERM:-dumb}" != "dumb" ]] \
    && tput clear >/dev/null 2>&1; then
    if ! MESSAGE="$(dialog --title Duck --inputbox "$PROMPT" 8 72 4>&1 1>&3 2>&4 <&3)"; then
      MESSAGE=""
    fi
  else
    printf 'Duck > ' >&3
    IFS= read -r MESSAGE <&3 || true
  fi
  exec 3>&-
else
  exec 3>&- 2>/dev/null || true
  IFS= read -r MESSAGE || true
fi

if [[ -z "${MESSAGE:-}" ]]; then
  exit 0
fi

printf '%s' "$MESSAGE" | "$SCRIPT_DIR/duck-control.sh" reply-stdin >/dev/null 2>&1 || true
