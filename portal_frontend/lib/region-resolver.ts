// region-resolver.ts — pure, Odoo-free text parsing only.
//
// Maps a free-text CultFit request name (e.g. "Cult Elite Lakdikapul, Hyd,
// FOFO, Hybrid - InBody 260 S") to a known city + Indian state, using
// localities/aliases verified against real historical CultFit request names
// (see CULTFIT_PORTAL_MASTER_CONTEXT.md). Deliberately conservative: a token
// not listed here is "unclear", never guessed.
//
// This module never calls Odoo. lib/odoo-server.ts combines the resolved
// state with a live res.territory.state_ids lookup to get the actual
// Territory record — see resolveTerritoryIdForState() there. crm.lead.city/
// state_id are NOT usable for this (verified live: constant "Chennai"/"Tamil
// Nadu" on every real CultFit lead — they mirror the CultFit commercial
// partner's billing address, not the opportunity's actual location).

import 'server-only';

// Locality/abbreviation (lowercase) -> canonical city. Extend as new
// localities show up in real request names.
const LOCALITY_TO_CITY: Record<string, string> = {
  // Hyderabad
  hyd: 'Hyderabad', hyderabad: 'Hyderabad', lakdikapul: 'Hyderabad',
  kukatpally: 'Hyderabad', kondapur: 'Hyderabad', kushaiguda: 'Hyderabad',
  nizampet: 'Hyderabad',
  // Bengaluru
  blr: 'Bengaluru', bengaluru: 'Bengaluru', bangalore: 'Bengaluru',
  // Chennai
  chennai: 'Chennai',
  // Delhi / NCR
  delhi: 'Delhi', ncr: 'Delhi', gurgaon: 'Gurgaon', ggn: 'Gurgaon',
  gurugram: 'Gurgaon', noida: 'Noida', faridabad: 'Faridabad',
  // Mumbai
  mumbai: 'Mumbai', bombay: 'Mumbai', 'lower parel': 'Mumbai',
  lokhandwala: 'Mumbai', 'tilak nagar': 'Mumbai',
  // Pune
  pune: 'Pune',
  // Ahmedabad
  ahmedabad: 'Ahmedabad', ahm: 'Ahmedabad',
  // Other cities seen historically — single-lead sample size, but the
  // city-to-state fact itself is unambiguous, so still resolved with high
  // confidence (sample size isn't the same thing as location ambiguity).
  surat: 'Surat', indore: 'Indore', jaipur: 'Jaipur',
  mysuru: 'Mysuru', mysore: 'Mysuru',
  vijayawada: 'Vijayawada', visakhapatnam: 'Visakhapatnam', vizag: 'Visakhapatnam',
};

const CITY_TO_STATE: Record<string, string> = {
  Hyderabad: 'Telangana',
  Bengaluru: 'Karnataka',
  Chennai: 'Tamil Nadu',
  Delhi: 'Delhi',
  Gurgaon: 'Haryana',
  Noida: 'Uttar Pradesh',
  Faridabad: 'Haryana',
  Mumbai: 'Maharashtra',
  Pune: 'Maharashtra',
  Ahmedabad: 'Gujarat',
  Surat: 'Gujarat',
  Indore: 'Madhya Pradesh',
  Jaipur: 'Rajasthan',
  Mysuru: 'Karnataka',
  Vijayawada: 'Andhra Pradesh',
  Visakhapatnam: 'Andhra Pradesh',
};

// Real historical CultFit leads with genuinely conflicting location cues in
// the same request name (e.g. a Lucknow-named lead also mentioning a
// Bengaluru locality) — mapped to "unclear" rather than picking one
// arbitrarily, per the "do not guess" rule.
const AMBIGUOUS_TOKENS = new Set(['lucknow']);

export interface RegionDetection {
  matchedToken: string | null;
  city: string | null;
  state: string | null;
  confidence: 'high' | 'unclear';
}

export function resolveRegionFromRequestName(requestName: string): RegionDetection {
  const tokens = requestName
    .toLowerCase()
    .split(/[,\-]/)
    .map(t => t.trim())
    .filter(Boolean);

  const matchedCities = new Set<string>();
  let matchedToken: string | null = null;

  for (const token of tokens) {
    if (AMBIGUOUS_TOKENS.has(token)) return { matchedToken: token, city: null, state: null, confidence: 'unclear' };
    for (const candidate of [token, ...token.split(/\s+/)]) {
      const city = LOCALITY_TO_CITY[candidate];
      if (city) {
        matchedCities.add(city);
        matchedToken = matchedToken ?? candidate;
      }
    }
  }

  if (matchedCities.size !== 1) return { matchedToken, city: null, state: null, confidence: 'unclear' };
  const city = [...matchedCities][0];
  return { matchedToken, city, state: CITY_TO_STATE[city] ?? null, confidence: 'high' };
}
