import os
import sys
import json
import pytest
import numpy as np
import cv2
from unittest.mock import MagicMock, patch

# Add AI server directory to Python path
AI_SERVER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../src/services/ai-server"))
if AI_SERVER_DIR not in sys.path:
    sys.path.insert(0, AI_SERVER_DIR)

import worker

class TestAiWorker:
    @patch("worker.dynamodb_resource")
    def test_update_job_status(self, mock_dynamodb):
        """Test updating scan job status, result, and error in DynamoDB."""
        mock_table = MagicMock()
        mock_dynamodb.Table.return_value = mock_table

        worker.update_job_status("job-123", "COMPLETED", result={"match": True}, error=None)

        mock_dynamodb.Table.assert_called_with("helpme-scan-jobs")
        assert mock_table.update_item.called
        call_kwargs = mock_table.update_item.call_args[1]
        assert call_kwargs["Key"] == {"job_id": "job-123"}
        assert ":status" in call_kwargs["ExpressionAttributeValues"]
        assert call_kwargs["ExpressionAttributeValues"][":status"] == "COMPLETED"
        assert call_kwargs["ExpressionAttributeValues"][":result"] == {"match": True}

    @patch("worker.dynamodb_resource")
    def test_grant_access_session(self, mock_dynamodb):
        """Test granting a 1-hour emergency access session in DynamoDB."""
        mock_table = MagicMock()
        mock_dynamodb.Table.return_value = mock_table

        worker.grant_access_session("responder-001", "citizen-uuid-002")

        mock_dynamodb.Table.assert_called_with("helpme-access-sessions")
        assert mock_table.put_item.called
        item = mock_table.put_item.call_args[1]["Item"]
        assert item["session_id"] == "responder-001#citizen-uuid-002"
        assert item["responder_id"] == "responder-001"
        assert item["victim_id"] == "citizen-uuid-002"
        assert item["method"] == "FACE"

    @patch("worker.events_client")
    def test_publish_emergency_event(self, mock_events):
        """Test dispatching domain events to EventBridge EMERGENCY_BUS."""
        worker.publish_emergency_event("victim.identified", {
            "actorId": "responder-001",
            "targetId": "citizen-002",
        })

        assert mock_events.put_events.called
        entries = mock_events.put_events.call_args[1]["Entries"]
        assert len(entries) == 1
        assert entries[0]["EventBusName"] == "helpme-emergency-bus"
        assert entries[0]["Source"] == "helpme.ai-service"
        assert entries[0]["DetailType"] == "victim.identified"
        detail_obj = json.loads(entries[0]["Detail"])
        assert detail_obj["actorId"] == "responder-001"

    @patch("worker.s3_client")
    @patch("worker.update_job_status")
    def test_process_s3_image_download_failure(self, mock_update, mock_s3):
        """Test handling S3 download failure gracefully."""
        mock_s3.get_object.side_effect = Exception("NoSuchKey")
        mock_processor = MagicMock()

        worker.process_s3_image(mock_processor, "helpme-avatars", "raw-scans/job-fail.jpg")

        mock_update.assert_any_call("job-fail", "PROCESSING")
        mock_update.assert_any_call("job-fail", "FAILED", error="NoSuchKey")

    @patch("worker.s3_client")
    @patch("worker.update_job_status")
    def test_process_s3_image_face_detection_rejected(self, mock_update, mock_s3):
        """Test handling image rejection when face validation fails."""
        dummy_img = np.zeros((100, 100, 3), dtype=np.uint8)
        _, enc = cv2.imencode(".jpg", dummy_img)
        mock_s3.get_object.return_value = {"Body": MagicMock(read=lambda: enc.tobytes())}

        mock_processor = MagicMock()
        mock_processor.process_image.return_value = (False, "Face tilted too much")

        worker.process_s3_image(mock_processor, "helpme-avatars", "raw-scans/job-tilt.jpg")

        mock_update.assert_any_call("job-tilt", "PROCESSING")
        mock_update.assert_any_call("job-tilt", "FAILED", error="Face tilted too much")

    @patch("worker.get_db_connection")
    @patch("worker.grant_access_session")
    @patch("worker.publish_emergency_event")
    @patch("worker.dynamodb_resource")
    @patch("worker.update_job_status")
    @patch("worker.s3_client")
    def test_process_s3_image_match_found(
        self, mock_s3, mock_update, mock_dynamo, mock_publish, mock_grant, mock_db
    ):
        """Test full successful face search flow when a citizen match is found in DB."""
        # 1. S3 response
        dummy_img = np.zeros((100, 100, 3), dtype=np.uint8)
        _, enc = cv2.imencode(".jpg", dummy_img)
        mock_s3.get_object.return_value = {"Body": MagicMock(read=lambda: enc.tobytes())}

        # 2. Face processor output
        mock_processor = MagicMock()
        dummy_vector = [0.05] * 512
        mock_processor.process_image.return_value = (True, dummy_vector)

        # 3. DynamoDB job metadata
        job_table = MagicMock()
        job_table.get_item.return_value = {"Item": {"job_id": "job-match-1", "responder_id": "resp-99"}}
        mock_dynamo.Table.return_value = job_table

        # 4. Database cursor output
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cursor
        mock_db.return_value = mock_conn

        victim_row = {
            "id": "citizen-123",
            "cognitoId": "sub-123",
            "email": "user@example.com",
            "fullName": "Nguyen Van A",
            "phone": "0901234567",
            "avatarUrl": None,
            "dateOfBirth": "1990-01-01",
            "gender": "MALE",
            "address": "123 Main St",
            "cccdNumber": "001234567890",
            "emergencyContacts": [{"name": "Dad", "phone": "0987654321"}],
            "distance": 0.12,
        }
        med_row = {
            "distinguishingMarks": "Scar on left arm",
            "bloodGroup": "O+",
            "allergies": ["Penicillin"],
            "backgroundDiseases": [],
            "currentMedications": [],
            "notes": "None",
        }
        mock_cursor.fetchone.side_effect = [victim_row, med_row]

        worker.process_s3_image(mock_processor, "helpme-avatars", "raw-scans/job-match-1.jpg")

        mock_grant.assert_called_once_with("resp-99", "citizen-123")
        mock_publish.assert_called_once()
        assert mock_publish.call_args[0][0] == "victim.identified"
        assert mock_publish.call_args[0][1]["targetId"] == "citizen-123"

        # Expected serialized victim dict has distance as string
        expected_victim = dict(victim_row)
        expected_victim["distance"] = "0.12"

        mock_update.assert_any_call(
            "job-match-1",
            "COMPLETED",
            result={
                "matchStatus": "MATCH_FOUND",
                "distance": 0.12,
                "victim": expected_victim,
                "record": med_row,
            },
        )

    @patch("worker.get_db_connection")
    @patch("worker.dynamodb_resource")
    @patch("worker.update_job_status")
    @patch("worker.s3_client")
    def test_process_s3_image_no_match_found(
        self, mock_s3, mock_update, mock_dynamo, mock_db
    ):
        """Test face search flow when no citizen match satisfies distance threshold."""
        dummy_img = np.zeros((100, 100, 3), dtype=np.uint8)
        _, enc = cv2.imencode(".jpg", dummy_img)
        mock_s3.get_object.return_value = {"Body": MagicMock(read=lambda: enc.tobytes())}

        mock_processor = MagicMock()
        mock_processor.process_image.return_value = (True, [0.01] * 512)

        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cursor
        mock_db.return_value = mock_conn
        mock_cursor.fetchone.return_value = None # No DB match

        worker.process_s3_image(mock_processor, "helpme-avatars", "raw-scans/job-nomatch.jpg")

        mock_update.assert_any_call(
            "job-nomatch",
            "COMPLETED",
            result={"matchStatus": "NO_MATCH", "message": "No match found within similarity threshold"},
        )

    @patch("worker.get_db_connection")
    @patch("worker.dynamodb_resource")
    @patch("worker.update_job_status")
    @patch("worker.s3_client")
    def test_process_s3_image_enrollment_flow(
        self, mock_s3, mock_update, mock_dynamo, mock_db
    ):
        """Test enrollment flow (raw-uploads prefix) updating citizen face embedding vector."""
        dummy_img = np.zeros((100, 100, 3), dtype=np.uint8)
        _, enc = cv2.imencode(".jpg", dummy_img)
        mock_s3.get_object.return_value = {"Body": MagicMock(read=lambda: enc.tobytes())}

        mock_processor = MagicMock()
        mock_processor.process_image.return_value = (True, [0.03] * 512)

        job_table = MagicMock()
        job_table.get_item.return_value = {"Item": {"job_id": "job-enroll-1", "citizen_id": "cit-888"}}
        mock_dynamo.Table.return_value = job_table

        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_conn.cursor.return_value.__enter__.return_value = mock_cursor
        mock_db.return_value = mock_conn

        worker.process_s3_image(mock_processor, "helpme-avatars", "raw-uploads/job-enroll-1.jpg")

        assert mock_cursor.execute.called
        assert mock_conn.commit.called
        mock_update.assert_any_call(
            "job-enroll-1",
            "COMPLETED",
            result={"enrolled": True, "citizenId": "cit-888"},
        )
