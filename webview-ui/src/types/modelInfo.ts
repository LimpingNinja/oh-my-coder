export interface ModelCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cache?: {
    read?: number;
    write?: number;
  };
}

export interface ModelEntry {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  contextLength?: number;
  reasoning?: boolean;
  type?: string;
  family?: string;
  release_date?: string;
  releaseDate?: string;
  isFree?: boolean;
  description?: string;
  inputPrice?: number;
  outputPrice?: number;
  cacheReadsPrice?: number;
  cacheWritesPrice?: number;
  cost?: ModelCost;
  limit?: {
    context?: number;
    input?: number;
    output?: number;
  };
  modalities?: {
    input?: string[];
    output?: string[];
  };
  options?: {
    description?: string;
  };
  thinking?: { minLevel?: string; maxLevel?: string };
  [key: string]: unknown;
}
