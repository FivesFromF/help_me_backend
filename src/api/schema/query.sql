-- name: CreateCitizen :one
INSERT INTO citizens (
    full_name, date_of_birth, gender, address, email, phone, cccd_number, avatar_url, face_embedding, emergency_contacts
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
)
RETURNING *;

-- name: GetCitizen :one
SELECT * FROM citizens
WHERE id = $1 LIMIT 1;

-- name: GetCitizenByCCCD :one
SELECT * FROM citizens
WHERE cccd_number = $1 LIMIT 1;

-- name: SearchCitizenByFace :many
SELECT *, (face_embedding <-> $1) AS distance
FROM citizens
ORDER BY distance ASC
LIMIT $2;

-- name: UpdateCitizen :one
UPDATE citizens
SET 
    full_name = COALESCE(sqlc.narg('full_name'), full_name),
    date_of_birth = COALESCE(sqlc.narg('date_of_birth'), date_of_birth),
    gender = COALESCE(sqlc.narg('gender'), gender),
    address = COALESCE(sqlc.narg('address'), address),
    email = COALESCE(sqlc.narg('email'), email),
    phone = COALESCE(sqlc.narg('phone'), phone),
    cccd_number = COALESCE(sqlc.narg('cccd_number'), cccd_number),
    avatar_url = COALESCE(sqlc.narg('avatar_url'), avatar_url),
    face_embedding = COALESCE(sqlc.narg('face_embedding'), face_embedding),
    emergency_contacts = COALESCE(sqlc.narg('emergency_contacts'), emergency_contacts),
    updated_at = NOW()
WHERE id = $1
RETURNING *;


-- name: CreateMedicalRecord :one
INSERT INTO medical_records (
    citizen_id, distinguishing_marks, blood_group, allergies, background_diseases, current_medications, notes
) VALUES (
    $1, $2, $3, $4, $5, $6, $7
)
RETURNING *;

-- name: GetMedicalRecord :one
SELECT * FROM medical_records
WHERE citizen_id = $1 LIMIT 1;

-- name: UpdateMedicalRecord :one
UPDATE medical_records
SET
    distinguishing_marks = COALESCE(sqlc.narg('distinguishing_marks'), distinguishing_marks),
    blood_group = COALESCE(sqlc.narg('blood_group'), blood_group),
    allergies = COALESCE(sqlc.narg('allergies'), allergies),
    background_diseases = COALESCE(sqlc.narg('background_diseases'), background_diseases),
    current_medications = COALESCE(sqlc.narg('current_medications'), current_medications),
    notes = COALESCE(sqlc.narg('notes'), notes),
    last_updated = NOW()
WHERE citizen_id = $1
RETURNING *;

-- name: RegisterNFCTag :one
INSERT INTO nfc_tags (
    id, name, type, status, citizen_id
) VALUES (
    $1, $2, $3, $4, $5
)
RETURNING *;

-- name: GetNFCTag :one
SELECT * FROM nfc_tags
WHERE id = $1 LIMIT 1;

-- name: UpdateNFCTagStatus :one
UPDATE nfc_tags
SET status = $2
WHERE id = $1
RETURNING *;

-- name: UpdateNFCLastUsed :exec
UPDATE nfc_tags
SET last_used_at = NOW()
WHERE id = $1;

-- name: CreateQRCode :one
INSERT INTO qr_codes (
    name, status, citizen_id
) VALUES (
    $1, $2, $3
)
RETURNING *;

-- name: GetQRCode :one
SELECT * FROM qr_codes
WHERE id = $1 LIMIT 1;

-- name: UpdateQRStatus :one
UPDATE qr_codes
SET status = $2
WHERE id = $1
RETURNING *;

-- name: UpdateQRLastUsed :exec
UPDATE qr_codes
SET last_used_at = NOW()
WHERE id = $1;

-- name: CreateEmergencyReport :one
INSERT INTO emergency_reports (
    reporter_id, victim_id, location_lat, location_lon, situation_description
) VALUES (
    $1, $2, $3, $4, $5
)
RETURNING *;

-- name: GetEmergencyHistory :many
SELECT * FROM emergency_reports
WHERE reporter_id = $1 OR victim_id = $1
ORDER BY created_at DESC;
