// Typed client for the Draft Genie API (contracts/api.md).

export interface ApiError {
  error: string;
  message: string;
}

export class RequestError extends Error {
  constructor(
    public status: number,
    public body: ApiError,
  ) {
    super(body.message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => ({ error: "bad_response", message: "Unexpected server response." }))) as T &
    ApiError;
  if (!res.ok) throw new RequestError(res.status, json);
  return json;
}

export interface CredentialState {
  present: boolean;
  status: "working" | "failing" | null;
  swid_masked: string | null;
  last_validated_at: string | null;
}

export interface LeagueSummary {
  id: string;
  espn_league_id: string;
  season: number;
  name: string;
  team_count: number;
  my_team: { espn_team_id: number; name: string };
  scoring_summary: string;
  draft: { type: string | null; supported: boolean; scheduled_at: string | null; order_published: boolean };
  last_sync_at: string | null;
  sync_status: "ok" | "failed" | "pending";
  credentials_status: "working" | "failing" | null;
}

export interface LeagueDetail extends LeagueSummary {
  scoring_rules: { statId: number; label: string; points: number }[];
  scoring_type: string | null;
  roster_slots: { slotId: number; label: string; count: number }[];
  teams: { espn_team_id: number; name: string; manager_names: string[] }[];
  draft_order: number[] | null;
  snapshot_age_seconds: number;
  warning?: string;
}

export interface TeamChoice {
  connect_token: string;
  teams: { espn_team_id: number; name: string; manager_names: string[] }[];
}

export const apiClient = {
  requestCode: (email: string) => request<void>("POST", "/api/auth/request", { email }),
  verifyCode: (email: string, code: string) =>
    request<{ account: { id: string; email: string } }>("POST", "/api/auth/verify", { email, code }),
  signOut: () => request<void>("POST", "/api/auth/signout"),
  deleteAccount: () => request<void>("DELETE", "/api/account"),
  getCredentials: () => request<CredentialState>("GET", "/api/credentials"),
  putCredentials: (espn_s2: string, swid: string) =>
    request<{ status: string; swid_masked: string; leagues_revalidated: number }>("PUT", "/api/credentials", {
      espn_s2,
      swid,
    }),
  listLeagues: () => request<{ leagues: LeagueSummary[] }>("GET", "/api/leagues"),
  getLeague: (id: string) => request<LeagueDetail>("GET", `/api/leagues/${id}`),
  connectLeague: (league_ref: string) => request<LeagueDetail>("POST", "/api/leagues", { league_ref }),
  completeConnect: (connect_token: string, espn_team_id: number) =>
    request<LeagueDetail>("POST", "/api/leagues/connect/complete", { connect_token, espn_team_id }),
  syncLeague: (id: string) => request<LeagueDetail>("POST", `/api/leagues/${id}/sync`),
  deleteLeague: (id: string) => request<void>("DELETE", `/api/leagues/${id}`),
};
