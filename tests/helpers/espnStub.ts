// Stub ESPN fetch: routes league requests to fixtures, records every request
// for hygiene assertions. Assign a number to simulate an HTTP error status,
// "network" to simulate an unreachable host.
// Feature 002 additions: `kona` (leaguedefaults kona_player_info) and
// `proTeams` (proTeamSchedules_wl) fixtures for the public projection endpoints.

export type LeagueFixture = object | number | "network";

export interface EspnStub {
  fetch: typeof fetch;
  requests: { url: string; cookie: string }[];
  leagues: Record<string, LeagueFixture>;
  credsResponse: number | "network";
  kona: LeagueFixture | undefined;
  proTeams: LeagueFixture | undefined;
  /** 003: tier feed bodies keyed by feed key (e.g. "RB-PPR"); "network" to fail. */
  tiers: Record<string, string | number | "network">;
}

function respond(fixture: LeagueFixture): Response {
  if (fixture === "network") throw new TypeError("fetch failed");
  if (typeof fixture === "number") return new Response("error", { status: fixture });
  return Response.json(fixture);
}

export function makeEspnStub(
  leagues: Record<string, LeagueFixture> = {},
  opts: { kona?: LeagueFixture; proTeams?: LeagueFixture; tiers?: Record<string, string | number | "network"> } = {},
): EspnStub {
  const stub: EspnStub = {
    leagues,
    credsResponse: 200,
    requests: [],
    kona: opts.kona,
    proTeams: opts.proTeams,
    tiers: opts.tiers ?? {},
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const cookie = String(
        (init?.headers as Record<string, string> | undefined)?.["Cookie"] ?? "",
      );
      stub.requests.push({ url, cookie });

      // 003 tier feeds (Boris Chen text files).
      const tierMatch = url.match(/\/text_([A-Z-]+)\.txt$/);
      if (tierMatch) {
        const body = stub.tiers[tierMatch[1]!];
        if (body === undefined) return new Response("not found", { status: 404 });
        if (body === "network") throw new TypeError("fetch failed");
        if (typeof body === "number") return new Response("error", { status: body });
        return new Response(body, { status: 200, headers: { "Content-Type": "text/plain" } });
      }

      // 002 public projection endpoints (must work without cookies).
      if (url.includes("/leaguedefaults/")) {
        if (stub.kona === undefined) return new Response("not found", { status: 404 });
        return respond(stub.kona);
      }
      if (url.includes("view=proTeamSchedules_wl")) {
        if (stub.proTeams === undefined) return new Response("not found", { status: 404 });
        return respond(stub.proTeams);
      }

      const leagueMatch = url.match(/\/leagues\/(\d+)\?/);
      if (leagueMatch) {
        const fixture = stub.leagues[leagueMatch[1]!];
        if (fixture === undefined) return new Response("not found", { status: 404 });
        return respond(fixture);
      }
      // Credential probe endpoint.
      if (stub.credsResponse === "network") throw new TypeError("fetch failed");
      return new Response(stub.credsResponse === 200 ? "{}" : "denied", {
        status: stub.credsResponse,
      });
    }) as typeof fetch,
  };
  return stub;
}
