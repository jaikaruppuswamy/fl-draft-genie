// Shapes of the ESPN fantasy v3 responses we consume (views mSettings, mTeam,
// mDraftDetail). Fields are optional-heavy: ESPN omits liberally.

export interface EspnMember {
  id: string; // "{GUID}" — matches the SWID cookie
  displayName?: string;
  firstName?: string;
  lastName?: string;
}

export interface EspnTeam {
  id: number;
  name?: string;
  location?: string;
  nickname?: string;
  abbrev?: string;
  owners?: string[]; // member GUIDs
}

export interface EspnScoringItem {
  statId: number;
  points: number;
}

export interface EspnLeagueResponse {
  id: number;
  seasonId: number;
  gameId?: number;
  settings?: {
    name?: string;
    size?: number;
    scoringSettings?: {
      scoringType?: string;
      scoringItems?: EspnScoringItem[];
    };
    rosterSettings?: {
      lineupSlotCounts?: Record<string, number>;
    };
    draftSettings?: {
      type?: string; // SNAKE | AUCTION | ...
      date?: number; // epoch ms
      pickOrder?: number[];
    };
  };
  status?: {
    isActive?: boolean;
    currentMatchupPeriod?: number;
  };
  members?: EspnMember[];
  teams?: EspnTeam[];
  draftDetail?: {
    drafted?: boolean;
    inProgress?: boolean;
  };
}

export type EspnErrorCode = "espn_rejected" | "league_not_found" | "espn_unreachable";

export class EspnError extends Error {
  constructor(
    public code: EspnErrorCode,
    public status?: number,
  ) {
    super(code);
    this.name = "EspnError";
  }
}
