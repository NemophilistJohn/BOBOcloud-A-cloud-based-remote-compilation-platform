from flask import Flask, jsonify, request
import base64
import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import tempfile
import threading
import time
import uuid
from websockets.sync.server import serve

app = Flask(__name__)

SERVER_ROOT = '/shareOnling'
HTTP_PORT = 3100
WS_PORT = 3101

os.makedirs(SERVER_ROOT, exist_ok=True)

COMPILE_RULES = []
_RULES_LOADED = False

SOURCE_EXTENSIONS = {'.c', '.cpp', '.cc', '.cxx', '.h', '.hpp'}
RUN_CHANNELS = {}
RUN_CHANNELS_LOCK = threading.Lock()
RUN_SESSIONS = {}
SESSION_LOCK = threading.Lock()
SESSION_TTL_SECONDS = 120


class RunChannel:
    def __init__(self, run_id):
        self.run_id = run_id
        self.websocket = None
        self.closed = False
        self.condition = threading.Condition()
        self.send_lock = threading.Lock()

    def attach(self, websocket):
        with self.condition:
            self.websocket = websocket
            self.condition.notify_all()

    def wait_for_connection(self, timeout):
        with self.condition:
            if self.websocket is not None:
                return True
            self.condition.wait(timeout)
            return self.websocket is not None

    def wait_until_closed(self, timeout=None):
        with self.condition:
            if not self.closed:
                self.condition.wait(timeout)
            return self.closed

    def send(self, payload):
        message = json.dumps(payload, ensure_ascii=False)
        with self.send_lock:
            if self.closed or self.websocket is None:
                return False
            try:
                self.websocket.send(message)
                return True
            except Exception as exc:
                print(f'WebSocket send failed for run {self.run_id}: {exc}')
                self.close()
                return False

    def close(self):
        with self.condition:
            if self.closed:
                return
            self.closed = True
            self.condition.notify_all()
        try:
            if self.websocket is not None:
                self.websocket.close()
        except Exception:
            pass


def _load_compile_rules():
    global COMPILE_RULES, _RULES_LOADED
    if _RULES_LOADED:
        return
    _RULES_LOADED = True
    rules_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'compile_rules.json')
    try:
        with open(rules_path, 'r', encoding='utf-8') as file_obj:
            config = json.load(file_obj)
        COMPILE_RULES = config.get('rules', [])
        print(f'Loaded {len(COMPILE_RULES)} compile rules from {rules_path}')
    except Exception as exc:
        print(f'Warning: Failed to load compile rules from {rules_path}: {exc}')
        COMPILE_RULES = []


def _normalize_flags(raw_flags):
    normalized = []
    for item in raw_flags:
        if not item:
            continue
        if isinstance(item, str):
            if '`' in item or '$(' in item:
                normalized.append(item)
            else:
                normalized.extend(shlex.split(item))
        else:
            normalized.append(str(item))
    return normalized


def _detect_flags_in_content(content, compiler_type):
    flags = []
    if not COMPILE_RULES:
        return flags

    for rule in COMPILE_RULES:
        patterns = rule.get('detect', {}).get('patterns', [])
        if not any(re.search(pattern, content, re.MULTILINE) for pattern in patterns):
            continue
        for flag in _normalize_flags(rule.get('flags', {}).get(compiler_type, [])):
            if flag and flag not in flags:
                flags.append(flag)
    return flags


def _collect_compile_flags(working_dir, compiler_type):
    all_flags = []
    if not COMPILE_RULES or not os.path.exists(working_dir):
        return all_flags

    for root, _dirs, files in os.walk(working_dir):
        for item in files:
            item_path = os.path.join(root, item)
            ext = os.path.splitext(item)[1].lower()
            if ext not in SOURCE_EXTENSIONS:
                continue
            try:
                with open(item_path, 'r', encoding='utf-8', errors='ignore') as file_obj:
                    content = file_obj.read()
            except Exception:
                continue
            for flag in _detect_flags_in_content(content, compiler_type):
                if flag and flag not in all_flags:
                    all_flags.append(flag)

    if all_flags:
        print(f'Auto-detected compile flags for {compiler_type}: {all_flags}')
    return all_flags


