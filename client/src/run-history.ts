type Translate = (key: string, params?: Record<string, unknown>) => string;

const taskKinds = { build: 'Build', test: 'Test', run: 'Run', custom: 'Custom' };
const statuses = {
  running: 'Running', completed: 'Completed', failed: 'Failed', timed_out: 'Timed out',
  cancelled: 'Cancelled', interrupted: 'Interrupted'
};
const summaries = new WeakMap<HTMLElement, string>();

export function runHistoryTarget(t: Translate, filePath?: string, taskLabel?: string, taskKind?: string): string {
  if (!taskLabel) return filePath || '?';
  return t('{kind} task: {label}', { kind: t(taskKinds[taskKind as keyof typeof taskKinds] || 'Custom'), label: taskLabel });
}

export function runHistoryTime(value?: string): string {
  return value ? new Date(value).toLocaleString() : '';
}

export function runHistoryStatus(t: Translate, status: string): string {
  return t(statuses[status as keyof typeof statuses] || status || 'Failed');
}

export function renderRunHistorySummary(
  row: HTMLElement, t: Translate, target: string, status: string, metadata: string[]
): void {
  const text = [runHistoryStatus(t, status), ...metadata.filter(Boolean)].join(' · ');
  const key = JSON.stringify([target, status, text]);
  if (summaries.get(row) === key) return;
  summaries.set(row, key);
  const document = row.ownerDocument;
  const indicator = document.createElement('span');
  indicator.className = 'history-row-status';
  indicator.dataset.status = status;
  indicator.setAttribute('aria-hidden', 'true');
  indicator.textContent = '●';
  const title = document.createElement('span');
  title.className = 'history-row-file';
  title.textContent = target;
  title.title = target;
  const info = document.createElement('span');
  info.className = 'history-row-meta';
  info.textContent = text;
  row.replaceChildren(indicator, document.createTextNode(' '), title, document.createTextNode(' '), info);
}

export function sharedRunTranscript(events: Record<string, unknown>[]): string {
  const lines: string[] = [];
  const openLines = new Map<string, number>();
  for (const event of events) {
    if (event.type !== 'stdout' && event.type !== 'stderr' && event.type !== 'error') continue;
    const text = String(event.line ?? event.message ?? '');
    const prefix = event.type === 'stderr' ? '[stderr] ' : '';
    if (event.fragment !== true) {
      lines.push(prefix + text);
      continue;
    }
    const key = event.type + ':' + String(event.stage || '');
    const existing = openLines.get(key);
    if (existing !== undefined && event.replace === true) lines[existing] = prefix + text;
    else if (existing !== undefined && event.append === true) lines[existing] += text;
    else {
      openLines.set(key, lines.length);
      lines.push(prefix + text);
    }
    if (event.newline === true) openLines.delete(key);
  }
  return lines.join('\n');
}
