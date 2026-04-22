-- =============================================
-- HelpMe Database Schema: 3-Table Role Design
-- Authorization: Cognito Groups (citizen/staff/admin)
-- =============================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;

-- =============================================
-- TABLE 1: Citizens (Google Sign-In users)
-- Added automatically via Post Confirmation Lambda
-- =============================================
CREATE TABLE citizens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cognito_id TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL DEFAULT '',
    phone TEXT,
    avatar_url TEXT,

    -- Identity fields
    date_of_birth DATE,
    gender TEXT,
    address TEXT,
    cccd_number TEXT UNIQUE,

    -- Biometric
    face_embedding vector(512),

    -- Emergency contacts (JSON array)
    emergency_contacts JSONB,

    is_profile_updated BOOLEAN NOT NULL DEFAULT FALSE,
    is_verified BOOLEAN NOT NULL DEFAULT FALSE,

    first_declare_profile BOOLEAN NOT NULL DEFAULT FALSE,
    consent_regulation BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- TABLE 2: Staff (Healthcare Workers)
-- Manually created by Admin
-- =============================================
CREATE TABLE staff (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cognito_id TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    phone TEXT,
    avatar_url TEXT,

    -- Staff-specific fields
    hospital_name TEXT NOT NULL,
    department TEXT,
    status TEXT NOT NULL DEFAULT 'active', -- active, inactive, suspended

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- TABLE 3: Admins (System Administrators)
-- Manually created, separate from Staff
-- =============================================
CREATE TABLE admins (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cognito_id TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    avatar_url TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- Medical Records (linked to citizens)
-- =============================================
CREATE TABLE medical_records (
    citizen_id UUID PRIMARY KEY REFERENCES citizens(id) ON DELETE CASCADE,
    distinguishing_marks TEXT,
    blood_group TEXT,
    allergies TEXT[],
    background_diseases TEXT[],
    current_medications TEXT[],
    notes TEXT,
    last_updated TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- NFC Tags (linked to citizens)
-- =============================================
CREATE TABLE nfc_tags (
    id TEXT PRIMARY KEY,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'INACTIVE',
    citizen_id UUID NOT NULL REFERENCES citizens(id) ON DELETE CASCADE,
    registered_at TIMESTAMPTZ DEFAULT NOW(),
    last_used_at TIMESTAMPTZ
);

-- =============================================
-- QR Codes (linked to citizens)
-- =============================================
CREATE TABLE qr_codes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT,
    status TEXT NOT NULL DEFAULT 'INACTIVE',
    citizen_id UUID NOT NULL REFERENCES citizens(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_used_at TIMESTAMPTZ
);

-- =============================================
-- Emergency Reports
-- reporter = staff, victim = citizen
-- =============================================
CREATE TABLE emergency_reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    reporter_id UUID REFERENCES staff(id),   -- Staff who submitted
    victim_id UUID REFERENCES citizens(id),  -- Citizen victim
    location_lat TEXT NOT NULL,
    location_lon TEXT NOT NULL,
    situation_description TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING, IN_PROGRESS, RESOLVED
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- Indices
-- =============================================
-- Citizens
CREATE INDEX idx_citizens_cognito_id ON citizens(cognito_id);
CREATE INDEX idx_citizens_email ON citizens(email);
CREATE INDEX idx_citizens_cccd ON citizens(cccd_number);
CREATE INDEX idx_citizens_face ON citizens USING ivfflat (face_embedding vector_cosine_ops) WITH (lists = 100);

-- Staff
CREATE INDEX idx_staff_cognito_id ON staff(cognito_id);
CREATE INDEX idx_staff_email ON staff(email);

-- Admins
CREATE INDEX idx_admins_cognito_id ON admins(cognito_id);
CREATE INDEX idx_admins_email ON admins(email);
