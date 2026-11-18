#!/usr/bin/env bash
# Deletes every stack and empties the buckets so nothing keeps billing.
# Usage: ./scripts/destroy.sh            
#        ./scripts/destroy.sh --yes
source "$(dirname "$0")/common.sh"
need aws

if [ "${1:-}" != "--yes" ]; then
  read -r -p "Delete ALL $PROJECT stacks and data in $AWS_REGION? Type the project name to confirm: " answer
  [ "$answer" = "$PROJECT" ] || die "Aborted"
fi

# Removes every object version and delete marker (works for versioned buckets).
empty_bucket() {
  local bucket="$1" tmp
  [ -n "$bucket" ] && [ "$bucket" != "None" ] || return 0
  aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1 || return 0
  log "Emptying s3://$bucket"
  tmp="$(mktemp)"
  for selector in Versions DeleteMarkers; do
    while :; do
      aws s3api list-object-versions --bucket "$bucket" --max-items 1000 --output json \
        --query "{Objects: ${selector}[].{Key:Key,VersionId:VersionId}}" > "$tmp"
      grep -q '"Key"' "$tmp" || break
      aws s3api delete-objects --bucket "$bucket" --delete "file://$tmp" >/dev/null
    done
  done
  rm -f "$tmp"
}

delete_stack() {
  local name="$PROJECT-$1"
  stack_exists "$name" || return 0
  log "Deleting stack $name"
  aws cloudformation delete-stack --stack-name "$name"
  aws cloudformation wait stack-delete-complete --stack-name "$name"
}

if stack_exists "$PROJECT-edge"; then empty_bucket "$(output "$PROJECT-edge" WebBucketName)"; fi
delete_stack edge        
delete_stack app
delete_stack processing
delete_stack auth
if stack_exists "$PROJECT-data"; then empty_bucket "$(output "$PROJECT-data" UploadsBucketName)"; fi
delete_stack data
delete_stack network
if stack_exists "$PROJECT-bootstrap"; then empty_bucket "$(output "$PROJECT-bootstrap" ArtifactsBucketName)"; fi
delete_stack bootstrap

log "All $PROJECT stacks deleted."
echo "Double-check the Billing console tomorrow; costs appear with a delay."
