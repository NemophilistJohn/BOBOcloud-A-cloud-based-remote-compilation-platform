package resourcecontrol

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"bobocloud-server/internal/resourcegovernor"
)

const maxQueueIdentityBytes = 256

// Admission describes one scheduling unit. ScopeID is a stable project or
// workspace identity; WorkloadID identifies the individual operation.
type Admission struct {
	Workload   Workload
	OwnerID    string
	ScopeID    string
	WorkloadID string
	Minimum    resourcegovernor.Resources
}

type QueueWorkloadPolicy struct {
	Weight     int
	MaxWaiting int
	MaxWait    time.Duration
}

// QueuePolicy bounds every queue dimension. Workloads is a closed array so
// untrusted owner and project identities never become metric dimensions.
type QueuePolicy struct {
	Enabled              bool
	MaxWaiting           int
	MaxWaitingPerOwner   int
	MaxWaitingPerProject int
	AgingThreshold       time.Duration
	Workloads            [workloadCount]QueueWorkloadPolicy
}

type AdmissionErrorCode string

const (
	AdmissionQueueFull        AdmissionErrorCode = "queue_full"
	AdmissionOwnerQueueFull   AdmissionErrorCode = "owner_queue_full"
	AdmissionProjectQueueFull AdmissionErrorCode = "project_queue_full"
	AdmissionQueueTimeout     AdmissionErrorCode = "queue_timeout"
	AdmissionCancelled        AdmissionErrorCode = "cancelled"
	AdmissionDraining         AdmissionErrorCode = "draining"
	AdmissionImpossible       AdmissionErrorCode = "impossible_resource"
)

// AdmissionError reports scheduler policy failures separately from the
// resource ledger's structured capacity rejection.
type AdmissionError struct {
	Code     AdmissionErrorCode
	Workload Workload
	OwnerID  string
	ScopeID  string
	Cause    error
}

func (admissionError *AdmissionError) Error() string {
	if admissionError == nil {
		return ""
	}
	if admissionError.Cause != nil {
		return fmt.Sprintf("resource admission %s: %v", admissionError.Code, admissionError.Cause)
	}
	return fmt.Sprintf("resource admission %s", admissionError.Code)
}

func (admissionError *AdmissionError) Unwrap() error {
	if admissionError == nil {
		return nil
	}
	return admissionError.Cause
}

func normalizeAdmission(admission Admission) Admission {
	admission.OwnerID = boundedQueueIdentity(admission.OwnerID, "anonymous")
	admission.ScopeID = boundedQueueIdentity(admission.ScopeID, "default")
	admission.WorkloadID = boundedQueueIdentity(admission.WorkloadID, "operation")
	return admission
}

func boundedQueueIdentity(value, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		value = fallback
	}
	if len(value) <= maxQueueIdentityBytes {
		return value
	}
	sum := sha256.Sum256([]byte(value))
	return "sha256:" + hex.EncodeToString(sum[:])
}

func nonNilContext(ctx context.Context) context.Context {
	if ctx == nil {
		return context.Background()
	}
	return ctx
}
