// One navigation bar for every page inside a league.
//
// Before this, each league page carried its own hand-rolled set of links and
// they had drifted: the detail page offered four destinations, the board two,
// the preferred list two, the draft room three — so moving between them meant
// going back to the league page first. They also disagreed on which button was
// primary and which was secondary.
//
// The current page is shown as the ACTIVE pill rather than hidden, so the bar
// has the same shape everywhere and the owner can see where they are without
// reading the heading. It doubles as a breadcrumb.
//
// No "Back": the brand in the top bar already returns to the dashboard, and a
// second route to the same place is one more thing to look at during the hour
// when looking at things is expensive.

import { Link, useLocation } from "react-router-dom";

export interface LeagueNavProps {
  leagueId: string;
  /** Optional trailing action — e.g. the detail page's "Sync now". */
  children?: React.ReactNode;
}

const DESTINATIONS = [
  { suffix: "", label: "League" },
  { suffix: "/board", label: "Player board" },
  { suffix: "/preferred", label: "Preferred" },
  { suffix: "/room", label: "Draft room" },
] as const;

export default function LeagueNav({ leagueId, children }: LeagueNavProps) {
  const path = useLocation().pathname;
  const base = `/leagues/${leagueId}`;

  return (
    <nav className="league-nav" aria-label="League sections">
      {DESTINATIONS.map((d) => {
        const to = `${base}${d.suffix}`;
        // Exact match: without it "/leagues/x" would light up on every child
        // route, and the bar would stop telling you where you are.
        const active = path === to || (d.suffix === "" && path === `${base}/`);
        return (
          <Link key={d.suffix} to={to} className={active ? "league-nav-item active" : "league-nav-item"}>
            {d.label}
          </Link>
        );
      })}
      {children}
    </nav>
  );
}
