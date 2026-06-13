/**
 * Series types shared between frontend and backend.
 */

export interface TimePoint {
  date: string;
  value: number | null;
}

export type ProvenanceSource = "ceic" | "nbs" | "fred" | "stooq" | "yahoo" | "pending" | "static" | "akshare" | "oecd" | "hkex" | "eastmoney" | "chinadata" | "imported";

export interface Provenance {
  source: ProvenanceSource;
  lastUpdated: string; // ISO timestamp
  subscribed: boolean;
  cacheHit: boolean;
  error?: string;
}

export interface SeriesResponse {
  logicalId: string;
  data: TimePoint[];
  provenance: Provenance;
}

export interface RegistryEntry {
  id: string;
  label: string;
  category: string;
  fallback: string;
  unit: string;
}

export interface MacroRelease {
  date: string;
  time: string;
  agency: "NBS" | "PBOC" | "Customs" | "NDRC" | "MoF";
  indicator: string;
  frequency: "monthly" | "quarterly" | "annual";
  expectedRelease: boolean;
  notes?: string;
}
