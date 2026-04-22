package services

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pgvector/pgvector-go"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/cognitoidentityprovider"
	"github.com/fivesfromf/helpme/internal/ai"
	"github.com/fivesfromf/helpme/internal/api"
	"github.com/fivesfromf/helpme/internal/repository"
	"github.com/fivesfromf/helpme/internal/repository/sqlc"
	"github.com/fivesfromf/helpme/internal/utils"
)

type CitizenServer struct {
	store         *repository.Store
	cloudRepo     *repository.CloudRepository
	aiClient      *ai.Client
	cognitoClient *cognitoidentityprovider.Client
	userPoolID    string
	systemSecret  string
}

func NewCitizenServer(
	store *repository.Store,
	cloudRepo *repository.CloudRepository,
	aiClient *ai.Client,
	cognitoClient *cognitoidentityprovider.Client,
	userPoolID string,
	secret string,
) *CitizenServer {
	return &CitizenServer{
		store:         store,
		cloudRepo:     cloudRepo,
		aiClient:      aiClient,
		cognitoClient: cognitoClient,
		userPoolID:    userPoolID,
		systemSecret:  secret,
	}
}

// getOrCreateCitizen retrieves the citizen from DB, or syncs from Cognito if missing.
func (s *CitizenServer) getOrCreateCitizen(ctx context.Context, cognitoID string) (sqlc.Citizens, error) {
	// 1. Try DB
	citizen, err := s.store.GetCitizenByCognitoID(ctx, cognitoID)
	if err == nil {
		return citizen, nil
	}

	// 2. Not in DB? Sync from Cognito (Self-Healing)
	fmt.Printf("CitizenServer: Self-healing sync for cognito_id=%s\n", cognitoID)
	user, err := s.cognitoClient.AdminGetUser(ctx, &cognitoidentityprovider.AdminGetUserInput{
		UserPoolId: aws.String(s.userPoolID),
		Username:   aws.String(cognitoID),
	})
	if err != nil {
		return sqlc.Citizens{}, fmt.Errorf("failed to fetch user from cognito: %v", err)
	}

	email := ""
	name := ""
	for _, attr := range user.UserAttributes {
		switch *attr.Name {
		case "email":
			email = *attr.Value
		case "name":
			name = *attr.Value
		}
	}

	if name == "" {
		name = email
	}

	// 3. Create in DB
	newCitizen, err := s.store.CreateCitizen(ctx, sqlc.CreateCitizenParams{
		CognitoID: cognitoID,
		Email:     email,
		FullName:  name,
		Phone:     pgtype.Text{Valid: false},
		AvatarUrl: pgtype.Text{Valid: false},
	})
	if err != nil {
		return sqlc.Citizens{}, fmt.Errorf("failed to provision citizen in DB: %v", err)
	}

	fmt.Printf("CitizenServer: Successfully synchronized user %s from Cognito\n", email)
	return newCitizen, nil
}

