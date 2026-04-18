package services

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/cognitoidentityprovider"
	"github.com/aws/aws-sdk-go-v2/service/cognitoidentityprovider/types"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/jackc/pgx/v5/pgtype"
	"golang.org/x/crypto/bcrypt"

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
}

func NewAdminServer(store *repository.Store, cognitoClient *cognitoidentityprovider.Client, dbClient *dynamodb.Client, auditTable, userPoolID string) *AdminServer {
	return &AdminServer{
		store:         store,
		cognitoClient: cognitoClient,
		dbClient:      dbClient,
		auditTable:    auditTable,
		userPoolID:    userPoolID,
	}
}

type AuditRecord struct {
	ID         string    `dynamodbav:"id"`
	EventType  string    `dynamodbav:"event_type"`
	ActorID    string    `dynamodbav:"actor_id"`
	ResourceID string    `dynamodbav:"resource_id"`
	Details    string    `dynamodbav:"details"`
	Timestamp  time.Time `dynamodbav:"timestamp"`
}

func (s *AdminServer) ListAuditLogs(w http.ResponseWriter, r *http.Request) {
	var req api.ListAuditLogsRequest
	_ = json.NewDecoder(r.Body).Decode(&req)

	limit := int32(20)
	if req.Limit > 0 {
		limit = req.Limit
	}

	input := &dynamodb.ScanInput{
		TableName: aws.String(s.auditTable),
		Limit:     aws.Int32(limit),
	}

	result, err := s.dbClient.Scan(r.Context(), input)
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("failed to scan audit logs: %v", err))
		return
	}

	var records []AuditRecord
	err = attributevalue.UnmarshalListOfMaps(result.Items, &records)
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("failed to unmarshal logs: %v", err))
		return
	}

	apiLogs := make([]api.AuditLog, len(records))
	for i, rec := range records {
		apiLogs[i] = api.AuditLog{
			ID:         rec.ID,
			EventType:  rec.EventType,
			ActorID:    rec.ActorID,
			ResourceID: rec.ResourceID,
			Details:    rec.Details,
			Timestamp:  rec.Timestamp,
		}
	}

	utils.WriteJSON(w, http.StatusOK, api.ListAuditLogsResponse{
		Logs:      apiLogs,
		NextToken: "",
	})
}

func (s *AdminServer) GetSystemStats(w http.ResponseWriter, r *http.Request) {
	citizensCount, err := s.store.GetCountCitizens(r.Context())
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, "failed to get citizen count")
		return
	}

	staffCount, err := s.store.GetCountStaff(r.Context())
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, "failed to get staff count")
		return
	}

	emergencyToday, err := s.store.GetCountEmergencyToday(r.Context())
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, "failed to get emergency count")
		return
	}

	utils.WriteJSON(w, http.StatusOK, api.GetSystemStatsResponse{
		TotalCitizens:        citizensCount,
		TotalStaff:           staffCount,
		EmergencyEventsToday: emergencyToday,
	})
}

func (s *AdminServer) ManageStaff(w http.ResponseWriter, r *http.Request) {
	var req api.ManageStaffRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid payload")
		return
	}

	staffID, err := utils.StringToUUID(req.StaffID)
	if err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid staff id")
		return
	}

	err = s.store.UpdateStaffStatus(r.Context(), sqlc.UpdateStaffStatusParams{
		ID:     staffID,
		Status: req.NewStatus,
	})
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("failed to update staff status: %v", err))
		return
	}

	utils.WriteJSON(w, http.StatusOK, api.ManageStaffResponse{
		Success: true,
		Message: "Staff status updated successfully",
	})
}

func (s *AdminServer) RegisterStaff(w http.ResponseWriter, r *http.Request) {
	var req api.RegisterStaffRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid payload")
		return
	}

	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, "failed to hash password")
		return
	}

	_, err = s.cognitoClient.AdminCreateUser(r.Context(), &cognitoidentityprovider.AdminCreateUserInput{
		UserPoolId: aws.String(s.userPoolID),
		Username:   aws.String(req.Email),
		UserAttributes: []types.AttributeType{
			{Name: aws.String("email"), Value: aws.String(req.Email)},
			{Name: aws.String("phone_number"), Value: aws.String(req.Phone)},
			{Name: aws.String("custom:role"), Value: aws.String(req.Role)},
			{Name: aws.String("email_verified"), Value: aws.String("true")},
			{Name: aws.String("phone_number_verified"), Value: aws.String("true")},
		},
		TemporaryPassword: aws.String(req.Password),
		MessageAction:     types.MessageActionTypeSuppress,
	})
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("failed to create staff in cognito: %v", err))
		return
	}

	_, _ = s.cognitoClient.AdminSetUserPassword(r.Context(), &cognitoidentityprovider.AdminSetUserPasswordInput{
		UserPoolId: aws.String(s.userPoolID),
		Username:   aws.String(req.Email),
		Password:   aws.String(req.Password),
		Permanent:  true,
	})

	groupName := "Staff"
	if req.Role == "ADMIN" {
		groupName = "Admins"
	}
	_, _ = s.cognitoClient.AdminAddUserToGroup(r.Context(), &cognitoidentityprovider.AdminAddUserToGroupInput{
		UserPoolId: aws.String(s.userPoolID),
		Username:   aws.String(req.Email),
		GroupName:  aws.String(groupName),
	})

	staff, err := s.store.CreateStaff(r.Context(), sqlc.CreateStaffParams{
		FullName:     req.FullName,
		Email:        req.Email,
		PasswordHash: string(hashedPassword),
		HospitalName: pgtype.Text{String: req.HospitalName, Valid: req.HospitalName != ""},
		Role:         req.Role,
		Phone:        pgtype.Text{String: req.Phone, Valid: req.Phone != ""},
	})
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("failed to store staff record: %v", err))
		return
	}

	utils.WriteJSON(w, http.StatusOK, api.RegisterStaffResponse{
		Profile: &api.StaffProfile{
			ID:           utils.UUIDToString(staff.ID),
			FullName:     staff.FullName,
			Email:        staff.Email,
			HospitalName: staff.HospitalName.String,
			Role:         staff.Role,
			Status:       staff.Status,
			CreatedAt:    staff.CreatedAt.Time,
		},
	})
}
