import os
import json
import time
import logging
import threading
from typing import Optional, Dict, Any
from decimal import Decimal
import numpy as np
import cv2
import boto3
import psycopg2
from psycopg2.extras import RealDictCursor
from regconition_original import FaceProcessor

logger = logging.getLogger("ai-worker")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] [%(name)s] %(message)s")

AWS_REGION = os.getenv("AWS_REGION", "ap-southeast-1")
ENDPOINT_URL = os.getenv("AWS_ENDPOINT_URL") or os.getenv("LOCALSTACK_URL") or "http://localhost:4566"
SQS_ENDPOINT_URL = os.getenv("SQS_ENDPOINT_URL") or os.getenv("AWS_ENDPOINT_URL") or "http://localhost:9324"
DYNAMO_ENDPOINT_URL = os.getenv("DYNAMODB_ENDPOINT") or os.getenv("AWS_ENDPOINT_URL") or "http://localhost:8001"
S3_ENDPOINT_URL = os.getenv("S3_ENDPOINT_URL") or os.getenv("AWS_ENDPOINT_URL") or "http://localhost:4569"

QUEUE_URL = os.getenv("AI_JOBS_QUEUE_URL", "http://localhost:9324/queue/helpme-ai-jobs-queue")
SCAN_JOBS_TABLE = os.getenv("SCAN_JOBS_TABLE", "helpme-scan-jobs")
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:password@localhost:5432/helpme")
EMERGENCY_BUS_NAME = os.getenv("EMERGENCY_BUS_NAME", "helpme-emergency-bus")

# Credentials for local testing
os.environ.setdefault("AWS_ACCESS_KEY_ID", "test")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test")

sqs_client = boto3.client("sqs", region_name=AWS_REGION, endpoint_url=SQS_ENDPOINT_URL)
s3_client = boto3.client("s3", region_name=AWS_REGION, endpoint_url=S3_ENDPOINT_URL)
dynamodb_resource = boto3.resource("dynamodb", region_name=AWS_REGION, endpoint_url=DYNAMO_ENDPOINT_URL)
events_client = boto3.client("events", region_name=AWS_REGION, endpoint_url=ENDPOINT_URL)


def get_db_connection():
    if not DATABASE_URL:
        return None
    try:
        return psycopg2.connect(DATABASE_URL)
    except Exception as e:
        logger.error(f"Failed to connect to PostgreSQL: {e}")
        return None


def _to_dynamo_safe(value: Any) -> Any:
    """
    boto3's DynamoDB resource refuses Python floats ("Float types are not supported. Use Decimal
    types instead") and raises at write time, so a job that matched successfully never leaves
    PROCESSING and the client polls forever. Converting at this boundary covers every call site.
    numpy scalars (pgvector distances arrive as np.float64) are not float subclasses, hence .item().
    """
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, np.generic):
        return _to_dynamo_safe(value.item())
    if isinstance(value, dict):
        return {k: _to_dynamo_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_dynamo_safe(v) for v in value]
    return value


def update_job_status(job_id: str, status: str, result: Optional[Dict[str, Any]] = None, error: Optional[str] = None):
    try:
        table = dynamodb_resource.Table(SCAN_JOBS_TABLE)
        update_expr = "SET #s = :status, updated_at = :now"
        expr_names = {"#s": "status"}
        expr_values: Dict[str, Any] = {
            ":status": status,
            ":now": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }

        if result is not None:
            update_expr += ", #r = :result"
            expr_names["#r"] = "result"
            expr_values[":result"] = _to_dynamo_safe(result)
        if error is not None:
            update_expr += ", #e = :error"
            expr_names["#e"] = "error"
            expr_values[":error"] = error

        table.update_item(
            Key={"job_id": job_id},
            UpdateExpression=update_expr,
            ExpressionAttributeNames=expr_names,
            ExpressionAttributeValues=expr_values,
        )
    except Exception as e:
        logger.error(f"Failed to update job {job_id} in DynamoDB: {e}")


