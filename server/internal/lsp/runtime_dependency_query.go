package lsp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

var runtimeDependencyImageID = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)

// RuntimeDependencyAPIQuery reads metadata from the selected immutable runtime
// image. Its caller owns a no-wait resource lease for the short-lived container.
// The probe has no workspace, dependency, credential, or host mounts and never
// imports an installed package. It cannot confuse toolkit libraries with the
// selected runtime's installed libraries.
func RuntimeDependencyAPIQuery(ctx context.Context, imageID, language, runtimeID, revision string, query DependencyAPIQuery) (DependencyAPIIndexPage, error) {
	return runtimeDependencyAPIQuery(ctx, imageID, language, runtimeID, revision, query, runRuntimeDependencyProbe)
}

type runtimeDependencyProbe func(context.Context, string, string, string) ([]byte, error)

func runtimeDependencyAPIQuery(ctx context.Context, imageID, language, runtimeID, revision string, query DependencyAPIQuery, probe runtimeDependencyProbe) (DependencyAPIIndexPage, error) {
	if err := ValidateDependencyAPIQuery(query); err != nil {
		return DependencyAPIIndexPage{}, err
	}
	language = normalizeLanguage(language)
	if !runtimeDependencyImageID.MatchString(imageID) || runtimeID == "" || revision == "" || (language != "python" && language != "node") || (query.Kind != "catalog" && query.Kind != "module") {
		return DependencyAPIIndexPage{}, ErrDependencyAPIIndexUnavailable
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return DependencyAPIIndexPage{}, err
	}
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	module := ""
	if query.Kind == "module" {
		module = query.Module
	}
	data, err := probe(probeCtx, imageID, language, module)
	if err != nil || len(data) > DependencyAPIIndexPageMaxBytes {
		return DependencyAPIIndexPage{}, ErrDependencyAPIIndexUnavailable
	}
	var result struct {
		Roots     []string                  `json:"roots"`
		Entries   []DependencyAPIIndexEntry `json:"entries"`
		Truncated bool                      `json:"truncated"`
		Coverage  string                    `json:"coverage"`
	}
	if err := json.Unmarshal(data, &result); err != nil || len(result.Roots) > dependencyQueryMaxModules || len(result.Entries) > 512 {
		return DependencyAPIIndexPage{}, ErrDependencyAPIIndexUnavailable
	}
	for _, root := range result.Roots {
		if !validDependencyQueryName(root) {
			return DependencyAPIIndexPage{}, ErrDependencyAPIIndexUnavailable
		}
	}
	for _, entry := range result.Entries {
		if !validDependencyQueryName(entry.Module) || len(entry.Symbols) > dependencyQueryMaxSymbols {
			return DependencyAPIIndexPage{}, ErrDependencyAPIIndexUnavailable
		}
		for _, symbol := range entry.Symbols {
			if !validDependencyQuerySymbol(language, symbol.Name) || !validDependencyAPIIndexSymbolKind(symbol.Kind) {
				return DependencyAPIIndexPage{}, ErrDependencyAPIIndexUnavailable
			}
		}
	}
	coverage := "direct"
	if result.Truncated {
		coverage = "partial"
	} else if result.Coverage == "unavailable" {
		coverage = "unavailable"
	}
	page := DependencyAPIIndexPage{
		Schema: DependencyAPIIndexSchema, LanguageID: language, RuntimeID: runtimeID, Revision: revision,
		QueryKind: query.Kind, Module: module, Roots: result.Roots, Entries: result.Entries,
		Complete: true, Coverage: coverage, Truncated: result.Truncated,
	}
	return fitDependencyQueryPage(page, query.MaxBytes), nil
}

func runtimeDependencyProbeArguments(name, imageID, language, module string) ([]string, error) {
	if !runtimeDependencyImageID.MatchString(imageID) || !strings.HasPrefix(name, "bobocloud-lsp-probe-") || len(name) > 64 || (module != "" && !validDependencyQueryName(module)) {
		return nil, ErrDependencyAPIIndexUnavailable
	}
	args := []string{"run", "--rm", "--pull=never", "--name", name,
		"--label", "bobocloud.lsp.probe=true", "--network", "none", "--read-only",
		"--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "32",
		"--memory", "128m", "--memory-swap", "128m", "--cpus", "0.5", "-w", "/"}
	switch normalizeLanguage(language) {
	case "python":
		args = append(args, "--entrypoint", "python3", imageID, "-I", "-S", "-c", runtimePythonDependencyProbe, module)
	case "node":
		args = append(args, "--entrypoint", "node", imageID, "--no-addons", "-e", runtimeNodeDependencyProbe, module)
	default:
		return nil, ErrDependencyAPIIndexUnsupported
	}
	return args, nil
}

type boundedRuntimeProbeOutput struct {
	data []byte
}

