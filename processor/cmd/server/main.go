package main

import (
	"log"
	"net/http"
	"os"
	"strconv"

	"smartvad/processor/internal/processor"
)

func main() {
	cfg := processor.Config{
		Address:      env("APP_ADDR", ":8081"),
		FFmpegBin:    env("FFMPEG_BIN", "/opt/ffmpeg/bin/ffmpeg"),
		FFprobeBin:   env("FFPROBE_BIN", "/opt/ffmpeg/bin/ffprobe"),
		MaxBodyBytes: envInt64("MAX_BODY_MB", 100) * 1024 * 1024,
	}

	handler := processor.New(cfg).Handler()
	log.Printf("processor listening on %s", cfg.Address)
	if err := http.ListenAndServe(cfg.Address, handler); err != nil {
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
