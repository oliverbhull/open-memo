const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return 'Unknown time';

  const dayDifference = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
  if (dayDifference === 0) return timeFormatter.format(date);
  if (dayDifference === 1) return `Yesterday ${timeFormatter.format(date)}`;
  return dateTimeFormatter.format(date);
}