def grant_access_session(responder_id: str, victim_id: str):
    """
    Cấp quyền truy cập 1 giờ, nay ghi vào bảng Postgres `access_sessions` thay vì DynamoDB.

    ON CONFLICT trên cặp (responder, victim) tái hiện đúng khoá ghép `responderId#victimId` của
    bảng cũ: quét lại cùng một người thì gia hạn phiên, không sinh thêm hàng.
    """
    conn = get_db_connection()
    if not conn:
        logger.error("Failed to create access session: no database connection")
        return

    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO access_sessions (responder_id, victim_id, method, granted_at, expires_at)
                VALUES (%s, %s::uuid, 'FACE', NOW(), NOW() + INTERVAL '1 hour')
                ON CONFLICT (responder_id, victim_id)
                DO UPDATE SET expires_at = EXCLUDED.expires_at,
                              granted_at = EXCLUDED.granted_at,
                              method     = EXCLUDED.method
                """,
                (responder_id, victim_id),
            )
        conn.commit()
    except Exception as e:
        logger.error(f"Failed to create access session in Postgres: {e}")
    finally:
        conn.close()


def publish_emergency_event(detail_type: str, detail: Dict[str, Any]):
    try:
        events_client.put_events(
            Entries=[
                {
                    "EventBusName": EMERGENCY_BUS_NAME,
                    "Source": "helpme.ai-service",
                    "DetailType": detail_type,
                    "Detail": json.dumps(detail),
                    "Time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                }
            ]
        )
    except Exception as e:
        logger.error(f"Failed to publish EventBridge event: {e}")


def process_s3_image(processor: FaceProcessor, bucket: str, key: str):
    logger.info(f"Processing image from s3://{bucket}/{key}")

    # Extract Job ID from Key: raw-scans/{jobId}.jpg or raw-uploads/{jobId}.jpg
    filename = key.split("/")[-1]
    job_id = filename.split(".")[0]
    is_enrollment = "raw-uploads" in key

    update_job_status(job_id, "PROCESSING")

    # 1. Download image from S3
    try:
        response = s3_client.get_object(Bucket=bucket, Key=key)
        img_bytes = response["Body"].read()
        nparr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("Failed to decode image from bytes")
    except Exception as e:
        logger.error(f"S3 download or decode failed for {key}: {e}")
        update_job_status(job_id, "FAILED", error=str(e))
        return

    # 2. Run Face Embedding Extraction
    try:
        success, result = processor.process_image(img)
        if not success:
            logger.warning(f"Face processing rejected image for job {job_id}: {result}")
            update_job_status(job_id, "FAILED", error=str(result))
            return
        vector = result # list of 512 floats
    except Exception as e:
        logger.error(f"Inference exception for job {job_id}: {e}")
        update_job_status(job_id, "FAILED", error=str(e))
        return

    # 3. Database Operations with PostgreSQL
    conn = get_db_connection()
    if not conn:
        logger.error("No database connection available")
        update_job_status(job_id, "FAILED", error="Database connection unavailable")
        return

    vector_str = f"[{','.join(map(str, vector))}]"

    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            if is_enrollment:
                # Enrollment flow: update citizen face vector
                # Lookup job metadata to get citizen_id
                job_table = dynamodb_resource.Table(SCAN_JOBS_TABLE)
                job_resp = job_table.get_item(Key={"job_id": job_id})
                citizen_id = job_resp.get("Item", {}).get("citizen_id")

                if citizen_id:
                    cur.execute(
                        "UPDATE citizens SET face_embedding = %s::vector, is_verified = true, updated_at = NOW() WHERE id = %s OR cognito_id = %s",
                        (vector_str, citizen_id, citizen_id),
                    )
                    conn.commit()
                    logger.info(f"Updated face embedding for citizen {citizen_id}")

                update_job_status(job_id, "COMPLETED", result={"enrolled": True, "citizenId": citizen_id})
            else:
                # Face Search Flow (Top 3 Candidates)
                cur.execute(
                    """
                    SELECT id, cognito_id as "cognitoId", email, full_name as "fullName", phone, 
                           avatar_url as "avatarUrl", date_of_birth as "dateOfBirth", gender, address, 
                           cccd_number as "cccdNumber", emergency_contacts as "emergencyContacts",
                           (face_embedding <=> %s::vector) AS distance 
                    FROM citizens 
                    WHERE face_embedding IS NOT NULL AND (face_embedding <=> %s::vector) < 0.35 
                    ORDER BY distance ASC 
                    LIMIT 3
                    """,
                    (vector_str, vector_str),
                )
                matches = cur.fetchall()

                if matches:
                    # Lookup responder_id from Job
                    job_table = dynamodb_resource.Table(SCAN_JOBS_TABLE)
                    job_resp = job_table.get_item(Key={"job_id": job_id})
                    responder_id = job_resp.get("Item", {}).get("responder_id", "system")

                    top_candidates = []
                    for match in matches:
                        m_dist = float(match["distance"])
                        victim_id = match["id"]

                        # Fetch medical record if available
                        cur.execute(
                            """
                            SELECT distinguishing_marks as "distinguishingMarks", blood_group as "bloodGroup", 
                                   allergies, background_diseases as "backgroundDiseases", 
                                   current_medications as "currentMedications", notes 
                            FROM medical_records 
                            WHERE citizen_id = %s
                            """,
                            (victim_id,),
                        )
                        record = cur.fetchone()

                        # Serialize match for DynamoDB
                        match_data = dict(match)
                        if "dateOfBirth" in match_data and match_data["dateOfBirth"]:
                            match_data["dateOfBirth"] = str(match_data["dateOfBirth"])
                        match_data["distance"] = str(m_dist)

                        top_candidates.append({
                            "victim": match_data,
                            "record": dict(record) if record else None,
                            "distance": m_dist,
                        })

                    # Primary (best) match
                    primary = top_candidates[0]
                    primary_victim_id = primary["victim"]["id"]
                    primary_distance = primary["distance"]

                    # Grant 1-hour temporary session for primary match
                    grant_access_session(responder_id, primary_victim_id)

                    # Emit victim.identified Event
                    publish_emergency_event(
                        "victim.identified",
                        {
                            "actorId": responder_id,
                            "responderId": responder_id,
                            "targetId": primary_victim_id,
                            "method": "FACE",
                            # Sự kiện mang theo dữ liệu mà notification-worker cần, để worker đó
                            # không phải truy vấn Postgres (và do đó không cần vào VPC/NAT).
                            "victim": {
                                "fullName": primary["victim"].get("fullName"),
                                "emergencyContacts": primary["victim"].get("emergencyContacts"),
                            },
                            "metadata": {
                                "distance": primary_distance,
                                "jobId": job_id,
                                "totalCandidates": len(top_candidates),
                            },
                        },
                    )

                    update_job_status(
                        job_id,
                        "COMPLETED",
                        result={
                            "matchStatus": "MATCH_FOUND",
                            "matchesCount": len(top_candidates),
                            "distance": primary_distance,
                            "victim": primary["victim"],
                            "record": primary["record"],
                            "topMatches": top_candidates,
                        },
                    )
                    logger.info(
                        f"Match found for job {job_id}: {len(top_candidates)} candidate(s) (best: {primary_victim_id}, distance: {primary_distance:.4f})"
                    )
                else:
                    update_job_status(
                        job_id,
                        "COMPLETED",
                        result={
                            "matchStatus": "NO_MATCH",
                            "matchesCount": 0,
                            "topMatches": [],
                            "message": "No match found within similarity threshold",
                        },
                    )
                    logger.info(f"No match found for job {job_id}")
    except Exception as e:
        logger.error(f"Error during DB operations for job {job_id}: {e}")
        update_job_status(job_id, "FAILED", error=str(e))
    finally:
        conn.close()


def run_sqs_worker(processor: FaceProcessor, stop_event: threading.Event):
    if not QUEUE_URL:
        logger.warning("AI_JOBS_QUEUE_URL not configured; SQS worker idle")
        return

    logger.info(f"Starting SQS worker polling on {QUEUE_URL}")

    while not stop_event.is_set():
        try:
            response = sqs_client.receive_message(
                QueueUrl=QUEUE_URL,
                MaxNumberOfMessages=5,
                WaitTimeSeconds=20,
                VisibilityTimeout=120,
            )

            messages = response.get("Messages", [])
            for msg in messages:
                receipt_handle = msg["ReceiptHandle"]
                body_str = msg.get("Body", "{}")

                try:
                    body = json.loads(body_str)
                    
                    # Check if body is EventBridge S3 Event or direct S3 notification
                    if "detail" in body and "bucket" in body["detail"] and "object" in body["detail"]:
                        bucket = body["detail"]["bucket"]["name"]
                        key = body["detail"]["object"]["key"]
                        process_s3_image(processor, bucket, key)
                    elif "Records" in body:
                        for record in body["Records"]:
                            bucket = record["s3"]["bucket"]["name"]
                            key = record["s3"]["object"]["key"]
                            process_s3_image(processor, bucket, key)
                    else:
                        logger.warning(f"Unrecognized message structure in SQS: {body_str[:200]}")
                except Exception as e:
                    logger.error(f"Failed to process SQS message: {e}")
                finally:
                    try:
                        sqs_client.delete_message(QueueUrl=QUEUE_URL, ReceiptHandle=receipt_handle)
                    except Exception as e:
                        logger.error(f"Failed to delete SQS message: {e}")

        except Exception as e:
            if not stop_event.is_set():
                logger.error(f"Error polling SQS: {e}")
                time.sleep(5)

    logger.info("SQS worker stopped.")