// Register completes the citizen profile after first Google login.
func (s *CitizenServer) Register(w http.ResponseWriter, r *http.Request) {
	var req api.RegisterCitizenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}

	cognitoID := r.Header.Get("X-Cognito-Id")
	email := ""

	// Fallback/Extraction: try to parse the Authorization header manually if Gateway missing headers or whitelisted
	authHeader := r.Header.Get("Authorization")
	if token := strings.TrimPrefix(authHeader, "Bearer "); token != "" && token != authHeader {
		claims := jwt.MapClaims{}
		_, _, err := new(jwt.Parser).ParseUnverified(token, claims)
		if err == nil {
			if sub, ok := claims["sub"].(string); ok && (cognitoID == "" || cognitoID != sub) {
				cognitoID = sub
			}
			if em, ok := claims["email"].(string); ok {
				email = em
			}
		}
	}

	if cognitoID == "" {
		utils.WriteError(w, http.StatusUnauthorized, "identity required (missing x-cognito-id and fallback failed)")
		return
	}

	// 2. Identity Resolution - Self Healing
	fmt.Printf("Register: Attempting lookup for cognito_id=%s, email=%s\n", cognitoID, email)
	citizen, err := s.store.GetCitizenByCognitoID(r.Context(), cognitoID)
	if err != nil {
		// If not found by ID, try email fallback
		fmt.Printf("Register: Cognito ID not found (%v), trying email fallback for %s\n", err, email)
		if email != "" {
			citizenByEmail, errEmail := s.store.GetCitizenByEmail(r.Context(), email)
			if errEmail == nil {
				// Found! Link the new cognito ID
				fmt.Printf("Register: Found citizen by email. Linking current cognitoID=%s to citizenID=%s\n", cognitoID, citizenByEmail.ID)
				errLink := s.store.UpdateCitizenCognitoID(r.Context(), sqlc.UpdateCitizenCognitoIDParams{
					CognitoID: cognitoID,
					ID:        citizenByEmail.ID,
				})
				if errLink != nil {
					fmt.Printf("Register: Failed to link cognito ID: %v\n", errLink)
				}
				citizen = citizenByEmail
			} else {
				fmt.Printf("Register: Email fallback also failed: %v\n", errEmail)
				utils.WriteError(w, http.StatusNotFound, "citizen record not found (identity mapping failed)")
				return
			}
		} else {
			utils.WriteError(w, http.StatusNotFound, "citizen record not found (no email to fallback)")
			return
		}
	}

	fmt.Printf("Completing citizen profile: %s\n", citizen.Email)

	var dob pgtype.Date
	if req.DateOfBirth != "" {
		t, err := time.Parse("2006-01-02", req.DateOfBirth)
		if err == nil {
			dob = pgtype.Date{Time: t, Valid: true}
		}
	}

	updatedCitizen, err := s.store.UpdateCitizen(r.Context(), sqlc.UpdateCitizenParams{
		ID:          citizen.ID,
		FullName:    req.FullName,
		Phone:       pgtype.Text{String: req.Phone, Valid: req.Phone != ""},
		AvatarUrl:   pgtype.Text{String: req.AvatarUrl, Valid: req.AvatarUrl != ""},
		DateOfBirth: dob,
		Gender:      pgtype.Text{String: req.Gender, Valid: req.Gender != ""},
		Address:     pgtype.Text{String: req.Address, Valid: req.Address != ""},
		CccdNumber:  pgtype.Text{String: req.CccdNumber, Valid: req.CccdNumber != ""},
		IsProfileUpdated: true,
		IsVerified:       req.CccdNumber != "",
		FirstDeclareProfile: true,
		ConsentRegulation:   req.ConsentRegulation || citizen.ConsentRegulation,
	})
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("failed to update citizen: %v", err))
		return
	}

	// Handle face embedding (either direct vector or image-to-vector)
	faceVector := req.FaceVector
	if req.FaceImageB64 != "" && s.aiClient != nil {
		imgData, err := base64.StdEncoding.DecodeString(req.FaceImageB64)
		if err == nil {
			vec, err := s.aiClient.ExtractEmbedding(imgData)
			if err == nil {
				faceVector = vec
			} else {
				fmt.Printf("AI extraction failed: %v\n", err)
			}
		}
	}

	if len(faceVector) > 0 {
		vec := pgvector.NewVector(faceVector)
		_ = s.store.UpdateCitizenFaceEmbedding(r.Context(), sqlc.UpdateCitizenFaceEmbeddingParams{
			ID:            citizen.ID,
			FaceEmbedding: &vec,
		})
	}

	// Create initial medical record
	if req.InitialMedicalRecord != nil {
		_, _ = s.store.CreateMedicalRecord(r.Context(), sqlc.CreateMedicalRecordParams{
			CitizenID:           citizen.ID,
			DistinguishingMarks: pgtype.Text{String: req.InitialMedicalRecord.DistinguishingMarks, Valid: true},
			BloodGroup:          pgtype.Text{String: req.InitialMedicalRecord.BloodGroup, Valid: true},
			Allergies:           req.InitialMedicalRecord.Allergies,
			BackgroundDiseases:  req.InitialMedicalRecord.BackgroundDiseases,
			CurrentMedications:  req.InitialMedicalRecord.CurrentMedications,
			Notes:               pgtype.Text{String: req.InitialMedicalRecord.Notes, Valid: true},
		})
	}

	_ = s.cloudRepo.PublishSystemEvent(r.Context(), "citizen.profile_updated", map[string]string{
		"citizen_id": utils.UUIDToString(citizen.ID),
	})

	utils.WriteJSON(w, http.StatusOK, api.RegisterCitizenResponse{
		Profile: mapCitizenToProfile(updatedCitizen),
	})
}

