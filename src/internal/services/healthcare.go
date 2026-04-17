package services

import (
	"context"
	"fmt"

	"github.com/bufbuild/connect-go"
	"github.com/jackc/pgx/v5/pgtype"
	"google.golang.org/protobuf/types/known/timestamppb"

	helpmev1 "github.com/fivesfromf/helpme/internal/gen/v1"
	"github.com/fivesfromf/helpme/internal/repository"
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

func (s *HealthcareServer) GetData(
	ctx context.Context,
	req *connect.Request[helpmev1.GetMedicalRecordRequest],
) (*connect.Response[helpmev1.GetMedicalRecordResponse], error) {
	fmt.Printf("Fetching medical record for citizen: %s by staff: %s\n", req.Msg.CitizenId, req.Msg.StaffId)
	
	var citizenID pgtype.UUID
	if err := citizenID.Scan(req.Msg.CitizenId); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid citizen_id: %w", err))
	}

	// 1. Check for Active Session in DynamoDB (Privacy Lock)
	staffID := req.Msg.StaffId
	hasAccess, err := s.cloudRepo.CheckAccessSession(ctx, staffID, req.Msg.CitizenId)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to verify access session: %w", err))
	}
	if !hasAccess {
		return nil, connect.NewError(connect.CodePermissionDenied, fmt.Errorf("no active identification session found for this victim"))
	}

	// 2. Fetch Data from RDS
	record, err := s.store.GetMedicalRecord(ctx, citizenID)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("medical record not found: %w", err))
	}

	// 3. Publish Audit Event to EventBridge (Decoupled Logging)
	_ = s.cloudRepo.PublishEvent(ctx, "access.medical_record", map[string]string{
		"staff_id":   staffID,
		"citizen_id": req.Msg.CitizenId,
		"action":     "READ",
		"reason":     "Medical triage",
	})

	return connect.NewResponse(&helpmev1.GetMedicalRecordResponse{
		Record: &helpmev1.MedicalRecord{
			CitizenId:           record.CitizenID.String(),
			DistinguishingMarks: record.DistinguishingMarks.String,
			BloodGroup:          record.BloodGroup.String,
			Allergies:           record.Allergies,
			BackgroundDiseases:  record.BackgroundDiseases,
			CurrentMedications:  record.CurrentMedications,
			Notes:               record.Notes.String,
			LastUpdated:         timestamppb.New(record.LastUpdated.Time),
		},
	}), nil
}

func (s *HealthcareServer) LogAccess(
	ctx context.Context,
	req *connect.Request[helpmev1.LogAccessRequest],
) (*connect.Response[helpmev1.LogAccessResponse], error) {
	// Auditing is handled via EventBridge workers in the full architecture,
	// but for MVP we log directly in GetData.
	return connect.NewResponse(&helpmev1.LogAccessResponse{Success: true}), nil
}
