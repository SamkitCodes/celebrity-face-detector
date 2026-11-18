#!/usr/bin/env bash
# Stops (pause) or starts (resume) the API instance. While stopped you pay only
# for the 8 GB EBS volume (cents per month); the site loads but /api returns errors.
# Usage: ./scripts/pause.sh          -> stop
#        ./scripts/pause.sh resume   -> start
source "$(dirname "$0")/common.sh"
need aws
ID="$(output "$PROJECT-app" InstanceId)"

if [ "${1:-}" = "resume" ]; then
  log "Starting $ID"
  aws ec2 start-instances --instance-ids "$ID" >/dev/null
  aws ec2 wait instance-running --instance-ids "$ID"
else
  log "Stopping $ID"
  aws ec2 stop-instances --instance-ids "$ID" >/dev/null
  aws ec2 wait instance-stopped --instance-ids "$ID"
fi
aws ec2 describe-instances --instance-ids "$ID" --query 'Reservations[0].Instances[0].State.Name' --output text
