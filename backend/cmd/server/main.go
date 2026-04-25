package main

import (
	"log"
	"os"
	"strconv"

	"smartvad/backend/internal/app"
)

func main() {
	cfg := app.Config{
		Address:      env("APP_ADDR", ":8080"),
		StorageDir:   env("STORAGE_DIR", "/data"),
		ProcessorURL: env("PROCESSOR_URL", "http://processor:8081/process"),
		MaxUploadMB:  envInt64("MAX_UPLOAD_MB", 100),
	}

	application, err := app.New(cfg)
	if err != nil {
		log.Fatalf("failed to initialize app: %v", err)
	}

	log.Printf("backend listening on %s", cfg.Address)
	if err := application.Run(); err != nil {
		log.Fatalf("server failed: %v", err)
	}
}

func env(key, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func envInt64(key string, fallback int64) int64 {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}

	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return fallback
	}
	return parsed
}
