import { Fragment } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Training pages start a fresh exercise on mount. Mixed Training can send the user to the same URL
 * again (e.g. two push/fold spots in a row → /gto?mixed=…), which React Router treats as the same
 * element, so the old spot (and its answer) stayed on screen. Keying by the navigation entry makes
 * every navigation — including one to an identical URL — a genuinely new item.
 */
export function Fresh({ children }: { children: React.ReactNode }) {
  const { key } = useLocation();
  return <Fragment key={key}>{children}</Fragment>;
}
