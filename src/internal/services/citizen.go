package services

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/bufbuild/connect-go"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pgvector/pgvector-go"
	"google.golang.org/protobuf/types/known/timestamppb"

	helpmev1 "github.com/fivesfromf/helpme/internal/gen/v1"
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

func (s *CitizenServer) Register(
	ctx context.Context,
	req *connect.Request[helpmev1.RegisterRequest],
) (*connect.Response[helpmev1.RegisterResponse], error) {
	fmt.Printf("Registering citizen: %s\n", req.Msg.FullName)

	// 1. Map Face Vector
	var faceVec pgvector.Vector
	if len(req.Msg.FaceVector) > 0 {
		faceVec = pgvector.NewVector(req.Msg.FaceVector)
	}

	// 2. Parse DOB
	var dob pgtype.Date
	if req.Msg.DateOfBirth != "" {
		t, err := time.Parse("2006-01-02", req.Msg.DateOfBirth)
		if err == nil {
			dob = pgtype.Date{Time: t, Valid: true}
		}
	}

	// 3. Create Citizen (CCCD)
	var cccd pgtype.Text
	if req.Msg.CccdNumber != "" {
		cccd = pgtype.Text{String: req.Msg.CccdNumber, Valid: true}
	}

	// 3. Marshal Emergency Contacts to JSON
	contactsJSON, _ := json.Marshal(req.Msg.EmergencyContacts)

	// 4. Create Citizen
	citizen, err := s.store.CreateCitizen(ctx, sqlc.CreateCitizenParams{
		FullName:          req.Msg.FullName,
		DateOfBirth:       dob,
		Gender:            pgtype.Text{String: req.Msg.Gender, Valid: req.Msg.Gender != ""},
		Address:           pgtype.Text{String: req.Msg.Address, Valid: req.Msg.Address != ""},
		Email:             pgtype.Text{String: req.Msg.Email, Valid: req.Msg.Email != ""},
		Phone:             pgtype.Text{String: req.Msg.Phone, Valid: req.Msg.Phone != ""},
		CccdNumber:        cccd,
		AvatarUrl:         pgtype.Text{String: req.Msg.AvatarUrl, Valid: req.Msg.AvatarUrl != ""},
		FaceEmbedding:     faceVec,
		EmergencyContacts: contactsJSON,
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to create citizen: %w", err))
	}

	// 5. Create Medical Record if provided
	if req.Msg.InitialMedicalRecord != nil {
		_, _ = s.store.CreateMedicalRecord(ctx, sqlc.CreateMedicalRecordParams{
			CitizenID:           citizen.ID,
			DistinguishingMarks: pgtype.Text{String: req.Msg.InitialMedicalRecord.DistinguishingMarks, Valid: true},
			BloodGroup:          pgtype.Text{String: req.Msg.InitialMedicalRecord.BloodGroup, Valid: true},
			Allergies:           req.Msg.InitialMedicalRecord.Allergies,
			BackgroundDiseases:  req.Msg.InitialMedicalRecord.BackgroundDiseases,
			CurrentMedications:  req.Msg.InitialMedicalRecord.CurrentMedications,
			Notes:               pgtype.Text{String: req.Msg.InitialMedicalRecord.Notes, Valid: true},
		})
	}

	// 6. Publish Audit Events
	_ = s.cloudRepo.PublishEvent(ctx, "citizen.created", map[string]string{
		"citizen_id": citizen.ID.String(),
		"action":     "CREATE",
		"reason":     "New registration",
	})

	_ = s.cloudRepo.PublishEvent(ctx, "consent.granted", map[string]string{
		"citizen_id": citizen.ID.String(),
		"action":     "CONSENT",
		"reason":     "Standard terms agreement",
	})

	return connect.NewResponse(&helpmev1.RegisterResponse{
		Profile: s.mapCitizenToProfile(citizen),
	}), nil
}

func (s *CitizenServer) VerifyIdentity(
	ctx context.Context,
	req *connect.Request[helpmev1.VerifyIdentityRequest],
) (*connect.Response[helpmev1.VerifyIdentityResponse], error) {
	fmt.Println("Verifying identity...")

	var citizenID string
	var method string
	var qrID pgtype.UUID // Still need qrID for Scan if QR is used

	// 1. Retrieve Row by ID
	if req.Msg.GetNfcId() != "" {
		tag, err := s.store.GetNFCTag(ctx, req.Msg.GetNfcId())
		if err != nil {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("NFC tag not found"))
		}
		if tag.Status != "ACTIVE" {
			return nil, connect.NewError(connect.CodePermissionDenied, fmt.Errorf("tag is not active"))
		}
		citizenID = tag.CitizenID.String()
		method = "NFC"
		_ = s.store.UpdateNFCLastUsed(ctx, tag.ID)
	} else if req.Msg.GetQrId() != "" {
		_ = qrID.Scan(req.Msg.GetQrId())
		qr, err := s.store.GetQRCode(ctx, qrID)
		if err != nil {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("QR code not found"))
		}
		if qr.Status != "ACTIVE" {
			return nil, connect.NewError(connect.CodePermissionDenied, fmt.Errorf("QR is not active"))
		}
		citizenID = qr.CitizenID.String()
		method = "QR"
		_ = s.store.UpdateQRLastUsed(ctx, qr.ID)
	} else {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("identifier required"))
	}

	// 2. Security Check: Verify Hash (Hash is NOT stored, it's computed on-the-fly)
	if !utils.VerifyHash(citizenID, req.Msg.HashedCitizenId, s.systemSecret) {
		return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("invalid hash verification"))
	}

	// 3. Fetch Full Profile
	var cID pgtype.UUID
	_ = cID.Scan(citizenID)
	citizen, _ := s.store.GetCitizen(ctx, cID)
	med, _ := s.store.GetMedicalRecord(ctx, cID)
	// CreateAccessSession is now handled asynchronously by Grant Permission Worker via EventBridge

	// Publish Identification Event for Auditing and Notifications
	staffID := "unknown" // In real world, extract from request context/authorizer
	_ = s.cloudRepo.PublishEvent(ctx, "victim.identified", map[string]string{
		"staff_id":   staffID,
		"citizen_id": citizenID,
		"method":     method,
		"full_name":  citizen.FullName,
	})

	return connect.NewResponse(&helpmev1.VerifyIdentityResponse{
		Profile:           s.mapCitizenToProfile(citizen),
		MedicalRecord:     s.mapMedicalRecord(med),
		EmergencyContacts: s.mapEmergencyContacts(citizen.EmergencyContacts),
	}), nil
}

