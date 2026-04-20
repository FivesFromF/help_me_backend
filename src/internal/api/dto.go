package api

import "time"

// ========= CITIZEN PROFILE =========

type CitizenProfile struct {
	ID                string    `json:"id"`
	CognitoID         string    `json:"cognitoId,omitempty"`
	Email             string    `json:"email"`
	FullName          string    `json:"fullName"`
	Phone             string    `json:"phone,omitempty"`
	AvatarUrl         string    `json:"avatarUrl,omitempty"`
	DateOfBirth       string    `json:"dateOfBirth,omitempty"`
	Gender            string    `json:"gender,omitempty"`
	Address           string    `json:"address,omitempty"`
	CccdNumber        string    `json:"cccdNumber,omitempty"`
	CreatedAt         time.Time `json:"createdAt"`
}

// ========= STAFF PROFILE =========

type StaffProfile struct {
	ID           string    `json:"id"`
	CognitoID    string    `json:"cognitoId,omitempty"`
	Email        string    `json:"email"`
	FullName     string    `json:"fullName"`
	Phone        string    `json:"phone,omitempty"`
	AvatarUrl    string    `json:"avatarUrl,omitempty"`
	HospitalName string    `json:"hospitalName"`
	Department   string    `json:"department,omitempty"`
	Status       string    `json:"status"`
	CreatedAt    time.Time `json:"createdAt"`
}

// ========= ADMIN PROFILE =========

