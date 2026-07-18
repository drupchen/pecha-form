import { useAuthStore, activeOrg, type Section, type PermLevel } from './useAuthStore';

/** Reactive per-section access for the ACTIVE org.
 *  visible   — the section's tab shows at all (permission !== 'none');
 *  canModify — write affordances render; false = the section is read-only.
 *  Enforcement lives on the backend — this only drives what the UI offers. */
export function useCan(section: Section): { visible: boolean; canModify: boolean } {
  const level = useAuthStore(s => activeOrg(s)?.perms[section] ?? 'none');
  return { visible: level !== 'none', canModify: level === 'modify' };
}

/** Imperative check for non-React code paths. */
export function canModify(section: Section): boolean {
  const s = useAuthStore.getState();
  return (activeOrg(s)?.perms[section] ?? 'none') === 'modify';
}

/** The whole permission map (for the Header's tab filter). */
export function usePerms(): Record<Section, PermLevel> | null {
  return useAuthStore(s => activeOrg(s)?.perms ?? null);
}

/** Org-admin (or platform-admin) in the active org — shows the Admin tab. */
export function useIsAdmin(): boolean {
  return useAuthStore(s =>
    s.user?.is_superuser === true || activeOrg(s)?.can_manage_org === true);
}
