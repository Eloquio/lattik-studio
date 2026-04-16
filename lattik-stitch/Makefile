# lattik-stitch build targets.
#
# These wrap scripts/image-build.sh to give the two Docker images a
# self-documenting build surface. The script is still the source of truth —
# these targets are terser invocations plus `make help`. See README.md for
# the full build workflow.

.PHONY: default help images spark-image trino-image version

default: help

help: ## Show this help message
	@echo "lattik-stitch — build targets (current VERSION: $$(cat VERSION))"
	@echo
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*## "}; {printf "  %-14s %s\n", $$1, $$2}'
	@echo
	@echo "Run 'make -j2 images' to build both images in parallel."
	@echo "Set FORCE=1 to overwrite an existing immutable tag (e.g. FORCE=1 make spark-image)."

images: spark-image trino-image ## Build both Spark and Trino stitch images

spark-image: ## Build lattik/spark-stitch and kind-load it into 'lattik'
	@./scripts/image-build.sh spark $(if $(FORCE),--force,)

trino-image: ## Build lattik/trino-stitch and kind-load it into 'lattik'
	@./scripts/image-build.sh trino $(if $(FORCE),--force,)

version: ## Print the current VERSION
	@cat VERSION
