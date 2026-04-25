FROM golang:1.23-alpine AS builder
WORKDIR /src

COPY backend/go.mod ./go.mod
COPY backend/cmd ./cmd
COPY backend/internal ./internal

RUN CGO_ENABLED=0 GOOS=linux go build -o /out/backend ./cmd/server

FROM alpine:3.21
WORKDIR /app
RUN mkdir -p /data

COPY --from=builder /out/backend /usr/local/bin/backend

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/backend"]
