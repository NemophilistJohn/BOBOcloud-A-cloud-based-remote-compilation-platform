from flask import Flask, request, jsonify
import os
import subprocess
import tempfile
import shutil
import base64

app = Flask(__name__)

# 服务端项目根目录
SERVER_ROOT = '/shareOnling'

# 确保根目录存在
if not os.path.exists(SERVER_ROOT):
    os.makedirs(SERVER_ROOT)

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

# 处理检查文件夹请求
def handle_check_folder(data):
    folder_name = data.get("folderName")
    if not folder_name:
        return jsonify({"success": False, "error": "folderName is required"})
    
    folder_path = os.path.join(SERVER_ROOT, folder_name)
    
    # 检查文件夹是否存在，不存在则创建
    if not os.path.exists(folder_path):
        try:
            os.makedirs(folder_path)
            print(f"Created folder: {folder_path}")
        except Exception as e:
            return jsonify({"success": False, "error": f"Failed to create folder: {str(e)}"})
    
    return jsonify({"success": True, "folderPath": folder_path})

# 处理删除文件请求
def handle_delete_file(data):
    file_path = data.get("filePath")
    folder_name = data.get("folderName")
    
    if not file_path or not folder_name:
        return jsonify({"success": False, "error": "filePath and folderName are required"})
    
    # 构建服务器上的文件路径
    server_file_path = os.path.join(SERVER_ROOT, folder_name, file_path)
    
    try:
        # 检查文件是否存在
        if os.path.exists(server_file_path):
            # 删除文件
            os.remove(server_file_path)
            print(f"Deleted file: {server_file_path}")
            return jsonify({"success": True, "message": f"File deleted successfully: {file_path}"})
        else:
            return jsonify({"success": True, "message": f"File not found: {file_path}"})
    except Exception as e:
        print(f"Error deleting file: {e}")
        return jsonify({"success": False, "error": f"Failed to delete file: {str(e)}"})

# 获取目录中的文件列表（不包括子目录）
def get_file_list(dir_path):
    file_list = []
    if os.path.exists(dir_path):
        for item in os.listdir(dir_path):
            item_path = os.path.join(dir_path, item)
            if os.path.isfile(item_path):
                file_list.append(item)
    return file_list

