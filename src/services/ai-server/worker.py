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

# ─── Local emulator wiring ────────────────────────────────────────────────────
# LOCAL_AWS_EMULATION=true nói rằng AWS ở đây là stack giả lập (ElasticMQ, s3rver, DynamoDB Local,
# serverless-offline EventBridge). Chỉ khi đó mới dùng endpoint localhost và credentials giả.
#
# Trước 2026-08-22 hai thứ này được áp dụng vô điều kiện, và task Fargate đã chết câm vì thế:
# endpoint_url rơi về http://localhost:9324 (chính nó), còn setdefault ghi AWS_ACCESS_KEY_ID=test
# đè lên ECS task role — env var đứng trước container credential provider trong boto3. Task vẫn
# "running", vẫn steady state, chỉ log "Error polling SQS" mỗi 5 giây và không nhận nổi một message.
# Mặc định phải là AWS thật: sai ở local thì lỗi ngay, sai ở cloud thì im lặng hàng giờ.
LOCAL_AWS = os.getenv("LOCAL_AWS_EMULATION", "").strip().lower() in ("1", "true", "yes")


def _endpoint(*env_names: str, local_default: str) -> Optional[str]:
    """Override tường minh thắng; nếu không, dùng emulator khi LOCAL_AWS, còn lại None = AWS thật."""
    for name in env_names:
        value = os.getenv(name)
        if value:
            return value
    return local_default if LOCAL_AWS else None


ENDPOINT_URL = _endpoint("AWS_ENDPOINT_URL", "LOCALSTACK_URL", local_default="http://localhost:4566")
SQS_ENDPOINT_URL = _endpoint("SQS_ENDPOINT_URL", "AWS_ENDPOINT_URL", local_default="http://localhost:9324")
DYNAMO_ENDPOINT_URL = _endpoint("DYNAMODB_ENDPOINT", "AWS_ENDPOINT_URL", local_default="http://localhost:8001")
S3_ENDPOINT_URL = _endpoint("S3_ENDPOINT_URL", "AWS_ENDPOINT_URL", local_default="http://localhost:4569")

QUEUE_URL = os.getenv("AI_JOBS_QUEUE_URL") or (
    "http://localhost:9324/queue/helpme-ai-jobs-queue" if LOCAL_AWS else ""
)
SCAN_JOBS_TABLE = os.getenv("SCAN_JOBS_TABLE", "helpme-scan-jobs")
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:password@localhost:5432/helpme")
EMERGENCY_BUS_NAME = os.getenv("EMERGENCY_BUS_NAME", "helpme-emergency-bus")

if LOCAL_AWS:
    # Emulator nhận key bất kỳ; riêng s3rver chỉ nhận đúng S3RVER/S3RVER — docker-compose set sẵn.
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
        # connect_timeout là bắt buộc, không phải tinh chỉnh. Khi security group chặn 5432 thì gói tin
        # bị drop chứ không bị từ chối, nên psycopg2 treo tới lúc TCP timeout của OS — đo được ~131s.
        # VisibilityTimeout của queue là 120s: message hiện lại trong khi worker vẫn đang giữ nó, và
        # bị phát lại. Một task thì chỉ là xử lý trùng; scale lên là hai task cùng tải một ảnh.
        return psycopg2.connect(DATABASE_URL, connect_timeout=10)
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


# is_complained() bị bỏ ngày 2026-08-23. Nó chỉ kiểm được MỘT người và mở thêm một kết nối riêng,
# nên khi phải kiểm cả 3 ứng viên thì vừa sai vừa tốn. Thay bằng một truy vấn theo lô ngay trong
# nhánh tìm kiếm, dùng lại đúng cursor đang mở: xem `complained_ids` trong process_s3_image().
#
# Khiếu nại là chung cuộc, và nhận diện khuôn mặt cũng là một đường truy cập - không kiểm ở đây thì
# người bị khiếu nại chỉ cần quét mặt là lại thấy bệnh án, dù NFC và QR đều đã bị chặn.


