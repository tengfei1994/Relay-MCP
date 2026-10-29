export type WellState = 'ok' | 'stale' | 'fail' | 'wait';
export const PLATE_SIZE = 96;

export interface PlateInput {
  documents: number;
  indexedDocuments: number;
  stale: boolean;
  failedBatches: number;
}

export function buildPlate({
  documents,
  indexedDocuments,
  stale,
  failedBatches,
}: PlateInput): { wells: WellState[]; batchSize: number } {
  const batchSize = Math.max(1, Math.ceil(documents / PLATE_SIZE));
  const indexed =
    documents <= 0 ? 0 : Math.min(PLATE_SIZE, Math.floor(indexedDocuments / batchSize));
  const failed = Math.min(Math.max(0, failedBatches), PLATE_SIZE - indexed);
  const wells: WellState[] = [];
  for (let i = 0; i < PLATE_SIZE; i += 1) {
    if (i < indexed) wells.push(stale ? 'stale' : 'ok');
    else if (i < indexed + failed) wells.push('fail');
    else wells.push('wait');
  }
  return { wells, batchSize };
}
