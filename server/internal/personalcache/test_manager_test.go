package personalcache

func newTestManager(dataDir string, options Options) *Manager {
	options.ReadPinner = NewPortableReadPinnerForTests()
	return NewManager(dataDir, options)
}
