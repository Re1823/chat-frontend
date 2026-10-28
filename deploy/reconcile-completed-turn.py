import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request


DATA = Path('/opt/qiuqiu/chat-frontend/data')
TRANSCRIPTS = Path('/root/.claude/projects/-root')
DEBUG_LOG = Path('/root/.local/state/qiuqiu-frontend-message-rollout/startup-debug.log')
BACKUPS = Path('/var/lib/qiuqiu-completion-reconciler')
ORIGIN = 'http://127.0.0.1:4173'
UUID = re.compile(r'^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
BRIDGE_STATUS = """import json,socket
with socket.socket(socket.AF_UNIX) as client:
    client.settimeout(8)
    client.connect('/run/qiuqiu-claude-bridge/control.sock')
    client.sendall(b'{"op":"status"}\\n')
    client.shutdown(socket.SHUT_WR)
    response=b''
    while True:
        chunk=client.recv(4096)
        if not chunk:break
        response+=chunk
        if len(response)>65536:raise RuntimeError('bridge_response_too_large')
    print(json.dumps(json.loads(response)))
"""


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def timestamp(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def completion_evidence(rows, item, session, debug_tail, now):
    require(item.get('source', 'user') == 'user' and not item.get('imageIds'), 'unsupported_turn')
    require(item.get('status') == 'active', 'queue_not_active')
    rows = [row for row in rows if row.get('timestamp', '') >= item['createdAt']]
    require(bool(rows), 'no_turn_records')
    require(all(row.get('sessionId') == session and row.get('isSidechain') is not True for row in rows), 'session_mismatch')
    prompts = [row for row in rows if row.get('type') == 'user' and isinstance(row.get('message', {}).get('content'), str)]
    require(len(prompts) == 1 and prompts[0]['message']['content'] == item['prompt'], 'prompt_mismatch')
    require(rows[0] is prompts[0], 'unexpected_turn_prefix')
    for row in rows[1:]:
        if row.get('type') == 'user':
            content = row.get('message', {}).get('content')
            require(isinstance(content, list) and bool(content) and
                    all(isinstance(part, dict) and part.get('type') == 'tool_result' for part in content), 'unexpected_user_record')
    previous = rows[0]['uuid']
    for row in rows[1:]:
        require(row.get('parentUuid') == previous and bool(row.get('uuid')), 'broken_record_chain')
        previous = row['uuid']
    assistants = [row for row in rows if row.get('type') == 'assistant']
    require(bool(assistants), 'no_assistant')
    terminal = assistants[-1]
    require(terminal.get('message', {}).get('stop_reason') == 'end_turn', 'not_end_turn')
    terminal_index = rows.index(terminal)
    suffix = rows[terminal_index + 1:]
    require(all(row.get('type') in ('attachment', 'system') for row in suffix), 'continuation_after_terminal')
    require(not any(row.get('subtype') == 'compact_boundary' for row in rows), 'compact_boundary')
    summary = [row for row in suffix if row.get('subtype') == 'stop_hook_summary']
    require(len(summary) == 1 and summary[0].get('preventedContinuation') is False, 'missing_stop_summary')
    require(summary[0].get('hookErrors') == [], 'hook_error')
    require(rows[-1].get('subtype') == 'turn_duration', 'missing_turn_duration')
    completed_at = timestamp(rows[-1]['timestamp'])
    require(now - completed_at >= 60, 'completion_grace_period')
    require(completed_at >= timestamp(terminal['timestamp']), 'invalid_completion_time')
    cancelled = []
    for line in debug_tail.splitlines():
        if 'Hook Stop (Stop) cancelled:' in line:
            event_at = timestamp(line.split(' ', 1)[0])
            if timestamp(terminal['timestamp']) <= event_at <= completed_at:
                cancelled.append(event_at)
    require(len(cancelled) == 1, 'missing_cancelled_stop')
    return {'terminalUuid': terminal['uuid'], 'terminalAt': terminal['timestamp'],
            'completedAt': rows[-1]['timestamp'], 'cancelledStopAt': cancelled[0]}


def read_tail(path, limit):
    before = path.stat()
    with path.open('rb') as stream:
        stream.seek(max(0, before.st_size - limit))
        if stream.tell():
            stream.readline()
        data = stream.read()
    after = path.stat()
    require((before.st_ino, before.st_size, before.st_mtime_ns) ==
            (after.st_ino, after.st_size, after.st_mtime_ns), 'file_changed_during_read')
    require(data.endswith(b'\n'), 'partial_record')
    return data, (before.st_ino, before.st_size, before.st_mtime_ns)


def get_json(route):
    with urllib.request.urlopen(ORIGIN + route, timeout=10) as response:
        return json.load(response)


def service_pid(name):
    return int(subprocess.check_output(['systemctl', 'show', name, '-p', 'MainPID', '--value'], text=True, timeout=8))


def bridge_status():
    return json.loads(subprocess.check_output(['runuser', '-u', 'qiuqiu', '--', 'python3', '-c', BRIDGE_STATUS], text=True, timeout=10))


def check_access():
    runtime = get_json('/api/runtimes/claude-tmux/status')
    bridge = bridge_status()
    state = json.loads((DATA / 'rsc-production-state.json').read_text())
    session = state['currentProductionSessionId']
    require(bool(UUID.fullmatch(session)), 'invalid_session_id')
    read_tail(TRANSCRIPTS / (session + '.jsonl'), 65536)
    read_tail(DEBUG_LOG, 65536)
    json.loads((DATA / 'turn-queue.json').read_text())
    environment = Path(f"/proc/{service_pid('chat-frontend')}/environ").read_bytes()
    require(any(entry.startswith(b'DWELL_CLAUDE_HOOK_SECRET=') for entry in environment.split(b'\0')), 'hook_secret_unavailable')
    require(runtime.get('state') == 'connected' and bridge.get('running'), 'runtime_unavailable')
    print(json.dumps({'event': 'completion_recovery_access_verified', 'active': runtime.get('active')}), flush=True)


def inspect():
    runtime = get_json('/api/runtimes/claude-tmux/status')
    if not runtime.get('active'):
        return None
    turn_id = runtime.get('activeTurnId', '')
    require(bool(UUID.fullmatch(turn_id)), 'invalid_turn_id')
    turn = get_json('/api/chat/turn/' + turn_id + '/status')
    require(turn.get('active') and turn.get('receivedByRuntime') and not turn.get('finished'), 'turn_not_running')
    require(turn.get('state') == 'streaming', 'turn_state_changed')
    queue_bytes = (DATA / 'turn-queue.json').read_bytes()
    queue = json.loads(queue_bytes)
    active = [item for item in queue['records'] if item['status'] in ('active', 'dispatching', 'delivery_uncertain')]
    require(len(active) == 1 and active[0].get('turnId') == turn_id, 'queue_turn_mismatch')
    item = active[0]
    state_bytes = (DATA / 'rsc-production-state.json').read_bytes()
    state = json.loads(state_bytes)
    session = state.get('currentProductionSessionId', '')
    require(bool(UUID.fullmatch(session)), 'invalid_session_id')
    require(state.get('handoffState') == 'ACTIVE' and state.get('candidateActiveSessionId') is None, 'handoff_in_progress')
    pane = subprocess.check_output(['tmux', '-S', '/run/qiuqiu-claude-bridge/dwell-frontend.sock',
                                    'list-panes', '-t', 'dwell-claude', '-F', '#{pane_pid}'], text=True, timeout=8).strip()
    require(pane.isdigit(), 'ambiguous_pane')
    command = Path('/proc/' + pane + '/cmdline').read_bytes().split(b'\0')
    require(b'--resume' in command and command[command.index(b'--resume') + 1].decode() == session, 'process_session_mismatch')
    bridge = bridge_status()
    require(bridge.get('running') and bridge.get('active') and bridge.get('activeTurnId') == turn_id, 'bridge_turn_mismatch')
    tail, fingerprint = read_tail(TRANSCRIPTS / (session + '.jsonl'), 2 * 1024 * 1024)
    rows = [json.loads(line) for line in tail.splitlines() if line]
    debug_tail, _ = read_tail(DEBUG_LOG, 2 * 1024 * 1024)
    evidence = completion_evidence(rows, item, session, debug_tail.decode(), datetime.now(timezone.utc).timestamp())
    evidence.update(turnId=turn_id, sessionId=session, claudePid=int(pane),
                    serverPid=service_pid('chat-frontend'), bridgePid=service_pid('qiuqiu-claude-bridge'),
                    transcriptFingerprint=fingerprint, transcriptTailSha256=hashlib.sha256(tail).hexdigest(),
                    leaseSha256=hashlib.sha256(state_bytes).hexdigest())
    return evidence, queue_bytes, state_bytes, tail


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--check-access', action='store_true')
    arguments = parser.parse_args()
    os.umask(0o077)
    try:
        if arguments.check_access:
            check_access()
            return
        inspected = inspect()
        if inspected is None:
            return
        evidence, queue_bytes, state_bytes, tail = inspected
        print(json.dumps({'event': 'completion_recovery_verified', **evidence}), flush=True)
        if not arguments.apply:
            return
        backup = BACKUPS / evidence['turnId']
        backup.mkdir(mode=0o700, parents=True, exist_ok=False)
        for name, data in [('turn-queue.json', queue_bytes), ('rsc-production-state.json', state_bytes), ('transcript-tail.jsonl', tail)]:
            (backup / name).write_bytes(data)
        (backup / 'evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
        rechecked = inspect()
        require(rechecked is not None and rechecked[0] == evidence, 'evidence_changed_before_completion')
        environment = dict(entry.split(b'=', 1) for entry in Path(f"/proc/{evidence['serverPid']}/environ").read_bytes().split(b'\0') if b'=' in entry)
        secret = environment[b'DWELL_CLAUDE_HOOK_SECRET'].decode()
        body = json.dumps({'hook_event_name': 'Stop', 'session_id': evidence['sessionId'], 'turnId': evidence['turnId']}).encode()
        request = urllib.request.Request(ORIGIN + '/api/internal/claude-code/events', data=body,
                                         headers={'Content-Type': 'application/json', 'x-dwell-hook-secret': secret}, method='POST')
        with urllib.request.urlopen(request, timeout=45) as response:
            result = json.load(response)
        require(result.get('ok') and result.get('accepted'), 'completion_not_accepted')
        print(json.dumps({'event': 'completion_recovered', 'turnId': evidence['turnId']}), flush=True)
    except ValueError as error:
        print(json.dumps({'event': 'completion_recovery_skipped', 'reason': str(error)}), flush=True)
    except Exception as error:
        print(json.dumps({'event': 'completion_recovery_failed', 'errorClass': type(error).__name__}), flush=True)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
