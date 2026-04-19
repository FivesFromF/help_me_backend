package services

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/golang-jwt/jwt/v5"

	"github.com/fivesfromf/helpme/internal/api"
	"github.com/fivesfromf/helpme/internal/repository"
	"github.com/fivesfromf/helpme/internal/repository/sqlc"
	"github.com/fivesfromf/helpme/internal/utils"
)

type AuthServer struct {
	store *repository.Store
}

func NewAuthServer(store *repository.Store) *AuthServer {
	return &AuthServer{store: store}
}

// SignIn handles Google token exchange.
// It reads the Cognito Group from the JWT to determine role,
// then fetches or creates the correct record in the matching table.
func (s *AuthServer) SignIn(w http.ResponseWriter, r *http.Request) {
	var req api.SignInRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid payload")
		return
	}

	// Parse JWT (unverified — signature is verified by API Gateway Authorizer)
	claims := jwt.MapClaims{}
	_, _, err := new(jwt.Parser).ParseUnverified(req.AccessToken, claims)
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
		s.handleAdminSignIn(w, r, cognitoID, email, name)
	case "staff":
		s.handleStaffSignIn(w, r, cognitoID, email, name)
	default: // "citizen"
		s.handleCitizenSignIn(w, r, cognitoID, email, name)
	}
}

func (s *AuthServer) handleCitizenSignIn(w http.ResponseWriter, r *http.Request, cognitoID, email, name string) {
	citizen, err := s.store.GetCitizenByCognitoID(r.Context(), cognitoID)
	if err != nil {
		if strings.Contains(err.Error(), "no rows in result set") {
			// Auto-provision: Post Confirmation Lambda already added to Cognito Group,
			// now create the DB record
			fmt.Printf("Auto-provisioning citizen: %s\n", email)
			citizen, err = s.store.CreateCitizen(r.Context(), sqlc.CreateCitizenParams{
				CognitoID: cognitoID,
				Email:     email,
				FullName:  name,
				Phone:     pgtype.Text{},
				AvatarUrl: pgtype.Text{},
			})
			if err != nil {
				utils.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("failed to provision citizen: %v", err))
				return
			}
		} else {
			utils.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("failed to fetch citizen: %v", err))
			return
		}
	}

	utils.WriteJSON(w, http.StatusOK, api.SignInResponse{
		Role:    "citizen",
		Citizen: mapCitizenToProfile(citizen),
	})
}

func (s *AuthServer) handleStaffSignIn(w http.ResponseWriter, r *http.Request, cognitoID, email, name string) {
	staff, err := s.store.GetStaffByCognitoID(r.Context(), cognitoID)
	if err != nil {
		utils.WriteError(w, http.StatusNotFound, "staff record not found — contact admin")
		return
	}

	utils.WriteJSON(w, http.StatusOK, api.SignInResponse{
		Role:  "staff",
		Staff: mapStaffToProfile(staff),
	})
}

func (s *AuthServer) handleAdminSignIn(w http.ResponseWriter, r *http.Request, cognitoID, email, name string) {
	admin, err := s.store.GetAdminByCognitoID(r.Context(), cognitoID)
	if err != nil {
		if strings.Contains(err.Error(), "no rows in result set") {
			fmt.Printf("Auto-provisioning admin: %s\n", email)
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
		} else {
			utils.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("failed to fetch admin: %v", err))
			return
		}
	}

	utils.WriteJSON(w, http.StatusOK, api.SignInResponse{
		Role:  "admin",
		Admin: mapAdminToProfile(admin),
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

func mapCitizenToProfile(c sqlc.Citizens) *api.CitizenProfile {
	p := &api.CitizenProfile{
		ID:        utils.UUIDToString(c.ID),
		CognitoID: c.CognitoID,
		Email:     c.Email,
		FullName:  c.FullName,
		Phone:     c.Phone.String,
		AvatarUrl: c.AvatarUrl.String,
		CreatedAt: c.CreatedAt.Time,
	}
	if c.DateOfBirth.Valid {
		p.DateOfBirth = c.DateOfBirth.Time.Format("2006-01-02")
	}
	p.Gender = c.Gender.String
	p.Address = c.Address.String
	p.CccdNumber = c.CccdNumber.String
	return p
}

func mapStaffToProfile(s sqlc.Staff) *api.StaffProfile {
	return &api.StaffProfile{
		ID:           utils.UUIDToString(s.ID),
		CognitoID:    s.CognitoID,
		Email:        s.Email,
		FullName:     s.FullName,
		Phone:        s.Phone.String,
		AvatarUrl:    s.AvatarUrl.String,
		HospitalName: s.HospitalName,
		Department:   s.Department.String,
		Status:       s.Status,
		CreatedAt:    s.CreatedAt.Time,
	}
}

func mapAdminToProfile(a sqlc.Admins) *api.AdminProfile {
	return &api.AdminProfile{
		ID:        utils.UUIDToString(a.ID),
		CognitoID: a.CognitoID,
		Email:     a.Email,
		FullName:  a.FullName,
		AvatarUrl: a.AvatarUrl.String,
		CreatedAt: a.CreatedAt.Time,
	}
}
