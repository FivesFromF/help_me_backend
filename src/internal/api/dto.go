package api

import "time"

// ========= AUTHENTICATION =========

type RequestOTPRequest struct {
	Phone string `json:"phone"`
}

type RequestOTPResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

type VerifyOTPRequest struct {
	Phone string `json:"phone"`
	Code  string `json:"code"`
}

type VerifyOTPResponse struct {
	Token        string          `json:"token"`
	Profile      *CitizenProfile `json:"profile,omitempty"`
	StaffProfile *StaffProfile   `json:"staffProfile,omitempty"` // For Staff login fallback
}

type StaffSignInRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type StaffSignInResponse struct {
	Token   string        `json:"token,omitempty"`
	Profile *StaffProfile `json:"profile,omitempty"`
}

// ========= PROFILES =========

type CitizenProfile struct {
	ID          string    `json:"id"`
	FullName    string    `json:"fullName"`
	DateOfBirth string    `json:"dateOfBirth"`
	Gender      string    `json:"gender"`
	Address     string    `json:"address"`
	Email       string    `json:"email"`
	Phone       string    `json:"phone"`
	CccdNumber  string    `json:"cccdNumber"`
	AvatarUrl   string    `json:"avatarUrl"`
	CreatedAt   time.Time `json:"createdAt"`
}

type StaffProfile struct {
	ID           string    `json:"id"`
	FullName     string    `json:"fullName"`
	Email        string    `json:"email"`
	HospitalName string    `json:"hospitalName"`
	Role         string    `json:"role"`
	Status       string    `json:"status"`
	CreatedAt    time.Time `json:"createdAt"`
}

type ContactInfo struct {
	Name         string `json:"name"`
	Relationship string `json:"relationship"`
	Phone        string `json:"phone"`
}

type MedicalRecord struct {
	ID                  string    `json:"id"`
	DistinguishingMarks string    `json:"distinguishingMarks"`
	BloodGroup          string    `json:"bloodGroup"`
	Allergies           []string  `json:"allergies"`
	BackgroundDiseases  []string  `json:"backgroundDiseases"`
	CurrentMedications  []string  `json:"currentMedications"`
	Notes               string    `json:"notes"`
	UpdatedAt           time.Time `json:"updatedAt"`
}

// ========= CITIZEN REGISTRATION =========

type RegisterRequest struct {
	FullName             string         `json:"fullName"`
	DateOfBirth          string         `json:"dateOfBirth"` // "2006-01-02"
	Gender               string         `json:"gender"`
	Address              string         `json:"address"`
	Email                string         `json:"email"`
	Phone                string         `json:"phone"`
	CccdNumber           string         `json:"cccdNumber"`
	AvatarUrl            string         `json:"avatarUrl"`
	FaceVector           []float32      `json:"faceVector"`
	EmergencyContacts    []ContactInfo  `json:"emergencyContacts"`
	InitialMedicalRecord *MedicalRecord `json:"initialMedicalRecord,omitempty"`
}

type RegisterResponse struct {
	Profile *CitizenProfile `json:"profile"`
}

// ========= IDENTIFICATION =========

type VerifyIdentityRequest struct {
	NfcID           string `json:"nfcId,omitempty"`
	QrID            string `json:"qrId,omitempty"`
	HashedCitizenID string `json:"hashedCitizenId"`
}

type VerifyIdentityResponse struct {
	Profile           *CitizenProfile `json:"profile"`
	MedicalRecord     *MedicalRecord  `json:"medicalRecord"`
	EmergencyContacts []ContactInfo   `json:"emergencyContacts"`
}

type SearchByFaceRequest struct {
	FaceVector []float32 `json:"faceVector"`
}

type SearchByFaceResponse struct {
	Profile           *CitizenProfile `json:"profile"`
	MedicalRecord     *MedicalRecord  `json:"medicalRecord"`
	EmergencyContacts []ContactInfo   `json:"emergencyContacts"`
}

// ========= GENERAL GENERIC RESPONSES =========

type ErrorResponse struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// ========= ADMIN / STAFF =========

type ListAuditLogsRequest struct {
	Limit int32 `json:"limit"`
}

type AuditLog struct {
	ID         string    `json:"id"`
	EventType  string    `json:"eventType"`
	ActorID    string    `json:"actorId"`
	ResourceID string    `json:"resourceId"`
	Details    string    `json:"details"`
	Timestamp  time.Time `json:"timestamp"`
}

type ListAuditLogsResponse struct {
	Logs      []AuditLog `json:"logs"`
	NextToken string     `json:"nextToken"`
}

type GetSystemStatsRequest struct{}

type GetSystemStatsResponse struct {
	TotalCitizens        int64 `json:"totalCitizens"`
	TotalStaff           int64 `json:"totalStaff"`
	EmergencyEventsToday int64 `json:"emergencyEventsToday"`
}

type ManageStaffRequest struct {
	StaffID   string `json:"staffId"`
	NewStatus string `json:"newStatus"`
}

type ManageStaffResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

type RegisterStaffRequest struct {
	FullName     string `json:"fullName"`
	Email        string `json:"email"`
	Phone        string `json:"phone"`
	Password     string `json:"password"`
	HospitalName string `json:"hospitalName"`
	Role         string `json:"role"`
}

type RegisterStaffResponse struct {
	Profile *StaffProfile `json:"profile"`
}

// ========= EMERGENCY =========

type ReportEmergencyRequest struct {
	VictimID             string  `json:"victimId,omitempty"`
	LocationLat          float64 `json:"locationLat"`
	LocationLon          float64 `json:"locationLon"`
	SituationDescription string  `json:"situationDescription"`
}

type EmergencyReport struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

type ReportEmergencyResponse struct {
	Report *EmergencyReport `json:"report"`
}

// ========= HEALTHCARE =========

type GetMedicalRecordRequest struct {
	CitizenID string `json:"citizenId"`
	StaffID   string `json:"staffId"`
}

type GetMedicalRecordResponse struct {
	Record *ApiMedicalRecord `json:"record"`
}

type ApiMedicalRecord struct {
	CitizenID           string    `json:"citizenId"`
	DistinguishingMarks string    `json:"distinguishingMarks"`
	BloodGroup          string    `json:"bloodGroup"`
	Allergies           []string  `json:"allergies"`
	BackgroundDiseases  []string  `json:"backgroundDiseases"`
	CurrentMedications  []string  `json:"currentMedications"`
	Notes               string    `json:"notes"`
	LastUpdated         time.Time `json:"lastUpdated"`
}
