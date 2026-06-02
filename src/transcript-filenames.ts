/**
 * Session-transcript filename detection — local mirror of OpenClaw's
 * `src/config/sessions/artifacts.ts`.
 *
 * The plugin's `migrate.ts` runs on `gateway_start` and needs to classify
 * session files. The OpenClaw core exposes the same detection helpers but
 * only behind private paths; the public SDK barrel does not re-export them
 * (and per `openclaw/src/plugin-sdk/CLAUDE.md`, broad convenience re-exports
 * are intentionally avoided). Keeping a small local copy next to the consumer
 * is the lowest-friction option. If the SDK later promotes these helpers,
 * swap to the SDK import and delete this file.
 *
 * Source of truth: openclaw/src/config/sessions/artifacts.ts
 *   - COMPACTION_CHECKPOINT_TRANSCRIPT_RE
 *   - isSessionArchiveArtifactName / hasArchiveSuffix
 *   - ARCHIVE_TIMESTAMP_RE
 *   - isTrajectoryRuntimeArtifactName / isTrajectoryPointerArtifactName
 *   - isPrimarySessionTranscriptFileName
 */

const ARCHIVE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z$/;
// Unix epoch milliseconds (13 digits) — also seen on disk for `.deleted.<ts>` files
const UNIX_MS_RE = /^\d{13,}$/;

// Canonical checkpoint filename: <base>.checkpoint.<uuid>.jsonl
// Source: openclaw/src/config/sessions/artifacts.ts:7-8
const COMPACTION_CHECKPOINT_TRANSCRIPT_RE =
  /^(.+)\.checkpoint\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i;

type SessionArchiveReason = "bak" | "reset" | "deleted";

function hasArchiveSuffix(fileName: string, reason: SessionArchiveReason): boolean {
  const marker = `.${reason}.`;
  const index = fileName.lastIndexOf(marker);
  if (index < 0) {
    return false;
  }
  const raw = fileName.slice(index + marker.length);
  return ARCHIVE_TIMESTAMP_RE.test(raw);
}

/** True for `.deleted.<iso>`, `.reset.<iso>`, `.bak.<n>` archive files (OpenClaw-strict). */
export function isSessionArchiveArtifactName(fileName: string): boolean {
  return (
    hasArchiveSuffix(fileName, "deleted") ||
    hasArchiveSuffix(fileName, "reset") ||
    hasArchiveSuffix(fileName, "bak")
  );
}

/**
 * Loose archive-variant detection used for sessionKey normalization.
 *
 * OpenClaw's `isSessionArchiveArtifactName` is strict — it only matches the
 * ISO 8601 timestamp suffix (used to decide which files are safe to GC).
 * But on disk we also see:
 *   - `<base>.jsonl.deleted.<unix-ms>` (e.g. 1780167611136) — used by some
 *     OpenClaw versions
 *   - `<base>.jsonl.bak-<n>-<unix-ms>` (e.g. bak-3946-1778327668577) — legacy
 *
 * For sessionKey normalization we want to fold ALL such variants back to the
 * base sessionId. So this looser check just looks at the structural shape:
 * a marker `.jsonl.<reason>.<rest>` (or `.jsonl.bak-<rest>`) at the end of
 * the filename, where `<rest>` may itself contain dots (e.g. the `.000Z` in
 * `2026-05-01T00-00-00.000Z`) or hyphens.
 */
export function isArchiveVariantFileName(fileName: string): boolean {
  // `<base>.jsonl.reset.<rest>` / `<base>.jsonl.deleted.<rest>` (rest can contain dots/hyphens)
  if (/\.jsonl\.(reset|deleted)\.[\w.-]+$/.test(fileName)) return true;
  // `<base>.jsonl.bak-<rest>`
  if (/\.jsonl\.bak-[\w.-]+$/.test(fileName)) return true;
  return false;
}

/** Quick guard for the unix-ms / iso / bak variants observed in the test fixtures. */
export function looksLikeUnixMsOrIso(suffix: string): boolean {
  return ARCHIVE_TIMESTAMP_RE.test(suffix) || UNIX_MS_RE.test(suffix);
}

/**
 * Parse `<base>.checkpoint.<uuid>.jsonl` into { sessionId, checkpointId }.
 * Returns null if the filename is not a checkpoint file.
 */
export function parseCompactionCheckpointTranscriptFileName(
  fileName: string,
): { sessionId: string; checkpointId: string } | null {
  const match = COMPACTION_CHECKPOINT_TRANSCRIPT_RE.exec(fileName);
  const sessionId = match?.[1];
  const checkpointId = match?.[2];
  return sessionId && checkpointId ? { sessionId, checkpointId } : null;
}

/** True for `*.trajectory.jsonl` files. */
export function isTrajectoryRuntimeArtifactName(fileName: string): boolean {
  return fileName.endsWith(".trajectory.jsonl");
}

/** True for `*.trajectory-path.json` files. */
export function isTrajectoryPointerArtifactName(fileName: string): boolean {
  return fileName.endsWith(".trajectory-path.json");
}

/**
 * True for primary session transcripts — plain `<uuid>.jsonl` files only.
 * Excludes checkpoints, archive (reset/deleted/bak), and trajectory variants.
 */
export function isPrimarySessionTranscriptFileName(fileName: string): boolean {
  if (!fileName.endsWith(".jsonl")) {
    return false;
  }
  if (isTrajectoryRuntimeArtifactName(fileName)) {
    return false;
  }
  if (parseCompactionCheckpointTranscriptFileName(fileName) !== null) {
    return false;
  }
  return !isSessionArchiveArtifactName(fileName);
}

/**
 * Normalize a session-transcript filename to its base sessionId.
 *
 * - `<base>.jsonl` → `<base>`
 * - `<base>.checkpoint.<uuid>.jsonl` → `<base>`
 * - `<base>.jsonl.reset.<iso|unix-ms>.jsonl` → `<base>` (and analogous for deleted)
 * - `<base>.jsonl.bak-<n>-<ts>` → `<base>`
 *
 * Returns null when the filename is not a recognized transcript (trajectory,
 * pointer, temp, store file, etc.) — the caller should skip such files.
 *
 * Uses `isArchiveVariantFileName` (loose) rather than OpenClaw's strict
 * `isSessionArchiveArtifactName` (ISO 8601 only) so the unix-ms / bak- forms
 * also collapse to the base sessionKey.
 */
export function normalizeSessionTranscriptFileName(fileName: string): string | null {
  if (isTrajectoryRuntimeArtifactName(fileName)) return null;
  if (isTrajectoryPointerArtifactName(fileName)) return null;

  const cp = parseCompactionCheckpointTranscriptFileName(fileName);
  if (cp) return cp.sessionId;

  if (isArchiveVariantFileName(fileName)) {
    // Strip the `.jsonl.<reason>.<suffix>` (or `.jsonl.bak-<suffix>`) tail.
    for (const reason of ["deleted", "reset"] as const) {
      const marker = `.jsonl.${reason}.`;
      const index = fileName.lastIndexOf(marker);
      if (index > 0) {
        return fileName.slice(0, index);
      }
    }
    if (fileName.includes(".jsonl.bak-")) {
      return fileName.slice(0, fileName.indexOf(".jsonl.bak-"));
    }
    return null;
  }

  if (fileName.endsWith(".jsonl")) {
    return fileName.slice(0, -".jsonl".length);
  }
  return null;
}

/** Strip a trailing `.checkpoint.<uuid>` from a sessionKey. */
export function stripCheckpointSuffix(sessionKey: string): string {
  return sessionKey.replace(/\.checkpoint\.[^.]+$/, "");
}
