/** Admin endpoints (orgs, members, roles, invites, platform users) — kept out of
 *  client.ts, which is the data-plane module. All through the auth-aware jfetch. */
import { API_BASE, J, jfetch } from './http';
import type { Section, PermLevel } from '../store/useAuthStore';

export interface OrgRow { id: number; name: string; member_count?: number }
export interface RoleRow {
  id: number; name: string;
  perms: Record<Section, PermLevel>;
  can_manage_org: boolean;
}
export interface MemberRow {
  user_id: number; email: string; display_name: string; role_ids: number[];
}
export interface InviteRow {
  id: number; email: string; role_ids: string;
  created_at: string; expires_at: string; expired: 0 | 1;
}
export interface PlatformUser {
  id: number; email: string; display_name: string; is_superuser: boolean;
  has_password: boolean; has_google: boolean; created_at: string;
  orgs: { org_id: number; org_name: string }[];
}

export const listOrgs = () => jfetch<OrgRow[]>(`${API_BASE}/orgs`);
export const createOrg = (name: string) =>
  jfetch<OrgRow>(`${API_BASE}/orgs`, { method: 'POST', headers: J, body: JSON.stringify({ name }) });
export const renameOrg = (orgId: number, name: string) =>
  jfetch<OrgRow>(`${API_BASE}/orgs/${orgId}`, { method: 'PATCH', headers: J, body: JSON.stringify({ name }) });

export const listUsers = () => jfetch<PlatformUser[]>(`${API_BASE}/users`);

export const listMembers = (orgId: number) =>
  jfetch<MemberRow[]>(`${API_BASE}/orgs/${orgId}/members`);
export const setMemberRoles = (orgId: number, userId: number, roleIds: number[]) =>
  jfetch(`${API_BASE}/orgs/${orgId}/members/${userId}/roles`,
    { method: 'PUT', headers: J, body: JSON.stringify({ role_ids: roleIds }) });
export const removeMember = (orgId: number, userId: number) =>
  jfetch(`${API_BASE}/orgs/${orgId}/members/${userId}`, { method: 'DELETE' });

export const listRoles = (orgId: number) =>
  jfetch<RoleRow[]>(`${API_BASE}/orgs/${orgId}/roles`);
export const createRole = (orgId: number, body: Partial<RoleRow>) =>
  jfetch<RoleRow>(`${API_BASE}/orgs/${orgId}/roles`,
    { method: 'POST', headers: J, body: JSON.stringify(body) });
export const updateRole = (orgId: number, roleId: number, body: Partial<RoleRow>) =>
  jfetch<RoleRow>(`${API_BASE}/orgs/${orgId}/roles/${roleId}`,
    { method: 'PATCH', headers: J, body: JSON.stringify(body) });
export const deleteRole = (orgId: number, roleId: number) =>
  jfetch(`${API_BASE}/orgs/${orgId}/roles/${roleId}`, { method: 'DELETE' });

export const listInvites = (orgId: number) =>
  jfetch<InviteRow[]>(`${API_BASE}/orgs/${orgId}/invites`);
export const createInvite = (orgId: number, email: string, roleIds: number[]) =>
  jfetch<{ id: number; email: string; invite_url: string }>(`${API_BASE}/orgs/${orgId}/invites`,
    { method: 'POST', headers: J, body: JSON.stringify({ email, role_ids: roleIds }) });
export const revokeInvite = (orgId: number, inviteId: number) =>
  jfetch(`${API_BASE}/orgs/${orgId}/invites/${inviteId}`, { method: 'DELETE' });