# 处理运行代码请求
def handle_run_code(data):
    file_path = data.get("filePath")
    folder_name = data.get("folderName")
    
    if not file_path or not folder_name:
        return jsonify({"success": False, "error": "filePath and folderName are required"})
    
    # 构建服务器上的文件路径
    server_file_path = os.path.join(SERVER_ROOT, folder_name, file_path)
    
    # 检查文件是否存在
    if not os.path.exists(server_file_path):
        return jsonify({"success": False, "error": f"File not found on server: {file_path}"})
    
    # 读取文件内容
    try:
        with open(server_file_path, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        return jsonify({"success": False, "error": f"Failed to read file: {str(e)}"})
    
    # 获取文件扩展名，判断语言
    _, ext = os.path.splitext(file_path)
    language = get_language_from_extension(ext)
    
    if not language:
        return jsonify({"success": False, "error": f"Unsupported file extension: {ext}"})
    
    # 创建临时目录和文件
    with tempfile.TemporaryDirectory() as temp_dir:
        # 先复制项目中的所有文件到临时目录
        project_path = os.path.join(SERVER_ROOT, folder_name)
        if os.path.exists(project_path):
            for item in os.listdir(project_path):
                item_path = os.path.join(project_path, item)
                if os.path.isfile(item_path):
                    # 只复制文件，不复制目录
                    shutil.copy2(item_path, temp_dir)
        
        # 获取文件名
        file_name = os.path.basename(file_path)
        temp_file_path = os.path.join(temp_dir, file_name)
        
        # 然后写入当前文件内容，覆盖之前复制的文件
        with open(temp_file_path, 'w') as f:
            f.write(content)
        
        # 记录执行前的文件列表
        before_files = get_file_list(temp_dir)
        
        # 执行代码
        result = execute_code(language, temp_file_path, temp_dir)
        
        # 记录执行后的文件列表
        after_files = get_file_list(temp_dir)
        
        # 找出新增的文件
        new_files = list(set(after_files) - set(before_files))
        
        # 读取新增文件的内容，并将新增文件保存到服务器的项目文件夹中
        new_files_content = {}
        for new_file in new_files:
            new_file_path = os.path.join(temp_dir, new_file)
            try:
                # 尝试以文本模式读取文件
                try:
                    with open(new_file_path, 'r', encoding='utf-8') as f:
                        content = f.read()
                    # 文本文件，直接保存内容
                    new_files_content[new_file] = {
                        'type': 'text',
                        'content': content
                    }
                except UnicodeDecodeError:
                    # 二进制文件，使用base64编码
                    with open(new_file_path, 'rb') as f:
                        binary_content = f.read()
                    base64_content = base64.b64encode(binary_content).decode('utf-8')
                    new_files_content[new_file] = {
                        'type': 'binary',
                        'content': base64_content
                    }
                
                # 将新增文件保存到服务器的项目文件夹中
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
        
        # 将新增文件信息添加到结果中
        result["newFiles"] = new_files_content
    
    return jsonify(result)

# 根据文件扩展名获取语言
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

# 执行代码
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

# 运行Python代码
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

# 运行Java代码
def run_java(file_path, working_dir):
    # 编译
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
    
    # 获取类名（文件名不含扩展名）
    class_name = os.path.splitext(os.path.basename(file_path))[0]
    
    # 运行
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

# 运行C代码
def run_c(file_path, working_dir):
    # 编译
    output_file = os.path.join(working_dir, 'output')
    print(f"Compiling C file: {file_path} to {output_file}")
    print(f"Working directory: {working_dir}")
    print(f"Files in directory: {os.listdir(working_dir)}")
    
    compile_result = subprocess.run(
        ['gcc', file_path, '-o', output_file, '-Wall'],
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
    
    # 检查可执行文件是否存在
    if not os.path.exists(output_file):
        return {
            "success": False,
            "output": "",
            "error": "Compilation succeeded but executable file not found",
            "returncode": 1
        }
    
    # 检查文件信息
    file_stat = os.stat(output_file)
    print(f"File stats: {file_stat}")
    print(f"File permissions: {oct(file_stat.st_mode)}")
    print(f"File size: {file_stat.st_size} bytes")
    
    # 添加执行权限
    try:
        import stat
        os.chmod(output_file, stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR | 
                 stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)
        print(f"Set executable permissions successfully")
    except Exception as e:
        print(f"Warning: Could not set executable permissions: {e}")
    
    # 再次检查权限
    file_stat = os.stat(output_file)
    print(f"File permissions after chmod: {oct(file_stat.st_mode)}")
    
    # 运行 - 使用shell=True以兼容CentOS 7
    print(f"Running executable: {output_file}")
    try:
        # 尝试几种不同的运行方式
        if os.path.exists(output_file):
            # 使用相对路径 + shell=True
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

# 运行C++代码
def run_cpp(file_path, working_dir):
    # 编译
    output_file = os.path.join(working_dir, 'output')
    print(f"Compiling C++ file: {file_path} to {output_file}")
    print(f"Working directory: {working_dir}")
    print(f"Files in directory: {os.listdir(working_dir)}")
    
    compile_result = subprocess.run(
        ['g++', file_path, '-o', output_file, '-Wall'],
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
    
    # 检查可执行文件是否存在
    if not os.path.exists(output_file):
        return {
            "success": False,
            "output": "",
            "error": "Compilation succeeded but executable file not found",
            "returncode": 1
        }
    
    # 检查文件信息
    file_stat = os.stat(output_file)
    print(f"File stats: {file_stat}")
    print(f"File permissions: {oct(file_stat.st_mode)}")
    print(f"File size: {file_stat.st_size} bytes")
    
    # 添加执行权限
    try:
        import stat
        os.chmod(output_file, stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR | 
                 stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)
        print(f"Set executable permissions successfully")
    except Exception as e:
        print(f"Warning: Could not set executable permissions: {e}")
    
    # 再次检查权限
    file_stat = os.stat(output_file)
    print(f"File permissions after chmod: {oct(file_stat.st_mode)}")
    
    # 运行 - 使用shell=True以兼容CentOS 7
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

# 运行Go代码
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

# 运行Rust代码
def run_rust(file_path, working_dir):
    # 编译
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
    
    # 检查可执行文件是否存在
    if not os.path.exists(output_file):
        return {
            "success": False,
            "output": "",
            "error": "Compilation succeeded but executable file not found",
            "returncode": 1
        }
    
    # 检查文件信息
    file_stat = os.stat(output_file)
    print(f"File stats: {file_stat}")
    print(f"File permissions: {oct(file_stat.st_mode)}")
    print(f"File size: {file_stat.st_size} bytes")
    
    # 添加执行权限
    try:
        import stat
        os.chmod(output_file, stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR | 
                 stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)
        print(f"Set executable permissions successfully")
    except Exception as e:
        print(f"Warning: Could not set executable permissions: {e}")
    
    # 再次检查权限
    file_stat = os.stat(output_file)
    print(f"File permissions after chmod: {oct(file_stat.st_mode)}")
    
    # 运行 - 使用shell=True以兼容CentOS 7
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

# 主程序入口
if __name__ == '__main__':
    app.run(host='0.0.0.0', port=3100, debug=False)
