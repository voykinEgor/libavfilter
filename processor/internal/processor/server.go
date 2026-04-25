package processor

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Address      string
	FFmpegBin    string
	FFprobeBin   string
	MaxBodyBytes int64
}

type Server struct {
	cfg Config
}

func New(cfg Config) *Server {
	return &Server{cfg: cfg}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/process", s.handleProcess)
	return loggingMiddleware(mux)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func (s *Server) handleProcess(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxBodyBytes)
	if err := r.ParseMultipartForm(s.cfg.MaxBodyBytes); err != nil {
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

	workDir, err := os.MkdirTemp("", "smartvad-*")
	if err != nil {
		http.Error(w, "failed to allocate workspace", http.StatusInternalServerError)
		return
	}
	defer os.RemoveAll(workDir)

	inputExt := strings.ToLower(filepath.Ext(header.Filename))
	if inputExt == "" {
		inputExt = ".bin"
	}

	inputPath := filepath.Join(workDir, "input"+inputExt)
	outputPath := filepath.Join(workDir, "output.wav")

	if err := writeInput(inputPath, file); err != nil {
		http.Error(w, fmt.Sprintf("failed to save input: %v", err), http.StatusInternalServerError)
		return
	}

	params := parseParams(r)
	if err := s.runFFmpeg(inputPath, outputPath, params); err != nil {
		http.Error(w, fmt.Sprintf("ffmpeg failed: %v", err), http.StatusBadRequest)
		return
	}

	originalDuration, err := s.probeDuration(inputPath)
	if err != nil {
		http.Error(w, fmt.Sprintf("failed to read input duration: %v", err), http.StatusInternalServerError)
		return
	}
	processedDuration, err := s.probeDuration(outputPath)
	if err != nil {
		http.Error(w, fmt.Sprintf("failed to read output duration: %v", err), http.StatusInternalServerError)
		return
	}

	raw, err := os.ReadFile(outputPath)
	if err != nil {
		http.Error(w, "failed to read output", http.StatusInternalServerError)
		return
	}

	ratio := 0.0
	if processedDuration > 0 {
		ratio = originalDuration / processedDuration
	}

	w.Header().Set("Content-Type", "audio/wav")
	w.Header().Set("X-Original-Duration", fmt.Sprintf("%.6f", originalDuration))
	w.Header().Set("X-Processed-Duration", fmt.Sprintf("%.6f", processedDuration))
	w.Header().Set("X-Compression-Ratio", fmt.Sprintf("%.6f", ratio))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}

type smartVADParams struct {
	FrameMS         int
	VADMode         int
	MinSilenceMS    int
	TargetSilenceMS int
	SpeechPadMS     int
	FadeMS          int
}

func parseParams(r *http.Request) smartVADParams {
	frameMS := intParam(r.FormValue("frame_ms"), 20, 10, 30)
	if frameMS != 10 && frameMS != 20 && frameMS != 30 {
		frameMS = 20
	}

	return smartVADParams{
		FrameMS:         frameMS,
		VADMode:         intParam(r.FormValue("vad_mode"), 2, 0, 3),
		MinSilenceMS:    intParam(r.FormValue("min_silence_ms"), 300, 0, 10000),
		TargetSilenceMS: intParam(r.FormValue("target_silence_ms"), 120, 0, 10000),
		SpeechPadMS:     intParam(r.FormValue("speech_pad_ms"), 120, 0, 2000),
		FadeMS:          intParam(r.FormValue("fade_ms"), 10, 0, 2000),
	}
}

func intParam(raw string, fallback, min, max int) int {
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return fallback
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func writeInput(path string, src io.Reader) error {
	dst, err := os.Create(path)
	if err != nil {
		return err
	}
	defer dst.Close()

	_, err = io.Copy(dst, src)
	return err
}

func (s *Server) runFFmpeg(inputPath, outputPath string, params smartVADParams) error {
	filter := fmt.Sprintf(
		"aformat=sample_fmts=s16:channel_layouts=mono,aresample=16000,smartvad=frame_ms=%d:vad_mode=%d:min_silence_ms=%d:target_silence_ms=%d:speech_pad_ms=%d:fade_ms=%d",
		params.FrameMS,
		params.VADMode,
		params.MinSilenceMS,
		params.TargetSilenceMS,
		params.SpeechPadMS,
		params.FadeMS,
	)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	cmd := exec.CommandContext(
		ctx,
		s.cfg.FFmpegBin,
		"-hide_banner",
		"-loglevel", "error",
		"-y",
		"-i", inputPath,
		"-af", filter,
		outputPath,
	)

	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

func (s *Server) probeDuration(path string) (float64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	cmd := exec.CommandContext(
		ctx,
		s.cfg.FFprobeBin,
		"-v", "error",
		"-show_entries", "format=duration",
		"-of", "default=nw=1:nk=1",
		path,
	)

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return 0, fmt.Errorf("%w: %s", err, strings.TrimSpace(stderr.String()))
	}

	value := strings.TrimSpace(stdout.String())
	duration, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid duration value %q", value)
	}
	return duration, nil
}

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s (%s)", r.Method, r.URL.Path, time.Since(started))
	})
}
