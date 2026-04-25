package storage

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var (
	ErrNotFound  = errors.New("file not found")
	ErrInvalidID = errors.New("invalid id")
	idPattern    = regexp.MustCompile(`^[a-f0-9]{16}$`)
)

type Meta struct {
	ID                 string    `json:"id"`
	OriginalName       string    `json:"originalName"`
	OriginalStoredName string    `json:"originalStoredName"`
	ProcessedStored    string    `json:"processedStoredName,omitempty"`
	CreatedAt          time.Time `json:"createdAt"`

	OriginalDurationSec  float64 `json:"originalDurationSec,omitempty"`
	ProcessedDurationSec float64 `json:"processedDurationSec,omitempty"`
	CompressionRatio     float64 `json:"compressionRatio,omitempty"`
}

type Store struct {
	baseDir string
	mu      sync.Mutex
}

func New(baseDir string) (*Store, error) {
	if err := os.MkdirAll(baseDir, 0o755); err != nil {
		return nil, err
	}
	return &Store{baseDir: baseDir}, nil
}

func (s *Store) CreateUpload(originalName string, src io.Reader) (*Meta, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	id, err := randomID()
	if err != nil {
		return nil, err
	}

	dir := filepath.Join(s.baseDir, id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}

	ext := strings.ToLower(filepath.Ext(originalName))
	if ext == "" {
		ext = ".bin"
	}

	storedName := "original" + ext
	dstPath := filepath.Join(dir, storedName)

	dst, err := os.Create(dstPath)
	if err != nil {
		return nil, err
	}
	if _, err := io.Copy(dst, src); err != nil {
		_ = dst.Close()
		return nil, err
	}
	if err := dst.Close(); err != nil {
		return nil, err
	}

	meta := &Meta{
		ID:                 id,
		OriginalName:       originalName,
		OriginalStoredName: storedName,
		CreatedAt:          time.Now().UTC(),
	}

	if err := s.saveMeta(meta); err != nil {
		return nil, err
	}
	return meta, nil
}

func (s *Store) GetMeta(id string) (*Meta, error) {
	if !idPattern.MatchString(id) {
		return nil, ErrInvalidID
	}

	metaPath := filepath.Join(s.baseDir, id, "meta.json")
	raw, err := os.ReadFile(metaPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	var meta Meta
	if err := json.Unmarshal(raw, &meta); err != nil {
		return nil, err
	}
	return &meta, nil
}

func (s *Store) SaveProcessed(id string, audio []byte, originalDuration, processedDuration float64) (*Meta, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	meta, err := s.GetMeta(id)
	if err != nil {
		return nil, err
	}

	dir := filepath.Join(s.baseDir, id)
	processedName := "processed.wav"
	processedPath := filepath.Join(dir, processedName)
	if err := os.WriteFile(processedPath, audio, 0o644); err != nil {
		return nil, err
	}

	meta.ProcessedStored = processedName
	meta.OriginalDurationSec = originalDuration
	meta.ProcessedDurationSec = processedDuration
	if processedDuration > 0 {
		meta.CompressionRatio = originalDuration / processedDuration
	}

	if err := s.saveMeta(meta); err != nil {
		return nil, err
	}
	return meta, nil
}

func (s *Store) GetMediaPath(id, kind string) (string, string, error) {
	meta, err := s.GetMeta(id)
	if err != nil {
		return "", "", err
	}

	var stored string
	switch kind {
	case "original":
		stored = meta.OriginalStoredName
	case "processed":
		stored = meta.ProcessedStored
	default:
		return "", "", ErrNotFound
	}

	if stored == "" {
		return "", "", ErrNotFound
	}

	path := filepath.Join(s.baseDir, id, stored)
	if _, err := os.Stat(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", "", ErrNotFound
		}
		return "", "", err
	}

	ctype := mime.TypeByExtension(filepath.Ext(stored))
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	if strings.EqualFold(filepath.Ext(stored), ".wav") {
		ctype = "audio/wav"
	}

	return path, ctype, nil
}

func (s *Store) saveMeta(meta *Meta) error {
	metaPath := filepath.Join(s.baseDir, meta.ID, "meta.json")
	tmpPath := metaPath + ".tmp"

	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}

	if err := os.WriteFile(tmpPath, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmpPath, metaPath)
}

func randomID() (string, error) {
	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	return hex.EncodeToString(random), nil
}
