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

export interface BoardPlayer {
  espn_player_id: number;
  name: string;
  position: string;
  eligible_positions: string[];
  team: string;
  bye_week: number | null;
  projected_points: number | null;
  position_rank: number | null;
  adp: number | null;
  overall_rank: number | null;
  tier: number | null;
}

export interface BoardResponse {
  freshness: { fetched_at: string; season: number; stale: boolean };
  players: BoardPlayer[];
}

export interface SignalBlock {
  rank: number;
  score: number;
  label: string;
}

export interface PlayerDetail {
  player: BoardPlayer;
  freshness: { fetched_at: string };
  signals?: {
    offense: SignalBlock | null;
    sos: SignalBlock | null;
    oline: SignalBlock | null;
    bye_week: number | null;
  };
  breakdown: {
    statId: number;
    label: string;
    projected: number | null;
    points_per: number;
    points: number;
    covered: boolean;
  }[];
  total: number | null;
}

export interface ProjectionsStatus {
  fetched_at: string | null;
  season: number;
  player_count: number | null;
  stale: boolean;
  next_scheduled_hint: string;
}

export interface TeamChoice {
  connect_token: string;
  teams: { espn_team_id: number; name: string; manager_names: string[] }[];
}

export interface TapPairing {
  id: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  revoked: boolean;
  bound: boolean;
}


/** 005 — draft session status, including WHY advice is withheld. */
export interface DraftStatus {
  armed: boolean;
  status: string;
  detail?: string;
  season?: number;
  tap?: {
    state: string | null;
    version: string | null;
    /** A hidden tab's timers throttle to ~1/minute, so the tolerance widens. */
    hidden: boolean;
    lastHeartbeatAt: string | null;
    lapsed: boolean;
  };
  withholding: "not_receiving" | "incompatible" | "version_rejected" | null;
  completedAt?: string | null;
}

export interface DraftSnapshot {
  status: "idle" | "live" | "complete";
  revision: number;
  seq: number;
  picks: { overall: number; teamId: number; playerId: number; observedAt: string }[];
  onTheClock: number | null;
  picksUntilMyTurn: number | null;
  orderTrust: "observed" | "projected" | "unknown";
  totalPicks: number;
  complete: boolean;
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

  // 005 — the throwaway diagnostic surface (FR-025). 007 replaces the page
  // that consumes these wholesale, so the shapes are deliberately minimal.
  getDraftStatus: (id: string) => request<DraftStatus>("GET", `/api/leagues/${id}/draft`),
  getDraftSnapshot: (id: string) => request<DraftSnapshot>("GET", `/api/leagues/${id}/draft/snapshot`),
  getLeague: (id: string) => request<LeagueDetail>("GET", `/api/leagues/${id}`),
  connectLeague: (league_ref: string) => request<LeagueDetail>("POST", "/api/leagues", { league_ref }),
  completeConnect: (connect_token: string, espn_team_id: number) =>
    request<LeagueDetail>("POST", "/api/leagues/connect/complete", { connect_token, espn_team_id }),
  syncLeague: (id: string) => request<LeagueDetail>("POST", `/api/leagues/${id}/sync`),
  deleteLeague: (id: string) => request<void>("DELETE", `/api/leagues/${id}`),
  getBoard: (id: string) => request<BoardResponse>("GET", `/api/leagues/${id}/board`),
  getPlayerDetail: (id: string, playerId: number) =>
    request<PlayerDetail>("GET", `/api/leagues/${id}/board/players/${playerId}`),
  refreshProjections: () =>
    request<{ fetched_at: string; player_count: number }>("POST", "/api/projections/refresh"),
  getProjectionsStatus: () => request<ProjectionsStatus>("GET", "/api/projections/status"),
  listTapPairings: () => request<{ pairings: TapPairing[] }>("GET", "/api/tap-pairings"),
  createTapPairing: () => request<{ id: string; token: string; expires_at: string }>("POST", "/api/tap-pairings"),
  revokeTapPairing: (id: string) => request<void>("DELETE", `/api/tap-pairings/${id}`),
};