func (s *CitizenServer) SearchByFace(
	ctx context.Context,
	req *connect.Request[helpmev1.SearchByFaceRequest],
) (*connect.Response[helpmev1.SearchByFaceResponse], error) {
	if len(req.Msg.FaceVector) == 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("face_vector required"))
	}

	vec := pgvector.NewVector(req.Msg.FaceVector)
	hits, err := s.store.SearchCitizenByFace(ctx, sqlc.SearchCitizenByFaceParams{
		FaceEmbedding: vec,
		Limit:         1,
	})
	if err != nil || len(hits) == 0 {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no matching face found"))
	}

	bestMatch := hits[0]
	// Using a simple distance threshold for MVP (e.g., < 0.6)
	// Distance is returned by pgvector <-> operator
	distance, _ := bestMatch.Distance.(float64)
	if distance > 0.6 {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("face match confidence too low"))
	}

	res := &helpmev1.SearchByFaceResponse{
		Profile: &helpmev1.CitizenProfile{
			Id:         bestMatch.ID.String(),
			FullName:   bestMatch.FullName,
			CccdNumber: bestMatch.CccdNumber.String,
			AvatarUrl:  bestMatch.AvatarUrl.String,
			CreatedAt:  timestamppb.New(bestMatch.CreatedAt.Time),
		},
		MatchScore: float32(1.0 - distance),
	}

	// Publish Identification Event (Identification Category)
	// This event now triggers Grant Permission Worker asynchronously
	staffID := "unknown" // Extract from context/authorizer in production
	_ = s.cloudRepo.PublishEvent(ctx, "victim.identified", map[string]string{
		"staff_id":   staffID,
		"citizen_id": bestMatch.ID.String(),
		"method":     "FACE_SEARCH",
		"full_name":  bestMatch.FullName,
	})

	return connect.NewResponse(res), nil
}

// Helper Mappings
func (s *CitizenServer) mapCitizenToProfile(c sqlc.Citizens) *helpmev1.CitizenProfile {
	return &helpmev1.CitizenProfile{
		Id:          c.ID.String(),
		FullName:    c.FullName,
		DateOfBirth: c.DateOfBirth.Time.Format("2006-01-02"),
		Gender:      c.Gender.String,
		Address:     c.Address.String,
		Email:       c.Email.String,
		Phone:       c.Phone.String,
		CccdNumber:  c.CccdNumber.String,
		AvatarUrl:   c.AvatarUrl.String,
		CreatedAt:   timestamppb.New(c.CreatedAt.Time),
	}
}

