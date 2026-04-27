package services

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/fivesfromf/helpme/internal/api"
	"github.com/fivesfromf/helpme/internal/repository"
	"github.com/fivesfromf/helpme/internal/repository/sqlc"
	"github.com/fivesfromf/helpme/internal/utils"
)

type EmergencyService struct {
	store *repository.Store
}

func NewEmergencyService(store *repository.Store) *EmergencyService {
	return &EmergencyService{store: store}
}

func (s *EmergencyService) ReportEmergency(w http.ResponseWriter, r *http.Request) {
	var req api.ReportEmergencyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}

	fmt.Printf("Reporting emergency at %f, %f\n", req.LocationLat, req.LocationLon)

	// Stub: Extract reporter from header (passed by API Gateway authorizer)
	var reporterID pgtype.UUID
	reporterHeader := r.Header.Get("X-User-Id")
	if reporterHeader != "" {
		_ = reporterID.Scan(reporterHeader)
	}

	var victimID pgtype.UUID
	if req.VictimID != "" {
		_ = victimID.Scan(req.VictimID)
	}

	report, err := s.store.CreateEmergencyReport(r.Context(), sqlc.CreateEmergencyReportParams{
		ReporterID:           reporterID,
		VictimID:             victimID,
		LocationLat:          fmt.Sprintf("%f", req.LocationLat),
		LocationLon:          fmt.Sprintf("%f", req.LocationLon),
		SituationDescription: pgtype.Text{String: req.SituationDescription, Valid: true},
		Status:               "PENDING",
	})
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("failed to report emergency: %v", err))
		return
	}

	utils.WriteJSON(w, http.StatusOK, api.ReportEmergencyResponse{
		Report: &api.EmergencyReport{
			ID:     utils.UUIDToString(report.ID),
			Status: report.Status,
		},
	})
}
