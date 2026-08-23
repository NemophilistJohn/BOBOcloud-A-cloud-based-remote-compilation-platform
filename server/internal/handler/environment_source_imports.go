package handler

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"bobocloud-server/internal/model"
	"bobocloud-server/internal/personalcache"
)

const maxEnvironmentSourceBytes = int64(8 << 20)

var (
	pythonImportStatement = regexp.MustCompile(`(?m)^[\t ]*import[\t ]+([^\r\n]+)`)
	pythonFromStatement   = regexp.MustCompile(`(?m)^[\t ]*from[\t ]+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)[\t ]+import(?:[\t (*]|$)`)
)

var pythonImportDistributionAliases = map[string]string{
	"bs4":      "beautifulsoup4",
	"cv2":      "opencv-python",
	"crypto":   "pycryptodome",
	"dateutil": "python-dateutil",
	"pil":      "pillow",
	"sklearn":  "scikit-learn",
	"yaml":     "pyyaml",
}

var pythonStandardLibraryImports = stringSet(strings.Fields(`
__future__ _abc _ast _asyncio _bisect _blake2 _bz2 _codecs _collections _contextvars _csv _ctypes _curses _datetime _decimal _elementtree _functools _hashlib _heapq _imp _io _json _locale _lsprof _lzma _md5 _multibytecodec _multiprocessing _opcode _operator _pickle _posixshmem _posixsubprocess _queue _random _sha1 _sha256 _sha3 _sha512 _signal _socket _sqlite3 _ssl _statistics _string _struct _symtable _thread _tkinter _tracemalloc _uuid _warnings _weakref _xxsubinterpreters _zoneinfo
abc aifc argparse array ast asynchat asyncio asyncore audioop base64 bdb binascii bisect builtins bz2 calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys compileall concurrent configparser contextlib contextvars copy copyreg crypt csv ctypes curses dataclasses datetime dbm decimal difflib dis distutils doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc genericpath getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http idlelib imaplib imghdr imp importlib inspect io ipaddress itertools json keyword lib2to3 linecache locale logging lzma mailbox mailcap marshal math mimetypes mmap modulefinder multiprocessing netrc nis nntplib ntpath numbers opcode operator optparse os pathlib pdb pickle pickletools pipes pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtpd smtplib sndhdr socket socketserver sqlite3 sre_compile sre_constants sre_parse ssl stat statistics string stringprep struct subprocess sunau symtable sys sysconfig tabnanny tarfile telnetlib tempfile termios textwrap threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle turtledemo types typing unicodedata unittest urllib uu uuid venv warnings wave weakref webbrowser wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo
`))

type pythonEnvironmentSource struct {
	path    string
	rel     string
	data    []byte
	modTime int64
}

func inspectPythonSourceDependencies(root string) ([]model.ProjectEnvironmentManifest, []model.ProjectEnvironmentPackage, []int64, error) {
	sources := make([]pythonEnvironmentSource, 0)
	localModules := make(map[string]bool)
	visited := 0
	err := filepath.WalkDir(root, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		visited++
		if visited > maxEnvironmentFiles {
			return fs.SkipAll
		}
		if entry.IsDir() {
			if current != root && environmentSkippedDirs[strings.ToLower(entry.Name())] {
				return filepath.SkipDir
			}
			if current != root {
				rel, _ := filepath.Rel(root, current)
				if strings.Count(filepath.ToSlash(rel), "/") >= maxEnvironmentDepth {
					return filepath.SkipDir
				}
			}
			return nil
		}
		if !strings.EqualFold(filepath.Ext(entry.Name()), ".py") {
			return nil
		}
		info, infoErr := os.Lstat(current)
		if infoErr != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		if info.Size() > maxEnvironmentSourceBytes {
			return nil
		}
		data, readErr := os.ReadFile(current)
		if readErr != nil {
			return readErr
		}
		rel, relErr := filepath.Rel(root, current)
		if relErr != nil {
			return relErr
		}
		rel = filepath.ToSlash(rel)
		parts := strings.Split(rel, "/")
		base := strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name()))
		if base != "__init__" {
			localModules[strings.ToLower(base)] = true
		}
		if len(parts) > 1 {
			localModules[strings.ToLower(parts[0])] = true
			if strings.EqualFold(parts[0], "src") && len(parts) > 2 {
				localModules[strings.ToLower(parts[1])] = true
			}
		}
		sources = append(sources, pythonEnvironmentSource{path: current, rel: rel, data: data, modTime: info.ModTime().UTC().UnixMilli()})
		return nil
	})
	if err != nil {
		return nil, nil, nil, err
	}

	manifests := make([]model.ProjectEnvironmentManifest, 0)
	packages := make([]model.ProjectEnvironmentPackage, 0)
	modTimes := make([]int64, 0)
	for _, source := range sources {
		imports := parsePythonImports(source.data)
		thirdParty := make([]string, 0, len(imports))
		for _, importName := range imports {
			lower := strings.ToLower(importName)
			if pythonStandardLibraryImports[lower] || localModules[lower] {
				continue
			}
			thirdParty = append(thirdParty, importName)
		}
		if len(thirdParty) == 0 {
			continue
		}
		for _, importName := range thirdParty {
			packages = append(packages, model.ProjectEnvironmentPackage{
				Name: normalizePythonPackageName(importName), Scope: "runtime", Source: source.rel,
				Trust: "source-static", Reason: "Detected from Python import " + importName,
			})
		}
		manifests = append(manifests, model.ProjectEnvironmentManifest{
			Path: source.rel, Kind: "source-imports", Manager: "static", Language: "python",
			Parsed: true, Status: "recognized",
		})
		modTimes = append(modTimes, source.modTime)
	}
	return manifests, dedupeEnvironmentPackages(packages), modTimes, nil
}

