package collab

import (
	"sort"
	"sync"
)

type keyedMutexEntry struct {
	mu   sync.Mutex
	refs int
}

// keyedMutex serializes operations for one repository branch without making
// unrelated teams or branches wait for Git network and merge operations.
type keyedMutex struct {
	mu      sync.Mutex
	entries map[string]*keyedMutexEntry
}

func (m *keyedMutex) lock(key string) func() {
	m.mu.Lock()
	if m.entries == nil {
		m.entries = make(map[string]*keyedMutexEntry)
	}
	entry := m.entries[key]
	if entry == nil {
		entry = &keyedMutexEntry{}
		m.entries[key] = entry
	}
	entry.refs++
	m.mu.Unlock()

	entry.mu.Lock()
	var once sync.Once
	return func() {
		once.Do(func() {
			entry.mu.Unlock()
			m.mu.Lock()
			entry.refs--
			if entry.refs == 0 {
				delete(m.entries, key)
			}
			m.mu.Unlock()
		})
	}
}

func (m *keyedMutex) lockMany(keys ...string) func() {
	unique := make(map[string]struct{}, len(keys))
	ordered := make([]string, 0, len(keys))
	for _, key := range keys {
		if _, exists := unique[key]; exists {
			continue
		}
		unique[key] = struct{}{}
		ordered = append(ordered, key)
	}
	sort.Strings(ordered)
	releases := make([]func(), 0, len(ordered))
	for _, key := range ordered {
		releases = append(releases, m.lock(key))
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			for index := len(releases) - 1; index >= 0; index-- {
				releases[index]()
			}
		})
	}
}
