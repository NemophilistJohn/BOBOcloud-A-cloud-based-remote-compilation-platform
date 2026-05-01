from flask import Flask, request, jsonify
import os
import re
import json
import subprocess
import tempfile
import shutil
import base64

app = Flask(__name__)

SERVER_ROOT = '/shareOnling'

if not os.path.exists(SERVER_ROOT):
    os.makedirs(SERVER_ROOT)

COMPILE_RULES = []
_RULES_LOADED = False

SOURCE_EXTENSIONS = {'.c', '.cpp', '.cc', '.cxx', '.h', '.hpp'}

def _load_compile_rules():
    global COMPILE_RULES, _RULES_LOADED
    if _RULES_LOADED:
        return
    _RULES_LOADED = True
    rules_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'compile_rules.json')
    try:
        with open(rules_path, 'r', encoding='utf-8') as f:
            config = json.load(f)
            COMPILE_RULES = config.get('rules', [])
            print(f"Loaded {len(COMPILE_RULES)} compile rules from {rules_path}")
    except Exception as e:
        print(f"Warning: Failed to load compile rules from {rules_path}: {e}")
        COMPILE_RULES = []

def reload_compile_rules():
    global _RULES_LOADED
    _RULES_LOADED = False
    _load_compile_rules()

_load_compile_rules()

def _detect_flags_in_content(content, compiler_type):
    flags = []
    if not COMPILE_RULES:
        return flags
    for rule in COMPILE_RULES:
        for pattern in rule.get('detect', {}).get('patterns', []):
            if re.search(pattern, content, re.MULTILINE):
                for flag in rule.get('flags', {}).get(compiler_type, []):
                    if flag and flag not in flags:
                        flags.append(flag)
                break
    return flags

