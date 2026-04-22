-- =============================================
-- Citizens Queries
-- =============================================

-- name: CreateCitizen :one
INSERT INTO citizens (
    cognito_id, email, full_name, phone, avatar_url
) VALUES (
    $1, $2, $3, $4, $5
)
RETURNING *;

-- name: GetCitizen :one
SELECT * FROM citizens WHERE id = $1 LIMIT 1;

-- name: GetCitizenByCognitoID :one
SELECT * FROM citizens WHERE cognito_id = $1 LIMIT 1;

-- name: GetCitizenByEmail :one
SELECT * FROM citizens WHERE email = $1 LIMIT 1;

-- name: UpdateCitizenBasicInfo :exec
UPDATE citizens SET email = $2, full_name = $3 WHERE id = $1;

-- name: UpdateCitizenCognitoID :exec
UPDATE citizens SET cognito_id = $1, updated_at = NOW() WHERE id = $2;

-- name: UpdateCitizenEmergencyContacts :exec
UPDATE citizens SET emergency_contacts = $2, updated_at = NOW() WHERE id = $1;

-- name: UpdateCitizen :one
UPDATE citizens
SET
    full_name          = $2,
    phone              = $3,
    avatar_url         = $4,
    date_of_birth      = $5,
    gender             = $6,
    address            = $7,
    cccd_number        = $8,
    is_profile_updated    = $9,
    is_verified           = $10,
    first_declare_profile = $11,
    consent_regulation    = $12,
    updated_at            = NOW()
WHERE id = $1
RETURNING *;

-- name: UpdateCitizenFaceEmbedding :exec
UPDATE citizens SET face_embedding = $2 WHERE id = $1;

-- name: SearchCitizenByFace :many
SELECT id, full_name, avatar_url, face_embedding <=> $1 AS distance
FROM citizens
WHERE face_embedding IS NOT NULL
ORDER BY distance ASC
LIMIT $2;

-- name: CountCitizens :one
SELECT COUNT(*) FROM citizens;

-- =============================================
-- Staff Queries
-- =============================================

-- name: CreateStaff :one
INSERT INTO staff (
    cognito_id, email, full_name, phone, hospital_name, department, status
) VALUES (
    $1, $2, $3, $4, $5, $6, $7
)
RETURNING *;

-- name: GetStaff :one
SELECT * FROM staff WHERE id = $1 LIMIT 1;

-- name: GetStaffByCognitoID :one
SELECT * FROM staff WHERE cognito_id = $1 LIMIT 1;

-- name: GetStaffByEmail :one
SELECT * FROM staff WHERE email = $1 LIMIT 1;

-- name: UpdateStaff :one
UPDATE staff
SET
    full_name     = $2,
    phone         = $3,
    avatar_url    = $4,
    hospital_name = $5,
    department    = $6,
    updated_at    = NOW()
WHERE id = $1
RETURNING *;

-- name: UpdateStaffStatus :one
UPDATE staff SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *;

-- name: ListStaff :many
SELECT * FROM staff ORDER BY created_at DESC;

-- name: CountStaff :one
SELECT COUNT(*) FROM staff;

-- =============================================
-- Admin Queries
-- =============================================

-- name: CreateAdmin :one
INSERT INTO admins (
    cognito_id, email, full_name, avatar_url
) VALUES (
    $1, $2, $3, $4
)
RETURNING *;

-- name: GetAdmin :one
SELECT * FROM admins WHERE id = $1 LIMIT 1;

-- name: GetAdminByCognitoID :one
SELECT * FROM admins WHERE cognito_id = $1 LIMIT 1;

-- name: GetAdminByEmail :one
SELECT * FROM admins WHERE email = $1 LIMIT 1;

-- name: UpdateAdminCognitoID :exec
UPDATE admins SET cognito_id = $1, updated_at = NOW() WHERE id = $2;

-- name: CountAdmins :one
SELECT COUNT(*) FROM admins;

-- =============================================
-- Medical Records
-- =============================================

-- name: CreateMedicalRecord :one
INSERT INTO medical_records (
    citizen_id, distinguishing_marks, blood_group, allergies,
    background_diseases, current_medications, notes
) VALUES (
    $1, $2, $3, $4, $5, $6, $7
)
RETURNING *;

-- name: GetMedicalRecord :one
SELECT * FROM medical_records WHERE citizen_id = $1 LIMIT 1;

-- name: UpdateMedicalRecord :one
UPDATE medical_records
SET
    distinguishing_marks = $2,
    blood_group          = $3,
    allergies            = $4,
    background_diseases  = $5,
    current_medications  = $6,
    notes                = $7,
    last_updated         = NOW()
WHERE citizen_id = $1
RETURNING *;

-- =============================================
-- NFC Tags
-- =============================================

-- name: CreateNFCTag :one
INSERT INTO nfc_tags (id, name, status, citizen_id)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: GetNFCTag :one
SELECT * FROM nfc_tags WHERE id = $1 LIMIT 1;

-- name: ListCitizenNFCTags :many
SELECT * FROM nfc_tags WHERE citizen_id = $1 ORDER BY registered_at DESC;

-- name: UpdateNFCTagStatus :one
UPDATE nfc_tags SET status = $2 WHERE id = $1 RETURNING *;

-- name: UpdateNFCLastUsed :exec
UPDATE nfc_tags SET last_used_at = NOW() WHERE id = $1;

-- name: DeleteNFCTag :exec
DELETE FROM nfc_tags WHERE id = $1 AND citizen_id = $2;

-- =============================================
-- QR Codes
-- =============================================

-- name: CreateQRCode :one
INSERT INTO qr_codes (name, status, citizen_id)
VALUES ($1, $2, $3)
RETURNING *;

-- name: GetQRCode :one
SELECT * FROM qr_codes WHERE id = $1 LIMIT 1;

-- name: UpdateQRLastUsed :exec
UPDATE qr_codes SET last_used_at = NOW() WHERE id = $1;

-- name: ListCitizenQRCodes :many
SELECT * FROM qr_codes WHERE citizen_id = $1 ORDER BY created_at DESC;

-- name: UpdateQRCodeStatus :one
UPDATE qr_codes SET status = $2 WHERE id = $1 RETURNING *;

-- name: DeleteQRCode :exec
DELETE FROM qr_codes WHERE id = $1 AND citizen_id = $2;

-- =============================================
-- Emergency Reports
-- =============================================

-- name: CreateEmergencyReport :one
INSERT INTO emergency_reports (
    reporter_id, victim_id, location_lat, location_lon, situation_description, status
) VALUES (
    $1, $2, $3, $4, $5, $6
)
RETURNING *;

-- name: GetEmergencyReport :one
SELECT * FROM emergency_reports WHERE id = $1 LIMIT 1;

-- name: CountEmergencyToday :one
SELECT COUNT(*) FROM emergency_reports
WHERE created_at >= NOW() - INTERVAL '24 hours';
