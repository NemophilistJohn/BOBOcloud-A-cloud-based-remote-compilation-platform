// Package serverruntime coordinates process-wide server lifecycle without
// owning any application resources itself.
package serverruntime

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

var (
	ErrDraining            = errors.New("server runtime is draining")
	ErrNotAccepting        = errors.New("server runtime is not accepting registrations")
	ErrNotDraining         = errors.New("server runtime must begin draining before waiting")
	ErrInvalidRegistration = errors.New("invalid server runtime registration")
	ErrDuplicateName       = errors.New("duplicate server runtime registration name")
)

// State is the externally observable process lifecycle state.
type State uint8

const (
	Accepting State = iota
	Draining
	Stopped
)

func (state State) String() string {
	switch state {
	case Accepting:
		return "accepting"
	case Draining:
		return "draining"
	case Stopped:
		return "stopped"
	default:
		return "unknown"
	}
}

// StopPhase orders resource shutdown after listeners and background workers
// have stopped. Hooks in one phase run concurrently; phases run in ascending
// order. Use separate phases whenever one resource depends on another.
type StopPhase uint16

const (
	PhaseServices  StopPhase = 100
	PhaseResources StopPhase = 200
	PhaseStorage   StopPhase = 300
)

// Listener is implemented by http.Server. Implementations should honor the
// supplied context so a shutdown attempt can finish within its bound.
type Listener interface {
	Shutdown(context.Context) error
}

// StopHook releases a process resource. Hooks must honor the supplied context
// and be safe to retry after returning an error or after their context expires.
type StopHook func(context.Context) error

type Runtime struct {
	ctx    context.Context
	cancel context.CancelCauseFunc

	mu             sync.Mutex
	state          State
	listeners      []*listenerRegistration
	hooks          []*hookRegistration
	names          map[string]struct{}
	workers        sync.WaitGroup
	workersDone    chan struct{}
	waitStarted    bool
	done           chan struct{}
	parentStop     func() bool
	shutdownPermit chan struct{}
}

type listenerRegistration struct {
	name     string
	listener Listener
	step     stopStep
}

type hookRegistration struct {
	name  string
	phase StopPhase
	hook  StopHook
	step  stopStep
}

// stopStep prevents duplicate concurrent shutdown calls while allowing an
// interrupted or failed step to be retried by a later Shutdown call.
type stopStep struct {
	mu       sync.Mutex
	complete bool
	running  bool
	wait     chan struct{}
	lastErr  error
}

// New creates a process runtime rooted in parent. Cancelling parent begins
// draining, but resource shutdown remains explicit through Shutdown.
func New(parent context.Context) *Runtime {
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancelCause(parent)
	runtime := &Runtime{
		ctx:            ctx,
		cancel:         cancel,
		state:          Accepting,
		names:          make(map[string]struct{}),
		workersDone:    make(chan struct{}),
		done:           make(chan struct{}),
		shutdownPermit: make(chan struct{}, 1),
	}
	runtime.shutdownPermit <- struct{}{}
	runtime.parentStop = context.AfterFunc(parent, func() {
		runtime.BeginDrain(context.Cause(parent))
	})
	if parent.Err() != nil {
		runtime.BeginDrain(context.Cause(parent))
	}
	return runtime
}

func (runtime *Runtime) Context() context.Context {
	return runtime.ctx
}

func (runtime *Runtime) Done() <-chan struct{} {
	return runtime.done
}

func (runtime *Runtime) State() State {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	return runtime.state
}

func (runtime *Runtime) IsAccepting() bool {
	return runtime.State() == Accepting
}

