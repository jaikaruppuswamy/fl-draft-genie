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
    /**
     * Populated ONLY once the draft completes.
     *
     * Gate 0 established this the hard way: 207 samples across ~30 real picks
     * showed `picks[]` frozen during a live draft, and every DRAFT transaction
     * in a finished draft shares one `proposedDate` equal to `completeDate`.
     * ESPN writes the draft to its league database once, at the end.
     *
     * That makes it useless as a live source and valuable as an INDEPENDENT
     * ORACLE: it is derived without the tap, so reconciling the tap-built
     * draft against it is the strongest available check that nothing was
     * missed (005 T048).
     */
    picks?: EspnCompletedPick[];
  };
}

/** One pick from ESPN's post-completion flush. */
export interface EspnCompletedPick {
  /** NEVER filtered on sign: D/ST ids are legitimately negative (~ -16000). */
  playerId?: number;
  teamId?: number;
  overallPickNumber?: number;
  roundId?: number;
  roundPickNumber?: number;
  keeper?: boolean;
  autoDraftTypeId?: number;
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
