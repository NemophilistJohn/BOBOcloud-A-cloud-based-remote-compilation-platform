//go:build !linux

package hostresource

func detect(string) Capacity {
	return runtimeCPUCapacity()
}
