# Stage 1: Generate protobuf Go code
FROM bufbuild/buf:1.50.0 AS buf
WORKDIR /build
COPY buf.yaml buf.gen.yaml ./
COPY proto/ proto/
RUN buf generate

# Stage 2: Build the Go binary
FROM golang:1.23-alpine AS build
WORKDIR /build
COPY go.mod ./
RUN go mod download 2>/dev/null || true
COPY main.go ./
COPY --from=buf /build/gen/ gen/
# Resolve dependencies now that all source is present
RUN go mod tidy && CGO_ENABLED=0 GOOS=linux go build -o /lattik-ingest .

# Stage 3: Minimal runtime
FROM alpine:3.21
RUN apk --no-cache add ca-certificates
COPY --from=build /lattik-ingest /lattik-ingest
EXPOSE 8090
ENTRYPOINT ["/lattik-ingest"]