// UpdateProfile updates all aspects of a citizen's profile.
func (s *CitizenServer) UpdateProfile(w http.ResponseWriter, r *http.Request) {
	var req api.UpdateProfileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}

	cognitoID := r.Header.Get("X-Cognito-Id")
	if cognitoID == "" {
		authHeader := r.Header.Get("Authorization")
		if token := strings.TrimPrefix(authHeader, "Bearer "); token != "" && token != authHeader {
			claims := jwt.MapClaims{}
			_, _, err := new(jwt.Parser).ParseUnverified(token, claims)
			if err == nil {
				if sub, ok := claims["sub"].(string); ok {
					cognitoID = sub
				}
			}
		}
	}
	if cognitoID == "" {
		utils.WriteError(w, http.StatusUnauthorized, "identity required")
		return
	}

	citizen, err := s.store.GetCitizenByCognitoID(r.Context(), cognitoID)
	if err != nil {
		utils.WriteError(w, http.StatusNotFound, "citizen record not found")
		return
	}

	ctx := r.Context()

	// 1. Update Basic Info
	var dob pgtype.Date
	if req.DateOfBirth != "" {
		t, err := time.Parse("2006-01-02", req.DateOfBirth)
		if err == nil {
			dob = pgtype.Date{Time: t, Valid: true}
		}
	} else {
		dob = citizen.DateOfBirth
	}

	fullName := req.FullName
	if fullName == "" {
		fullName = citizen.FullName
	}
	phone := req.Phone
	if phone == "" {
		phone = citizen.Phone.String
	}
	gender := req.Gender
	if gender == "" {
		gender = citizen.Gender.String
	}
	address := req.Address
	if address == "" {
		address = citizen.Address.String
	}
	cccd := req.CccdNumber
	if cccd == "" {
		cccd = citizen.CccdNumber.String
	}

	updatedCitizen, err := s.store.UpdateCitizen(ctx, sqlc.UpdateCitizenParams{
		ID:          citizen.ID,
		FullName:    fullName,
		Phone:       pgtype.Text{String: phone, Valid: phone != ""},
		AvatarUrl:   pgtype.Text{String: req.AvatarUrl, Valid: req.AvatarUrl != ""},
		DateOfBirth: dob,
		Gender:      pgtype.Text{String: gender, Valid: gender != ""},
		Address:     pgtype.Text{String: address, Valid: address != ""},
		CccdNumber:  pgtype.Text{String: cccd, Valid: cccd != ""},
		IsProfileUpdated: true,
		IsVerified:       cccd != "" || citizen.IsVerified,
		FirstDeclareProfile: req.FirstDeclareProfile || citizen.FirstDeclareProfile,
		ConsentRegulation:   req.ConsentRegulation || citizen.ConsentRegulation,
	})
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("failed to update citizen: %v", err))
		return
	}

	// 2. Update Emergency Contacts
	if req.EmergencyContacts != nil {
		contactsJSON, _ := json.Marshal(req.EmergencyContacts)
		err = s.store.UpdateCitizenEmergencyContacts(ctx, sqlc.UpdateCitizenEmergencyContactsParams{
			ID:                citizen.ID,
			EmergencyContacts: contactsJSON,
		})
		if err != nil {
			utils.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("failed to update emergency contacts: %v", err))
			return
		}
		// Re-fetch to get updated contacts in response if needed, 
		// but we'll just map from request for now or rely on the final object.
		updatedCitizen.EmergencyContacts = contactsJSON
	}

	// 3. Update Medical Record
	var finalMed sqlc.MedicalRecords
	if req.MedicalRecord != nil {
		// Try to see if record exists
		med, errMed := s.store.GetMedicalRecord(ctx, citizen.ID)
		if errMed != nil {
			// Create
			finalMed, err = s.store.CreateMedicalRecord(ctx, sqlc.CreateMedicalRecordParams{
				CitizenID:           citizen.ID,
				DistinguishingMarks: pgtype.Text{String: req.MedicalRecord.DistinguishingMarks, Valid: true},
				BloodGroup:          pgtype.Text{String: req.MedicalRecord.BloodGroup, Valid: true},
				Allergies:           req.MedicalRecord.Allergies,
				BackgroundDiseases:  req.MedicalRecord.BackgroundDiseases,
				CurrentMedications:  req.MedicalRecord.CurrentMedications,
				Notes:               pgtype.Text{String: req.MedicalRecord.Notes, Valid: true},
			})
		} else {
			_ = med
			// Update
			finalMed, err = s.store.UpdateMedicalRecord(ctx, sqlc.UpdateMedicalRecordParams{
				CitizenID:           citizen.ID,
				DistinguishingMarks: pgtype.Text{String: req.MedicalRecord.DistinguishingMarks, Valid: true},
				BloodGroup:          pgtype.Text{String: req.MedicalRecord.BloodGroup, Valid: true},
				Allergies:           req.MedicalRecord.Allergies,
				BackgroundDiseases:  req.MedicalRecord.BackgroundDiseases,
				CurrentMedications:  req.MedicalRecord.CurrentMedications,
				Notes:               pgtype.Text{String: req.MedicalRecord.Notes, Valid: true},
			})
		}
		if err != nil {
			utils.WriteError(w, http.StatusInternalServerError, fmt.Sprintf("failed to update medical record: %v", err))
			return
		}
	} else {
		// Just fetch current if not updating
		finalMed, _ = s.store.GetMedicalRecord(ctx, citizen.ID)
	}

	utils.WriteJSON(w, http.StatusOK, api.UpdateProfileResponse{
		Profile:       mapCitizenToProfile(updatedCitizen),
		MedicalRecord: mapMedicalRecord(finalMed),
	})
}

