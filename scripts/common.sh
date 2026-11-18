#!/usr/bin/env bash
# Shared settings and helpers. Works with macOS's default bash 3.2.
set -euo pipefail

# Personal settings (email, AWS profile) live in .env.local, which git ignores.
_ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.env.local"
# shellcheck disable=SC1090
if [ -f "$_ENV_FILE" ]; then source "$_ENV_FILE"; fi

PROJECT="${PROJECT:-cfd}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC2034  # used by scripts that source this file
BUILD="$ROOT/.build"
NODE_MAJOR="${NODE_MAJOR:-22}"

log()  { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed"; }

stack_exists() {
  aws cloudformation describe-stacks --stack-name "$1" >/dev/null 2>&1
}

# output <stack> <OutputKey>
output() {
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
}

# deploy <stack-suffix> <template> [Key=Value ...]
deploy() {
  local name="$PROJECT-$1" template="$2"
  shift 2
  log "Deploying stack $name"
  aws cloudformation deploy \
    --stack-name "$name" \
    --template-file "$template" \
    --parameter-overrides ProjectName="$PROJECT" "$@" \
    --capabilities CAPABILITY_IAM \
    --tags Project="$PROJECT" \
    --no-fail-on-empty-changeset
}

hash_files() {
  # Content hash of the given files, portable across macOS and Linux.
  cat "$@" | shasum -a 256 | cut -c1-16
}
