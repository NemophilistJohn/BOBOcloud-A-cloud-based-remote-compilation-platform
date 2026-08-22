package personalcache

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
	if entry.Writing {
		return nil, entry, true, ErrCacheInUse
	}
	reader := m.retainProtectedReadLocked(request, entry)
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
	reader := m.retainProtectedReadLocked(request, entry)
	entry.Active = true
	return reader, entry, inspection
}
