export function planTrashAction(run, { selectedProjectPath }) {
  if (run.status !== 'running') return { kind: 'dismiss' };
  // Missing paths cannot establish a channel, even when both happen to be null.
  if (typeof selectedProjectPath === 'string' && selectedProjectPath.length > 0
    && run.projectPath === selectedProjectPath) return { kind: 'takeover' };
  return {
    kind: 'refuse',
    reason: 'agen ini milik sesi Claude Code lain — dashboard hanya mengamatinya lewat hooks dan tidak punya kanal untuk menggantinya',
  };
}

// The caller supplies time so a recorded run always produces the same brief in tests.
export function takeoverMessage(run, { now }) {
  const elapsed = run.startedAt == null ? NaN : new Date(now) - new Date(run.startedAt);
  const duration = Number.isFinite(elapsed) ? `${Math.max(0, Math.floor(elapsed / 1000))} detik` : 'tidak diketahui';
  return [
    `Permintaan take over untuk run ${run.id} (agentId: ${run.agentId ?? 'tidak diketahui'}).`,
    `Tipe agen asli: ${run.agentType ?? 'unknown'}.`,
    `Deskripsi tugas asli: ${run.description || 'tidak tercatat'}`,
    `Prompt tugas asli: ${run.prompt || 'tidak tercatat'}`,
    `Sudah berjalan: ${duration}.`,
    'Hentikan agen tersebut, lalu kirim agen pengganti dengan brief yang LEBIH SEMPIT dan terarah ke solusi tugas yang sama. Tetapkan langkah konkret dan kriteria selesai yang jelas.',
    'Jika agen tersebut tidak dapat dihentikan dari sesi ini, jelaskan kendalanya. Jangan hentikan seluruh sesi atau klaim agen sudah berhenti tanpa konfirmasi.',
  ].join('\n');
}
