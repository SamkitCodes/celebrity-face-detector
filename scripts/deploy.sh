#!/usr/bin/env bash
# Deploys (or updates) every stack, builds the API bundle and the React site.
# Usage: ALERT_EMAIL=you@example.com ./scripts/deploy.sh
source "$(dirname "$0")/common.sh"

ALERT_EMAIL="${ALERT_EMAIL:-}"
[[ "$ALERT_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] \
  || die "Set ALERT_EMAIL to your email (budget alerts + SES sender/recipient)"
for tool in aws node npm curl tar shasum; do need "$tool"; done

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)" \
  || die "AWS CLI is not authenticated. Run 'aws configure sso' or 'aws sso login'."
log "Account $ACCOUNT, region $AWS_REGION, project $PROJECT"
mkdir -p "$BUILD"

# ---------- 1-4: foundation stacks ----------
deploy bootstrap "$ROOT/infra/00-bootstrap.yaml" AlertEmail="$ALERT_EMAIL"
ARTIFACTS="$(output "$PROJECT-bootstrap" ArtifactsBucketName)"

deploy network "$ROOT/infra/01-network.yaml"

# Keep the current CORS origin on re-deploys; first deploy uses localhost.
ORIGIN="http://localhost:5173"
if stack_exists "$PROJECT-edge"; then ORIGIN="$(output "$PROJECT-edge" SiteUrl)"; fi
deploy data "$ROOT/infra/02-data.yaml" AllowedOrigin="$ORIGIN"

deploy auth "$ROOT/infra/03-auth.yaml"
USER_POOL_ID="$(output "$PROJECT-auth" UserPoolId)"
CLIENT_ID="$(output "$PROJECT-auth" WebClientId)"

# ---------- 5: processing (Lambda code packaged to S3) ----------
log "Packaging Lambda"
aws cloudformation package \
  --template-file "$ROOT/infra/04-processing.yaml" \
  --s3-bucket "$ARTIFACTS" --s3-prefix lambda \
  --output-template-file "$BUILD/04-processing.packaged.yaml" >/dev/null
deploy processing "$BUILD/04-processing.packaged.yaml" SenderEmail="$ALERT_EMAIL"

# ---------- 6: API bundle (Node runtime + app + Cognito JWKS) ----------
# The instance has no internet access, so everything it needs ships in one tarball.
log "Building API bundle"
JWKS="$BUILD/jwks.json"
curl -fsS "https://cognito-idp.$AWS_REGION.amazonaws.com/$USER_POOL_ID/.well-known/jwks.json" -o "$JWKS"

NODE_INDEX="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
curl -fsS "$NODE_INDEX/SHASUMS256.txt" -o "$BUILD/SHASUMS256.txt"
NODE_TARBALL="$(grep -E 'node-v[0-9.]+-linux-arm64\.tar\.gz$' "$BUILD/SHASUMS256.txt" | awk '{print $2}')"
[ -n "$NODE_TARBALL" ] || die "Could not find a linux-arm64 Node.js build"

BUNDLE_HASH="$( (cd "$ROOT/api" && find src package.json package-lock.json -type f | sort | xargs cat; \
  echo "$NODE_TARBALL"; cat "$JWKS") | shasum -a 256 | cut -c1-16)"
BUNDLE_KEY="app/api-$BUNDLE_HASH.tar.gz"

if aws s3api head-object --bucket "$ARTIFACTS" --key "$BUNDLE_KEY" >/dev/null 2>&1; then
  log "Bundle $BUNDLE_KEY already uploaded"
else
  STAGE="$BUILD/bundle"
  rm -rf "$STAGE" && mkdir -p "$STAGE/node" "$STAGE/app"
  if [ ! -f "$BUILD/$NODE_TARBALL" ]; then
    curl -fsS "$NODE_INDEX/$NODE_TARBALL" -o "$BUILD/$NODE_TARBALL"
  fi
  # Verify the Node.js download against the official checksum list.
  (cd "$BUILD" && grep " $NODE_TARBALL\$" SHASUMS256.txt | shasum -a 256 -c -) || die "Node.js checksum mismatch"
  tar -xzf "$BUILD/$NODE_TARBALL" -C "$STAGE/node" --strip-components=1
  rm -rf "$STAGE/node/include" "$STAGE/node/share"

  cp -R "$ROOT/api/src" "$ROOT/api/package.json" "$ROOT/api/package-lock.json" "$STAGE/app/"
  cp "$JWKS" "$STAGE/app/jwks.json"
  # Pure-JS dependencies, so installing on macOS is fine for Linux arm64.
  (cd "$STAGE/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent)

  COPYFILE_DISABLE=1 tar -czf "$BUILD/api-bundle.tar.gz" -C "$STAGE" node app
  aws s3 cp "$BUILD/api-bundle.tar.gz" "s3://$ARTIFACTS/$BUNDLE_KEY" --only-show-errors
fi

prefix_list() {
  aws ec2 describe-managed-prefix-lists --filters "Name=prefix-list-name,Values=$1" \
    --query 'PrefixLists[0].PrefixListId' --output text
}
CF_PL="$(prefix_list com.amazonaws.global.cloudfront.origin-facing)"
S3_PL="$(prefix_list "com.amazonaws.$AWS_REGION.s3")"
DDB_PL="$(prefix_list "com.amazonaws.$AWS_REGION.dynamodb")"

deploy app "$ROOT/infra/05-app.yaml" \
  AppBundleKey="$BUNDLE_KEY" \
  CloudFrontPrefixListId="$CF_PL" S3PrefixListId="$S3_PL" DynamoDbPrefixListId="$DDB_PL"

# ---------- 7: CloudFront (can take 5-15 minutes the first time) ----------
deploy edge "$ROOT/infra/06-edge.yaml" \
  InstanceArn="$(output "$PROJECT-app" InstanceArn)" \
  InstancePrivateDnsName="$(output "$PROJECT-app" InstancePrivateDnsName)"
SITE_URL="$(output "$PROJECT-edge" SiteUrl)"

# Allow the browser to POST uploads to S3 from the real site origin.
if [ "$ORIGIN" != "$SITE_URL" ]; then
  deploy data "$ROOT/infra/02-data.yaml" AllowedOrigin="$SITE_URL"
fi

# ---------- 8: React site ----------
log "Building and uploading the website"
(cd "$ROOT/web" && npm ci --no-audit --no-fund --silent \
  && VITE_USER_POOL_ID="$USER_POOL_ID" VITE_CLIENT_ID="$CLIENT_ID" npm run build --silent)
WEB_BUCKET="$(output "$PROJECT-edge" WebBucketName)"
# Hashed assets can be cached for a year; index.html must always be revalidated.
aws s3 sync "$ROOT/web/dist" "s3://$WEB_BUCKET" --delete --only-show-errors \
  --exclude index.html --cache-control "public,max-age=31536000,immutable"
aws s3 cp "$ROOT/web/dist/index.html" "s3://$WEB_BUCKET/index.html" --only-show-errors \
  --cache-control "no-cache" --content-type "text/html; charset=utf-8"
aws cloudfront create-invalidation --distribution-id "$(output "$PROJECT-edge" DistributionId)" \
  --paths /index.html >/dev/null

log "Done: $SITE_URL"
cat <<EOF
Next:
  1. Click the SES verification link sent to $ALERT_EMAIL (needed for result emails).
  2. Confirm the AWS Budgets alert subscription if asked.
  3. Health check:  curl $SITE_URL/api/health
  4. Save money when idle:  ./scripts/pause.sh   (or ./scripts/destroy.sh)
EOF
