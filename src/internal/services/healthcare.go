package services

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/fivesfromf/helpme/internal/api"
	"github.com/fivesfromf/helpme/internal/repository"
	"github.com/fivesfromf/helpme/internal/utils"
)

type HealthcareServer struct {
	store           *repository.Store
	timestreamStore *repository.TimestreamStore // Deprecated
	cloudRepo       *repository.CloudRepository
}

func NewHealthcareServer(store *repository.Store, cloudRepo *repository.CloudRepository) *HealthcareServer {
	return &HealthcareServer{
		store:     store,
		cloudRepo: cloudRepo,
	}
}

func (s *HealthcareServer) GetData(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CitizenID string `json:"citizenId"`
		StaffID   string `json:"staffId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}

	fmt.Printf("Fetching medical record for user: %s by staff: %s\n", req.CitizenID, req.StaffID)

	var userID pgtype.UUID
	if err := userID.Scan(req.CitizenID); err != nil {
		utils.WriteError(w, http.StatusBadRequest, fmt.Sprintf("invalid citizenId: %v", err))
		return
	}

	// 1. Check for Active Session in DynamoDB (Privacy Lock)
	hasAccess, err := s.cloudRepo.CheckAccessSession(r.Context(), req.StaffID, req.CitizenID)
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("failed to verify access session: %v", err))
		return
	}
	if !hasAccess {
		utils.WriteError(w, http.StatusForbidden, "no active identification session found for this victim")
		return
	}

	// 2. Fetch Data from RDS
	record, err := s.store.GetMedicalRecord(r.Context(), userID)
	if err != nil {
		utils.WriteError(w, http.StatusNotFound, fmt.Sprintf("medical record not found: %v", err))
		return
	}

	// 3. Publish Audit Event to EventBridge
	_ = s.cloudRepo.PublishSystemEvent(r.Context(), "access.medical_record", map[string]string{
		"staff_id":   req.StaffID,
		"citizen_id": req.CitizenID,
		"action":     "READ",
		"reason":     "Medical triage",
	})

	utils.WriteJSON(w, http.StatusOK, api.GetMedicalRecordResponse{
		Record: &api.MedicalRecord{
			ID:                  utils.UUIDToString(record.CitizenID),
			DistinguishingMarks: record.DistinguishingMarks.String,
			BloodGroup:          record.BloodGroup.String,
			Allergies:           record.Allergies,
			BackgroundDiseases:  record.BackgroundDiseases,
			CurrentMedications:  record.CurrentMedications,
			Notes:               record.Notes.String,
			UpdatedAt:           record.LastUpdated.Time,
		},
	})
}
