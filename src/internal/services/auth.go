package services

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/cognitoidentityprovider"
	"github.com/aws/aws-sdk-go-v2/service/cognitoidentityprovider/types"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/fivesfromf/helpme/internal/api"
	"github.com/fivesfromf/helpme/internal/repository"
	"github.com/fivesfromf/helpme/internal/repository/sqlc"
	"github.com/fivesfromf/helpme/internal/utils"
)

type AuthServer struct {
	store         *repository.Store
	cognitoClient *cognitoidentityprovider.Client
	userPoolID    string
	clientID      string
}

func NewAuthServer(store *repository.Store, cognitoClient *cognitoidentityprovider.Client, userPoolID, clientID string) *AuthServer {
	return &AuthServer{
		store:         store,
		cognitoClient: cognitoClient,
		userPoolID:    userPoolID,
		clientID:      clientID,
	}
}

func (s *AuthServer) RequestOTP(w http.ResponseWriter, r *http.Request) {
	var req api.RequestOTPRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}

	phone := req.Phone
	if phone == "" {
		utils.WriteError(w, http.StatusBadRequest, "phone number required")
		return
	}

	// Initiate Custom Auth Flow in Cognito (Citizen: OTP only)
	_, err := s.cognitoClient.InitiateAuth(r.Context(), &cognitoidentityprovider.InitiateAuthInput{
		AuthFlow: types.AuthFlowTypeCustomAuth,
		AuthParameters: map[string]string{
			"USERNAME": phone,
		},
		ClientId: aws.String(s.clientID),
	})

	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("failed to initiate citizen auth: %v", err))
		return
	}

	utils.WriteJSON(w, http.StatusOK, api.RequestOTPResponse{
		Success: true,
		Message: "OTP challenge initiated via Cognito",
	})
}

func (s *AuthServer) VerifyOTP(w http.ResponseWriter, r *http.Request) {
	var req api.VerifyOTPRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}

	phone := req.Phone
	code := req.Code

	// Respond to Custom Challenge (OTP Step)
	authResult, err := s.cognitoClient.RespondToAuthChallenge(r.Context(), &cognitoidentityprovider.RespondToAuthChallengeInput{
		ChallengeName: types.ChallengeNameTypeCustomChallenge,
		ChallengeResponses: map[string]string{
			"USERNAME": phone,
			"ANSWER":   code,
		},
		ClientId: aws.String(s.clientID),
	})

	if err != nil {
		utils.WriteError(w, http.StatusUnauthorized, fmt.Sprintf("invalid OTP: %v", err))
		return
	}

	if authResult.AuthenticationResult == nil {
		utils.WriteError(w, http.StatusUnauthorized, "authentication failed: challenge still pending")
		return
	}

	// Fetch profile from local DB
	if strings.Contains(phone, "@") {
		// Staff login (using email as 'phone' parameter)
		staff, err := s.store.GetStaffByEmail(r.Context(), phone)
		if err != nil {
			utils.WriteError(w, http.StatusNotFound, "staff profile not found")
			return
		}
		utils.WriteJSON(w, http.StatusOK, api.VerifyOTPResponse{
			Token:        *authResult.AuthenticationResult.IdToken,
			StaffProfile: s.mapStaffToProfile(staff),
		})
		return
	}

	// Try phone (Citizens)
	citizen, err := s.store.GetCitizenByPhone(r.Context(), pgtype.Text{String: phone, Valid: true})
	if err != nil {
		// New citizen: Cognito authenticated but DB profile missing.
		// Return Token so frontend can call Register()
		utils.WriteJSON(w, http.StatusOK, api.VerifyOTPResponse{
			Token:   *authResult.AuthenticationResult.IdToken,
			Profile: nil,
		})
		return
	}

	utils.WriteJSON(w, http.StatusOK, api.VerifyOTPResponse{
		Token:   *authResult.AuthenticationResult.IdToken,
		Profile: s.mapCitizenToProfile(citizen),
	})
}

func (s *AuthServer) StaffSignIn(w http.ResponseWriter, r *http.Request) {
	var req api.StaffSignInRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}

	email := req.Email
	password := req.Password

	// 1. Kick off Custom Auth Flow
	initInput := &cognitoidentityprovider.InitiateAuthInput{
		AuthFlow: types.AuthFlowTypeCustomAuth,
		AuthParameters: map[string]string{
			"USERNAME": email,
		},
		ClientId: aws.String(s.clientID),
	}

	resp, err := s.cognitoClient.InitiateAuth(r.Context(), initInput)
	if err != nil {
		utils.WriteError(w, http.StatusUnauthorized, fmt.Sprintf("failed to initiate staff auth: %v", err))
		return
	}

	// 2. We expect PASSWORD_VERIFIER challenge for Staff
	if resp.ChallengeName == types.ChallengeNameTypePasswordVerifier {
		challengeResp, err := s.cognitoClient.RespondToAuthChallenge(r.Context(), &cognitoidentityprovider.RespondToAuthChallengeInput{
			ChallengeName: types.ChallengeNameTypePasswordVerifier,
			ChallengeResponses: map[string]string{
				"USERNAME": email,
				"PASSWORD": password,
			},
			ClientId: aws.String(s.clientID),
			Session:  resp.Session,
		})

		if err != nil {
			utils.WriteError(w, http.StatusUnauthorized, fmt.Sprintf("invalid credentials: %v", err))
			return
		}

		// 3. Now it should be CUSTOM_CHALLENGE (OTP)
		if challengeResp.ChallengeName == types.ChallengeNameTypeCustomChallenge {
			staff, _ := s.store.GetStaffByEmail(r.Context(), email)
			utils.WriteJSON(w, http.StatusOK, api.StaffSignInResponse{
				Token:   "", // No token yet, needs OTP
				Profile: s.mapStaffToProfile(staff),
			})
			return
		}
	}

	utils.WriteError(w, http.StatusUnauthorized, "sign in failed to enter MFA stage")
}

func (s *AuthServer) mapCitizenToProfile(c sqlc.Citizens) *api.CitizenProfile {
	return &api.CitizenProfile{
		ID:          utils.UUIDToString(c.ID),
		FullName:    c.FullName,
		DateOfBirth: c.DateOfBirth.Time.Format("2006-01-02"),
		Gender:      c.Gender.String,
		Address:     c.Address.String,
		Email:       c.Email.String,
		Phone:       c.Phone.String,
		CccdNumber:  c.CccdNumber.String,
		AvatarUrl:   c.AvatarUrl.String,
		CreatedAt:   c.CreatedAt.Time,
	}
}

func (s *AuthServer) mapStaffToProfile(staff sqlc.HealthcareStaff) *api.StaffProfile {
	return &api.StaffProfile{
		ID:           utils.UUIDToString(staff.ID),
		FullName:     staff.FullName,
		Email:        staff.Email,
		HospitalName: staff.HospitalName.String,
		Role:         staff.Role,
		Status:       staff.Status,
		CreatedAt:    staff.CreatedAt.Time,
	}
}
