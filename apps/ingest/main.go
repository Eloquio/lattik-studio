package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/segmentio/kafka-go"
	"google.golang.org/protobuf/proto"

	loggerv1 "github.com/eloquio/lattik-studio/apps/ingest/gen/lattik/logger/v1"
)

const maxBodySize = 1 << 20 // 1 MB

func main() {
	addr := env("ADDR", ":8090")
	kafkaBrokers := env("KAFKA_BROKERS", "kafka.kafka:9092")
	dedupWindow := parseDuration(env("DEDUP_WINDOW", "1h"))

	writer := &kafka.Writer{
		Addr:         kafka.TCP(kafkaBrokers),
		Balancer:     &kafka.LeastBytes{},
		BatchTimeout: 5 * time.Millisecond, // low latency for local dev
		Async:        false,
	}
	defer writer.Close()

	dedup := newDedupCache(dedupWindow)
	go dedup.cleanupLoop()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealth)
	mux.HandleFunc("POST /v1/events", ingestHandler(writer, dedup))

	srv := &http.Server{
		Addr:         addr,
		Handler:      mux,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 5 * time.Second,
		IdleTimeout:  30 * time.Second,
	}

	// Graceful shutdown
	done := make(chan os.Signal, 1)
	signal.Notify(done, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		log.Printf("lattik-ingest listening on %s (dedup_window=%s)", addr, dedupWindow)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()

	<-done
	log.Println("shutting down...")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Fatalf("shutdown error: %v", err)
	}
}

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, "ok")
}

func ingestHandler(writer *kafka.Writer, dedup *dedupCache) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ct := r.Header.Get("Content-Type")
		if ct != "application/x-protobuf" {
			http.Error(w, "expected Content-Type: application/x-protobuf", http.StatusUnsupportedMediaType)
			return
		}

		body, err := io.ReadAll(io.LimitReader(r.Body, maxBodySize))
		if err != nil {
			http.Error(w, "read error", http.StatusBadRequest)
			return
		}

		var env loggerv1.Envelope
		if err := proto.Unmarshal(body, &env); err != nil {
			http.Error(w, "invalid protobuf envelope", http.StatusBadRequest)
			return
		}

		if env.Table == "" {
			http.Error(w, "missing table field", http.StatusBadRequest)
			return
		}

		if env.EventId == "" {
			http.Error(w, "missing event_id field", http.StatusBadRequest)
			return
		}

		// Dedup: if we've seen this event_id within the window, return 202
		// (idempotent) without producing again.
		if !dedup.tryMark(env.EventId) {
			w.WriteHeader(http.StatusAccepted)
			return
		}

		topic := "logger." + env.Table

		err = writer.WriteMessages(r.Context(), kafka.Message{
			Topic: topic,
			Key:   []byte(env.EventId),
			Value: body,
		})
		if err != nil {
			// Roll back the dedup mark so retries can succeed.
			dedup.unmark(env.EventId)
			log.Printf("produce failed: topic=%s event_id=%s err=%v", topic, env.EventId, err)
			http.Error(w, "produce failed", http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusAccepted)
	}
}

// dedupCache is an in-memory TTL cache for event_id deduplication.
// Events seen within the TTL window are silently dropped (idempotent 202).
type dedupCache struct {
	mu      sync.Mutex
	entries map[string]time.Time
	ttl     time.Duration
}

func newDedupCache(ttl time.Duration) *dedupCache {
	return &dedupCache{
		entries: make(map[string]time.Time),
		ttl:     ttl,
	}
}

// tryMark returns true if the event_id was NOT seen before (i.e. it's new).
// Returns false if it's a duplicate.
func (d *dedupCache) tryMark(eventID string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if expiry, exists := d.entries[eventID]; exists && time.Now().Before(expiry) {
		return false // duplicate
	}
	d.entries[eventID] = time.Now().Add(d.ttl)
	return true
}

// unmark removes an event_id from the cache (used on produce failure).
func (d *dedupCache) unmark(eventID string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.entries, eventID)
}

// cleanupLoop periodically evicts expired entries to bound memory usage.
func (d *dedupCache) cleanupLoop() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		d.mu.Lock()
		now := time.Now()
		for id, expiry := range d.entries {
			if now.After(expiry) {
				delete(d.entries, id)
			}
		}
		d.mu.Unlock()
	}
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func parseDuration(s string) time.Duration {
	d, err := time.ParseDuration(s)
	if err != nil {
		log.Fatalf("invalid duration %q: %v", s, err)
	}
	return d
}
