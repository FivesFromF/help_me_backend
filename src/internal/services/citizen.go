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

// Register completes the citizen profile after first Google login.
func (s *CitizenServer) Register(w http.ResponseWriter, r *http.Request) {
	var req api.RegisterCitizenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}

	cognitoID := r.Header.Get("X-Cognito-Id")
	if cognitoID == "" {
		utils.WriteError(w, http.StatusUnauthorized, "identity required")
		return
	}

	citizen, err := s.store.GetCitizenByCognitoID(r.Context(), cognitoID)
	if err != nil {
		utils.WriteError(w, http.StatusNotFound, "citizen record not found")
		return
	}

	fmt.Printf("Completing citizen profile: %s\n", citizen.Email)

	var dob pgtype.Date
	if req.DateOfBirth != "" {
		t, err := time.Parse("2006-01-02", req.DateOfBirth)
		if err == nil {
			dob = pgtype.Date{Time: t, Valid: true}
		}
	}

	updatedCitizen, err := s.store.UpdateCitizen(r.Context(), sqlc.UpdateCitizenParams{
		ID:          citizen.ID,
		FullName:    req.FullName,
		Phone:       pgtype.Text{String: req.Phone, Valid: req.Phone != ""},
		AvatarUrl:   pgtype.Text{String: req.AvatarUrl, Valid: req.AvatarUrl != ""},
		DateOfBirth: dob,
		Gender:      pgtype.Text{String: req.Gender, Valid: req.Gender != ""},
		Address:     pgtype.Text{String: req.Address, Valid: req.Address != ""},
		CccdNumber:  pgtype.Text{String: req.CccdNumber, Valid: req.CccdNumber != ""},
	})
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("failed to update citizen: %v", err))
		return
	}

	// Handle face embedding
	if len(req.FaceVector) > 0 {
		vec := pgvector.NewVector(req.FaceVector)
		_ = s.store.UpdateCitizenFaceEmbedding(r.Context(), sqlc.UpdateCitizenFaceEmbeddingParams{
			ID:            citizen.ID,
			FaceEmbedding: &vec,
		})
	}

	// Create initial medical record
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

	_ = s.cloudRepo.PublishSystemEvent(r.Context(), "citizen.profile_updated", map[string]string{
		"citizen_id": utils.UUIDToString(citizen.ID),
	})

	utils.WriteJSON(w, http.StatusOK, api.RegisterCitizenResponse{
		Profile: mapCitizenToProfile(updatedCitizen),
	})
}

// VerifyIdentity identifies a victim via NFC or QR code.
func (s *CitizenServer) VerifyIdentity(w http.ResponseWriter, r *http.Request) {
	var req api.VerifyIdentityRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}

	var citizenID string
	var method string

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
		var qrID pgtype.UUID
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
		utils.WriteError(w, http.StatusBadRequest, "identifier required (nfcId or qrId)")
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

	_ = s.cloudRepo.PublishEmergencyEvent(r.Context(), "victim.identified", map[string]string{
		"citizen_id": citizenID,
		"method":     method,
		"full_name":  citizen.FullName,
	})

	utils.WriteJSON(w, http.StatusOK, api.VerifyIdentityResponse{
		Profile:           mapCitizenToProfile(citizen),
		MedicalRecord:     mapMedicalRecord(med),
		EmergencyContacts: mapEmergencyContacts(citizen.EmergencyContacts),
	})
}

// SearchByFace searches citizens by face vector.
func (s *CitizenServer) SearchByFace(w http.ResponseWriter, r *http.Request) {
	var req api.SearchByFaceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}

	vec := pgvector.NewVector(req.FaceVector)
	hits, err := s.store.SearchCitizenByFace(r.Context(), sqlc.SearchCitizenByFaceParams{
		FaceEmbedding: &vec,
		Limit:         1,
	})
	if err != nil || len(hits) == 0 {
		utils.WriteError(w, http.StatusNotFound, "no matching face found")
		return
	}

	bestMatch := hits[0]
	citizen, _ := s.store.GetCitizen(r.Context(), bestMatch.ID)
	med, _ := s.store.GetMedicalRecord(r.Context(), bestMatch.ID)

	_ = s.cloudRepo.PublishEmergencyEvent(r.Context(), "victim.identified", map[string]string{
		"citizen_id": utils.UUIDToString(bestMatch.ID),
		"method":     "FACE_SCAN",
		"full_name":  citizen.FullName,
	})

	utils.WriteJSON(w, http.StatusOK, api.SearchByFaceResponse{
		Profile:           mapCitizenToProfile(citizen),
		MedicalRecord:     mapMedicalRecord(med),
		EmergencyContacts: mapEmergencyContacts(citizen.EmergencyContacts),
	})
}

// ------- Mappers -------

func mapMedicalRecord(m sqlc.MedicalRecords) *api.MedicalRecord {
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

func mapEmergencyContacts(data []byte) []api.ContactInfo {
	var contacts []api.ContactInfo
	if len(data) > 0 {
		_ = json.Unmarshal(data, &contacts)
	}
	return contacts
}