func (output *boundedRuntimeProbeOutput) Write(data []byte) (int, error) {
	if len(output.data)+len(data) > DependencyAPIIndexPageMaxBytes {
		return 0, fmt.Errorf("runtime dependency metadata exceeds limit")
	}
	output.data = append(output.data, data...)
	return len(data), nil
}

func runRuntimeDependencyProbe(ctx context.Context, imageID, language, module string) ([]byte, error) {
	var id [12]byte
	if _, err := rand.Read(id[:]); err != nil {
		return nil, err
	}
	name := "bobocloud-lsp-probe-" + hex.EncodeToString(id[:])
	args, err := runtimeDependencyProbeArguments(name, imageID, language, module)
	if err != nil {
		return nil, err
	}
	command := exec.CommandContext(ctx, "docker", args...)
	output := &boundedRuntimeProbeOutput{}
	command.Stdout = output
	command.Stderr = io.Discard
	err = command.Run()
	// docker run's client can exit on cancellation before the daemon removes
	// the container. Keep the caller's resource lease until removal is proven.
	removal := dockerContainerRemoval{remove: forceRemoveDockerContainer}
	if cleanupErr := removal.try(name); cleanupErr != nil {
		removal.wait(name)
		err = errors.Join(err, cleanupErr)
	}
	if err != nil {
		return nil, err
	}
	return output.data, nil
}

const runtimePythonDependencyProbe = `import sys,sysconfig,os,ast,json
module=sys.argv[1]
MAX=512
paths=[]
for key in ('purelib','platlib','stdlib','platstdlib'):
 p=sysconfig.get_path(key)
 if p and p not in paths: paths.append(p)
for p in list(paths):
 d=os.path.join(p,'lib-dynload')
 if os.path.isdir(d): paths.append(d)
roots={n for n in sys.builtin_module_names if n.isidentifier() and not n.startswith('_')}
def entries(p):
 try:
  with os.scandir(p) as scan: return sorted(list(scan)[:8192],key=lambda e:e.name)
 except OSError: return []
def stem(name):
 for ext in ('.pyi','.py','.so','.pyd'):
  if name.endswith(ext):
   value=name[:-len(ext)].split('.')[0]
   if value.isidentifier() and value!='__init__': return value
 return ''
for p in paths:
 for e in entries(p):
  name=e.name if e.is_dir(follow_symlinks=False) else stem(e.name)
  if name and name.isidentifier() and not name.startswith('_') and name not in ('site-packages','dist-packages','test','tests','bin'): roots.add(name)
result={'roots':sorted(roots)[:8192],'entries':[],'truncated':len(roots)>8192}
if module:
 symbols={}; children=set(); visited=set(); parsed=0
 def locate(name):
  parts=name.split('.')
  if not all(p.isidentifier() for p in parts): return None
  for base in paths:
   value=os.path.join(base,*parts)
   for file,ispackage in ((value+'/__init__.pyi',True),(value+'/__init__.py',True),(value+'.pyi',False),(value+'.py',False)):
    if os.path.isfile(file): return file,ispackage
  return None
 def exports(name,depth=0):
  global parsed
  if name in visited: return {}
  if depth>4 or parsed>=32: result['truncated']=True; return {}
  visited.add(name); found=locate(name)
  if not found: return {}
  file,ispackage=found; parsed+=1
  try:
   with open(file,'rb') as handle: source=handle.read(262145)
   if len(source)>262144: result['truncated']=True; return {}
   tree=ast.parse(source)
  except (OSError,SyntaxError,ValueError): return {}
  values={}; allowed=None; dynamic_all=False
  statements=[]
  def branches(nodes):
   for node in nodes:
    if isinstance(node,(ast.If,ast.Try)):
     branches(node.body); branches(node.orelse)
     if isinstance(node,ast.Try):
      for handler in node.handlers: branches(handler.body)
      branches(node.finalbody)
    else: statements.append(node)
  branches(tree.body)
  for node in statements:
   if isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef)): values[node.name]='function'
   elif isinstance(node,ast.ClassDef): values[node.name]='class'
   elif isinstance(node,(ast.Assign,ast.AnnAssign)):
    targets=node.targets if isinstance(node,ast.Assign) else [node.target]
    for target in targets:
     if isinstance(target,ast.Name):
      values[target.id]='value'
      if target.id=='__all__':
       try:
        candidate=ast.literal_eval(node.value)
        if isinstance(candidate,(list,tuple)): allowed={v for v in candidate if isinstance(v,str)}
        else: dynamic_all=True
       except (ValueError,TypeError): dynamic_all=True
   elif isinstance(node,ast.AugAssign) and isinstance(node.target,ast.Name) and node.target.id=='__all__': dynamic_all=True
   elif isinstance(node,ast.ImportFrom):
    parent=name.split('.') if ispackage else name.split('.')[:-1]
    if node.level: target='.'.join(parent[:len(parent)-node.level+1]+((node.module or '').split('.') if node.module else []))
    else: target=node.module or ''
    for alias in node.names:
     if alias.name=='*': values.update(exports(target,depth+1))
     else: values[alias.asname or alias.name]='alias'
   elif isinstance(node,ast.Import):
    for alias in node.names: values[alias.asname or alias.name.split('.')[0]]='module'
  return {n:k for n,k in values.items() if n.isidentifier() and not n.startswith('_') and (dynamic_all or allowed is None or n in allowed)}
 symbols=exports(module)
 found=locate(module)
 if found and found[1]:
  for e in entries(os.path.dirname(found[0])):
   name=e.name if e.is_dir(follow_symlinks=False) else stem(e.name)
   if name and name.isidentifier() and not name.startswith('_') and name not in ('tests','test','doc','docs'): children.add(module+'.'+name)
 if len(symbols)>MAX or len(children)>128: result['truncated']=True
 result['roots']=[module]
 result['entries']=[{'module':module,'kind':'module','symbols':[{'name':n,'kind':symbols[n]} for n in sorted(symbols)[:MAX]]}]+[{'module':n,'kind':'module'} for n in sorted(children)[:128]]
 if not found: result['coverage']='unavailable'
print(json.dumps(result,separators=(',',':')))
`

