function apiOrigin(): string {
  const override = import.meta.env.VITE_API_ORIGIN as string | undefined;
  if (override) return override;
  return window.location.origin;
}

export function apiUrl(pathname: string): string {
  const base = apiOrigin();
  return new URL(pathname, base).toString();
}

