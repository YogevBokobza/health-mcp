import type { HealthFundId } from 'israeli-health-scrapers';

/**
 * Scopes are `fund:resource:capability`, e.g. `maccabi:medications:read`.
 *
 * Naming the fund is what lets a member grant an agent read-only access to one fund and
 * write access to another. It costs nothing while a single fund is configured, and is
 * impossible to retrofit cleanly once grants exist in the wild.
 *
 * Operations that touch no fund — reading the local database — use the reserved fund
 * segment `local`, so every scope has the same three-part shape and the matcher never
 * needs a special case.
 */
export type Scope = `${string}:${string}:${string}`;

/**
 * What a grant lets an operation do.
 *
 * `sensitive_read` exists because some data inside a resource is one decision more
 * private than the rest of it — the measured values behind a test-results timeline,
 * say, beside the timeline's metadata. A member may want an agent to see the timeline
 * without seeing what it measured. A `sensitive_read` grant includes everything a
 * `read` grant covers for the same fund and resource; the lattice is one-way, so a
 * plain `read` grant never reaches a `sensitive_read` operation.
 */
export type Capability = 'read' | 'sensitive_read' | 'write';

export type Resource =
  | 'medications'
  | 'appointments'
  | 'testResults'
  | 'vaccinations'
  | 'form17'
  | 'messages'
  /** The local store itself, reachable without naming a fund. */
  | 'database';

/** Reserved fund segment for operations that act on local data only. */
export const LOCAL = 'local';

export function scope(
  fund: HealthFundId | typeof LOCAL,
  resource: Resource,
  capability: Capability,
): Scope {
  return `${fund}:${resource}:${capability}`;
}

/**
 * Matches a concrete scope against a pattern where any of the three segments may be
 * `*`, e.g. `*:*:write` or `maccabi:appointments:*`.
 *
 * Only whole segments wildcard: `medic*` is not a pattern, it is a literal that will
 * never match. Partial matching invites a grant that reads narrower than it is.
 */
export function scopeMatches(pattern: string, granted: Scope): boolean {
  const patternParts = pattern.split(':');
  const grantedParts = granted.split(':');
  if (patternParts.length !== 3 || grantedParts.length !== 3) return false;

  return patternParts.every((part, i) => part === '*' || part === grantedParts[i]);
}

/** True when any pattern in the list matches. */
export function anyScopeMatches(patterns: readonly string[], granted: Scope): boolean {
  return patterns.some((pattern) => scopeMatches(pattern, granted));
}

/** Reads the capability segment back out of a scope. */
export function capabilityOf(s: Scope): Capability | null {
  const last = s.split(':')[2];
  return last === 'read' || last === 'sensitive_read' || last === 'write' ? last : null;
}

/**
 * The concrete scopes whose grant would satisfy `required`: itself, plus — for a
 * `read` scope — the same scope with the capability upgraded to `sensitive_read`,
 * because a sensitive-read grant includes read. Enumerating variants keeps wildcard
 * semantics in one place: `scopeMatches` stays pattern-vs-concrete, and implication
 * is applied before it, never inside it. The upgrade direction is the only one, so
 * `*:*:read` cannot reach a `sensitive_read` operation while `maccabi:testResults:*`
 * still can.
 */
function scopeVariantsSatisfying(required: Scope): Scope[] {
  const [fund, resource, capability] = required.split(':');
  return capability === 'read'
    ? [required, `${fund}:${resource}:sensitive_read` as Scope]
    : [required];
}

/** True when any granted pattern covers the required scope, honouring capability implication. */
export function grantsScope(patterns: readonly string[], required: Scope): boolean {
  return scopeVariantsSatisfying(required).some((variant) => anyScopeMatches(patterns, variant));
}
