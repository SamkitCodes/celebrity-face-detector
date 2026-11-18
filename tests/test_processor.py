"""Unit tests for the processor Lambda using in-memory fakes (no AWS calls).

Run: python -m pytest tests/
"""

import io
import os
import sys

import pytest
from botocore.exceptions import ClientError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lambda", "processor"))
import handler  # noqa: E402

SUB = "11111111-2222-3333-4444-555555555555"
JOB = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
KEY = f"uploads/{SUB}/{JOB}.jpg"
ITEM_KEY = {"PK": f"USER#{SUB}", "SK": f"JOB#{JOB}"}


class FakeTable:
    def __init__(self, item):
        self.items = {(item["PK"], item["SK"]): item} if item else {}
        self.updates = []

    def get_item(self, Key):
        item = self.items.get((Key["PK"], Key["SK"]))
        return {"Item": dict(item)} if item else {}

    def update_item(self, Key, UpdateExpression, ExpressionAttributeValues, **kw):
        item = self.items[(Key["PK"], Key["SK"])]
        if kw.get("ConditionExpression") == "#s = :pending" and item["status"] != "PENDING":
            raise ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem")
        self.updates.append(ExpressionAttributeValues)
        if ":done" in ExpressionAttributeValues:
            item["status"] = "DONE"
        if ":failed" in ExpressionAttributeValues:
            item["status"] = "FAILED"
            item["errorMessage"] = ExpressionAttributeValues[":m"]
        if ":e" in ExpressionAttributeValues:
            item["emailStatus"] = ExpressionAttributeValues[":e"]


class FakeS3:
    def __init__(self, data):
        self.data = data

    def get_object(self, Bucket, Key, Range):
        return {"Body": io.BytesIO(self.data[:8])}


class FakeRekognition:
    def __init__(self, response=None, error=None):
        self.response, self.error, self.calls = response, error, 0

    def recognize_celebrities(self, Image):
        self.calls += 1
        if self.error:
            raise ClientError({"Error": {"Code": self.error}}, "RecognizeCelebrities")
        return self.response


class FakeCognito:
    def admin_get_user(self, UserPoolId, Username):
        assert Username == SUB
        return {"UserAttributes": [{"Name": "email", "Value": "me@example.com"}]}


class FakeSes:
    def __init__(self):
        self.sent = []

    def send_email(self, **kwargs):
        self.sent.append(kwargs)


REK_RESPONSE = {
    "CelebrityFaces": [
        {"Name": "Jeff Bezos", "Id": "1SK7cR8M", "MatchConfidence": 99.53,
         "Urls": ["www.wikidata.org/wiki/Q312556"],
         "Face": {"BoundingBox": {"Left": 0.1, "Top": 0.2, "Width": 0.3, "Height": 0.4}}},
        {"Name": "Lookalike", "Id": "x", "MatchConfidence": 55.0, "Urls": [],
         "Face": {"BoundingBox": {}}},
    ],
    "UnrecognizedFaces": [{}, {}],
}


def make_deps(job_status="PENDING", send_email=False, data=b"\xff\xd8\xff\xe0rest", rek=None):
    item = {**ITEM_KEY, "status": job_status, "sendEmail": send_email} if job_status else None
    return handler.Deps(
        s3=FakeS3(data),
        rekognition=rek or FakeRekognition(REK_RESPONSE),
        table=FakeTable(item),
        cognito=FakeCognito(),
        ses=FakeSes(),
        env={"TABLE_NAME": "t", "USER_POOL_ID": "pool", "SENDER_EMAIL": "me@example.com",
             "MIN_CONFIDENCE": "80"},
    )


def test_happy_path_filters_low_confidence_and_adds_scheme():
    deps = make_deps()
    assert handler.process_upload("b", KEY, deps) == {"status": "done", "matches": 1}
    saved = deps.table.updates[0]
    assert [c["name"] for c in saved[":c"]] == ["Jeff Bezos"]
    assert saved[":c"][0]["urls"] == ["https://www.wikidata.org/wiki/Q312556"]
    assert saved[":u"] == 2 and saved[":l"] == 1


def test_email_sent_to_cognito_address_when_requested():
    deps = make_deps(send_email=True)
    handler.process_upload("b", KEY, deps)
    assert deps.ses.sent[0]["Destination"] == {"ToAddresses": ["me@example.com"]}
    assert "Jeff Bezos" in deps.ses.sent[0]["Content"]["Simple"]["Subject"]["Data"]
    assert deps.table.items[(ITEM_KEY["PK"], ITEM_KEY["SK"])]["emailStatus"] == "SENT"


def test_no_email_unless_opted_in():
    deps = make_deps(send_email=False)
    handler.process_upload("b", KEY, deps)
    assert deps.ses.sent == []


@pytest.mark.parametrize("key", [
    "uploads/not-a-uuid/x.jpg",
    f"uploads/{SUB}/{JOB}.gif",
    f"other/{SUB}/{JOB}.jpg",
    f"uploads/{SUB}/../{JOB}.jpg",
])
def test_unexpected_keys_are_ignored(key):
    deps = make_deps()
    assert handler.process_upload("b", key, deps)["status"] == "ignored"
    assert deps.rekognition.calls == 0


def test_non_image_bytes_fail_without_calling_rekognition():
    deps = make_deps(data=b"<html>evil</html>")
    assert handler.process_upload("b", KEY, deps)["status"] == "failed"
    assert deps.rekognition.calls == 0


def test_missing_job_is_ignored():
    deps = make_deps(job_status=None)
    assert handler.process_upload("b", KEY, deps)["status"] == "ignored"


def test_duplicate_event_is_idempotent():
    deps = make_deps(job_status="DONE")
    assert handler.process_upload("b", KEY, deps)["status"] == "duplicate"
    assert deps.rekognition.calls == 0


def test_permanent_rekognition_error_marks_failed():
    deps = make_deps(rek=FakeRekognition(error="InvalidImageFormatException"))
    assert handler.process_upload("b", KEY, deps)["status"] == "failed"


def test_transient_rekognition_error_is_raised_for_retry():
    deps = make_deps(rek=FakeRekognition(error="ThrottlingException"))
    with pytest.raises(ClientError):
        handler.process_upload("b", KEY, deps)


def test_build_email_no_matches():
    subject, body = handler.build_email(
        {"celebrities": [], "unrecognizedFaces": 1, "lowConfidenceMatches": 0})
    assert subject == "No celebrities recognized"
    assert "not recognized: 1" in body


def test_email_lookup_falls_back_to_list_users():
    class FallbackCognito:
        def admin_get_user(self, **kw):
            raise ClientError({"Error": {"Code": "UserNotFoundException"}}, "AdminGetUser")

        def list_users(self, UserPoolId, Filter, Limit):
            assert Filter == f'sub = "{SUB}"'
            return {"Users": [{"Attributes": [{"Name": "email", "Value": "alt@example.com"}]}]}

    deps = make_deps(send_email=True)
    deps.cognito = FallbackCognito()
    handler.process_upload("b", KEY, deps)
    assert deps.ses.sent[0]["Destination"] == {"ToAddresses": ["alt@example.com"]}