// RegisterListener registers an HTTP-style listener. Registration is closed as
// soon as draining begins.
func (runtime *Runtime) RegisterListener(name string, listener Listener) error {
	name = strings.TrimSpace(name)
	if name == "" || listener == nil {
		return ErrInvalidRegistration
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.state != Accepting {
		return ErrNotAccepting
	}
	if _, exists := runtime.names[name]; exists {
		return fmt.Errorf("%w: %s", ErrDuplicateName, name)
	}
	runtime.names[name] = struct{}{}
	runtime.listeners = append(runtime.listeners, &listenerRegistration{name: name, listener: listener})
	return nil
}

// RegisterStopHook registers a resource hook. Hooks normally execute after
// listeners and managed workers stop. If their bounded drain stage expires,
// hooks still run in phase order so forced resource and storage cleanup is not
// skipped.
func (runtime *Runtime) RegisterStopHook(phase StopPhase, name string, hook StopHook) error {
	name = strings.TrimSpace(name)
	if phase == 0 || name == "" || hook == nil {
		return ErrInvalidRegistration
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.state != Accepting {
		return ErrNotAccepting
	}
	if _, exists := runtime.names[name]; exists {
		return fmt.Errorf("%w: %s", ErrDuplicateName, name)
	}
	runtime.names[name] = struct{}{}
	runtime.hooks = append(runtime.hooks, &hookRegistration{name: name, phase: phase, hook: hook})
	return nil
}

// Go starts a managed background task. BeginDrain cancels the task context and
// prevents any new task from being added before Wait begins.
func (runtime *Runtime) Go(name string, task func(context.Context)) error {
	if task == nil {
		return ErrInvalidRegistration
	}
	release, err := runtime.Acquire(name)
	if err != nil {
		return err
	}

	go func() {
		defer release()
		task(runtime.ctx)
	}()
	return nil
}

// Acquire tracks work that already runs in a caller-owned goroutine, such as
// a hijacked WebSocket handler. The returned release is idempotent. Admission
// and WaitGroup registration are atomic with BeginDrain, so Wait never races
// with a late Add.
func (runtime *Runtime) Acquire(name string) (func(), error) {
	if strings.TrimSpace(name) == "" {
		return nil, ErrInvalidRegistration
	}
	runtime.mu.Lock()
	if runtime.state != Accepting {
		runtime.mu.Unlock()
		return nil, ErrNotAccepting
	}
	runtime.workers.Add(1)
	runtime.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(runtime.workers.Done)
	}, nil
}

// BeginDrain atomically rejects new registrations and cancels the process root
// context. Exactly one concurrent caller observes a successful transition.
func (runtime *Runtime) BeginDrain(cause error) bool {
	if cause == nil {
		cause = ErrDraining
	}
	runtime.mu.Lock()
	if runtime.state != Accepting {
		runtime.mu.Unlock()
		return false
	}
	runtime.state = Draining
	if !runtime.waitStarted {
		runtime.waitStarted = true
		go func() {
			runtime.workers.Wait()
			close(runtime.workersDone)
		}()
	}
	runtime.mu.Unlock()
	runtime.cancel(cause)
	return true
}

// Wait waits for every managed background task. Draining must start first so a
// concurrent Go call cannot race with the underlying WaitGroup wait.
func (runtime *Runtime) Wait(ctx context.Context) error {
	ctx = nonNilContext(ctx)
	runtime.mu.Lock()
	state := runtime.state
	workersDone := runtime.workersDone
	runtime.mu.Unlock()
	if state == Accepting {
		return ErrNotDraining
	}
	select {
	case <-workersDone:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Shutdown performs a bounded, retryable, best-effort shutdown. Only one caller
// executes an attempt at a time; concurrent callers wait with their own
// context. Ordinary errors are aggregated while later phases continue, but an
// interrupted stage stops the attempt so dependent resources are not closed
// underneath cleanup that is still running. A later call resumes unfinished
// steps. The runtime becomes Stopped only after every stage succeeds.
func (runtime *Runtime) Shutdown(ctx context.Context) error {
	ctx = nonNilContext(ctx)
	if runtime.State() == Stopped {
		return nil
	}
	runtime.BeginDrain(ErrDraining)
	if err := ctx.Err(); err != nil {
		return err
	}

	select {
	case <-runtime.shutdownPermit:
		defer func() { runtime.shutdownPermit <- struct{}{} }()
	case <-ctx.Done():
		return ctx.Err()
	}
	if runtime.State() == Stopped {
		return nil
	}

	listeners, hooks := runtime.snapshotShutdownSteps()
	listenerOperations := make([]stopOperation, 0, len(listeners))
	for _, registration := range listeners {
		registration := registration
		listenerOperations = append(listenerOperations, stopOperation{
			name: registration.name,
			step: &registration.step,
			call: registration.listener.Shutdown,
		})
	}
	hookGroups := groupStopHooks(hooks)
	stageCount := 1 + len(hookGroups)
	if len(listenerOperations) > 0 {
		stageCount++
	}
	budget := newShutdownBudget(ctx, stageCount)
	errorsFound := make([]error, 0, stageCount)
	if len(listenerOperations) > 0 {
		listenerCtx, cancelListeners := budget.next()
		listenerErr := runStopGroup(listenerCtx, listenerOperations)
		if listenerErr != nil {
			errorsFound = append(errorsFound, fmt.Errorf("shutdown listeners: %w", listenerErr))
		}
		cancelListeners()
		if stopGroupInterrupted(listenerErr) {
			return errors.Join(errorsFound...)
		}
	}

	workerCtx, cancelWorkers := budget.next()
	if err := runtime.Wait(workerCtx); err != nil {
		errorsFound = append(errorsFound, fmt.Errorf("wait for background tasks: %w", err))
	}
	cancelWorkers()

	for _, group := range hookGroups {
		operations := make([]stopOperation, 0, len(group.hooks))
		for _, registration := range group.hooks {
			registration := registration
			operations = append(operations, stopOperation{
				name: registration.name,
				step: &registration.step,
				call: registration.hook,
			})
		}
		phaseCtx, cancelPhase := budget.next()
		phaseErr := runStopGroup(phaseCtx, operations)
		if phaseErr != nil {
			errorsFound = append(errorsFound, fmt.Errorf("shutdown phase %d: %w", group.phase, phaseErr))
		}
		cancelPhase()
		if stopGroupInterrupted(phaseErr) {
			break
		}
	}

	if err := errors.Join(errorsFound...); err != nil {
		return err
	}
	runtime.markStopped()
	return nil
}

func stopGroupInterrupted(err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}

type hookGroup struct {
	phase StopPhase
	hooks []*hookRegistration
}

func groupStopHooks(hooks []*hookRegistration) []hookGroup {
	groups := make([]hookGroup, 0)
	for _, registration := range hooks {
		if len(groups) == 0 || groups[len(groups)-1].phase != registration.phase {
			groups = append(groups, hookGroup{phase: registration.phase})
		}
		last := len(groups) - 1
		groups[last].hooks = append(groups[last].hooks, registration)
	}
	return groups
}

// shutdownBudget gives every remaining stage a cumulative share of the
// caller's deadline. A stuck early stage therefore cannot consume the budget
// reserved for resource and storage cleanup, while no stage can outlive the
// caller's total shutdown deadline.
type shutdownBudget struct {
	parent      context.Context
	started     time.Time
	deadline    time.Time
	stages      int
	nextStage   int
	hasDeadline bool
}

func newShutdownBudget(parent context.Context, stages int) *shutdownBudget {
	budget := &shutdownBudget{parent: parent, started: time.Now(), stages: stages}
	budget.deadline, budget.hasDeadline = parent.Deadline()
	return budget
}

func (budget *shutdownBudget) next() (context.Context, context.CancelFunc) {
	budget.nextStage++
	if !budget.hasDeadline || budget.stages <= 0 {
		return context.WithCancel(budget.parent)
	}
	total := budget.deadline.Sub(budget.started)
	checkpoint := budget.started.Add(time.Duration(budget.nextStage) * total / time.Duration(budget.stages))
	if budget.nextStage >= budget.stages || checkpoint.After(budget.deadline) {
		checkpoint = budget.deadline
	}
	return context.WithDeadline(budget.parent, checkpoint)
}

func (runtime *Runtime) snapshotShutdownSteps() ([]*listenerRegistration, []*hookRegistration) {
	runtime.mu.Lock()
	listeners := append([]*listenerRegistration(nil), runtime.listeners...)
	hooks := append([]*hookRegistration(nil), runtime.hooks...)
	runtime.mu.Unlock()
	sort.SliceStable(hooks, func(left, right int) bool {
		return hooks[left].phase < hooks[right].phase
	})
	return listeners, hooks
}

func (runtime *Runtime) markStopped() {
	runtime.mu.Lock()
	if runtime.state == Stopped {
		runtime.mu.Unlock()
		return
	}
	runtime.state = Stopped
	close(runtime.done)
	parentStop := runtime.parentStop
	runtime.mu.Unlock()
	if parentStop != nil {
		parentStop()
	}
}

type stopOperation struct {
	name string
	step *stopStep
	call StopHook
}

type stopResult struct {
	name string
	err  error
}

func runStopGroup(ctx context.Context, operations []stopOperation) error {
	if len(operations) == 0 {
		return nil
	}
	results := make(chan stopResult, len(operations))
	for _, operation := range operations {
		operation := operation
		go func() {
			results <- stopResult{name: operation.name, err: operation.step.run(ctx, operation.call)}
		}()
	}

	remaining := len(operations)
	errorsFound := make([]error, 0)
	for remaining > 0 {
		select {
		case result := <-results:
			remaining--
			if result.err != nil {
				errorsFound = append(errorsFound, fmt.Errorf("%s: %w", result.name, result.err))
			}
		case <-ctx.Done():
			errorsFound = append(errorsFound, ctx.Err())
			for {
				select {
				case result := <-results:
					remaining--
					if result.err != nil {
						errorsFound = append(errorsFound, fmt.Errorf("%s: %w", result.name, result.err))
					}
				default:
					return errors.Join(errorsFound...)
				}
			}
		}
	}
	return errors.Join(errorsFound...)
}

func (step *stopStep) run(ctx context.Context, call StopHook) error {
	for {
		step.mu.Lock()
		if step.complete {
			step.mu.Unlock()
			return nil
		}
		if step.running {
			wait := step.wait
			step.mu.Unlock()
			select {
			case <-wait:
				continue
			case <-ctx.Done():
				return ctx.Err()
			}
		}

		wait := make(chan struct{})
		step.running = true
		step.wait = wait
		step.mu.Unlock()

		go func(callContext context.Context) {
			err := call(callContext)
			step.mu.Lock()
			step.lastErr = err
			step.complete = err == nil
			step.running = false
			close(wait)
			step.mu.Unlock()
		}(ctx)

		select {
		case <-wait:
			step.mu.Lock()
			err := step.lastErr
			step.mu.Unlock()
			return err
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func nonNilContext(ctx context.Context) context.Context {
	if ctx == nil {
		return context.Background()
	}
	return ctx
}