const runtimeNodeDependencyProbe = `const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const requested=process.argv[1]||'',roots=new Map();
const dirs=[...Module.globalPaths,path.resolve(path.dirname(process.execPath),'../lib/node_modules'),...(process.env.npm_config_prefix?[path.join(process.env.npm_config_prefix,'lib/node_modules')]:[]),...String(process.env.NODE_PATH||'').split(path.delimiter)].filter(Boolean);
const safe=name=>name&&!name.startsWith('/')&&!name.split('/').some(p=>!p||p==='.'||p==='..')&&!/[\\\0\r\n]/.test(name);
for(const name of Module.builtinModules){if(!name.startsWith('_'))roots.set(name.startsWith('node:')?name:'node:'+name,null);}
function readDir(dir){try{return fs.readdirSync(dir,{withFileTypes:true}).slice(0,8192);}catch{return [];}}
for(const dir of dirs)for(const entry of readDir(dir)){
 if(!entry.isDirectory()||entry.name.startsWith('.'))continue;
 const names=entry.name.startsWith('@')?readDir(path.join(dir,entry.name)).filter(e=>e.isDirectory()).map(e=>entry.name+'/'+e.name):[entry.name];
 for(const name of names){const p=path.join(dir,name);if(fs.existsSync(path.join(p,'package.json')))roots.set(name,p);}
}
const result={roots:[...roots.keys()].sort().slice(0,8192),entries:[],truncated:roots.size>8192};
function choice(value){if(typeof value==='string')return value;if(value&&typeof value==='object')for(const key of ['types','import','require','node','default']){const found=choice(value[key]);if(found)return found;}return '';}
if(requested){
 let root=requested;if(requested.startsWith('@'))root=requested.split('/').slice(0,2).join('/');else root=requested.split('/')[0];
 const base=roots.get(root),symbols=new Map(),children=[];
 if(base){try{
  const manifest=JSON.parse(fs.readFileSync(path.join(base,'package.json'),'utf8'));
  const tail=requested.slice(root.length),exports=manifest.exports;
  const entry=tail?choice(exports&&exports['.'+tail]):manifest.types||manifest.typings||choice(exports&&exports['.']||exports)||manifest.main||'index.d.ts';
  if(!tail&&exports&&typeof exports==='object')for(const key of Object.keys(exports))if(key.startsWith('./')&&!key.includes('*')&&safe(key.slice(2)))children.push(root+'/'+key.slice(2));
  const relative=String(entry).replace(/^\.\//,'');
  if(safe(relative)){
   const file=path.resolve(base,relative),prefix=path.resolve(base)+path.sep;
   if(file.startsWith(prefix)&&fs.statSync(file).size<=262144){const text=fs.readFileSync(file,'utf8');
    const pattern=/(?:^|[;\n])\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
    let match;while((match=pattern.exec(text))&&symbols.size<512)symbols.set(match[2],match[1]==='function'?'function':['class','type','interface','enum'].includes(match[1])?'class':'value');
    const assigned=/\b(?:exports|module\.exports)\.([A-Za-z_$][\w$]*)\s*=/g;while((match=assigned.exec(text))&&symbols.size<512)symbols.set(match[1],'value');
   }
  }
 }catch{result.coverage='unavailable';}}else result.coverage='unavailable';
 result.roots=[requested];result.entries=[{module:requested,kind:'module',symbols:[...symbols].sort().map(([name,kind])=>({name,kind}))},...children.slice(0,128).map(module=>({module,kind:'module'}))];
}
process.stdout.write(JSON.stringify(result));`