def get_run_channel(run_id, create=False):
    with RUN_CHANNELS_LOCK:
        channel = RUN_CHANNELS.get(run_id)
        if channel is None and create:
            channel = RunChannel(run_id)
            RUN_CHANNELS[run_id] = channel
        return channel


def remove_run_channel(run_id):
    with RUN_CHANNELS_LOCK:
        RUN_CHANNELS.pop(run_id, None)
    with SESSION_LOCK:
        RUN_SESSIONS.pop(run_id, None)


def cleanup_expired_sessions(now_ts):
    expired = []
    with SESSION_LOCK:
        for run_id, session in RUN_SESSIONS.items():
            if now_ts - session.get('created_at', now_ts) > SESSION_TTL_SECONDS:
                expired.append(run_id)
        for run_id in expired:
            RUN_SESSIONS.pop(run_id, None)
    for run_id in expired:
        remove_run_channel(run_id)


def send_status(channel, message):
    channel.send({'type': 'status', 'message': message})


def send_error(channel, message):
    channel.send({'type': 'error', 'message': message})


def snapshot_files(dir_path):
    snapshot = {}
    if not os.path.exists(dir_path):
        return snapshot

    for root, _dirs, files in os.walk(dir_path):
        for filename in files:
            full_path = os.path.join(root, filename)
            rel_path = os.path.relpath(full_path, dir_path)
            try:
                stat_result = os.stat(full_path)
                snapshot[rel_path] = (stat_result.st_size, stat_result.st_mtime_ns)
            except OSError:
                continue
    return snapshot


def copy_project_to_temp(source_dir, target_dir):
    if not os.path.exists(source_dir):
        return
    for root, dirs, files in os.walk(source_dir):
        rel_root = os.path.relpath(root, source_dir)
        target_root = target_dir if rel_root == '.' else os.path.join(target_dir, rel_root)
        os.makedirs(target_root, exist_ok=True)
        for directory in dirs:
            os.makedirs(os.path.join(target_root, directory), exist_ok=True)
        for filename in files:
            shutil.copy2(os.path.join(root, filename), os.path.join(target_root, filename))


def sync_generated_artifacts(temp_dir, project_dir, before_snapshot, source_rel_path):
    after_snapshot = snapshot_files(temp_dir)
    changed_files = []

    for rel_path, signature in after_snapshot.items():
        if rel_path == source_rel_path:
            continue
        if before_snapshot.get(rel_path) != signature:
            changed_files.append(rel_path)

    for rel_path in changed_files:
        temp_file_path = os.path.join(temp_dir, rel_path)
        project_file_path = os.path.join(project_dir, rel_path)
        os.makedirs(os.path.dirname(project_file_path), exist_ok=True)
        shutil.copy2(temp_file_path, project_file_path)
        print(f'Saved generated artifact to server workspace: {project_file_path}')

    return changed_files


