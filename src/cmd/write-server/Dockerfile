FROM golang:1.24-alpine AS builder

WORKDIR /app
COPY go.mod ./
RUN go mod download
COPY . .
RUN go build -o write-server ./cmd/write-server/main.go

FROM alpine:latest
WORKDIR /root/
COPY --from=builder /app/write-server .
COPY api/schema ./api/schema
EXPOSE 8080
CMD ["./write-server"]
