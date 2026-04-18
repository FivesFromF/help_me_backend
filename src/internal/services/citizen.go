package services

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pgvector/pgvector-go"

	"github.com/fivesfromf/helpme/internal/api"
	"github.com/fivesfromf/helpme/internal/repository"
	"github.com/fivesfromf/helpme/internal/repository/sqlc"
	"github.com/fivesfromf/helpme/internal/utils"
)

type CitizenServer struct {
	store        *repository.Store
	cloudRepo    *repository.CloudRepository
	systemSecret string
}

func NewCitizenServer(store *repository.Store, cloudRepo *repository.CloudRepository, secret string) *CitizenServer {
	return &CitizenServer{
		store:        store,
		cloudRepo:    cloudRepo,
		systemSecret: secret,
	}
}

func (s *CitizenServer) Register(w http.ResponseWriter, r *http.Request) {
	var req api.RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}

	fmt.Printf("Registering citizen: %s\n", req.FullName)

	var faceVec pgvector.Vector
	if len(req.FaceVector) > 0 {
		faceVec = pgvector.NewVector(req.FaceVector)
	}

	var dob pgtype.Date
	if req.DateOfBirth != "" {
		t, err := time.Parse("2006-01-02", req.DateOfBirth)
		if err == nil {
			dob = pgtype.Date{Time: t, Valid: true}
		}
	}

	var cccd pgtype.Text
	if req.CccdNumber != "" {
		cccd = pgtype.Text{String: req.CccdNumber, Valid: true}
	}

	contactsJSON, _ := json.Marshal(req.EmergencyContacts)

	citizen, err := s.store.CreateCitizen(r.Context(), sqlc.CreateCitizenParams{
		FullName:          req.FullName,
		DateOfBirth:       dob,
		Gender:            pgtype.Text{String: req.Gender, Valid: req.Gender != ""},
		Address:           pgtype.Text{String: req.Address, Valid: req.Address != ""},
		Email:             pgtype.Text{String: req.Email, Valid: req.Email != ""},
		Phone:             pgtype.Text{String: req.Phone, Valid: req.Phone != ""},
		CccdNumber:        cccd,
		AvatarUrl:         pgtype.Text{String: req.AvatarUrl, Valid: req.AvatarUrl != ""},
		FaceEmbedding:     faceVec,
		EmergencyContacts: contactsJSON,
	})
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("failed to create citizen: %v", err))
		return
	}

	if req.InitialMedicalRecord != nil {
		_, _ = s.store.CreateMedicalRecord(r.Context(), sqlc.CreateMedicalRecordParams{
			CitizenID:           citizen.ID,
			DistinguishingMarks: pgtype.Text{String: req.InitialMedicalRecord.DistinguishingMarks, Valid: true},
			BloodGroup:          pgtype.Text{String: req.InitialMedicalRecord.BloodGroup, Valid: true},
			Allergies:           req.InitialMedicalRecord.Allergies,
			BackgroundDiseases:  req.InitialMedicalRecord.BackgroundDiseases,
			CurrentMedications:  req.InitialMedicalRecord.CurrentMedications,
			Notes:               pgtype.Text{String: req.InitialMedicalRecord.Notes, Valid: true},
		})
	}

	_ = s.cloudRepo.PublishSystemEvent(r.Context(), "citizen.created", map[string]string{
		"citizen_id": utils.UUIDToString(citizen.ID),
		"action":     "CREATE",
		"reason":     "New registration",
	})
	_ = s.cloudRepo.PublishSystemEvent(r.Context(), "consent.granted", map[string]string{
		"citizen_id": utils.UUIDToString(citizen.ID),
		"action":     "CONSENT",
		"reason":     "Standard terms agreement",
	})

	utils.WriteJSON(w, http.StatusOK, api.RegisterResponse{
		Profile: s.mapCitizenToProfile(citizen),
	})
}

