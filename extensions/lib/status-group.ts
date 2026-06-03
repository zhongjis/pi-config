export type StatusItem = {
  status: string;
};

export function groupByStatus<T extends StatusItem>(items: readonly T[]): Record<string, T[]> {
  const groups: Record<string, T[]> = {};

  for (const item of items) {
    const group = groups[item.status];
    if (group) {
      group.push(item);
    } else {
      groups[item.status] = [item];
    }
  }

  return groups;
}