// GetMedicalRecord returns the medical record for the authenticated citizen.
func (s *CitizenServer) GetMedicalRecord(w http.ResponseWriter, r *http.Request) {
	cognitoID := r.Header.Get("X-Cognito-Id")
	if cognitoID == "" {
		authHeader := r.Header.Get("Authorization")
		if token := strings.TrimPrefix(authHeader, "Bearer "); token != "" && token != authHeader {
			claims := jwt.MapClaims{}
			_, _, err := new(jwt.Parser).ParseUnverified(token, claims)
			if err == nil {
				if sub, ok := claims["sub"].(string); ok {
					cognitoID = sub
				}
			}
		}
	}
	if cognitoID == "" {
		utils.WriteError(w, http.StatusUnauthorized, "identity required")
		return
	}

	citizen, err := s.store.GetCitizenByCognitoID(r.Context(), cognitoID)
	if err != nil {
		utils.WriteError(w, http.StatusNotFound, "citizen record not found")
		return
	}

	med, err := s.store.GetMedicalRecord(r.Context(), citizen.ID)
	if err != nil {
		utils.WriteJSON(w, http.StatusOK, api.GetMedicalRecordResponse{Record: nil})
		return
	}

	utils.WriteJSON(w, http.StatusOK, api.GetMedicalRecordResponse{
		Record: mapMedicalRecord(med),
	})
}