func parsePythonImports(data []byte) []string {
	sanitized := sanitizePythonSource(data)
	imports := make(map[string]bool)
	for _, match := range pythonImportStatement.FindAllStringSubmatch(sanitized, -1) {
		if len(match) < 2 {
			continue
		}
		statement := strings.SplitN(match[1], ";", 2)[0]
		for _, item := range strings.Split(statement, ",") {
			fields := strings.Fields(strings.TrimSpace(item))
			if len(fields) == 0 {
				continue
			}
			root := strings.SplitN(fields[0], ".", 2)[0]
			if pythonSourceIdentifier(root) {
				imports[root] = true
			}
		}
	}
	for _, match := range pythonFromStatement.FindAllStringSubmatch(sanitized, -1) {
		if len(match) < 2 {
			continue
		}
		root := strings.SplitN(match[1], ".", 2)[0]
		if pythonSourceIdentifier(root) {
			imports[root] = true
		}
	}
	result := make([]string, 0, len(imports))
	for name := range imports {
		result = append(result, name)
	}
	sort.Slice(result, func(i, j int) bool { return strings.ToLower(result[i]) < strings.ToLower(result[j]) })
	return result
}

func sanitizePythonSource(data []byte) string {
	result := make([]byte, len(data))
	copy(result, data)
	for index, value := range result {
		if value != '\n' && value != '\r' {
			result[index] = ' '
		}
	}
	const (
		pythonCode = iota
		pythonComment
		pythonSingle
		pythonDouble
		pythonTripleSingle
		pythonTripleDouble
	)
	state := pythonCode
	escaped := false
	for index := 0; index < len(data); index++ {
		value := data[index]
		switch state {
		case pythonCode:
			switch {
			case value == '#':
				state = pythonComment
			case value == '\'' && index+2 < len(data) && data[index+1] == '\'' && data[index+2] == '\'':
				state = pythonTripleSingle
				index += 2
			case value == '"' && index+2 < len(data) && data[index+1] == '"' && data[index+2] == '"':
				state = pythonTripleDouble
				index += 2
			case value == '\'':
				state = pythonSingle
			case value == '"':
				state = pythonDouble
			default:
				result[index] = value
			}
		case pythonComment:
			if value == '\n' || value == '\r' {
				result[index] = value
				state = pythonCode
			}
		case pythonSingle, pythonDouble:
			quote := byte('\'')
			if state == pythonDouble {
				quote = '"'
			}
			if value == '\n' || value == '\r' {
				result[index] = value
			}
			if escaped {
				escaped = false
			} else if value == '\\' {
				escaped = true
			} else if value == quote {
				state = pythonCode
			}
		case pythonTripleSingle, pythonTripleDouble:
			quote := byte('\'')
			if state == pythonTripleDouble {
				quote = '"'
			}
			if value == '\n' || value == '\r' {
				result[index] = value
			}
			if value == quote && index+2 < len(data) && data[index+1] == quote && data[index+2] == quote {
				state = pythonCode
				index += 2
			}
		}
	}
	return string(result)
}

func resolvePythonSourceDistributions(items []model.ProjectEnvironmentPackage, inventory []personalcache.InventoryPackage) []model.ProjectEnvironmentPackage {
	byImport := make(map[string][]string)
	for _, distribution := range inventory {
		for _, importName := range distribution.Imports {
			key := strings.ToLower(strings.TrimSpace(importName))
			if key != "" && !containsStringFold(byImport[key], distribution.Name) {
				byImport[key] = append(byImport[key], distribution.Name)
			}
		}
	}
	for index := range items {
		item := &items[index]
		if item.Trust != "source-static" {
			continue
		}
		importName := strings.ToLower(strings.TrimSpace(item.Name))
		matches := byImport[importName]
		switch len(matches) {
		case 1:
			item.Name = normalizePythonPackageName(matches[0])
			item.Reason = "Python import maps to installed distribution " + item.Name
		case 0:
			if alias := pythonImportDistributionAliases[importName]; alias != "" {
				item.Name = normalizePythonPackageName(alias)
			}
		default:
			sort.Strings(matches)
			item.Trust = "source-ambiguous"
			item.Reason = "Python import is provided by multiple distributions: " + strings.Join(matches, ", ")
		}
	}
	return dedupeEnvironmentPackages(items)
}

func stringSet(values []string) map[string]bool {
	result := make(map[string]bool, len(values))
	for _, value := range values {
		result[strings.ToLower(strings.TrimSpace(value))] = true
	}
	return result
}

func containsStringFold(values []string, candidate string) bool {
	for _, value := range values {
		if strings.EqualFold(value, candidate) {
			return true
		}
	}
	return false
}

func pythonSourceIdentifier(value string) bool {
	if value == "" {
		return false
	}
	for index, char := range value {
		if index == 0 {
			if !(char == '_' || char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z') {
				return false
			}
			continue
		}
		if !(char == '_' || char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9') {
			return false
		}
	}
	return true
}
