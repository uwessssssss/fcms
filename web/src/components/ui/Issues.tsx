'use client';

import React from 'react';

import type { Issue } from '@/lib/checks';

/** The issue(s) for one field, shown under it. */
export function FieldIssues({ issues, field, tried }: { issues: Issue[]; field: string; tried: boolean }) {
  const mine = issues.filter((i) => i.field === field && (i.level === 'warning' || tried));
  if (mine.length === 0) return null;
  return (
    <>
      {mine.map((i, k) => (
        <p key={k} className="text-[11px] mt-0.5" style={{ color: i.level === 'error' ? '#ef4444' : '#F59E0B' }}>
          {i.level === 'error' ? '✕ ' : '⚠ '}{i.message}
        </p>
      ))}
    </>
  );
}

/** Everything wrong or worth checking on the form, above its save button. */
export function IssueSummary({ issues, tried }: { issues: Issue[]; tried: boolean }) {
  const errors = tried ? issues.filter((i) => i.level === 'error') : [];
  const warnings = issues.filter((i) => i.level === 'warning');
  if (errors.length === 0 && warnings.length === 0) return null;
  return (
    <div role="alert" className="rounded-lg border p-2 space-y-1 text-xs"
         style={{ borderColor: errors.length ? '#ef4444' : '#F59E0B', background: 'var(--card)' }}>
      {errors.length > 0 && (
        <p className="font-semibold" style={{ color: '#ef4444' }}>
          {errors.length === 1 ? '1 thing to fix' : `${errors.length} things to fix`} before saving:
        </p>
      )}
      {errors.map((i, k) => <p key={`e${k}`} style={{ color: '#ef4444' }}>✕ {i.message}</p>)}
      {warnings.length > 0 && (
        <p className="font-semibold pt-1" style={{ color: '#F59E0B' }}>
          Worth checking{errors.length ? '' : ' - you can still save'}:
        </p>
      )}
      {warnings.map((i, k) => <p key={`w${k}`} style={{ color: '#F59E0B' }}>⚠ {i.message}</p>)}
    </div>
  );
}

/**
 * A form's problem, kept beside its save button until it is fixed -- not a
 * toast that is gone before it is read. Cleared when save is pressed again.
 */
export function FormProblem({ msg }: { msg?: string }) {
  if (!msg) return null;
  return (
    <div role="alert" className="rounded-lg border px-2 py-1.5 text-xs"
         style={{ borderColor: '#ef4444', color: '#ef4444', background: 'var(--card)' }}>
      ✕ {msg}
    </div>
  );
}