func (s *CitizenServer) mapMedicalRecord(m sqlc.MedicalRecords) *helpmev1.MedicalRecord {
	return &helpmev1.MedicalRecord{
		CitizenId:           m.CitizenID.String(),
		DistinguishingMarks: m.DistinguishingMarks.String,
		BloodGroup:          m.BloodGroup.String,
		Allergies:           m.Allergies,
		BackgroundDiseases:  m.BackgroundDiseases,
		CurrentMedications:  m.CurrentMedications,
		Notes:               m.Notes.String,
		LastUpdated:         timestamppb.New(m.LastUpdated.Time),
	}
}

func (s *CitizenServer) mapEmergencyContacts(contactsJSON []byte) []*helpmev1.EmergencyContact {
	var results []*helpmev1.EmergencyContact
	if len(contactsJSON) > 0 {
		_ = json.Unmarshal(contactsJSON, &results)
	}
	return results
}

// Implement stubs for NFC/QR management
func (s *CitizenServer) RegisterNFCTag(ctx context.Context, req *connect.Request[helpmev1.RegisterNFCTagRequest]) (*connect.Response[helpmev1.RegisterNFCTagResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("not implemented yet"))
}
func (s *CitizenServer) CreateQRCode(ctx context.Context, req *connect.Request[helpmev1.CreateQRCodeRequest]) (*connect.Response[helpmev1.CreateQRCodeResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("not implemented yet"))
}
func (s *CitizenServer) UpdateTagStatus(ctx context.Context, req *connect.Request[helpmev1.UpdateTagStatusRequest]) (*connect.Response[helpmev1.UpdateTagStatusResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("not implemented yet"))
}
func (s *CitizenServer) GetProfile(ctx context.Context, req *connect.Request[helpmev1.GetProfileRequest]) (*connect.Response[helpmev1.GetProfileResponse], error) {
	var cID pgtype.UUID
	if err := cID.Scan(req.Msg.Id); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid citizen id"))
	}

	citizen, err := s.store.GetCitizen(ctx, cID)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("citizen not found"))
	}

	med, _ := s.store.GetMedicalRecord(ctx, cID)

	// Publish Audit Event (CRUD Read & Medical Access)
	// For MVP, we assume the requester might be the citizen themselves or an authorized staff
	staffID := "unknown" 
	_ = s.cloudRepo.PublishEvent(ctx, "access.medical_record", map[string]string{
		"staff_id":   staffID,
		"citizen_id": req.Msg.Id,
		"action":     "READ",
		"reason":     "Profile view",
	})

	return connect.NewResponse(&helpmev1.GetProfileResponse{
		Profile:           s.mapCitizenToProfile(citizen),
		MedicalRecord:     s.mapMedicalRecord(med),
		EmergencyContacts: s.mapEmergencyContacts(citizen.EmergencyContacts),
	}), nil
}

func (s *CitizenServer) UpdateProfile(ctx context.Context, req *connect.Request[helpmev1.UpdateProfileRequest]) (*connect.Response[helpmev1.UpdateProfileResponse], error) {
	var cID pgtype.UUID
	if err := cID.Scan(req.Msg.Id); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid citizen id"))
	}

	params := sqlc.UpdateCitizenParams{
		ID:        cID,
		FullName:  pgtype.Text{String: req.Msg.GetFullName(), Valid: req.Msg.FullName != nil},
		Address:   pgtype.Text{String: req.Msg.GetAddress(), Valid: req.Msg.Address != nil},
		Email:     pgtype.Text{String: req.Msg.GetEmail(), Valid: req.Msg.Email != nil},
		AvatarUrl: pgtype.Text{String: req.Msg.GetAvatarUrl(), Valid: req.Msg.AvatarUrl != nil},
	}

	citizen, err := s.store.UpdateCitizen(ctx, params)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to update profile: %w", err))
	}

	// Publish Audit Event (CRUD Update)
	_ = s.cloudRepo.PublishEvent(ctx, "citizen.updated", map[string]string{
		"citizen_id": citizen.ID.String(),
		"action":     "UPDATE",
		"reason":     "Profile update",
	})

	return connect.NewResponse(&helpmev1.UpdateProfileResponse{
		Profile: s.mapCitizenToProfile(citizen),
	}), nil
}