type AdminProfile struct {
	ID        string    `json:"id"`
	CognitoID string    `json:"cognitoId,omitempty"`
	Email     string    `json:"email"`
	FullName  string    `json:"fullName"`
	AvatarUrl string    `json:"avatarUrl,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

// ========= AUTH =========

type SignInRequest struct {
	AccessToken string `json:"accessToken,omitempty"`
	Email       string `json:"email,omitempty"`
	Password    string `json:"password,omitempty"`
}

// SignInResponse returns the profile based on Cognito Group
type SignInResponse struct {
	AccessToken string          `json:"accessToken,omitempty"`
	Role        string          `json:"role"` // "citizen" | "staff" | "admin"
	Citizen     *CitizenProfile `json:"citizen,omitempty"`
	Staff       *StaffProfile   `json:"staff,omitempty"`
	Admin       *AdminProfile   `json:"admin,omitempty"`
}

// ========= CITIZEN - REGISTER (Complete Profile) =========

type RegisterCitizenRequest struct {
	FullName    string   `json:"fullName"`
	Phone       string   `json:"phone,omitempty"`
	DateOfBirth string   `json:"dateOfBirth,omitempty"`
	Gender      string   `json:"gender,omitempty"`
	Address     string   `json:"address,omitempty"`
	CccdNumber  string   `json:"cccdNumber,omitempty"`
	AvatarUrl   string   `json:"avatarUrl,omitempty"`
	FaceVector  []float32 `json:"faceVector,omitempty"`
	FaceImageB64 string   `json:"faceImageB64,omitempty"`

	InitialMedicalRecord *MedicalRecordInput `json:"medicalRecord,omitempty"`
}

type RegisterCitizenResponse struct {
	Profile *CitizenProfile `json:"profile"`
}

// ========= CITIZEN - UPDATE PROFILE (Unified) =========

type UpdateProfileRequest struct {
	FullName          string              `json:"fullName,omitempty"`
	Phone             string              `json:"phone,omitempty"`
	DateOfBirth       string              `json:"dateOfBirth,omitempty"`
	Gender            string              `json:"gender,omitempty"`
	Address           string              `json:"address,omitempty"`
	CccdNumber        string              `json:"cccdNumber,omitempty"`
	AvatarUrl         string              `json:"avatarUrl,omitempty"`
	MedicalRecord     *MedicalRecordInput `json:"medicalRecord,omitempty"`
	EmergencyContacts []ContactInfo       `json:"emergencyContacts,omitempty"`
}

type UpdateProfileResponse struct {
	Profile       *CitizenProfile `json:"profile"`
	MedicalRecord *MedicalRecord  `json:"medicalRecord,omitempty"`
}

// ========= MEDICAL RECORD =========

type MedicalRecordInput struct {
	DistinguishingMarks string   `json:"distinguishingMarks,omitempty"`
	BloodGroup          string   `json:"bloodGroup,omitempty"`
	Allergies           []string `json:"allergies,omitempty"`
	BackgroundDiseases  []string `json:"backgroundDiseases,omitempty"`
	CurrentMedications  []string `json:"currentMedications,omitempty"`
	Notes               string   `json:"notes,omitempty"`
}

type MedicalRecord struct {
	ID                  string    `json:"id"` // citizen_id
	DistinguishingMarks string    `json:"distinguishingMarks,omitempty"`
	BloodGroup          string    `json:"bloodGroup,omitempty"`
	Allergies           []string  `json:"allergies,omitempty"`
	BackgroundDiseases  []string  `json:"backgroundDiseases,omitempty"`
	CurrentMedications  []string  `json:"currentMedications,omitempty"`
	Notes               string    `json:"notes,omitempty"`
	UpdatedAt           time.Time `json:"updatedAt"`
}

// ========= IDENTITY VERIFICATION =========

type VerifyIdentityRequest struct {
	NfcID          string `json:"nfcId,omitempty"`
	QrID           string `json:"qrId,omitempty"`
	HashedCitizenID string `json:"hashedCitizenId,omitempty"`
}

type VerifyIdentityResponse struct {
	Profile           *CitizenProfile `json:"profile"`
	MedicalRecord     *MedicalRecord  `json:"medicalRecord,omitempty"`
	EmergencyContacts []ContactInfo   `json:"emergencyContacts,omitempty"`
}

// ========= FACE SEARCH =========

type SearchByFaceRequest struct {
	FaceVector   []float32 `json:"faceVector,omitempty"`
	FaceImageB64 string    `json:"faceImageB64,omitempty"`
	StaffID      string    `json:"staffId,omitempty"`
}

type SearchByFaceResponse struct {
	Profile           *CitizenProfile `json:"profile"`
	MedicalRecord     *MedicalRecord  `json:"medicalRecord,omitempty"`
	EmergencyContacts []ContactInfo   `json:"emergencyContacts,omitempty"`
}

// ========= EMERGENCY REPORT =========

type ReportEmergencyRequest struct {
	LocationLat          float64 `json:"locationLat"`
	LocationLon          float64 `json:"locationLon"`
	SituationDescription string  `json:"situationDescription,omitempty"`
	VictimID             string  `json:"victimId,omitempty"`
}

type EmergencyReport struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

type ReportEmergencyResponse struct {
	Report *EmergencyReport `json:"report"`
}

// ========= HEALTHCARE / MEDICAL DATA =========

type GetMedicalRecordRequest struct {
	CitizenID string `json:"citizenId"`
	StaffID   string `json:"staffId"`
}

type GetMedicalRecordResponse struct {
	Record *MedicalRecord `json:"record"`
}

// ========= CONTACT INFO =========

type ContactInfo struct {
	Name         string `json:"name"`
	Relationship string `json:"relationship,omitempty"`
	Phone        string `json:"phone,omitempty"`
	Email        string `json:"email,omitempty"`
}

// ========= ADMIN: REGISTER STAFF =========

type RegisterStaffRequest struct {
	FullName     string `json:"fullName"`
	Email        string `json:"email"`
	Phone        string `json:"phone,omitempty"`
	HospitalName string `json:"hospitalName"`
	Department   string `json:"department,omitempty"`
}

type RegisterStaffResponse struct {
	Profile *StaffProfile `json:"profile"`
}

// ========= ADMIN: MANAGE STAFF =========

type ManageStaffRequest struct {
	StaffID  string `json:"staffId"`
	NewStatus string `json:"newStatus,omitempty"` // active, inactive, suspended
}

type ManageStaffResponse struct {
	Profile *StaffProfile `json:"profile"`
}

// ========= ADMIN: SYSTEM STATS =========

type GetSystemStatsResponse struct {
	TotalCitizens        int64 `json:"totalCitizens"`
	TotalStaff           int64 `json:"totalStaff"`
	TotalAdmins          int64 `json:"totalAdmins"`
	EmergencyEventsToday int64 `json:"emergencyEventsToday"`
}

// ========= AUDIT LOGS =========

type AuditLog struct {
	ID         string    `json:"id"`
	EventType  string    `json:"eventType"`
	ActorID    string    `json:"actorId"`
	ResourceID string    `json:"resourceId"`
	Details    string    `json:"details"`
	Timestamp  time.Time `json:"timestamp"`
}

type ListAuditLogsRequest struct {
	Limit     int32  `json:"limit,omitempty"`
	NextToken string `json:"nextToken,omitempty"`
}

type ListAuditLogsResponse struct {
	Logs      []AuditLog `json:"logs"`
	NextToken string     `json:"nextToken,omitempty"`
}
