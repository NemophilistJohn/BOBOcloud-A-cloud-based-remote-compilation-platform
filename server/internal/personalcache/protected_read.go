package personalcache

import (
	"errors"
	"os"
)

// AcquireEntryInspectionRead retains a managed namespace selected by its
// cache-relative path without changing its LRU timestamp. Management APIs use
// this form because they do not have the original workspace tree needed to
// recompute the dependency digest, and merely listing caches is not cache use.
func (m *Manager) AcquireEntryInspectionRead(userID, relative string) (*ReadLease, Entry, bool, error) {
	if m == nil || m.options.ScopeMode != "project-lock" {
		return nil, Entry{}, false, nil
	}
	gate := m.userGate(userID)
	gate.Lock()
	defer gate.Unlock()
	request, _, entry, err := m.resolveManagedEntryLocked(userID, relative, 0)
	if errors.Is(err, os.ErrNotExist) {
		return nil, Entry{}, false, nil
	}
	if err != nil {
		return nil, Entry{}, false, err
	}
	m.mu.Lock()
	writerWithoutBase := m.writers[entry.key] > 0 && !m.writerHasBase[entry.key]
	m.mu.Unlock()
	if writerWithoutBase {
		return nil, entry, true, ErrCacheInUse
	}
	reader, retainErr := m.retainInspectionReadLocked(request, entry)
	if retainErr != nil {
		return nil, entry, true, retainErr
	}
	entry.Active = true
	entry.Generation = reader.Generation
	return reader, entry, true, nil
}

// AcquireProtectedRead retains an exact namespace and prevents a package
// manager from mutating that same digest until the lease is released.
func (m *Manager) AcquireProtectedRead(request Request) (*ReadLease, Entry, bool, error) {
	if m == nil || m.options.ScopeMode != "project-lock" {
		return nil, Entry{}, false, nil
	}
	gate := m.userGate(request.UserID)
	gate.Lock()
	defer gate.Unlock()
	entry, exists, err := m.lookupLocked(request)
	if err != nil || !exists {
		return nil, entry, exists, err
	}
	m.mu.Lock()
	writerWithoutBase := m.writers[entry.key] > 0 && !m.writerHasBase[entry.key]
	m.mu.Unlock()
	if writerWithoutBase {
		return nil, entry, true, ErrCacheInUse
	}
	reader, retainErr := m.retainProtectedReadLocked(request, entry)
	if retainErr != nil {
		return nil, entry, true, retainErr
	}
	entry.Active = true
	return reader, entry, true, nil
}

// AcquireProtectedPackageInventoryRead is the Python inventory-verified form
// of AcquireProtectedRead.
func (m *Manager) AcquireProtectedPackageInventoryRead(request Request) (*ReadLease, Entry, InventoryInspection) {
	if m == nil || m.options.ScopeMode != "project-lock" {
		inspection := InventoryInspection{State: "unavailable", Detail: "Project dependency cache inspection is unavailable"}
		return nil, Entry{}, inspection
	}
	gate := m.userGate(request.UserID)
	gate.Lock()
	defer gate.Unlock()
	inspection, entry := m.inspectPackageInventoryLocked(request)
	if inspection.State != "ready" || !inspection.Exact {
		return nil, entry, inspection
	}
	reader, retainErr := m.retainProtectedReadLocked(request, entry)
	if retainErr != nil {
		return nil, entry, InventoryInspection{State: "error", Detail: "The published dependency generation could not be retained"}
	}
	entry.Active = true
	return reader, entry, inspection
}
