package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/smtp"
	"os"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/fivesfromf/helpme/internal/repository"
)

type ContactInfo struct {
	Name         string `json:"name"`
	Relationship string `json:"relationship"`
	Phone        string `json:"phone"`
	BackupPhone  string `json:"backupPhone"`
	Email        string `json:"email"`
}

var store *repository.Store

func init() {
	ctx := context.Background()
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		log.Fatalf("DATABASE_URL must be set")
	}

	var err error
	store, err = repository.NewStore(ctx, dbURL)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
}

func HandleRequest(ctx context.Context, event events.CloudWatchEvent) error {
	fmt.Printf("Notification Worker: Processing event: %s\n", event.DetailType)

	var detail map[string]string
	if err := json.Unmarshal(event.Detail, &detail); err != nil {
		return fmt.Errorf("failed to unmarshal identification detail: %w", err)
	}

	citizenIDStr := detail["citizen_id"]
	victimName := detail["full_name"]
	if citizenIDStr == "" {
		return fmt.Errorf("missing citizen_id in event detail")
	}

	var cID pgtype.UUID
	if err := cID.Scan(citizenIDStr); err != nil {
		return fmt.Errorf("invalid citizen_id format: %w", err)
	}

	// Use unified GetUser instead of GetCitizen
	user, err := store.GetCitizen(ctx, cID)
	if err != nil {
		return fmt.Errorf("failed to fetch user from DB: %w", err)
	}

	var contacts []ContactInfo
	if len(user.EmergencyContacts) > 0 {
		if err := json.Unmarshal(user.EmergencyContacts, &contacts); err != nil {
			fmt.Printf("Warning: failed to parse emergency contacts for user %s: %v\n", citizenIDStr, err)
		}
	}

	if len(contacts) == 0 {
		fmt.Printf("No emergency contacts found for user %s.\n", citizenIDStr)
		return nil
	}

	for _, contact := range contacts {
		// Send Email (SMTP) - Now the primary and only channel
		if contact.Email != "" {
			err := sendEmailViaSMTP(contact, victimName, user.FullName)
			if err != nil {
				fmt.Printf("Failed to send Email to %s: %v\n", contact.Email, err)
			}
		} else {
			fmt.Printf("Skipping contact %s: No email provided\n", contact.Name)
		}
	}

	return nil
}

func sendEmailViaSMTP(contact ContactInfo, victimName, fullName string) error {
	host := os.Getenv("SMTP_HOST")
	port := os.Getenv("SMTP_PORT")
	user := os.Getenv("SMTP_USER")
	pass := os.Getenv("SMTP_PASS")
	from := os.Getenv("SMTP_FROM")

	subject := fmt.Sprintf("Subject: [HelpMe] Thong bao khan cap: %s dang gap su co\n", victimName)
	mime := "MIME-version: 1.0;\nContent-Type: text/html; charset=\"UTF-8\";\n\n"

	htmlBody := fmt.Sprintf(`
		<div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
			<h2 style="color: #FF5722;">CẢNH BÁO KHẨN CẤP</h2>
			<p>Xin chào <strong>%s</strong>,</p>
			<p>Hệ thống <strong>HelpMe</strong> xin thông báo: <strong>%s</strong> (%s) vừa được đội ngũ y tế xác nhận đang trong tình trạng khẩn cấp.</p>
			<div style="background-color: #fce4ec; border-left: 5px solid #ff5722; padding: 15px; margin: 20px 0;">
				<strong>Vui lòng thực hiện các bước sau:</strong>
				<ul>
					<li>Kiểm tra vị trí của nạn nhân trên ứng dụng HelpMe.</li>
					<li>Liên hệ với cơ quan y tế hoặc bệnh viện gần nhất.</li>
					<li>Chuẩn bị các giấy tờ tùy thân của nạn nhân nếu cần thiết.</li>
				</ul>
			</div>
			<p>Trân trọng,<br>Đội ngũ HelpMe</p>
		</div>
	`, contact.Name, victimName, fullName)

	msg := []byte(subject + mime + htmlBody)
	addr := host + ":" + port

	auth := smtp.PlainAuth("", user, pass, host)

	fmt.Printf("Sending SMTP Email to %s (%s)...\n", contact.Name, contact.Email)

	err := smtp.SendMail(addr, auth, from, []string{contact.Email}, msg)
	if err != nil {
		return err
	}

	fmt.Printf("Email sent via SMTP successfully to %s\n", contact.Email)
	return nil
}

func main() {
	lambda.Start(HandleRequest)
}
