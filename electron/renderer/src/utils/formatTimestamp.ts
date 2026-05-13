import { format, isToday, isYesterday, formatDistanceToNow } from 'date-fns';

export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();

  if (isToday(date)) {
    // Today: "2:34 PM"
    return format(date, 'h:mm a');
  } else if (isYesterday(date)) {
    // Yesterday: "Yesterday 3:15 PM"
    return `Yesterday ${format(date, 'h:mm a')}`;
  } else {
    // Older: "Dec 20, 2024 10:30 AM"
    return format(date, 'MMM d, yyyy h:mm a');
  }
}

export function formatTimestampRelative(timestamp: number): string {
  const date = new Date(timestamp);
  return formatDistanceToNow(date, { addSuffix: true });
}


