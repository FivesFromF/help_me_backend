package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/golang-jwt/jwt/v5"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/cognitoidentityprovider"
	"github.com/aws/aws-sdk-go-v2/service/cognitoidentityprovider/types"
	"github.com/fivesfromf/helpme/internal/api"
	"github.com/fivesfromf/helpme/internal/repository"
	"github.com/fivesfromf/helpme/internal/repository/sqlc"
	"github.com/fivesfromf/helpme/internal/utils"
)

type AuthService struct {
	store         *repository.Store
	cognitoClient *cognitoidentityprovider.Client
	appClientID   string
	cognitoDomain string
	redirectURI   string
	s3Service     *utils.S3Service
}

func NewAuthService(store *repository.Store, cognitoClient *cognitoidentityprovider.Client, s3Service *utils.S3Service) *AuthService {
	return &AuthService{
		store:         store,
		cognitoClient: cognitoClient,
		appClientID:   os.Getenv("COGNITO_CLIENT_ID"),
		cognitoDomain: os.Getenv("COGNITO_DOMAIN"),
		redirectURI:   os.Getenv("COGNITO_REDIRECT_URI"),
		s3Service:     s3Service,
	}
}

// SignIn handles Google token exchange.
// It reads the Cognito Group from the JWT to determine role,
// then fetches or creates the correct record in the matching table.
func (s *AuthService) SignIn(w http.ResponseWriter, r *http.Request) {
	var req api.SignInRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid payload")
		return
	}

	accessToken := req.AccessToken

	// If Email/Password provided, exchange for a token first (for Admin/Staff login)
	if req.Email != "" && req.Password != "" {
		output, err := s.cognitoClient.InitiateAuth(r.Context(), &cognitoidentityprovider.InitiateAuthInput{
			AuthFlow: types.AuthFlowTypeUserPasswordAuth,
			ClientId: aws.String(s.appClientID),
			AuthParameters: map[string]string{
				"USERNAME": req.Email,
				"PASSWORD": req.Password,
			},
		})
		if err != nil {
			utils.WriteError(w, http.StatusUnauthorized, fmt.Sprintf("authentication failed: %v", err))
			return
		}
		if output.AuthenticationResult != nil {
			accessToken = *output.AuthenticationResult.AccessToken
		}
	}

	if accessToken == "" {
		utils.WriteError(w, http.StatusBadRequest, "access token or credentials required")
		return
	}

	// Parse JWT (unverified — signature is verified by API Gateway Authorizer)
	claims := jwt.MapClaims{}
	_, _, err := new(jwt.Parser).ParseUnverified(accessToken, claims)
	if err != nil {
		utils.WriteError(w, http.StatusUnauthorized, "invalid token format")
		return
	}

	cognitoID, _ := claims["sub"].(string)
	email, _ := claims["email"].(string)
	name, _ := claims["name"].(string)
	if name == "" {
		name = email
	}

	// Determine role from cognito:groups
	role := extractPrimaryRole(claims)

	switch role {
	case "admin":
		s.handleAdminSignIn(w, r, accessToken, cognitoID, email, name)
	case "staff":
		s.handleStaffSignIn(w, r, accessToken, cognitoID, email, name)
	default: // "citizen"
		s.handleCitizenSignIn(w, r, accessToken, cognitoID, email, name)
	}
}

func (s *AuthService) handleCitizenSignIn(w http.ResponseWriter, r *http.Request, accessToken, cognitoID, email, name string) {
	ctx := r.Context()

	// 1. Sync with local Database - Self Healing
	// We trust the cognitoID (sub claim) provided in the verified token.
	fmt.Printf("SignIn: Seeking record for cognito_id=%s, email=%s\n", cognitoID, email)
	
	citizen, err := s.store.GetCitizenByCognitoID(ctx, cognitoID)
	if err == nil {
		// Existing user found - Ensure email/name are synced (Self-healing)
		if citizen.Email == "" || citizen.FullName == "" {
			fmt.Printf("SignIn: Syncing missing info for existing citizen: %s\n", email)
			_ = s.store.UpdateCitizenBasicInfo(ctx, sqlc.UpdateCitizenBasicInfoParams{
				ID:       citizen.ID,
				Email:    email,
				FullName: name,
			})
			// Re-fetch to get updated record
			citizen, _ = s.store.GetCitizenByCognitoID(ctx, cognitoID)
		}
	} else {
		// Fallback to email to handle cases where user existed before Cognito or ID changed
		fmt.Printf("SignIn: Cognito ID not found (%v), trying email fallback for %s\n", err, email)
		citizenByEmail, errEmail := s.store.GetCitizenByEmail(ctx, email)
		if errEmail == nil {
			// Found by email! Link the ID
			fmt.Printf("SignIn: Found citizen by email. Linking current sub=%s to citizenID=%s\n", cognitoID, citizenByEmail.ID)
			_ = s.store.UpdateCitizenCognitoID(ctx, sqlc.UpdateCitizenCognitoIDParams{
				CognitoID: cognitoID,
				ID:        citizenByEmail.ID,
			})
			citizen = citizenByEmail
		} else {
			// Not found by either, provision new
			fmt.Printf("SignIn: Provisioning NEW DB record for citizen: %s\n", email)
			citizen, err = s.store.CreateCitizen(ctx, sqlc.CreateCitizenParams{
				CognitoID: cognitoID,
				Email:     email,
				FullName:  name,
				Phone:     pgtype.Text{Valid: false},
				AvatarUrl: pgtype.Text{Valid: false},
			})
			if err != nil {
				utils.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("failed to provision citizen: %v", err))
				return
			}
		}
	}

	utils.WriteJSON(w, http.StatusOK, api.SignInResponse{
		AccessToken: accessToken,
		Role:        "citizen",
		Citizen:     mapCitizenToProfile(ctx, citizen, s.s3Service),
	})
}

