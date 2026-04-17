package services

import (
	"context"
	"fmt"

	"github.com/bufbuild/connect-go"
	"github.com/jackc/pgx/v5/pgtype"
	helpmev1 "github.com/fivesfromf/helpme/internal/gen/v1"
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

func (s *EmergencyServer) ReportEmergency(
	ctx context.Context,
	req *connect.Request[helpmev1.ReportEmergencyRequest],
) (*connect.Response[helpmev1.ReportEmergencyResponse], error) {
	fmt.Printf("Reporting emergency at %s, %s\n", req.Msg.LocationLat, req.Msg.LocationLon)
	
	// Convert victim_id if provided
	var victimID pgtype.UUID
	if req.Msg.VictimId != "" {
		_ = victimID.Scan(req.Msg.VictimId)
	}

	report, err := s.store.CreateEmergencyReport(ctx, sqlc.CreateEmergencyReportParams{
		VictimID:             victimID,
		LocationLat:          req.Msg.LocationLat,
		LocationLon:          req.Msg.LocationLon,
		SituationDescription: pgtype.Text{String: req.Msg.SituationDescription, Valid: true},
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to report emergency: %w", err))
	}

	return connect.NewResponse(&helpmev1.ReportEmergencyResponse{
		Report: &helpmev1.EmergencyReport{
			Id:       utils.UUIDToString(report.ID),
			Status:   report.Status,
		},
	}), nil
}

func (s *EmergencyServer) GetEmergencyHistory(
	ctx context.Context,
	req *connect.Request[helpmev1.GetEmergencyHistoryRequest],
) (*connect.Response[helpmev1.GetEmergencyHistoryResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("not implemented yet"))
}