def send_artifacts(channel, temp_dir, rel_paths):
    for rel_path in rel_paths or []:
        full_path = os.path.join(temp_dir, rel_path)
        if not os.path.exists(full_path):
            continue

        file_type = 'binary'
        content = ''
        try:
            with open(full_path, 'rb') as file_obj:
                data = file_obj.read()
            try:
                content = data.decode('utf-8')
                file_type = 'text'
            except Exception:
                content = base64.b64encode(data).decode('ascii')
                file_type = 'binary'
        except Exception as exc:
            channel.send({'type': 'stderr', 'line': f'Failed to read artifact {rel_path}: {exc}'})
            continue

        chunk_size = 200000
        total_chunks = max(1, (len(content) + chunk_size - 1) // chunk_size)
        for idx in range(total_chunks):
            part = content[idx * chunk_size:(idx + 1) * chunk_size]
            channel.send({
                'type': 'artifact',
                'path': rel_path,
                'fileType': file_type,
                'chunkIndex': idx,
                'chunkCount': total_chunks,
                'data': part
            })


def stream_process(command, cwd, channel, stage, timeout=30, env=None):
    command_display = command if isinstance(command, str) else ' '.join(command)
    send_status(channel, f'[{stage}] {command_display}')

    process = subprocess.Popen(
        command,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        encoding='utf-8',
        errors='replace',
        env=env,
        shell=isinstance(command, str)
    )

    stdout_lines = []
    stderr_lines = []

    def pump(stream, bucket, event_type):
        try:
            for line in iter(stream.readline, ''):
                clean_line = line.rstrip('\r\n')
                bucket.append(clean_line)
                channel.send({'type': event_type, 'line': clean_line, 'stage': stage})
        finally:
            stream.close()

    stdout_thread = threading.Thread(target=pump, args=(process.stdout, stdout_lines, 'stdout'), daemon=True)
    stderr_thread = threading.Thread(target=pump, args=(process.stderr, stderr_lines, 'stderr'), daemon=True)
    stdout_thread.start()
    stderr_thread.start()

    timed_out = False
    try:
        return_code = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        process.kill()
        return_code = process.wait()
        channel.send({'type': 'stderr', 'line': f'[{stage}] Process timed out after {timeout} seconds', 'stage': stage})

    stdout_thread.join(timeout=1)
    stderr_thread.join(timeout=1)

    return {
        'success': return_code == 0 and not timed_out,
        'returncode': return_code,
        'stdout': '\n'.join(stdout_lines),
        'stderr': '\n'.join(stderr_lines),
        'timed_out': timed_out
    }


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


def ensure_executable(file_path):
    try:
        current_mode = os.stat(file_path).st_mode
        os.chmod(file_path, current_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    except Exception as exc:
        print(f'Warning: Failed to set executable bit for {file_path}: {exc}')


def run_python(file_path, working_dir, channel):
    command = ['python3.9', file_path]
    env = {**os.environ, 'PYTHONPATH': working_dir}
    return stream_process(command, working_dir, channel, 'run:python', timeout=30, env=env)


def run_java(file_path, working_dir, channel):
    compile_result = stream_process(['javac', file_path], working_dir, channel, 'compile:java', timeout=30)
    if not compile_result['success']:
        return compile_result
    class_name = os.path.splitext(os.path.basename(file_path))[0]
    return stream_process(['java', class_name], working_dir, channel, 'run:java', timeout=30)


def run_c(file_path, working_dir, channel):
    output_file = os.path.join(working_dir, 'output')
    compile_cmd = ['gcc', file_path, '-o', output_file, '-Wall'] + _collect_compile_flags(working_dir, 'gcc')
    compile_result = stream_process(compile_cmd, working_dir, channel, 'compile:c', timeout=30)
    if not compile_result['success']:
        return compile_result
    if not os.path.exists(output_file):
        return {'success': False, 'returncode': 1, 'stdout': '', 'stderr': 'Compilation succeeded but executable file not found'}
    ensure_executable(output_file)
    return stream_process([output_file], working_dir, channel, 'run:c', timeout=30)


def run_cpp(file_path, working_dir, channel):
    output_file = os.path.join(working_dir, 'output')
    compile_cmd = ['g++', file_path, '-o', output_file, '-Wall'] + _collect_compile_flags(working_dir, 'g++')
    compile_result = stream_process(compile_cmd, working_dir, channel, 'compile:cpp', timeout=30)
    if not compile_result['success']:
        return compile_result
    if not os.path.exists(output_file):
        return {'success': False, 'returncode': 1, 'stdout': '', 'stderr': 'Compilation succeeded but executable file not found'}
    ensure_executable(output_file)
    return stream_process([output_file], working_dir, channel, 'run:cpp', timeout=30)


def run_go(file_path, working_dir, channel):
    return stream_process(['go', 'run', file_path], working_dir, channel, 'run:go', timeout=30)


def run_rust(file_path, working_dir, channel):
    output_file = os.path.join(working_dir, 'output')
    compile_result = stream_process(['rustc', file_path, '-o', output_file], working_dir, channel, 'compile:rust', timeout=60)
    if not compile_result['success']:
        return compile_result
    if not os.path.exists(output_file):
        return {'success': False, 'returncode': 1, 'stdout': '', 'stderr': 'Compilation succeeded but executable file not found'}
    ensure_executable(output_file)
    return stream_process([output_file], working_dir, channel, 'run:rust', timeout=30)


def execute_code(language, file_path, working_dir, channel):
    if language == 'python':
        return run_python(file_path, working_dir, channel)
    if language == 'java':
        return run_java(file_path, working_dir, channel)
    if language == 'c':
        return run_c(file_path, working_dir, channel)
    if language == 'cpp':
        return run_cpp(file_path, working_dir, channel)
    if language == 'go':
        return run_go(file_path, working_dir, channel)
    if language == 'rust':
        return run_rust(file_path, working_dir, channel)
    return {'success': False, 'returncode': 1, 'stdout': '', 'stderr': f'Unsupported language: {language}'}


def run_code_task(run_id, folder_name, file_path, channel):

    project_path = os.path.join(SERVER_ROOT, folder_name)

    try:
        _, ext = os.path.splitext(file_path)
        language = get_language_from_extension(ext)
        if not language:
            send_error(channel, f'Unsupported file extension: {ext}')
            channel.send({'type': 'result', 'success': False, 'returncode': 1})
            return

        with tempfile.TemporaryDirectory(prefix=f'run-{run_id[:8]}-') as temp_dir:
            send_status(channel, f'Preparing isolated workspace for {file_path}')
            copy_project_to_temp(project_path, temp_dir)
            before_snapshot = snapshot_files(temp_dir)
            temp_file_path = os.path.join(temp_dir, file_path)

            if not os.path.exists(temp_file_path):
                send_error(channel, f'File missing in isolated workspace: {file_path}')
                channel.send({'type': 'result', 'success': False, 'returncode': 1})
                return

            result = execute_code(language, temp_file_path, temp_dir, channel)
            changed_files = sync_generated_artifacts(temp_dir, project_path, before_snapshot, file_path)
            send_artifacts(channel, temp_dir, changed_files)
            channel.send({'type': 'artifactsComplete'})

            channel.send({
                'type': 'result',
                'success': result.get('success', False),
                'returncode': result.get('returncode', 1)
            })
    except Exception as exc:
        print(f'Run task error for {run_id}: {exc}')
        send_error(channel, str(exc))
        channel.send({'type': 'result', 'success': False, 'returncode': 1})
    finally:
        channel.close()
        remove_run_channel(run_id)


@app.route('/', methods=['GET', 'POST'])
def handle_request():
    try:
        json_data = request.get_json() or {}
        action = json_data.get('action')
        print(f'Received request: {json_data}')

        if action == 'checkFolder':
            return handle_check_folder(json_data)
        if action == 'runCode':
            return handle_run_code(json_data)
        if action == 'deleteFile':
            return handle_delete_file(json_data)
        return jsonify({'success': False, 'error': 'Unknown action'})
    except Exception as exc:
        print(f'Error handling request: {exc}')
        return jsonify({'success': False, 'error': str(exc)})


def handle_check_folder(data):
    folder_name = data.get('folderName')
    if not folder_name:
        return jsonify({'success': False, 'error': 'folderName is required'})

    folder_path = os.path.join(SERVER_ROOT, folder_name)
    try:
        os.makedirs(folder_path, exist_ok=True)
    except Exception as exc:
        return jsonify({'success': False, 'error': f'Failed to create folder: {exc}'})

    return jsonify({'success': True, 'folderPath': folder_path})


def handle_delete_file(data):
    file_path = data.get('filePath')
    folder_name = data.get('folderName')
    if not file_path or not folder_name:
        return jsonify({'success': False, 'error': 'filePath and folderName are required'})

    server_file_path = os.path.join(SERVER_ROOT, folder_name, file_path)
    try:
        if os.path.exists(server_file_path):
            os.remove(server_file_path)
            print(f'Deleted file: {server_file_path}')
            return jsonify({'success': True, 'message': f'File deleted successfully: {file_path}'})
        return jsonify({'success': True, 'message': f'File not found: {file_path}'})
    except Exception as exc:
        print(f'Error deleting file: {exc}')
        return jsonify({'success': False, 'error': f'Failed to delete file: {exc}'})


def handle_run_code(data):
    file_path = data.get('filePath')
    folder_name = data.get('folderName')
    run_id = data.get('runId') or str(uuid.uuid4())

    if not file_path or not folder_name:
        return jsonify({'success': False, 'error': 'filePath and folderName are required'})

    project_path = os.path.join(SERVER_ROOT, folder_name)
    server_file_path = os.path.join(project_path, file_path)
    if not os.path.exists(server_file_path):
        return jsonify({'success': False, 'error': f'File not found on server: {file_path}'})

    token = uuid.uuid4().hex
    channel = get_run_channel(run_id, create=True)
    cleanup_expired_sessions(time.time())
    with SESSION_LOCK:
        RUN_SESSIONS[run_id] = {
            'token': token,
            'folder_name': folder_name,
            'file_path': file_path,
            'created_at': time.time(),
            'started': False
        }

    return jsonify({'success': True, 'message': 'Handshake accepted', 'runId': run_id, 'token': token, 'wsPath': '/ws'})


def websocket_handler(websocket):
    try:
        raw = websocket.recv()
    except Exception:
        return

    try:
        payload = json.loads(raw) if raw else {}
    except Exception:
        try:
            websocket.send(json.dumps({'type': 'error', 'message': 'Invalid attach payload'}))
        except Exception:
            pass
        return

    if payload.get('type') != 'attach':
        try:
            websocket.send(json.dumps({'type': 'error', 'message': 'First message must be attach'}))
        except Exception:
            pass
        return

    run_id = payload.get('runId')
    token = payload.get('token')
    if not run_id or not token:
        try:
            websocket.send(json.dumps({'type': 'error', 'message': 'Missing runId or token'}))
        except Exception:
            pass
        return

    channel = get_run_channel(run_id)
    with SESSION_LOCK:
        session = RUN_SESSIONS.get(run_id)

    if channel is None or session is None:
        try:
            websocket.send(json.dumps({'type': 'error', 'message': 'Unknown runId'}))
        except Exception:
            pass
        print(f'WS attach rejected: unknown runId={run_id}', flush=True)
        return

    if session.get('token') != token:
        try:
            websocket.send(json.dumps({'type': 'error', 'message': 'Invalid token'}))
        except Exception:
            pass
        print(f'WS attach rejected: invalid token runId={run_id}', flush=True)
        remove_run_channel(run_id)
        return

    with SESSION_LOCK:
        if session.get('started'):
            try:
                websocket.send(json.dumps({'type': 'error', 'message': 'Run already started'}))
            except Exception:
                pass
            return
        session['started'] = True

    channel.attach(websocket)
    print(f'WS attached runId={run_id}', flush=True)

    worker = threading.Thread(
        target=run_code_task,
        args=(run_id, session.get('folder_name'), session.get('file_path'), channel),
        daemon=True
    )
    worker.start()

    channel.wait_until_closed(timeout=None)


def start_websocket_server():
    try:
        print(f'Starting WebSocket server on 0.0.0.0:{WS_PORT}', flush=True)
        with serve(websocket_handler, '0.0.0.0', WS_PORT) as server:
            server.serve_forever()
    except Exception as exc:
        print(f'WebSocket server failed to start: {exc}', flush=True)


if __name__ == '__main__':
    _load_compile_rules()
    ws_thread = threading.Thread(target=start_websocket_server, daemon=True)
    ws_thread.start()
    print(f'Starting HTTP server on 0.0.0.0:{HTTP_PORT}', flush=True)
    app.run(host='0.0.0.0', port=HTTP_PORT, debug=False, threaded=True)
