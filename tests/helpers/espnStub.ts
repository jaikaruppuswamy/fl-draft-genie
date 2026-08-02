// Stub ESPN fetch: routes league requests to fixtures, records every request
// for hygiene assertions. Assign a number to simulate an HTTP error status,
// "network" to simulate an unreachable host.

export type LeagueFixture = object | number | "network";

export interface EspnStub {
  fetch: typeof fetch;
  requests: { url: string; cookie: string }[];
  leagues: Record<string, LeagueFixture>;
  credsResponse: number | "network";
}

export function makeEspnStub(leagues: Record<string, LeagueFixture> = {}): EspnStub {
  const stub: EspnStub = {
    leagues,
    credsResponse: 200,
    requests: [],
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const cookie = String(
        (init?.headers as Record<string, string> | undefined)?.["Cookie"] ?? "",
      );
      stub.requests.push({ url, cookie });

      const leagueMatch = url.match(/\/leagues\/(\d+)\?/);
      if (leagueMatch) {
        const fixture = stub.leagues[leagueMatch[1]!];
        if (fixture === undefined) return new Response("not found", { status: 404 });
        if (fixture === "network") throw new TypeError("fetch failed");
        if (typeof fixture === "number") return new Response("error", { status: fixture });
        return Response.json(fixture);
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