func (s *AuthService) handleStaffSignIn(w http.ResponseWriter, r *http.Request, accessToken, cognitoID, email, name string) {
	staff, err := s.store.GetStaffByCognitoID(r.Context(), cognitoID)
	if err != nil {
		utils.WriteError(w, http.StatusNotFound, "staff record not found — contact admin")
		return
	}

	utils.WriteJSON(w, http.StatusOK, api.SignInResponse{
		AccessToken: accessToken,
		Role:        "staff",
		Staff:       mapStaffToProfile(r.Context(), staff, s.s3Service),
	})
}

func (s *AuthService) handleAdminSignIn(w http.ResponseWriter, r *http.Request, accessToken, cognitoID, email, name string) {
	admin, err := s.store.GetAdminByCognitoID(r.Context(), cognitoID)
	if err != nil {
		// Fallback to email
		fmt.Printf("SignIn: Admin Cognito ID not found (%v), trying email fallback for %s\n", err, email)
		adminByEmail, errEmail := s.store.GetAdminByEmail(r.Context(), email)
		if errEmail == nil {
			// Found by email! Link the ID
			fmt.Printf("SignIn: Found admin by email. Linking current sub=%s to adminID=%s\n", cognitoID, adminByEmail.ID)
			_ = s.store.UpdateAdminCognitoID(r.Context(), sqlc.UpdateAdminCognitoIDParams{
				CognitoID: cognitoID,
				ID:        adminByEmail.ID,
			})
			admin = adminByEmail
		} else {
			// Provision new
			fmt.Printf("SignIn: Auto-provisioning admin: %s\n", email)
			admin, err = s.store.CreateAdmin(r.Context(), sqlc.CreateAdminParams{
				CognitoID: cognitoID,
				Email:     email,
				FullName:  name,
				AvatarUrl: pgtype.Text{},
			})
			if err != nil {
				utils.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("failed to provision admin: %v", err))
				return
			}
		}
	}

	utils.WriteJSON(w, http.StatusOK, api.SignInResponse{
		AccessToken: accessToken,
		Role:        "admin",
		Admin:       mapAdminToProfile(r.Context(), admin, s.s3Service),
	})
}

// extractPrimaryRole reads cognito:groups and returns the highest-priority role.
// Precedence: admin (0) > staff (1) > citizen (2)
func extractPrimaryRole(claims jwt.MapClaims) string {
	groups, ok := claims["cognito:groups"].([]interface{})
	if !ok {
		return "citizen"
	}

	role := "citizen"
	for _, g := range groups {
		switch strings.ToLower(fmt.Sprintf("%v", g)) {
		case "admin", "admins":
			return "admin" // Highest priority, return immediately
		case "staff":
			role = "staff"
		}
	}
	return role
}

// --------- Mappers ---------

func mapCitizenToProfile(ctx context.Context, c sqlc.Citizens, s3Service *utils.S3Service) *api.CitizenProfile {
	avatarUrl := c.AvatarUrl.String
	if s3Service != nil {
		avatarUrl = s3Service.ResolveAvatarURL(ctx, avatarUrl)
	}

	p := &api.CitizenProfile{
		ID:                  utils.UUIDToString(c.ID),
		CognitoID:           c.CognitoID,
		Email:               c.Email,
		FullName:            c.FullName,
		Phone:               c.Phone.String,
		AvatarUrl:           avatarUrl,
		IsProfileUpdated:    c.IsProfileUpdated,
		IsVerified:          c.IsVerified,
		FirstDeclareProfile: c.FirstDeclareProfile,
		ConsentRegulation:   c.ConsentRegulation,
		CreatedAt:           c.CreatedAt.Time,
	}
	if len(c.EmergencyContacts) > 0 {
		_ = json.Unmarshal(c.EmergencyContacts, &p.EmergencyContacts)
	}
	if c.DateOfBirth.Valid {
		p.DateOfBirth = c.DateOfBirth.Time.Format("2006-01-02")
	}
	p.Gender = c.Gender.String
	p.Address = c.Address.String
	p.CccdNumber = c.CccdNumber.String
	return p
}

func mapStaffToProfile(ctx context.Context, s sqlc.Staff, s3Service *utils.S3Service) *api.StaffProfile {
	avatarUrl := s.AvatarUrl.String
	if s3Service != nil {
		avatarUrl = s3Service.ResolveAvatarURL(ctx, avatarUrl)
	}

	return &api.StaffProfile{
		ID:           utils.UUIDToString(s.ID),
		CognitoID:    s.CognitoID,
		Email:        s.Email,
		FullName:     s.FullName,
		Phone:        s.Phone.String,
		AvatarUrl:    avatarUrl,
		HospitalName: s.HospitalName,
		Department:   s.Department.String,
		Status:       s.Status,
		CreatedAt:    s.CreatedAt.Time,
	}
}

func mapAdminToProfile(ctx context.Context, a sqlc.Admins, s3Service *utils.S3Service) *api.AdminProfile {
	avatarUrl := a.AvatarUrl.String
	if s3Service != nil {
		avatarUrl = s3Service.ResolveAvatarURL(ctx, avatarUrl)
	}

	return &api.AdminProfile{
		ID:        utils.UUIDToString(a.ID),
		CognitoID: a.CognitoID,
		Email:     a.Email,
		FullName:  a.FullName,
		AvatarUrl: avatarUrl,
		CreatedAt: a.CreatedAt.Time,
	}
}