func (s *CitizenServer) VerifyIdentity(w http.ResponseWriter, r *http.Request) {
	fmt.Println("Verifying identity via REST...")

	var req api.VerifyIdentityRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}

	var citizenID string
	var method string
	var qrID pgtype.UUID

	if req.NfcID != "" {
		tag, err := s.store.GetNFCTag(r.Context(), req.NfcID)
		if err != nil {
			utils.WriteError(w, http.StatusNotFound, "NFC tag not found")
			return
		}
		if tag.Status != "ACTIVE" {
			utils.WriteError(w, http.StatusForbidden, "tag is not active")
			return
		}
		citizenID = utils.UUIDToString(tag.CitizenID)
		method = "NFC"
		_ = s.store.UpdateNFCLastUsed(r.Context(), tag.ID)
	} else if req.QrID != "" {
		_ = qrID.Scan(req.QrID)
		qr, err := s.store.GetQRCode(r.Context(), qrID)
		if err != nil {
			utils.WriteError(w, http.StatusNotFound, "QR code not found")
			return
		}
		if qr.Status != "ACTIVE" {
			utils.WriteError(w, http.StatusForbidden, "QR is not active")
			return
		}
		citizenID = utils.UUIDToString(qr.CitizenID)
		method = "QR"
		_ = s.store.UpdateQRLastUsed(r.Context(), qr.ID)
	} else {
		utils.WriteError(w, http.StatusBadRequest, "identifier required")
		return
	}

	if !utils.VerifyHash(citizenID, req.HashedCitizenID, s.systemSecret) {
		utils.WriteError(w, http.StatusUnauthorized, "invalid hash verification")
		return
	}

	var cID pgtype.UUID
	_ = cID.Scan(citizenID)
	citizen, _ := s.store.GetCitizen(r.Context(), cID)
	med, _ := s.store.GetMedicalRecord(r.Context(), cID)

	staffID := "unknown"
	_ = s.cloudRepo.PublishEmergencyEvent(r.Context(), "victim.identified", map[string]string{
		"staff_id":   staffID,
		"citizen_id": citizenID,
		"method":     method,
		"full_name":  citizen.FullName,
	})

	utils.WriteJSON(w, http.StatusOK, api.VerifyIdentityResponse{
		Profile:           s.mapCitizenToProfile(citizen),
		MedicalRecord:     s.mapMedicalRecord(med),
		EmergencyContacts: s.mapEmergencyContacts(citizen.EmergencyContacts),
	})
}

func (s *CitizenServer) SearchByFace(w http.ResponseWriter, r *http.Request) {
	var req api.SearchByFaceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}

	if len(req.FaceVector) == 0 {
		utils.WriteError(w, http.StatusBadRequest, "face_vector required")
		return
	}

	vec := pgvector.NewVector(req.FaceVector)
	hits, err := s.store.SearchCitizenByFace(r.Context(), sqlc.SearchCitizenByFaceParams{
		FaceEmbedding: vec,
		Limit:         1,
	})
	if err != nil || len(hits) == 0 {
		utils.WriteError(w, http.StatusNotFound, "no matching face found")
		return
	}

	bestMatch := hits[0]
	distance, _ := bestMatch.Distance.(float64)
	if distance > 0.6 {
		utils.WriteError(w, http.StatusNotFound, "face match confidence too low")
		return
	}

	cID := bestMatch.ID
	citizen, _ := s.store.GetCitizen(r.Context(), cID)
	med, _ := s.store.GetMedicalRecord(r.Context(), cID)

	staffID := "unknown"
	_ = s.cloudRepo.PublishEmergencyEvent(r.Context(), "victim.identified", map[string]string{
		"staff_id":   staffID,
		"citizen_id": utils.UUIDToString(cID),
		"method":     "FACE_SCAN",
		"full_name":  citizen.FullName,
	})

	utils.WriteJSON(w, http.StatusOK, api.SearchByFaceResponse{
		Profile:           s.mapCitizenToProfile(citizen),
		MedicalRecord:     s.mapMedicalRecord(med),
		EmergencyContacts: s.mapEmergencyContacts(citizen.EmergencyContacts),
	})
}

// ------ MAAPERS -------

func (s *CitizenServer) mapCitizenToProfile(c sqlc.Citizens) *api.CitizenProfile {
	return &api.CitizenProfile{
		ID:          utils.UUIDToString(c.ID),
		FullName:    c.FullName,
		DateOfBirth: c.DateOfBirth.Time.Format("2006-01-02"),
		Gender:      c.Gender.String,
		Address:     c.Address.String,
		Email:       c.Email.String,
		Phone:       c.Phone.String,
		CccdNumber:  c.CccdNumber.String,
		AvatarUrl:   c.AvatarUrl.String,
		CreatedAt:   c.CreatedAt.Time,
	}
}

func (s *CitizenServer) mapMedicalRecord(m sqlc.MedicalRecords) *api.MedicalRecord {
	return &api.MedicalRecord{
		ID:                  utils.UUIDToString(m.CitizenID),
		DistinguishingMarks: m.DistinguishingMarks.String,
		BloodGroup:          m.BloodGroup.String,
		Allergies:           m.Allergies,
		BackgroundDiseases:  m.BackgroundDiseases,
		CurrentMedications:  m.CurrentMedications,
		Notes:               m.Notes.String,
		UpdatedAt:           m.LastUpdated.Time,
	}
}

func (s *CitizenServer) mapEmergencyContacts(data []byte) []api.ContactInfo {
	var contacts []api.ContactInfo
	if len(data) > 0 {
		_ = json.Unmarshal(data, &contacts)
	}
	return contacts
}
