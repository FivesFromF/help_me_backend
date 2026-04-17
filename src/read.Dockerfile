FROM golang:1.21-alpine AS builder

WORKDIR /app
COPY go.mod ./
RUN go mod download
COPY . .
RUN go build -o read-server ./cmd/read-server/main.go

FROM alpine:latest
WORKDIR /root/
COPY --from=builder /app/read-server .
EXPOSE 8080
CMD ["./read-server"]
