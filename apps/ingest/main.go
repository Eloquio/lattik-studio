package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/segmentio/kafka-go"
	"google.golang.org/protobuf/proto"

	loggerv1 "github.com/eloquio/lattik-studio/apps/ingest/gen/lattik/logger/v1"
)

const maxBodySize = 1 << 20 // 1 MB

// tableNameRe constrains the `table` field of every Envelope. Matches what
// downstream consumers (Kafka topic names, Trino identifiers, Iceberg table
// names) accept without quoting — keeps the wire contract narrow and blocks
// `../`, control characters, and topic-namespace breakout.
var tableNameRe = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

func main() {
	addr := env("ADDR", ":8090")
	kafkaBrokers := env("KAFKA_BROKERS", "kafka.kafka:9092")
	dedupWindow := parseDuration(env("DEDUP_WINDOW", "1h"))

	// Required: ingest is unauthenticated-by-default in the previous code path,
	// which allowed any client that could reach the pod to inject events into
	// arbitrary logger tables. Fail closed if the token is missing so a
	// misconfigured deployment doesn't silently expose the endpoint.
	apiToken := os.Getenv("INGEST_API_TOKEN")
	if apiToken == "" {
		log.Fatal("INGEST_API_TOKEN is required (set to a high-entropy random string)")
	}
	apiTokenBytes := []byte(apiToken)

	// Hash balancer (CRC32 over key) ensures every message with the same
	// event_id lands on the same partition. That matters for retries — the
	// idempotency dedup happens by event_id, so if a retry routes to a
	// different partition than the original we lose ordering in the consumer
	// view. LeastBytes (the prior default) optimizes broker-side balance but
	// breaks the key→partition pin.
	writer := &kafka.Writer{
		Addr:         kafka.TCP(kafkaBrokers),
		Balancer:     &kafka.Hash{},
		BatchTimeout: 5 * time.Millisecond, // low latency for local dev
		Async:        false,
	}
	defer writer.Close()

	dedup := newDedupCache(dedupWindow)
	go dedup.cleanupLoop()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealth)
	mux.HandleFunc("POST /v1/events", requireBearer(apiTokenBytes, ingestHandler(writer, dedup)))

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

// requireBearer wraps a handler with a constant-time Bearer-token check.
// The client sends `Authorization: Bearer <token>`; only requests with a
// matching token reach the wrapped handler. Length-checking before the
// constant-time compare prevents a side channel on the length itself.
func requireBearer(expected []byte, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		const prefix = "Bearer "
		if !strings.HasPrefix(auth, prefix) {
			http.Error(w, "missing or malformed Authorization header", http.StatusUnauthorized)
			return
		}
		got := []byte(auth[len(prefix):])
		if len(got) != len(expected) || subtle.ConstantTimeCompare(got, expected) != 1 {
			http.Error(w, "invalid bearer token", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

// Pool 64 KiB scratch buffers for body reads so the per-request growth
// allocations inside `io.ReadAll`'s `bytes.Buffer` don't repeat. The final
// payload is still a fresh, independent slice (so the pooled buffer can be
// released safely after we hand it off to Kafka).
var ingestBufPool = sync.Pool{
	New: func() interface{} {
		buf := bytes.NewBuffer(make([]byte, 0, 64*1024))
		return buf
	},
}

func readBodyPooled(r io.Reader, max int64) ([]byte, error) {
	buf := ingestBufPool.Get().(*bytes.Buffer)
	buf.Reset()
	defer ingestBufPool.Put(buf)
	if _, err := buf.ReadFrom(io.LimitReader(r, max)); err != nil {
		return nil, err
	}
	// Copy out so the returned slice is independent of the pooled buffer.
	out := make([]byte, buf.Len())
	copy(out, buf.Bytes())
	return out, nil
}

func ingestHandler(writer *kafka.Writer, dedup *dedupCache) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ct := r.Header.Get("Content-Type")
		if ct != "application/x-protobuf" {
			http.Error(w, "expected Content-Type: application/x-protobuf", http.StatusUnsupportedMediaType)
			return
		}

		body, err := readBodyPooled(r.Body, maxBodySize)
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

		if !tableNameRe.MatchString(env.Table) {
			http.Error(w, "invalid table field (must match ^[a-z][a-z0-9_]{0,63}$)", http.StatusBadRequest)
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
//
// Bounded to maxEntries so a spike of unique event_ids (legitimate or a
// targeted attack with the API token) can't grow the map without bound
// in between cleanup loop ticks. When at the cap, an opportunistic
// in-place purge of expired entries runs first; if still at the cap, the
// new mark is dropped and tryMark returns true (treat-as-new — at-least-
// once delivery still holds, we just lose dedup for a window).
type dedupCache struct {
	mu         sync.Mutex
	entries    map[string]time.Time
	ttl        time.Duration
	maxEntries int
}

const dedupMaxEntries = 1_000_000 // ~150 MB at ~150 bytes/entry on amd64

func newDedupCache(ttl time.Duration) *dedupCache {
	return &dedupCache{
		entries:    make(map[string]time.Time),
		ttl:        ttl,
		maxEntries: dedupMaxEntries,
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
	if len(d.entries) >= d.maxEntries {
		// Opportunistic purge before giving up the mark. If the ticker
		// hasn't run yet and we're at the cap, do its work inline.
		now := time.Now()
		for id, expiry := range d.entries {
			if now.After(expiry) {
				delete(d.entries, id)
			}
		}
		if len(d.entries) >= d.maxEntries {
			// Still full — drop the mark. The event still goes through;
			// we just trade dedup for memory safety. Logged so an
			// operator can scale up or shorten the TTL.
			return true
		}
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
