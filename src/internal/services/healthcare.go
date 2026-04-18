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
	var req api.GetMedicalRecordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}

	fmt.Printf("Fetching medical record for citizen: %s by staff: %s\n", req.CitizenID, req.StaffID)

	var citizenID pgtype.UUID
	if err := citizenID.Scan(req.CitizenID); err != nil {
		utils.WriteError(w, http.StatusBadRequest, fmt.Sprintf("invalid citizen_id: %v", err))
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
	record, err := s.store.GetMedicalRecord(r.Context(), citizenID)
	if err != nil {
		utils.WriteError(w, http.StatusNotFound, fmt.Sprintf("medical record not found: %v", err))
		return
	}

	// 3. Publish Audit Event to EventBridge (Decoupled Logging)
	_ = s.cloudRepo.PublishSystemEvent(r.Context(), "access.medical_record", map[string]string{
		"staff_id":   req.StaffID,
		"citizen_id": req.CitizenID,
		"action":     "READ",
		"reason":     "Medical triage",
	})

	utils.WriteJSON(w, http.StatusOK, api.GetMedicalRecordResponse{
		Record: &api.ApiMedicalRecord{ // Use aliased internal DTO due to conflict with same package naming
			CitizenID:           utils.UUIDToString(record.CitizenID),
			DistinguishingMarks: record.DistinguishingMarks.String,
			BloodGroup:          record.BloodGroup.String,
			Allergies:           record.Allergies,
			BackgroundDiseases:  record.BackgroundDiseases,
			CurrentMedications:  record.CurrentMedications,
			Notes:               record.Notes.String,
			LastUpdated:         record.LastUpdated.Time,
		},
	})
}
