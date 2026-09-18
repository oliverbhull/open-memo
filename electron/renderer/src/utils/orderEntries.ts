export interface ChronologicalEntry {
  id: string;
  timestamp: number;
  createdAt?: number;
}

export function mergeChronologically<T extends ChronologicalEntry>(
  current: T[],
  incoming: T[],
): T[] {
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  incoming.forEach((entry) => byId.set(entry.id, entry));
  return [...byId.values()].sort((left, right) => (
    (right.createdAt || right.timestamp) - (left.createdAt || left.timestamp) ||
    right.id.localeCompare(left.id)
  ));
}
