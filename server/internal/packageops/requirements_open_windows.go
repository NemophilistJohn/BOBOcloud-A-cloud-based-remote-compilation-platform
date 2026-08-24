//go:build windows

package packageops

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

func openRequirementsFile(root, relative string) (*os.File, bool, error) {
	parts := strings.Split(filepath.Clean(relative), string(filepath.Separator))
	if len(parts) == 0 {
		return nil, false, fmt.Errorf("invalid requirements manifest path")
	}
	handles := make([]windows.Handle, 0, len(parts))
	defer func() {
		for index := len(handles) - 1; index >= 0; index-- {
			_ = windows.CloseHandle(handles[index])
		}
	}()

	current := filepath.Clean(root)
	rootHandle, err := openWindowsRequirementsDirectory(current)
	if err != nil {
		return nil, false, fmt.Errorf("open real project workspace: %w", err)
	}
	handles = append(handles, rootHandle)

	for _, part := range parts[:len(parts)-1] {
		if part == "" || part == "." || part == ".." {
			return nil, false, fmt.Errorf("invalid requirements manifest path")
		}
		current = filepath.Join(current, part)
		handle, openErr := openWindowsRequirementsDirectory(current)
		if windowsPathMissing(openErr) {
			return nil, false, nil
		}
		if openErr != nil {
			return nil, false, fmt.Errorf("open real requirements directory %q: %w", part, openErr)
		}
		handles = append(handles, handle)
	}

	name := parts[len(parts)-1]
	if name == "" || name == "." || name == ".." {
		return nil, false, fmt.Errorf("invalid requirements manifest path")
	}
	target := filepath.Join(current, name)
	pointer, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return nil, false, fmt.Errorf("encode requirements manifest path: %w", err)
	}
	handle, err := windows.CreateFile(pointer, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if windowsPathMissing(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("open real requirements manifest: %w", err)
	}
	var information windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &information); err != nil {
		_ = windows.CloseHandle(handle)
		return nil, false, fmt.Errorf("inspect requirements manifest handle: %w", err)
	}
	if information.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|windows.FILE_ATTRIBUTE_DIRECTORY) != 0 {
		_ = windows.CloseHandle(handle)
		return nil, false, fmt.Errorf("requirements manifest must be a real regular file")
	}
	file := os.NewFile(uintptr(handle), target)
	if file == nil {
		_ = windows.CloseHandle(handle)
		return nil, false, fmt.Errorf("open real requirements manifest")
	}
	return file, true, nil
}

func openWindowsRequirementsDirectory(path string) (windows.Handle, error) {
	pointer, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return windows.InvalidHandle, err
	}
	handle, err := windows.CreateFile(pointer, windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return windows.InvalidHandle, err
	}
	var information windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &information); err != nil {
		_ = windows.CloseHandle(handle)
		return windows.InvalidHandle, err
	}
	if information.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 || information.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		_ = windows.CloseHandle(handle)
		return windows.InvalidHandle, fmt.Errorf("path component is not a real directory")
	}
	return handle, nil
}

func windowsPathMissing(err error) bool {
	return errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND)
}