// GetProfile returns the complete profile for the authenticated citizen.
func (s *CitizenServer) GetProfile(w http.ResponseWriter, r *http.Request) {
	cognitoID := r.Header.Get("X-Cognito-Id")
	if cognitoID == "" {
		authHeader := r.Header.Get("Authorization")
		if token := strings.TrimPrefix(authHeader, "Bearer "); token != "" && token != authHeader {
			claims := jwt.MapClaims{}
			_, _, err := new(jwt.Parser).ParseUnverified(token, claims)
			if err == nil {
				if sub, ok := claims["sub"].(string); ok {
					cognitoID = sub
				}
			}
		}
	}
	if cognitoID == "" {
		utils.WriteError(w, http.StatusUnauthorized, "identity required")
		return
	}

	citizen, err := s.store.GetCitizenByCognitoID(r.Context(), cognitoID)
	if err != nil {
		utils.WriteError(w, http.StatusNotFound, "citizen record not found")
		return
	}

	utils.WriteJSON(w, http.StatusOK, api.RegisterCitizenResponse{
		Profile: mapCitizenToProfile(citizen),
	})
}

// VerifyIdentity identifies a victim via NFC or QR code.
func (s *CitizenServer) VerifyIdentity(w http.ResponseWriter, r *http.Request) {
	var req api.VerifyIdentityRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}

	var citizenID string
	var method string

	if req.NfcID != "" {
		tag, err := s.store.GetNFCTag(r.Context(), req.NfcID)
		if err != nil {
			utils.WriteError(w, http.StatusNotFound, "NFC tag not found")
			return
		}
		if tag.Status != "ACTIVE" {
			utils.WriteError(w, http.StatusForbidden, "tag is not active")
			return
		}
		citizenID = utils.UUIDToString(tag.CitizenID)
		method = "NFC"
		_ = s.store.UpdateNFCLastUsed(r.Context(), tag.ID)
	} else if req.QrID != "" {
		var qrID pgtype.UUID
		_ = qrID.Scan(req.QrID)
		qr, err := s.store.GetQRCode(r.Context(), qrID)
		if err != nil {
			utils.WriteError(w, http.StatusNotFound, "QR code not found")
			return
		}
		if qr.Status != "ACTIVE" {
			utils.WriteError(w, http.StatusForbidden, "QR is not active")
			return
		}
		citizenID = utils.UUIDToString(qr.CitizenID)
		method = "QR"
		_ = s.store.UpdateQRLastUsed(r.Context(), qr.ID)
	} else {
		utils.WriteError(w, http.StatusBadRequest, "identifier required (nfcId or qrId)")
		return
	}

	if !utils.VerifyHash(citizenID, req.HashedCitizenID, s.systemSecret) {
		utils.WriteError(w, http.StatusUnauthorized, "invalid hash verification")
		return
	}

	var cID pgtype.UUID
	_ = cID.Scan(citizenID)
	citizen, _ := s.store.GetCitizen(r.Context(), cID)
	med, _ := s.store.GetMedicalRecord(r.Context(), cID)

	_ = s.cloudRepo.PublishEmergencyEvent(r.Context(), "victim.identified", map[string]string{
		"citizen_id": citizenID,
		"method":     method,
		"full_name":  citizen.FullName,
	})

	utils.WriteJSON(w, http.StatusOK, api.VerifyIdentityResponse{
		Profile:           mapCitizenToProfile(citizen),
		MedicalRecord:     mapMedicalRecord(med),
		EmergencyContacts: mapEmergencyContacts(citizen.EmergencyContacts),
	})
}
func (s *CitizenServer) SearchByFace(w http.ResponseWriter, r *http.Request) {
	var req api.SearchByFaceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	var faceVector []float32 = req.FaceVector

	// If image is provided, call AI service to get vector
	if req.FaceImageB64 != "" && s.aiClient != nil {
		imgData, err := base64.StdEncoding.DecodeString(req.FaceImageB64)
		if err != nil {
			utils.WriteError(w, http.StatusBadRequest, "invalid base64 image")
			return
		}
		vec, err := s.aiClient.ExtractEmbedding(imgData)
		if err != nil {
			utils.WriteError(w, http.StatusUnprocessableEntity, fmt.Sprintf("AI extraction failed: %v", err))
			return
		}
		faceVector = vec
	}

	if len(faceVector) == 0 {
		utils.WriteError(w, http.StatusBadRequest, "face vector or image required")
		return
	}

	vec := pgvector.NewVector(faceVector)
	hits, err := s.store.SearchCitizenByFace(r.Context(), sqlc.SearchCitizenByFaceParams{
		FaceEmbedding: &vec,
		Limit:         1,
	})
	if err != nil || len(hits) == 0 {
		utils.WriteError(w, http.StatusNotFound, "no matching face found")
		return
	}

	bestMatch := hits[0]
	citizen, _ := s.store.GetCitizen(r.Context(), bestMatch.ID)
	med, _ := s.store.GetMedicalRecord(r.Context(), bestMatch.ID)

	_ = s.cloudRepo.PublishEmergencyEvent(r.Context(), "victim.identified", map[string]string{
		"citizen_id": utils.UUIDToString(bestMatch.ID),
		"method":     "FACE_SCAN",
		"full_name":  citizen.FullName,
	})

	utils.WriteJSON(w, http.StatusOK, api.SearchByFaceResponse{
		Profile:           mapCitizenToProfile(citizen),
		MedicalRecord:     mapMedicalRecord(med),
		EmergencyContacts: mapEmergencyContacts(citizen.EmergencyContacts),
	})
}

