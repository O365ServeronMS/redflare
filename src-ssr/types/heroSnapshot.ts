export interface HeroSnapshotEntry {
  rank: number;
  tmdbId: number;
  slug: string;
}

export interface HeroRefreshResult {
  tmdbCount: number;
  matchedCount: number;
  notFoundCount: number;
  failedCount: number;
}

export interface HeroSnapshotMetadata {
  lastSuccessAt: number;
  lastAttemptAt: number;
  result: HeroRefreshResult;
}

export interface HeroRefreshState {
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  lastResult: HeroRefreshResult | null;
}
