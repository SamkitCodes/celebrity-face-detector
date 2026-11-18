import json
import logging
import os
import re
import time
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError

log = logging.getLogger()
log.setLevel(logging.INFO)

KEY_RE = re.compile(
    r"^uploads/(?P<sub>[0-9a-f-]{36})/(?P<job>[0-9a-f-]{36})\.(?P<ext>jpg|png)$"
)
JPEG_MAGIC = b"\xff\xd8\xff"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

# Rekognition errors caused by the image itself: retrying won't help.
PERMANENT_IMAGE_ERRORS = {
    "InvalidImageFormatException": "Unsupported or corrupt image.",
    "ImageTooLargeException": "Image is too large for Rekognition.",
    "InvalidParameterException": "Image could not be analyzed (too small or invalid).",
    "InvalidS3ObjectException": "Uploaded file could not be read.",
}


class Deps:
    """AWS clients and settings, injectable for unit tests."""

    def __init__(self, s3=None, rekognition=None, table=None, cognito=None, ses=None, env=None):
        env = env if env is not None else os.environ
        self.s3 = s3 or boto3.client("s3")
        self.rekognition = rekognition or boto3.client("rekognition")
        self.table = table or boto3.resource("dynamodb").Table(env["TABLE_NAME"])
        self.cognito = cognito or boto3.client("cognito-idp")
        self.ses = ses or boto3.client("sesv2")
        self.user_pool_id = env["USER_POOL_ID"]
        self.sender = env["SENDER_EMAIL"]
        self.min_confidence = float(env.get("MIN_CONFIDENCE", "80"))


_deps = None


def lambda_handler(event, _context):
    global _deps
    if _deps is None:  # reuse clients across warm invocations
        _deps = Deps()
    detail = event.get("detail", {})
    bucket = detail.get("bucket", {}).get("name")
    key = detail.get("object", {}).get("key")
    if not bucket or not key:
        log.warning(json.dumps({"msg": "event missing bucket/key", "event": event}))
        return {"status": "ignored"}
    return process_upload(bucket, key, _deps)


def process_upload(bucket, key, deps):
    match = KEY_RE.match(key)
    if not match:
        log.warning(json.dumps({"msg": "unexpected key, ignoring", "key": key}))
        return {"status": "ignored"}

    sub, job_id, ext = match["sub"], match["job"], match["ext"]
    item_key = {"PK": f"USER#{sub}", "SK": f"JOB#{job_id}"}

    job = deps.table.get_item(Key=item_key).get("Item")
    if not job:
        # Uploads only happen through API-issued presigned URLs, so this means
        # the job expired or was deleted. Nothing to do.
        log.warning(json.dumps({"msg": "no job for upload", "key": key}))
        return {"status": "ignored"}
    if job.get("status") != "PENDING":
        log.info(json.dumps({"msg": "already processed", "jobId": job_id}))
        return {"status": "duplicate"}

    # Never trust the extension or the declared Content-Type: check the bytes.
    head = deps.s3.get_object(Bucket=bucket, Key=key, Range="bytes=0-7")["Body"].read()
    if not (head.startswith(JPEG_MAGIC) or head.startswith(PNG_MAGIC)):
        _fail(deps, item_key, "File is not a JPEG or PNG image.")
        return {"status": "failed"}

    try:
        response = deps.rekognition.recognize_celebrities(
            Image={"S3Object": {"Bucket": bucket, "Name": key}}
        )
    except ClientError as err:
        code = err.response["Error"]["Code"]
        if code in PERMANENT_IMAGE_ERRORS:
            _fail(deps, item_key, PERMANENT_IMAGE_ERRORS[code])
            return {"status": "failed"}
        raise  # throttling/transient: let Lambda retry, then DLQ

    result = summarize(response, deps.min_confidence)
    try:
        deps.table.update_item(
            Key=item_key,
            UpdateExpression=(
                "SET #s = :done, celebrities = :c, unrecognizedFaces = :u, "
                "lowConfidenceMatches = :l, processedAt = :t"
            ),
            ConditionExpression="#s = :pending",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":done": "DONE",
                ":pending": "PENDING",
                ":c": result["celebrities"],
                ":u": result["unrecognizedFaces"],
                ":l": result["lowConfidenceMatches"],
                ":t": int(time.time()),
            },
        )
    except ClientError as err:
        if err.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return {"status": "duplicate"}
        raise

    log.info(json.dumps({
        "msg": "processed",
        "jobId": job_id,
        "matches": len(result["celebrities"]),
        "unrecognized": int(result["unrecognizedFaces"]),
    }))

    if job.get("sendEmail"):
        _send_email(deps, item_key, sub, result)
    return {"status": "done", "matches": len(result["celebrities"])}