// ========= NFC Management =========

func (s *CitizenServer) LinkNFCTag(w http.ResponseWriter, r *http.Request) {
	var req api.LinkNFCTagRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}

	cognitoID := r.Header.Get("X-Cognito-Id")
	citizen, err := s.getOrCreateCitizen(r.Context(), cognitoID)
	if err != nil {
		utils.WriteError(w, http.StatusNotFound, fmt.Sprintf("citizen not found: %v", err))
		return
	}

	// 1. Check if already exists
	existing, err := s.store.GetNFCTag(r.Context(), req.NfcID)
	if err == nil {
		if existing.CitizenID == citizen.ID {
			// Already linked to this user, just return hash again if they need to re-write
			utils.WriteJSON(w, http.StatusOK, api.LinkNFCTagResponse{
				HashedCitizenID: utils.HashCitizenID(utils.UUIDToString(citizen.ID), s.systemSecret),
			})
			return
		}
		utils.WriteError(w, http.StatusConflict, "this tag is already linked to another user")
		return
	}

	// 2. Link tag
	_, err = s.store.CreateNFCTag(r.Context(), sqlc.CreateNFCTagParams{
		ID:        req.NfcID,
		Name:      pgtype.Text{String: req.Name, Valid: req.Name != ""},
		Status:    "ACTIVE",
		CitizenID: citizen.ID,
	})
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, "failed to link tag")
		return
	}

	// 3. Return Hash for the app to write to tag
	utils.WriteJSON(w, http.StatusCreated, api.LinkNFCTagResponse{
		HashedCitizenID: utils.HashCitizenID(utils.UUIDToString(citizen.ID), s.systemSecret),
	})
}

func (s *CitizenServer) ListMyNFCTags(w http.ResponseWriter, r *http.Request) {
	cognitoID := r.Header.Get("X-Cognito-Id")
	citizen, err := s.getOrCreateCitizen(r.Context(), cognitoID)
	if err != nil {
		utils.WriteError(w, http.StatusNotFound, fmt.Sprintf("citizen not found: %v", err))
		return
	}

	tags, err := s.store.ListCitizenNFCTags(r.Context(), citizen.ID)
	if err != nil {
		utils.WriteJSON(w, http.StatusOK, api.ListNFCTagsResponse{Tags: []api.NFCTagInfo{}})
		return
	}

	resp := make([]api.NFCTagInfo, len(tags))
	for i, t := range tags {
		resp[i] = mapNFCTagInfo(t)
	}

	utils.WriteJSON(w, http.StatusOK, api.ListNFCTagsResponse{Tags: resp})
}

