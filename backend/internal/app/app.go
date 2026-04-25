package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"smartvad/backend/internal/storage"
)

type Config struct {
	Address      string
	StorageDir   string
	ProcessorURL string
	MaxUploadMB  int64
}

type App struct {
	cfg            Config
	store          *storage.Store
	client         *http.Client
	maxUploadBytes int64
}

type processorStats struct {
	OriginalDuration  float64
	ProcessedDuration float64
}

func New(cfg Config) (*App, error) {
	store, err := storage.New(cfg.StorageDir)
	if err != nil {
		return nil, err
	}

	return &App{
		cfg:   cfg,
		store: store,
		client: &http.Client{
			Timeout: 20 * time.Minute,
		},
		maxUploadBytes: cfg.MaxUploadMB * 1024 * 1024,
	}, nil
}

func (a *App) Run() error {
	server := &http.Server{
		Addr:              a.cfg.Address,
		Handler:           a.routes(),
		ReadHeaderTimeout: 15 * time.Second,
	}
	return server.ListenAndServe()
}

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", a.handleHealth)
	mux.HandleFunc("/api/upload", a.handleUpload)
	mux.HandleFunc("/api/process/", a.handleProcess)
	mux.HandleFunc("/media/", a.handleMedia)
	return loggingMiddleware(mux)
}

func (a *App) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *App) handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, a.maxUploadBytes)
	if err := r.ParseMultipartForm(a.maxUploadBytes); err != nil {
		http.Error(w, fmt.Sprintf("invalid multipart body: %v", err), http.StatusBadRequest)
		return
	}
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "field 'file' is required", http.StatusBadRequest)
		return
	}
	defer file.Close()

	meta, err := a.store.CreateUpload(header.Filename, file)
	if err != nil {
		http.Error(w, fmt.Sprintf("failed to save file: %v", err), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"id":          meta.ID,
		"fileName":    meta.OriginalName,
		"originalUrl": fmt.Sprintf("/media/%s/original", meta.ID),
	})
}

func (a *App) handleProcess(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	id := strings.TrimPrefix(r.URL.Path, "/api/process/")
	if id == "" || strings.Contains(id, "/") {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	meta, err := a.store.GetMeta(id)
	if err != nil {
		http.Error(w, "file not found", http.StatusNotFound)
		return
	}

	originalPath := filepath.Join(a.cfg.StorageDir, meta.ID, meta.OriginalStoredName)
	processedAudio, stats, err := a.processViaService(meta.OriginalName, originalPath)
	if err != nil {
		http.Error(w, fmt.Sprintf("processing failed: %v", err), http.StatusBadGateway)
		return
	}

	updatedMeta, err := a.store.SaveProcessed(id, processedAudio, stats.OriginalDuration, stats.ProcessedDuration)
	if err != nil {
		http.Error(w, fmt.Sprintf("failed to save processed file: %v", err), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"processedUrl":         fmt.Sprintf("/media/%s/processed", updatedMeta.ID),
		"compressionRatio":     updatedMeta.CompressionRatio,
		"originalDurationSec":  updatedMeta.OriginalDurationSec,
		"processedDurationSec": updatedMeta.ProcessedDurationSec,
	})
}

func (a *App) handleMedia(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	rest := strings.TrimPrefix(r.URL.Path, "/media/")
	parts := strings.Split(rest, "/")
	if len(parts) != 2 {
		http.Error(w, "invalid media path", http.StatusBadRequest)
		return
	}

	filePath, contentType, err := a.store.GetMediaPath(parts[0], parts[1])
	if err != nil {
		http.Error(w, "media not found", http.StatusNotFound)
		return
	}

	f, err := os.Open(filePath)
	if err != nil {
		http.Error(w, "failed to open media", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		http.Error(w, "failed to stat media", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", contentType)
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}

func (a *App) processViaService(originalName, originalPath string) ([]byte, processorStats, error) {
	src, err := os.Open(originalPath)
	if err != nil {
		return nil, processorStats{}, err
	}
	defer src.Close()

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)

	part, err := writer.CreateFormFile("file", originalName)
	if err != nil {
		return nil, processorStats{}, err
	}
	if _, err := io.Copy(part, src); err != nil {
		return nil, processorStats{}, err
	}

	_ = writer.WriteField("frame_ms", "20")
	_ = writer.WriteField("vad_mode", "2")
	_ = writer.WriteField("min_silence_ms", "300")
	_ = writer.WriteField("target_silence_ms", "120")
	_ = writer.WriteField("speech_pad_ms", "120")
	_ = writer.WriteField("fade_ms", "10")

	if err := writer.Close(); err != nil {
		return nil, processorStats{}, err
	}

	req, err := http.NewRequest(http.MethodPost, a.cfg.ProcessorURL, body)
	if err != nil {
		return nil, processorStats{}, err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())

	resp, err := a.client.Do(req)
	if err != nil {
		return nil, processorStats{}, err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, processorStats{}, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, processorStats{}, fmt.Errorf("processor returned %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}

	stats := processorStats{
		OriginalDuration:  parseHeaderFloat(resp.Header.Get("X-Original-Duration"), 0),
		ProcessedDuration: parseHeaderFloat(resp.Header.Get("X-Processed-Duration"), 0),
	}

	return raw, stats, nil
}

func parseHeaderFloat(value string, fallback float64) float64 {
	parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	if err != nil {
		return fallback
	}
	return parsed
}

func writeJSON(w http.ResponseWriter, statusCode int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(payload)
}

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s (%s)", r.Method, r.URL.Path, time.Since(started))
	})
}
