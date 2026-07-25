// E3-APP · domain policy constants (EES §2.5 versioning law: "policy constants (trash
// days, confirm thresholds) versioned with settings schema, not code-freeze") — the
// canonical DEFAULT policy values plus the pure reader that merges settings-store
// overrides. Anything user/settings visible is read through policyOf(); the constants
// below are the v1 default registry.
/** Structural settings-row shape (domain reads caller-supplied projections — never
 *  imports port types across the island seal; the shape is deliberately minimal). */
type SettingsRowLike = Readonly<Record<string, unknown>>;

export interface LifecyclePolicy {
  /** §10-R16/spec W13: trash retention before purge. */
  readonly trashDays: number;
  /** C15 validation: bulkSize > threshold requires confirmedLarge. */
  readonly bulkConfirmThreshold: number;
  /** §5 meta.undoStack law. */
  readonly undoStackCap: number;
  /** C6 validation: ParkAll rate-limit (per-minute budget in ms latency units). */
  readonly parkAllWindowMs: number;
  /** Park operations expected heartbeat budget et al. (informational). */
  readonly heartbeatWindowMs: number;
}

/** Settings-schema v1 defaults (policy versioning anchor). */
export const DEFAULT_LIFECYCLE_POLICY: LifecyclePolicy = {
  trashDays: 30,
  bulkConfirmThreshold: 20,
  undoStackCap: 20,
  parkAllWindowMs: 60_000,
  heartbeatWindowMs: 250,
};

const MS_PER_DAY = 86_400_000;

export const trashRetentionMsOf = (policy: LifecyclePolicy): number =>
  policy.trashDays * MS_PER_DAY;

/** Settings-row reading law: unknown/invalid values fall back to defaults, never throw. */
export const policyOf = (settingsRows?: readonly SettingsRowLike[]): LifecyclePolicy => {
  if (settingsRows === undefined) return DEFAULT_LIFECYCLE_POLICY;
  const valueOf = (key: string): unknown => {
    const row = settingsRows.find((r) => r['key'] === key);
    return row === undefined ? undefined : row['value'];
  };
  const numOf = (key: string, fallback: number): number => {
    const v = valueOf(key);
    return typeof v === 'number' ? v : fallback;
  };
  return {
    trashDays: numOf('trash.retentionDays', DEFAULT_LIFECYCLE_POLICY.trashDays),
    bulkConfirmThreshold: numOf(
      'trash.bulkConfirmThreshold',
      DEFAULT_LIFECYCLE_POLICY.bulkConfirmThreshold,
    ),
    undoStackCap: numOf('undo.stackCap', DEFAULT_LIFECYCLE_POLICY.undoStackCap),
    parkAllWindowMs: numOf('park.allWindowMs', DEFAULT_LIFECYCLE_POLICY.parkAllWindowMs),
    heartbeatWindowMs: numOf('heartbeat.windowMs', DEFAULT_LIFECYCLE_POLICY.heartbeatWindowMs),
  };
};