func (s *CitizenServer) UpdateNFCTagStatus(w http.ResponseWriter, r *http.Request) {
	nfcID := r.PathValue("id")
	var req api.UpdateNFCTagStatusRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid payload")
		return
	}

	cognitoID := r.Header.Get("X-Cognito-Id")
	citizen, err := s.getOrCreateCitizen(r.Context(), cognitoID)
	if err != nil {
		utils.WriteError(w, http.StatusNotFound, fmt.Sprintf("citizen not found: %v", err))
		return
	}

	tag, err := s.store.GetNFCTag(r.Context(), nfcID)
	if err != nil || tag.CitizenID != citizen.ID {
		utils.WriteError(w, http.StatusNotFound, "tag not found or access denied")
		return
	}

	_, err = s.store.UpdateNFCTagStatus(r.Context(), sqlc.UpdateNFCTagStatusParams{
		ID:     nfcID,
		Status: req.Status,
	})
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, "failed to update tag")
		return
	}

	utils.WriteError(w, http.StatusNoContent, "")
}

func (s *CitizenServer) DeleteNFCTag(w http.ResponseWriter, r *http.Request) {
	nfcID := r.PathValue("id")
	cognitoID := r.Header.Get("X-Cognito-Id")
	citizen, err := s.getOrCreateCitizen(r.Context(), cognitoID)
	if err != nil {
		utils.WriteError(w, http.StatusNotFound, fmt.Sprintf("citizen not found: %v", err))
		return
	}

	err = s.store.DeleteNFCTag(r.Context(), sqlc.DeleteNFCTagParams{
		ID:        nfcID,
		CitizenID: citizen.ID,
	})
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, "failed to delete tag")
		return
	}

	utils.WriteError(w, http.StatusNoContent, "")
}

// ========= QR Code Management =========

func (s *CitizenServer) CreateQRCode(w http.ResponseWriter, r *http.Request) {
	var req api.CreateQRCodeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid JSON payload")
		return
	}

	cognitoID := r.Header.Get("X-Cognito-Id")
	citizen, err := s.getOrCreateCitizen(r.Context(), cognitoID)
	if err != nil {
		utils.WriteError(w, http.StatusNotFound, fmt.Sprintf("citizen not found: %v", err))
		return
	}

	qr, err := s.store.CreateQRCode(r.Context(), sqlc.CreateQRCodeParams{
		Name:      pgtype.Text{String: req.Name, Valid: req.Name != ""},
		Status:    "ACTIVE",
		CitizenID: citizen.ID,
	})
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, "failed to create QR code")
		return
	}

	utils.WriteJSON(w, http.StatusCreated, api.CreateQRCodeResponse{
		ID:              utils.UUIDToString(qr.ID),
		HashedCitizenID: utils.HashCitizenID(utils.UUIDToString(citizen.ID), s.systemSecret),
	})
}

func (s *CitizenServer) ListMyQRCodes(w http.ResponseWriter, r *http.Request) {
	cognitoID := r.Header.Get("X-Cognito-Id")
	citizen, err := s.getOrCreateCitizen(r.Context(), cognitoID)
	if err != nil {
		utils.WriteError(w, http.StatusNotFound, fmt.Sprintf("citizen not found: %v", err))
		return
	}

	codes, err := s.store.ListCitizenQRCodes(r.Context(), citizen.ID)
	if err != nil {
		utils.WriteJSON(w, http.StatusOK, api.ListQRCodesResponse{QRCodes: []api.QRCodeInfo{}})
		return
	}

	hashedID := utils.HashCitizenID(utils.UUIDToString(citizen.ID), s.systemSecret)
	resp := make([]api.QRCodeInfo, len(codes))
	for i, c := range codes {
		resp[i] = mapQRCodeInfo(c, hashedID)
	}

	utils.WriteJSON(w, http.StatusOK, api.ListQRCodesResponse{QRCodes: resp})
}

