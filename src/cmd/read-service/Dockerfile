FROM golang:1.24-alpine AS builder

WORKDIR /app
COPY go.mod ./
RUN go mod download
COPY . .
RUN go build -o read-service ./cmd/read-service/main.go

FROM alpine:latest
WORKDIR /root/
COPY --from=builder /app/read-service .
EXPOSE 8080
CMD ["./read-service"]
