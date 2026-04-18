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

type EmergencyServer struct {
	store *repository.Store
}

func NewEmergencyServer(store *repository.Store) *EmergencyServer {
	return &EmergencyServer{store: store}
}

func (s *EmergencyServer) ReportEmergency(w http.ResponseWriter, r *http.Request) {
	var req api.ReportEmergencyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}

	fmt.Printf("Reporting emergency at %f, %f\n", req.LocationLat, req.LocationLon)

	var victimID pgtype.UUID
	if req.VictimID != "" {
		_ = victimID.Scan(req.VictimID)
	}

	report, err := s.store.CreateEmergencyReport(r.Context(), sqlc.CreateEmergencyReportParams{
		VictimID:             victimID,
		LocationLat:          fmt.Sprintf("%f", req.LocationLat),
		LocationLon:          fmt.Sprintf("%f", req.LocationLon),
		SituationDescription: pgtype.Text{String: req.SituationDescription, Valid: true},
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