func (s *CitizenServer) UpdateQRCodeStatus(w http.ResponseWriter, r *http.Request) {
	qrIDStr := r.PathValue("id")
	var req api.UpdateQRCodeStatusRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid payload")
		return
	}

	var qrID pgtype.UUID
	if err := qrID.Scan(qrIDStr); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid QR ID format")
		return
	}

	cognitoID := r.Header.Get("X-Cognito-Id")
	citizen, err := s.getOrCreateCitizen(r.Context(), cognitoID)
	if err != nil {
		utils.WriteError(w, http.StatusNotFound, fmt.Sprintf("citizen not found: %v", err))
		return
	}

	qr, err := s.store.GetQRCode(r.Context(), qrID)
	if err != nil || qr.CitizenID != citizen.ID {
		utils.WriteError(w, http.StatusNotFound, "QR code not found or access denied")
		return
	}

	_, err = s.store.UpdateQRCodeStatus(r.Context(), sqlc.UpdateQRCodeStatusParams{
		ID:     qrID,
		Status: req.Status,
	})
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, "failed to update QR code")
		return
	}

	utils.WriteError(w, http.StatusNoContent, "")
}

func (s *CitizenServer) DeleteQRCode(w http.ResponseWriter, r *http.Request) {
	qrIDStr := r.PathValue("id")
	var qrID pgtype.UUID
	if err := qrID.Scan(qrIDStr); err != nil {
		utils.WriteError(w, http.StatusBadRequest, "invalid QR ID format")
		return
	}

	cognitoID := r.Header.Get("X-Cognito-Id")
	citizen, err := s.getOrCreateCitizen(r.Context(), cognitoID)
	if err != nil {
		utils.WriteError(w, http.StatusNotFound, fmt.Sprintf("citizen not found: %v", err))
		return
	}

	err = s.store.DeleteQRCode(r.Context(), sqlc.DeleteQRCodeParams{
		ID:        qrID,
		CitizenID: citizen.ID,
	})
	if err != nil {
		utils.WriteError(w, http.StatusInternalServerError, "failed to delete QR code")
		return
	}

	utils.WriteError(w, http.StatusNoContent, "")
}

// ------- Mappers -------

func mapQRCodeInfo(c sqlc.QrCodes, hashedID string) api.QRCodeInfo {
	var lastUsed *time.Time
	if c.LastUsedAt.Valid {
		lastUsed = &c.LastUsedAt.Time
	}
	return api.QRCodeInfo{
		ID:              utils.UUIDToString(c.ID),
		Name:            c.Name.String,
		Status:          c.Status,
		HashedCitizenID: hashedID,
		CreatedAt:       c.CreatedAt.Time,
		LastUsedAt:      lastUsed,
	}
}

func mapNFCTagInfo(t sqlc.NfcTags) api.NFCTagInfo {
	var lastUsed *time.Time
	if t.LastUsedAt.Valid {
		lastUsed = &t.LastUsedAt.Time
	}
	return api.NFCTagInfo{
		ID:           t.ID,
		Name:         t.Name.String,
		Status:       t.Status,
		RegisteredAt: t.RegisteredAt.Time,
		LastUsedAt:   lastUsed,
	}
}

func mapMedicalRecord(m sqlc.MedicalRecords) *api.MedicalRecord {
	return &api.MedicalRecord{
		ID:                  utils.UUIDToString(m.CitizenID),
		DistinguishingMarks: m.DistinguishingMarks.String,
		BloodGroup:          m.BloodGroup.String,
		Allergies:           m.Allergies,
		BackgroundDiseases:  m.BackgroundDiseases,
		CurrentMedications:  m.CurrentMedications,
		Notes:               m.Notes.String,
		UpdatedAt:           m.LastUpdated.Time,
	}
}

func mapEmergencyContacts(data []byte) []api.ContactInfo {
	var contacts []api.ContactInfo
	if len(data) > 0 {
		_ = json.Unmarshal(data, &contacts)
	}
	return contacts
}
