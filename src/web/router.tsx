import { useEffect, useState } from 'react';

/** Hash router: "#/trips/3" -> { section: "trips", id: 3, parts: ["trips", "3"] }. */
export function useRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const path = hash.replace(/^#/, '') || '/';
  const parts = path.split('/').filter(Boolean);
  return { path, parts, section: parts[0] ?? '', id: parts[1] ? Number(parts[1]) : null };
}

export const navigate = (path: string) => {
  window.location.hash = path;
};
