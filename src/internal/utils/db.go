package utils

import (
	"fmt"
	"github.com/jackc/pgx/v5/pgtype"
)

// UUIDToString converts a pgtype.UUID to its standard string representation (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).
// This is used to maintain compatibility across different pgx/v5 versions that may or may not provide a .String() method.
func UUIDToString(uuid pgtype.UUID) string {
	if !uuid.Valid {
		return ""
	}
	return fmt.Sprintf("%x-%x-%x-%x-%x",
		uuid.Bytes[0:4],
		uuid.Bytes[4:6],
		uuid.Bytes[6:8],
		uuid.Bytes[8:10],
		uuid.Bytes[10:16])
}

// StringToUUID receives a UUID formatted string and returns a pgtype.UUID block
func StringToUUID(s string) (pgtype.UUID, error) {
	var uuid pgtype.UUID
	err := uuid.Scan(s)
	if err != nil {
		return uuid, err
	}
	return uuid, nil
}