def grant_access_session(
    responder_id: str,
    victim_id: str,
    scan_lat: Optional[str] = None,
    scan_lon: Optional[str] = None,
):
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
                INSERT INTO access_sessions
                    (responder_id, victim_id, method, granted_at, expires_at, scan_lat, scan_lon)
                VALUES (%s, %s::uuid, 'FACE', NOW(), NOW() + INTERVAL '12 hours', %s, %s)
                ON CONFLICT (responder_id, victim_id)
                DO UPDATE SET expires_at = EXCLUDED.expires_at,
                              granted_at = EXCLUDED.granted_at,
                              method     = EXCLUDED.method,
                              status     = 'ACTIVE',
                              -- COALESCE: lần quét không có GPS không được xoá vị trí đã biết.
                              scan_lat   = COALESCE(EXCLUDED.scan_lat, access_sessions.scan_lat),
                              scan_lon   = COALESCE(EXCLUDED.scan_lon, access_sessions.scan_lon)
                """,
                (responder_id, victim_id, scan_lat, scan_lon),
            )
        conn.commit()
    except Exception as e:
        logger.error(f"Failed to create access session in Postgres: {e}")
    finally:
        conn.close()


MASK_VISIBLE_TAIL = 4


def mask_cccd(value: Any) -> Any:
    """
    `123456789885` -> `********9885`. Bản Python của `maskCccd` trong shared/services/mask.service.ts;
    hai đường quét phải che giống hệt nhau, nếu không responder thấy số đầy đủ ở đường này và số đã
    che ở đường kia.

    Bốn số cuối đủ để đối chiếu với thẻ căn cước trong ví nạn nhân - đủ cho việc cứu người. Cả 12 số
    thì mở được tài khoản ngân hàng và đăng ký SIM. Idempotent, và chuỗi <= 4 ký tự bị che hết.
    """
    if value is None:
        return None
    raw = str(value).strip()
    if raw == "":
        return raw
    if len(raw) <= MASK_VISIBLE_TAIL:
        return "*" * len(raw)
    return "*" * (len(raw) - MASK_VISIBLE_TAIL) + raw[-MASK_VISIBLE_TAIL:]


def copy_avatar_object(bucket: str, source_key: str, citizen_uuid: str) -> Optional[str]:
    """
    Sao chép ảnh enroll sang `avatars/<citizenId>.jpg` và trả về key đó.

    Đích PHẢI nằm ngoài `raw-uploads/` và `raw-scans/`: EventBridge rule chỉ lọc theo hai prefix đó
    (`infra/modules/sqs/main.tf`), nên bản sao không sinh job mới. Nếu đặt vào một trong hai prefix,
    bản sao sẽ được xử lý như một lần QUÉT - job ma, cấp access session, bắn `victim.identified`,
    và người thân nhận cảnh báo cấp cứu giả.

    Key ổn định theo citizen nên enroll lại sẽ ghi đè, và ảnh gốc trong `raw-uploads/` có thể xoá
    theo lifecycle mà không làm hỏng avatar. Lỗi sao chép trả về None: enroll khuôn mặt vẫn thành
    công, chỉ là avatar giữ nguyên giá trị cũ.
    """
    avatar_key = f"avatars/{citizen_uuid}.jpg"
    try:
        s3_client.copy_object(
            Bucket=bucket,
            CopySource={"Bucket": bucket, "Key": source_key},
            Key=avatar_key,
            ContentType="image/jpeg",
            MetadataDirective="REPLACE",
        )
        return avatar_key
    except Exception as e:
        logger.error(f"Failed to copy avatar {source_key} -> {avatar_key}: {e}")
        return None


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

                # Không có citizen_id thì KHÔNG có gì để enroll. Trước 2026-08-22 nhánh này vẫn báo
                # COMPLETED + enrolled: true, nên client tin là đã đăng ký khuôn mặt trong khi
                # face_embedding chưa từng được ghi. Bản ghi job hết hạn (TTL 2h) trong khi message
                # SQS sống 24h, nên chỉ cần worker chậm hơn 2 tiếng là mọi job rơi vào đúng lỗ này.
                if not citizen_id:
                    logger.error(
                        "Enrollment job %s has no citizen_id (job record missing or expired) — "
                        "refusing to report success", job_id,
                    )
                    update_job_status(
                        job_id, "FAILED",
                        error="Job metadata missing or expired; nothing was enrolled. Please upload again.",
                    )
                    return

                # RETURNING id để lấy UUID thật: citizen_id truyền vào có thể là cognito_id, mà key
                # của avatar phải ổn định theo một định danh duy nhất.
                cur.execute(
                    """
                    UPDATE citizens
                       SET face_embedding = %s::vector,
                           is_verified    = true,
                           updated_at     = NOW()
                     WHERE id = %s OR cognito_id = %s
                 RETURNING id
                    """,
                    (vector_str, citizen_id, citizen_id),
                )
                updated = cur.fetchone()
                # UPDATE không khớp dòng nào cũng là "thành công" với psycopg2 — phải tự kiểm,
                # nếu không thì một citizen_id sai vẫn trả về enrolled: true.
                if updated is None:
                    conn.rollback()
                    logger.error("Enrollment job %s: no citizen matched %s", job_id, citizen_id)
                    update_job_status(
                        job_id, "FAILED",
                        error=f"No citizen matched {citizen_id}; nothing was enrolled.",
                    )
                    return

                resolved_id = str(updated["id"])

                # avatar_url giữ **S3 key**, không phải URL đầy đủ: bucket chặn toàn bộ public access
                # nên một https://... lưu sẵn sẽ 403 vĩnh viễn. Đường đọc ký presigned GET từ key này
                # (`resolveAvatarUrl` trong s3.service.ts).
                avatar_key = copy_avatar_object(bucket, key, resolved_id)
                if avatar_key:
                    cur.execute(
                        "UPDATE citizens SET avatar_url = %s WHERE id = %s",
                        (avatar_key, resolved_id),
                    )

                conn.commit()
                logger.info(
                    f"Enrolled citizen {resolved_id} (avatar_url={avatar_key or 'unchanged'})"
                )
                update_job_status(
                    job_id,
                    "COMPLETED",
                    result={"enrolled": True, "citizenId": resolved_id, "avatarKey": avatar_key},
                )
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
                    job_item = job_resp.get("Item", {}) or {}
                    responder_id = job_item.get("responder_id", "system")
                    # Toạ độ được ghi lúc xin presigned URL - lúc đó điện thoại còn ở hiện trường.
                    scan_lat = job_item.get("scan_lat")
                    scan_lon = job_item.get("scan_lon")

                    # Khiếu nại phải kiểm cho TỪNG ứng viên, không chỉ ứng viên đứng đầu. Mỗi ứng
                    # viên trả về đều kèm bệnh án, nên chỉ kiểm người đầu tiên nghĩa là ai đã khiếu
                    # nại responder này vẫn lộ hồ sơ khi lọt vào vị trí thứ 2 hoặc 3.
                    # Một truy vấn cho cả nhóm, dùng lại đúng cursor này thay vì mở 3 kết nối mới.
                    cur.execute(
                        """
                        SELECT victim_id FROM access_sessions
                         WHERE responder_id = %s AND status = 'COMPLAINED'
                           AND victim_id = ANY(%s::uuid[])
                        """,
                        (responder_id, [str(m["id"]) for m in matches]),
                    )
                    complained_ids = {str(r["victim_id"]) for r in cur.fetchall()}

                    top_candidates = []
                    for match in matches:
                        m_dist = float(match["distance"])
                        victim_id = match["id"]

                        if str(victim_id) in complained_ids:
                            logger.warning(
                                f"Candidate {victim_id} suppressed for job {job_id}: "
                                f"access was complained about"
                            )
                            continue

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
                        # Che CCCD ngay tại đây, trước khi ghi: kết quả job nằm trong DynamoDB 2 giờ
                        # và responder đọc thẳng từ đó, nên che lúc trả về là quá muộn - số đầy đủ
                        # đã được lưu ở một nơi thứ hai rồi.
                        match_data["cccdNumber"] = mask_cccd(match_data.get("cccdNumber"))

                        top_candidates.append({
                            "victim": match_data,
                            "record": dict(record) if record else None,
                            "distance": m_dist,
                        })

                    # Mọi ứng viên đều bị khiếu nại: không còn gì được phép trả về.
                    if not top_candidates:
                        logger.warning(
                            f"All {len(matches)} candidate(s) suppressed for job {job_id}: "
                            f"access was complained about"
                        )
                        update_job_status(
                            job_id,
                            "COMPLETED",
                            result={
                                "matchStatus": "ACCESS_REVOKED",
                                "message": "Access to this citizen has been revoked following a complaint",
                            },
                        )
                        return

                    # Primary (best) match
                    primary = top_candidates[0]
                    primary_victim_id = primary["victim"]["id"]
                    primary_distance = primary["distance"]

                    # Cấp phiên cho TẤT CẢ ứng viên được trả về, không chỉ người đầu tiên: bệnh án
                    # của ai đã nằm trong phản hồi thì người đó phải thấy được lần truy cập ấy trong
                    # lịch sử của mình và khiếu nại được. Trao dữ liệu mà không để lại dấu vết là
                    # đúng thứ mà cơ chế khiếu nại sinh ra để chặn.
                    for candidate in top_candidates:
                        grant_access_session(
                            responder_id, str(candidate["victim"]["id"]), scan_lat, scan_lon
                        )

                    # Sự kiện CHỈ bắn cho ứng viên đứng đầu, dù phiên đã cấp cho tất cả.
                    # `victim.identified` kích hoạt notification-worker gửi cảnh báo cấp cứu cho
                    # người thân; bắn cho cả ứng viên 2 và 3 nghĩa là báo động giả cho hai gia đình
                    # không liên quan. Cấp quyền là chuyện trách nhiệm giải trình, báo động là chuyện
                    # khác - và chỉ có một người thực sự đang nằm đó.
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
                                "lat": scan_lat,
                                "lon": scan_lon,
                            },
                        },
                    )

                    update_job_status(
                        job_id,
                        "COMPLETED",
                        result={
                            "matchStatus": "MATCH_FOUND",
                            "matchesCount": len(top_candidates),
                            # Bao nhiêu ứng viên bị loại vì khiếu nại - không nói là ai.
                            "suppressedCount": len(matches) - len(top_candidates),
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
    logger.info(
        "AWS mode=%s sqs=%s s3=%s dynamodb=%s events=%s",
        "LOCAL EMULATION" if LOCAL_AWS else "real AWS",
        SQS_ENDPOINT_URL or "default", S3_ENDPOINT_URL or "default",
        DYNAMO_ENDPOINT_URL or "default", ENDPOINT_URL or "default",
    )

    consecutive_failures = 0

    while not stop_event.is_set():
        try:
            response = sqs_client.receive_message(
                QueueUrl=QUEUE_URL,
                MaxNumberOfMessages=5,
                WaitTimeSeconds=20,
                VisibilityTimeout=120,
            )

            consecutive_failures = 0
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
                consecutive_failures += 1
                logger.error(f"Error polling SQS: {e}")
                # Poll hỏng liên tiếp nghĩa là worker không hề nhìn thấy queue — message nằm lại ở
                # trạng thái Available và job đứng ở PENDING. Nói thẳng ra, đừng để nó trôi trong log.
                if consecutive_failures in (5, 50) or consecutive_failures % 500 == 0:
                    logger.error(
                        "SQS unreachable for %d consecutive polls (endpoint=%s, queue=%s). "
                        "No message can be received in this state.",
                        consecutive_failures, SQS_ENDPOINT_URL or "default AWS", QUEUE_URL,
                    )
                time.sleep(5)

    logger.info("SQS worker stopped.")