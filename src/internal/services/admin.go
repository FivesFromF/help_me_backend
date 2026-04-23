package services

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/cognitoidentityprovider"
	"github.com/aws/aws-sdk-go-v2/service/cognitoidentityprovider/types"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/fivesfromf/helpme/internal/api"
	"github.com/fivesfromf/helpme/internal/repository"
	"github.com/fivesfromf/helpme/internal/repository/sqlc"
	"github.com/fivesfromf/helpme/internal/utils"
)

type AdminServer struct {
	store         *repository.Store
	cognitoClient *cognitoidentityprovider.Client
	dbClient      *dynamodb.Client
	auditTable    string
	userPoolID    string
	s3Service     *utils.S3Service
}

func NewAdminServer(store *repository.Store, cognitoClient *cognitoidentityprovider.Client, dbClient *dynamodb.Client, auditTable, userPoolID string, s3Service *utils.S3Service) *AdminServer {
	return &AdminServer{
		store:         store,
		cognitoClient: cognitoClient,
		dbClient:      dbClient,
		auditTable:    auditTable,
		userPoolID:    userPoolID,
		s3Service:     s3Service,
	}
}

// GetSystemStats returns counts for each role table.
func (s *AdminServer) GetSystemStats(w http.ResponseWriter, r *http.Request) {
	citizens, _ := s.store.CountCitizens(r.Context())
	staff, _ := s.store.CountStaff(r.Context())
	admins, _ := s.store.CountAdmins(r.Context())
	emergency, _ := s.store.CountEmergencyToday(r.Context())

	utils.WriteJSON(w, http.StatusOK, api.GetSystemStatsResponse{
		TotalCitizens:        citizens,
		TotalStaff:           staff,
		TotalAdmins:          admins,
		EmergencyEventsToday: emergency,
	})
}

// ListStaff lists all staff members.
func (s *AdminServer) ListStaff(w http.ResponseWriter, r *http.Request) {
	staffList, err := s.store.ListStaff(r.Context())
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("failed to list staff: %v", err))
		return
	}

	profiles := make([]*api.StaffProfile, len(staffList))
	for i, staffRec := range staffList {
		profiles[i] = mapStaffToProfile(r.Context(), staffRec, s.s3Service)
	}

	utils.WriteJSON(w, http.StatusOK, map[string]interface{}{"staff": profiles})
}

// ManageStaff updates staff status (active/inactive/suspended).
func (s *AdminServer) ManageStaff(w http.ResponseWriter, r *http.Request) {
	var req api.ManageStaffRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid payload")
		return
	}

	staffID, err := utils.StringToUUID(req.StaffID)
	if err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid staff_id")
		return
	}

	updatedStaff, err := s.store.UpdateStaffStatus(r.Context(), sqlc.UpdateStaffStatusParams{
		ID:     staffID,
		Status: req.NewStatus,
	})
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("failed to update staff status: %v", err))
		return
	}

	utils.WriteJSON(w, http.StatusOK, api.ManageStaffResponse{
		Profile: mapStaffToProfile(r.Context(), updatedStaff, s.s3Service),
	})
}

// RegisterStaff creates a new staff member in Cognito and the staff table.
func (s *AdminServer) RegisterStaff(w http.ResponseWriter, r *http.Request) {
	var req api.RegisterStaffRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid payload")
		return
	}

	// 1. Create user in Cognito
	_, err := s.cognitoClient.AdminCreateUser(r.Context(), &cognitoidentityprovider.AdminCreateUserInput{
		UserPoolId: aws.String(s.userPoolID),
		Username:   aws.String(req.Email),
		UserAttributes: []types.AttributeType{
			{Name: aws.String("email"), Value: aws.String(req.Email)},
			{Name: aws.String("email_verified"), Value: aws.String("true")},
		},
		MessageAction: types.MessageActionTypeSuppress,
	})
	if err != nil && !strings.Contains(err.Error(), "UsernameExistsException") {
		utils.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("failed to create cognito user: %v", err))
		return
	}

	// 2. Add to 'Staff' group in Cognito
	_, _ = s.cognitoClient.AdminAddUserToGroup(r.Context(), &cognitoidentityprovider.AdminAddUserToGroupInput{
		UserPoolId: aws.String(s.userPoolID),
		Username:   aws.String(req.Email),
		GroupName:  aws.String("staff"),
	})

	// 3. Create staff record in DB (cognito_id will be updated on first login)
	staff, err := s.store.CreateStaff(r.Context(), sqlc.CreateStaffParams{
		CognitoID:    "PENDING_" + req.Email,
		Email:        req.Email,
		FullName:     req.FullName,
		Phone:        pgtype.Text{String: req.Phone, Valid: req.Phone != ""},
		HospitalName: req.HospitalName,
		Department:   pgtype.Text{String: req.Department, Valid: req.Department != ""},
		Status:       "active",
	})
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("failed to create staff record: %v", err))
		return
	}

	utils.WriteJSON(w, http.StatusOK, api.RegisterStaffResponse{
		Profile: mapStaffToProfile(r.Context(), staff, s.s3Service),
	})
}

// ListAuditLogs fetches audit logs from DynamoDB.
func (s *AdminServer) ListAuditLogs(w http.ResponseWriter, r *http.Request) {
	var req api.ListAuditLogsRequest
	_ = json.NewDecoder(r.Body).Decode(&req)

	limit := int32(20)
	if req.Limit > 0 {
		limit = req.Limit
	}

	result, err := s.dbClient.Scan(r.Context(), &dynamodb.ScanInput{
		TableName: aws.String(s.auditTable),
		Limit:     aws.Int32(limit),
	})
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("failed to scan audit logs: %v", err))
		return
	}

	type auditRecord struct {
		ID         string `dynamodbav:"id"`
		EventType  string `dynamodbav:"event_type"`
		ActorID    string `dynamodbav:"actor_id"`
		ResourceID string `dynamodbav:"resource_id"`
		Details    string `dynamodbav:"details"`
	}
	var records []auditRecord
	_ = attributevalue.UnmarshalListOfMaps(result.Items, &records)

	logs := make([]api.AuditLog, len(records))
	for i, rec := range records {
		logs[i] = api.AuditLog{
			ID:         rec.ID,
			EventType:  rec.EventType,
			ActorID:    rec.ActorID,
			ResourceID: rec.ResourceID,
			Details:    rec.Details,
		}
	}

	utils.WriteJSON(w, http.StatusOK, api.ListAuditLogsResponse{Logs: logs})
}
