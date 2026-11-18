#!/usr/bin/env bash
# Debugging without SSH:
#   ./scripts/logs.sh boot     -> EC2 serial console output (bootstrap script)
#   ./scripts/logs.sh lambda   -> tail the processor Lambda logs
#   ./scripts/logs.sh dlq      -> count failed events waiting in the dead-letter queue
source "$(dirname "$0")/common.sh"
need aws

case "${1:-boot}" in
  boot)
    aws ec2 get-console-output --instance-id "$(output "$PROJECT-app" InstanceId)" --latest --output text \
      | grep -E "cfd|error|Error" || echo "(no output yet; console output can lag a few minutes)"
    ;;
  lambda)
    aws logs tail "/aws/lambda/$PROJECT-processor" --since 1h --follow
    ;;
  dlq)
    aws sqs get-queue-attributes --queue-url "$(output "$PROJECT-processing" DeadLetterQueueUrl)" \
      --attribute-names ApproximateNumberOfMessages --query Attributes --output text
    ;;
  *) die "usage: $0 [boot|lambda|dlq]" ;;
esac
