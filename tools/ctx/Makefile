# ctx — build, test and release targets.
BINARY  := ctx
PKG     := ./cmd/ctx
BINDIR  := bin
# GOBIN often points inside a version-managed toolchain directory, which a
# toolchain upgrade deletes. Install somewhere stable instead.
PREFIX  ?= $(HOME)/.local/bin

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo none)
DATE    ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

LDFLAGS := -s -w \
	-X ctx/internal/buildinfo.Version=$(VERSION) \
	-X ctx/internal/buildinfo.Commit=$(COMMIT) \
	-X ctx/internal/buildinfo.Date=$(DATE)

.PHONY: all build install test race cover vet fmt fmt-check tidy hooktest selfgate ci clean

all: build

## build: static binary into bin/ (no cgo, so it runs in any CI image)
build:
	CGO_ENABLED=0 go build -trimpath -ldflags '$(LDFLAGS)' -o $(BINDIR)/$(BINARY) $(PKG)

## install: install the built binary into PREFIX (default ~/.local/bin)
install: build
	install -d $(PREFIX)
	install -m 0755 $(BINDIR)/$(BINARY) $(PREFIX)/$(BINARY)
	@echo "installed $(PREFIX)/$(BINARY)"

## test: unit + integration tests (integration tests shell out to real git)
test:
	go test ./... -count=1

race:
	go test ./... -race -count=1

cover:
	go test ./... -count=1 -coverprofile=coverage.out
	go tool cover -func=coverage.out | tail -1

vet:
	go vet ./...

fmt:
	gofmt -w ./cmd ./internal

## fmt-check: fail if anything is unformatted
fmt-check:
	@unformatted=$$(gofmt -l ./cmd ./internal); \
	if [ -n "$$unformatted" ]; then echo "unformatted:"; echo "$$unformatted"; exit 1; fi

tidy:
	go mod tidy

## hooktest: the Claude Code hook scripts, against a throwaway repo and TMPDIR
hooktest: build
	bash hack/test-hooks.sh

## selfgate: ctx enforces its own trailer contract on this repository
selfgate: build
	@if git rev-parse --git-dir >/dev/null 2>&1; then \
		$(BINDIR)/$(BINARY) gate; \
	else \
		echo "selfgate: skipped, not a git repository"; \
	fi

## ci: everything a pipeline should run
ci: fmt-check vet test race build hooktest selfgate

clean:
	rm -rf $(BINDIR) coverage.out
