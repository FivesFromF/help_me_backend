package utils

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
)

// HashCitizenID generates a secure hash of the citizen ID using a system secret.
// This is used for NFC/QR code identification without storing the hash in the database.
func HashCitizenID(citizenID string, secret string) string {
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(citizenID))
	return hex.EncodeToString(h.Sum(nil))
}

// VerifyHash compares a provided hash with the computed hash of a citizen ID.
func VerifyHash(citizenID, providedHash, secret string) bool {
	expectedHash := HashCitizenID(citizenID, secret)
	return hmac.Equal([]byte(expectedHash), []byte(providedHash))
}
