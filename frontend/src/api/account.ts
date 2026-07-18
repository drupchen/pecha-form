/** Own-account endpoints: profile, password, and the per-org resume state
 *  (last open text + tab; the position INSIDE a text is reading_positions). */
import { API_BASE, J, jfetch, apiFetch } from './http';

export interface UiState {
  last_text_id: number | null;
  last_route: string | null;
}

export const patchProfile = (displayName: string) =>
  jfetch(`${API_BASE}/auth/profile`, {
    method: 'PATCH', headers: J, body: JSON.stringify({ display_name: displayName }),
  });

export const changePassword = (currentPassword: string | null, newPassword: string) =>
  apiFetch(`${API_BASE}/auth/password`, {
    method: 'POST', headers: J,
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  }).then(() => {});

export const getUiState = () => jfetch<UiState>(`${API_BASE}/auth/state`);

export const putUiState = (state: UiState) =>
  jfetch<UiState>(`${API_BASE}/auth/state`, {
    method: 'PUT', headers: J, body: JSON.stringify(state),
  });
