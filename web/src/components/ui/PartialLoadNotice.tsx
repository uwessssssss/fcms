'use client';

import React from 'react';

/**
 * Said, not swallowed. A part of a screen that fails to load used to become
 * an empty list -- indistinguishable from "there is none". On a loss report
 * that reads as "no losses"; on a shift's credit sales it invites recording
 * one again. The screen still works; it says what it could not load.
 */
export default function PartialLoadNotice({ missing }: { missing: string[] }) {
  if (missing.length === 0) return null;
  return (
    <div role="alert" className="fixed bottom-4 left-4 right-4 md:left-auto md:max-w-md z-50 rounded-xl border p-3 text-xs"
         style={{ background: 'var(--card)', borderColor: '#F59E0B', color: 'var(--foreground)' }}>
      <span className="font-semibold" style={{ color: '#F59E0B' }}>Some of this screen could not be loaded: </span>
      {missing.join(', ')}. What you see may be incomplete - refresh before acting on it.
    </div>
  );
}
