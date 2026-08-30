package handler

import "bobocloud-server/internal/personalcache"

func newPersonalCacheManagerForTest(dataDir string, options personalcache.Options) *personalcache.Manager {
	options.ReadPinner = personalcache.NewPortableReadPinnerForTests()
	return personalcache.NewManager(dataDir, options)
}