def summarize(response, min_confidence):
    """Convert a Rekognition response into the DynamoDB-friendly result shape."""
    celebrities, low = [], 0
    for face in response.get("CelebrityFaces", []):
        confidence = float(face.get("MatchConfidence", 0))
        if confidence < min_confidence:
            low += 1
            continue
        box = face.get("Face", {}).get("BoundingBox", {})
        celebrities.append({
            "name": face.get("Name", "Unknown"),
            "id": face.get("Id", ""),
            "confidence": _dec(confidence, 1),
            "boundingBox": {k: _dec(box.get(k, 0), 4) for k in ("Left", "Top", "Width", "Height")},
            # Rekognition returns URLs without a scheme, e.g. "www.wikidata.org/wiki/Q1"
            "urls": [u if u.startswith("http") else f"https://{u}" for u in face.get("Urls", [])][:3],
        })
    celebrities.sort(key=lambda c: c["confidence"], reverse=True)
    return {
        "celebrities": celebrities,
        "unrecognizedFaces": len(response.get("UnrecognizedFaces", [])),
        "lowConfidenceMatches": low,
    }


def build_email(result):
    lines = ["Celebrity Face Detector - your results", ""]
    if result["celebrities"]:
        for c in result["celebrities"]:
            lines.append(f"- {c['name']} ({c['confidence']}% confidence)")
    else:
        lines.append("No celebrities were recognized in your photo.")
    if result["unrecognizedFaces"]:
        lines.append(f"\nOther faces detected but not recognized: {result['unrecognizedFaces']}")
    lines.append("\nYour photo is deleted automatically within 24 hours.")
    subject = (
        f"Recognized: {', '.join(c['name'] for c in result['celebrities'][:3])}"
        if result["celebrities"] else "No celebrities recognized"
    )
    return subject, "\n".join(lines)


def _send_email(deps, item_key, sub, result):
    """Email failures must not fail the job; record the outcome instead."""
    status = "SENT"
    try:
        # Recipient comes from Cognito, never from the client request.
        email = _lookup_email(deps, sub)
        subject, body = build_email(result)
        deps.ses.send_email(
            FromEmailAddress=deps.sender,
            Destination={"ToAddresses": [email]},
            Content={"Simple": {
                "Subject": {"Data": subject[:200]},
                "Body": {"Text": {"Data": body}},
            }},
        )
    except (ClientError, StopIteration) as err:
        status = "FAILED"
        log.error(json.dumps({"msg": "email failed", "error": str(err)}))
    deps.table.update_item(
        Key=item_key,
        UpdateExpression="SET emailStatus = :e",
        ExpressionAttributeValues={":e": status},
    )


def _lookup_email(deps, sub):
    # In email-as-username pools the internal username equals `sub`; fall back
    # to a filtered ListUsers in case that ever differs.
    try:
        attrs = deps.cognito.admin_get_user(UserPoolId=deps.user_pool_id, Username=sub)["UserAttributes"]
    except ClientError as err:
        if err.response["Error"]["Code"] != "UserNotFoundException":
            raise
        users = deps.cognito.list_users(
            UserPoolId=deps.user_pool_id, Filter=f'sub = "{sub}"', Limit=1)["Users"]
        if not users:
            raise
        attrs = users[0]["Attributes"]
    return next(a["Value"] for a in attrs if a["Name"] == "email")


def _fail(deps, item_key, message):
    deps.table.update_item(
        Key=item_key,
        UpdateExpression="SET #s = :failed, errorMessage = :m, processedAt = :t",
        ConditionExpression="#s = :pending",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={
            ":failed": "FAILED",
            ":pending": "PENDING",
            ":m": message,
            ":t": int(time.time()),
        },
    )


def _dec(value, places):
    return Decimal(str(round(float(value), places)))
