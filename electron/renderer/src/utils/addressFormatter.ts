interface LocationData {
  lat: number;
  lng: number;
  street?: string;
  neighborhood?: string;
  city?: string;
  state?: string;
  country?: string;
  formattedAddress: string;
}

export function formatAddress(location: LocationData): string {
  const parts: string[] = [];

  if (location.street) {
    parts.push(location.street);
  }

  if (location.neighborhood) {
    parts.push(location.neighborhood);
  }

  if (location.city) {
    parts.push(location.city);
  }

  if (location.state) {
    parts.push(location.state);
  }

  if (location.country) {
    parts.push(location.country);
  }

  if (parts.length === 0) {
    return 'Unknown Location';
  }

  return parts.join(', ');
}


