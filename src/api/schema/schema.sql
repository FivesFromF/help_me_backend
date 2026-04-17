-- Enable vector extension for HNSW/IVF face search
CREATE EXTENSION IF NOT EXISTS vector;

-- Citizens table: Basic identity and core profile
CREATE TABLE citizens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name TEXT NOT NULL,
    date_of_birth DATE,
    gender TEXT,
    address TEXT,
    email TEXT,
    phone TEXT,
    cccd_number TEXT UNIQUE, -- Citizen Identity Card Number
    avatar_url TEXT,
    face_embedding vector(512), -- Local pgvector storage for face embeddings
    emergency_contacts JSONB NOT NULL DEFAULT '[]', -- List of emergency contacts [JSON array]
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- Medical Records table (Sensitive data)
CREATE TABLE medical_records (
    citizen_id UUID PRIMARY KEY REFERENCES citizens(id) ON DELETE CASCADE,
    distinguishing_marks TEXT,
    blood_group TEXT,
    allergies TEXT[] NOT NULL DEFAULT '{}',
    background_diseases TEXT[] NOT NULL DEFAULT '{}',
    current_medications TEXT[] NOT NULL DEFAULT '{}',
    notes TEXT,
    last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- NFC Tags management
CREATE TABLE nfc_tags (
    id TEXT PRIMARY KEY, -- The serial/code of the NFC tag
    name TEXT,
    type TEXT,
    status TEXT NOT NULL DEFAULT 'INACTIVE', -- ACTIVE, INACTIVE, LOST, REVOKED
    citizen_id UUID NOT NULL REFERENCES citizens(id) ON DELETE CASCADE,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ
);

-- QR Codes management
CREATE TABLE qr_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE, INACTIVE, LOST, REVOKED
    citizen_id UUID NOT NULL REFERENCES citizens(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ
);

-- Emergency Reports table
CREATE TABLE emergency_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id UUID, -- If reporter is a registered citizen
    victim_id UUID REFERENCES citizens(id),
    location_lat TEXT NOT NULL,
    location_lon TEXT NOT NULL,
    situation_description TEXT,
    status TEXT NOT NULL DEFAULT 'REPORTED', -- REPORTED, EN_ROUTE, ARRIVED, COMPLETED
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_citizens_full_name ON citizens(full_name);
CREATE INDEX idx_citizens_cccd ON citizens(cccd_number);
-- HNSW Index for face vector search (L2 distance)
CREATE INDEX idx_citizens_face_embedding ON citizens USING hnsw (face_embedding vector_l2_ops);

CREATE INDEX idx_nfc_tags_citizen ON nfc_tags(citizen_id);
CREATE INDEX idx_qr_codes_citizen ON qr_codes(citizen_id);
CREATE INDEX idx_emergency_reports_victim ON emergency_reports(victim_id);
