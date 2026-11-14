// Package desktopchat projects the trusted canonical ChatRuntime into the native
// desktop JSON event protocol. It never selects an HTTP origin or accepts keys.
package desktopchat

import (
	"context"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
)

// Client is satisfied by the real *chatruntime.Service. This bridge owns only
// local bindings and subscriptions, never persistent sessions or shared Service
// lifetime. There is deliberately no DeleteSession or Service.Close capability.
type Client interface {
	CreateSession(context.Context, chatruntime.CreateSessionInput) (*chatruntime.Session, error)
	OpenChatSession(context.Context, chatruntime.OpenChatSessionInput) (*chatruntime.Session, error)
	ReadEvents(context.Context, string, int64) (*chatruntime.ReadEventsResult, error)
	Subscribe(string, chatruntime.EventListener) (func(), error)
	DispatchCommand(context.Context, string, map[string]any) (map[string]any, error)
	UploadAttachments(context.Context, string, []chatruntime.AttachmentUploadInput) ([]chatruntime.Attachment, error)
}

var _ Client = (*chatruntime.Service)(nil)

// Target is an authoritative host decision, not a copy of the helper's payload.
// ProjectPath is optional trusted work-session configuration. Empty follows the
// old /chat/sessions HTTP contract and uses OpenChatSession.
type Target struct{ Provider, Model, ExecutionAccountRef, ProjectPath string }

type Options struct {
	Client        Client
	ResolveTarget func(context.Context, map[string]any) (Target, error)
	// Emit is serialized on one worker and must return promptly. The bridge does
	// not block runtime event publication on host I/O or spawn per-event goroutines.
	Emit              func(map[string]any)
	TempDir           string
	MaxSessions       int
	MaxBufferedEvents int
	MaxBufferedBytes  int
	OperationTimeout  time.Duration
	// CleanupTimeout bounds waiting for canceled bridge-local opens on Close.
	// It never authorizes deletion of history or stopping an accepted runtime turn.
	CleanupTimeout time.Duration
}

type Bridge struct {
	client                           Client
	resolve                          func(context.Context, map[string]any) (Target, error)
	emit                             func(map[string]any)
	tempDir                          string
	maxSessions, maxEvents, maxBytes int
	operationTimeout, cleanupTimeout time.Duration
	ctx                              context.Context
	cancel                           context.CancelFunc
	mu                               sync.Mutex
	requests                         map[string]*requestState
	sessions                         map[string]*sessionState
	closed                           bool
	closeDone                        chan struct{}
	closeErr                         error
	operations                       chan struct{}
	inflight                         map[*requestState]struct{}
	outputMu                         sync.Mutex
	output                           []delivery
	outputBytes                      int
	outputWake                       chan struct{}
	outputDone                       chan struct{}
}

type requestState struct {
	requestID  string
	generation int64
	ctx        context.Context
	cancel     context.CancelFunc
	done       chan struct{}
	err        error
	entry      *sessionState
	suppressed bool
}
type sessionState struct {
	model                  string
	request                *requestState
	session                *chatruntime.Session
	ctx                    context.Context
	cancel                 context.CancelFunc
	mu                     sync.Mutex
	ready                  bool
	closed                 bool
	fatal                  error
	unsubscribe            func()
	queue                  []queuedEvent
	queueBytes             int
	observedSeq, lastSeq   int64
	pending                *commandBinding
	active                 *commandBinding
	lastGeneration         int64
	interruptRequested     bool
	lastTerminalID         string
	lastTerminalGeneration int64
	wake                   chan struct{}
	done                   chan struct{}
}
type commandBinding struct {
	id                  string
	generation, fromSeq int64
	stopRequested       bool
}
type queuedEvent struct {
	event chatruntime.EventEnvelope
	bytes int
}
type delivery struct {
	request *requestState
	message map[string]any
	bytes   int
}