def _collect_compile_flags(working_dir, compiler_type):
    all_flags = []
    if not COMPILE_RULES or not os.path.exists(working_dir):
        return all_flags
    for item in os.listdir(working_dir):
        item_path = os.path.join(working_dir, item)
        if not os.path.isfile(item_path):
            continue
        ext = os.path.splitext(item)[1].lower()
        if ext not in SOURCE_EXTENSIONS:
            continue
        try:
            with open(item_path, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()
        except Exception:
            continue
        for flag in _detect_flags_in_content(content, compiler_type):
            if flag and flag not in all_flags:
                all_flags.append(flag)
    if all_flags:
        print(f"Auto-detected compile flags for {compiler_type}: {all_flags}")
    return all_flags

@app.route('/', methods=['GET', 'POST'])
def handle_request():
    try:
        json_data = request.get_json()
        print(f"Received request: {json_data}")

        if json_data["action"] == "checkFolder":
            return handle_check_folder(json_data)
        elif json_data["action"] == "runCode":
            return handle_run_code(json_data)
        elif json_data["action"] == "deleteFile":
            return handle_delete_file(json_data)
        else:
            return jsonify({"success": False, "error": "Unknown action"})
    except Exception as e:
        print(f"Error handling request: {e}")
        return jsonify({"success": False, "error": str(e)})

def handle_check_folder(data):
    folder_name = data.get("folderName")
    if not folder_name:
        return jsonify({"success": False, "error": "folderName is required"})

    folder_path = os.path.join(SERVER_ROOT, folder_name)

    if not os.path.exists(folder_path):
        try:
            os.makedirs(folder_path)
            print(f"Created folder: {folder_path}")
        except Exception as e:
            return jsonify({"success": False, "error": f"Failed to create folder: {str(e)}"})

    return jsonify({"success": True, "folderPath": folder_path})

def handle_delete_file(data):
    file_path = data.get("filePath")
    folder_name = data.get("folderName")

    if not file_path or not folder_name:
        return jsonify({"success": False, "error": "filePath and folderName are required"})

    server_file_path = os.path.join(SERVER_ROOT, folder_name, file_path)

    try:
        if os.path.exists(server_file_path):
            os.remove(server_file_path)
            print(f"Deleted file: {server_file_path}")
            return jsonify({"success": True, "message": f"File deleted successfully: {file_path}"})
        else:
            return jsonify({"success": True, "message": f"File not found: {file_path}"})
    except Exception as e:
        print(f"Error deleting file: {e}")
        return jsonify({"success": False, "error": f"Failed to delete file: {str(e)}"})

def get_file_list(dir_path):
    file_list = []
    if os.path.exists(dir_path):
        for item in os.listdir(dir_path):
            item_path = os.path.join(dir_path, item)
            if os.path.isfile(item_path):
                file_list.append(item)
    return file_list

def handle_run_code(data):
    file_path = data.get("filePath")
    folder_name = data.get("folderName")

    if not file_path or not folder_name:
        return jsonify({"success": False, "error": "filePath and folderName are required"})

    server_file_path = os.path.join(SERVER_ROOT, folder_name, file_path)

    if not os.path.exists(server_file_path):
        return jsonify({"success": False, "error": f"File not found on server: {file_path}"})

    try:
        with open(server_file_path, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        return jsonify({"success": False, "error": f"Failed to read file: {str(e)}"})

    _, ext = os.path.splitext(file_path)
    language = get_language_from_extension(ext)

    if not language:
        return jsonify({"success": False, "error": f"Unsupported file extension: {ext}"})

    with tempfile.TemporaryDirectory() as temp_dir:
        project_path = os.path.join(SERVER_ROOT, folder_name)
        if os.path.exists(project_path):
            for item in os.listdir(project_path):
                item_path = os.path.join(project_path, item)
                if os.path.isfile(item_path):
                    shutil.copy2(item_path, temp_dir)

        file_name = os.path.basename(file_path)
        temp_file_path = os.path.join(temp_dir, file_name)

        with open(temp_file_path, 'w') as f:
            f.write(content)

        before_files = get_file_list(temp_dir)

        result = execute_code(language, temp_file_path, temp_dir)

        after_files = get_file_list(temp_dir)

        new_files = list(set(after_files) - set(before_files))

        new_files_content = {}
        for new_file in new_files:
            new_file_path = os.path.join(temp_dir, new_file)
            try:
                try:
                    with open(new_file_path, 'r', encoding='utf-8') as f:
                        file_content = f.read()
                    new_files_content[new_file] = {
                        'type': 'text',
                        'content': file_content
                    }
                except UnicodeDecodeError:
                    with open(new_file_path, 'rb') as f:
                        binary_content = f.read()
                    base64_content = base64.b64encode(binary_content).decode('utf-8')
                    new_files_content[new_file] = {
                        'type': 'binary',
                        'content': base64_content
                    }

                server_new_file_path = os.path.join(SERVER_ROOT, folder_name, new_file)
                if new_files_content[new_file]['type'] == 'text':
                    with open(server_new_file_path, 'w', encoding='utf-8') as f:
                        f.write(new_files_content[new_file]['content'])
                else:
                    with open(server_new_file_path, 'wb') as f:
                        f.write(base64.b64decode(new_files_content[new_file]['content']))
                print(f"Saved new file to server: {server_new_file_path}")
            except Exception as e:
                print(f"Error reading or saving new file {new_file}: {e}")

        result["newFiles"] = new_files_content

    return jsonify(result)

def get_language_from_extension(ext):
    ext_map = {
        '.py': 'python',
        '.java': 'java',
        '.c': 'c',
        '.cpp': 'cpp',
        '.cc': 'cpp',
        '.cxx': 'cpp',
        '.go': 'go',
        '.rs': 'rust'
    }
    return ext_map.get(ext.lower())

def execute_code(language, file_path, working_dir):
    try:
        if language == 'python':
            return run_python(file_path, working_dir)
        elif language == 'java':
            return run_java(file_path, working_dir)
        elif language == 'c':
            return run_c(file_path, working_dir)
        elif language == 'cpp':
            return run_cpp(file_path, working_dir)
        elif language == 'go':
            return run_go(file_path, working_dir)
        elif language == 'rust':
            return run_rust(file_path, working_dir)
        else:
            return {"success": False, "error": f"Unsupported language: {language}"}
    except Exception as e:
        return {"success": False, "error": str(e)}

def run_python(file_path, working_dir):
    result = subprocess.run(
        ['python3.9', file_path],
        cwd=working_dir,
        capture_output=True,
        text=True,
        timeout=30,
        env={**os.environ, 'PYTHONPATH': working_dir}
    )
    return {
        "success": result.returncode == 0,
        "output": result.stdout,
        "error": result.stderr,
        "returncode": result.returncode
    }

def run_java(file_path, working_dir):
    compile_result = subprocess.run(
        ['javac', file_path],
        cwd=working_dir,
        capture_output=True,
        text=True,
        timeout=30
    )

    if compile_result.returncode != 0:
        return {
            "success": False,
            "output": "",
            "error": compile_result.stderr,
            "returncode": compile_result.returncode
        }

    class_name = os.path.splitext(os.path.basename(file_path))[0]

    run_result = subprocess.run(
        ['java', class_name],
        cwd=working_dir,
        capture_output=True,
        text=True,
        timeout=30
    )

    return {
        "success": run_result.returncode == 0,
        "output": run_result.stdout,
        "error": run_result.stderr,
        "returncode": run_result.returncode
    }

def run_c(file_path, working_dir):
    output_file = os.path.join(working_dir, 'output')
    print(f"Compiling C file: {file_path} to {output_file}")
    print(f"Working directory: {working_dir}")
    print(f"Files in directory: {os.listdir(working_dir)}")

    extra_flags = _collect_compile_flags(working_dir, 'gcc')
    compile_cmd = ['gcc', file_path, '-o', output_file, '-Wall'] + extra_flags
    print(f"Compile command: {' '.join(compile_cmd)}")

    compile_result = subprocess.run(
        compile_cmd,
        cwd=working_dir,
        capture_output=True,
        text=True,
        timeout=30
    )

    print(f"Compile return code: {compile_result.returncode}")
    print(f"Compile stdout: {compile_result.stdout}")
    print(f"Compile stderr: {compile_result.stderr}")

    if compile_result.returncode != 0:
        return {
            "success": False,
            "output": compile_result.stdout,
            "error": compile_result.stderr,
            "returncode": compile_result.returncode
        }

    if not os.path.exists(output_file):
        return {
            "success": False,
            "output": "",
            "error": "Compilation succeeded but executable file not found",
            "returncode": 1
        }

    file_stat = os.stat(output_file)
    print(f"File stats: {file_stat}")
    print(f"File permissions: {oct(file_stat.st_mode)}")
    print(f"File size: {file_stat.st_size} bytes")

    try:
        import stat
        os.chmod(output_file, stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR |
                 stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)
        print(f"Set executable permissions successfully")
    except Exception as e:
        print(f"Warning: Could not set executable permissions: {e}")

    file_stat = os.stat(output_file)
    print(f"File permissions after chmod: {oct(file_stat.st_mode)}")

    print(f"Running executable: {output_file}")
    try:
        if os.path.exists(output_file):
            relative_output = os.path.basename(output_file)
            print(f"Running with shell=True: ./{relative_output}")
            run_result = subprocess.run(
                f"./{relative_output}",
                cwd=working_dir,
                capture_output=True,
                text=True,
                timeout=30,
                shell=True
            )
        else:
            return {
                "success": False,
                "output": "",
                "error": "Executable file missing before run",
                "returncode": 1
            }
    except Exception as e:
        print(f"Exception during execution: {e}")
        import traceback
        traceback.print_exc()
        return {
            "success": False,
            "output": "",
            "error": f"Execution error: {str(e)}",
            "returncode": 1
        }

    print(f"Run return code: {run_result.returncode}")
    print(f"Run stdout: {run_result.stdout}")
    print(f"Run stderr: {run_result.stderr}")

    return {
        "success": run_result.returncode == 0,
        "output": run_result.stdout,
        "error": run_result.stderr,
        "returncode": run_result.returncode
    }

def run_cpp(file_path, working_dir):
    output_file = os.path.join(working_dir, 'output')
    print(f"Compiling C++ file: {file_path} to {output_file}")
    print(f"Working directory: {working_dir}")
    print(f"Files in directory: {os.listdir(working_dir)}")

    extra_flags = _collect_compile_flags(working_dir, 'g++')
    compile_cmd = ['g++', file_path, '-o', output_file, '-Wall'] + extra_flags
    print(f"Compile command: {' '.join(compile_cmd)}")

    compile_result = subprocess.run(
        compile_cmd,
        cwd=working_dir,
        capture_output=True,
        text=True,
        timeout=30
    )

    print(f"Compile return code: {compile_result.returncode}")
    print(f"Compile stdout: {compile_result.stdout}")
    print(f"Compile stderr: {compile_result.stderr}")

    if compile_result.returncode != 0:
        return {
            "success": False,
            "output": compile_result.stdout,
            "error": compile_result.stderr,
            "returncode": compile_result.returncode
        }

    if not os.path.exists(output_file):
        return {
            "success": False,
            "output": "",
            "error": "Compilation succeeded but executable file not found",
            "returncode": 1
        }

    file_stat = os.stat(output_file)
    print(f"File stats: {file_stat}")
    print(f"File permissions: {oct(file_stat.st_mode)}")
    print(f"File size: {file_stat.st_size} bytes")

    try:
        import stat
        os.chmod(output_file, stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR |
                 stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)
        print(f"Set executable permissions successfully")
    except Exception as e:
        print(f"Warning: Could not set executable permissions: {e}")

    file_stat = os.stat(output_file)
    print(f"File permissions after chmod: {oct(file_stat.st_mode)}")

    print(f"Running executable: {output_file}")
    try:
        if os.path.exists(output_file):
            relative_output = os.path.basename(output_file)
            print(f"Running with shell=True: ./{relative_output}")
            run_result = subprocess.run(
                f"./{relative_output}",
                cwd=working_dir,
                capture_output=True,
                text=True,
                timeout=30,
                shell=True
            )
        else:
            return {
                "success": False,
                "output": "",
                "error": "Executable file missing before run",
                "returncode": 1
            }
    except Exception as e:
        print(f"Exception during execution: {e}")
        import traceback
        traceback.print_exc()
        return {
            "success": False,
            "output": "",
            "error": f"Execution error: {str(e)}",
            "returncode": 1
        }

    print(f"Run return code: {run_result.returncode}")
    print(f"Run stdout: {run_result.stdout}")
    print(f"Run stderr: {run_result.stderr}")

    return {
        "success": run_result.returncode == 0,
        "output": run_result.stdout,
        "error": run_result.stderr,
        "returncode": run_result.returncode
    }

def run_go(file_path, working_dir):
    result = subprocess.run(
        ['go', 'run', file_path],
        cwd=working_dir,
        capture_output=True,
        text=True,
        timeout=30
    )
    return {
        "success": result.returncode == 0,
        "output": result.stdout,
        "error": result.stderr,
        "returncode": result.returncode
    }

def run_rust(file_path, working_dir):
    output_file = os.path.join(working_dir, 'output')
    print(f"Compiling Rust file: {file_path} to {output_file}")
    print(f"Working directory: {working_dir}")
    print(f"Files in directory: {os.listdir(working_dir)}")

    compile_result = subprocess.run(
        ['rustc', file_path, '-o', output_file],
        cwd=working_dir,
        capture_output=True,
        text=True,
        timeout=60
    )

    print(f"Compile return code: {compile_result.returncode}")
    print(f"Compile stdout: {compile_result.stdout}")
    print(f"Compile stderr: {compile_result.stderr}")

    if compile_result.returncode != 0:
        return {
            "success": False,
            "output": compile_result.stdout,
            "error": compile_result.stderr,
            "returncode": compile_result.returncode
        }

    if not os.path.exists(output_file):
        return {
            "success": False,
            "output": "",
            "error": "Compilation succeeded but executable file not found",
            "returncode": 1
        }

    file_stat = os.stat(output_file)
    print(f"File stats: {file_stat}")
    print(f"File permissions: {oct(file_stat.st_mode)}")
    print(f"File size: {file_stat.st_size} bytes")

    try:
        import stat
        os.chmod(output_file, stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR |
                 stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)
        print(f"Set executable permissions successfully")
    except Exception as e:
        print(f"Warning: Could not set executable permissions: {e}")

    file_stat = os.stat(output_file)
    print(f"File permissions after chmod: {oct(file_stat.st_mode)}")

    print(f"Running executable: {output_file}")
    try:
        if os.path.exists(output_file):
            relative_output = os.path.basename(output_file)
            print(f"Running with shell=True: ./{relative_output}")
            run_result = subprocess.run(
                f"./{relative_output}",
                cwd=working_dir,
                capture_output=True,
                text=True,
                timeout=30,
                shell=True
            )
        else:
            return {
                "success": False,
                "output": "",
                "error": "Executable file missing before run",
                "returncode": 1
            }
    except Exception as e:
        print(f"Exception during execution: {e}")
        import traceback
        traceback.print_exc()
        return {
            "success": False,
            "output": "",
            "error": f"Execution error: {str(e)}",
            "returncode": 1
        }

    print(f"Run return code: {run_result.returncode}")
    print(f"Run stdout: {run_result.stdout}")
    print(f"Run stderr: {run_result.stderr}")

    return {
        "success": run_result.returncode == 0,
        "output": run_result.stdout,
        "error": run_result.stderr,
        "returncode": run_result.returncode
    }

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=3100, debug=False)
