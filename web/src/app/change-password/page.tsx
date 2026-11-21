'use client';

import { useRouter } from 'next/navigation';
import React, { useState } from 'react';

import { api, ApiError } from '@/lib/api';

/**
 * Change a password that must be changed.
 *
 * THIS PAGE DID NOT EXIST. Sign-in already pushed here whenever the server
 * said the password must change -- and `fn_set_password` sets that flag on
 * every account it touches, which is every account after `--set-password ALL`.
 * So the first sign-in on a fresh database ended on a 404, with a valid token
 * and nowhere to go.
 *
 * The token IS already set by then, so this call is authenticated. That is why
 * the form asks for the current password rather than the employee number: the
 * server knows who is asking, and asking again would let a borrowed screen
 * change somebody else's password.
 */
export default function ChangePasswordPage() {
  const router = useRouter();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setError('');
    if (next.length < 8) {
      setError('A new password needs at least eight characters.');
      return;
    }
    if (next !== confirm) {
      setError('The two new passwords are not the same.');
      return;
    }
    if (next === current) {
      // The whole point is that the issued password stops working.
      setError('The new password must be different from the one you were given.');
      return;
    }
    setSaving(true);
    try {
      await api.post<unknown>('/api/auth/change-password', {
        currentPassword: current,
        newPassword: next,
      });
      router.push('/');
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'var(--background)' }}>
      <div
        className="w-full max-w-sm rounded-2xl border p-6 space-y-4"
        style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
      >
        <div>
          <h1 className="text-lg font-semibold text-foreground">Choose your own password</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
            You signed in with a password that was issued to you. Everyone who set up
            this station knows it, so it has to be replaced before you go any further.
          </p>
        </div>

        <label className="block text-xs">
          <span className="block mb-1" style={{ color: 'var(--muted-foreground)' }}>
            The password you were given
          </span>
          <input
            type="password"
            className="input-field w-full"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
          />
        </label>

        <label className="block text-xs">
          <span className="block mb-1" style={{ color: 'var(--muted-foreground)' }}>
            Your new password
          </span>
          <input
            type="password"
            className="input-field w-full"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
          />
        </label>

        <label className="block text-xs">
          <span className="block mb-1" style={{ color: 'var(--muted-foreground)' }}>
            Type it again
          </span>
          <input
            type="password"
            className="input-field w-full"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
        </label>

        {error && (
          <p className="text-xs" style={{ color: 'var(--destructive)' }}>
            {error}
          </p>
        )}

        <button
          onClick={submit}
          disabled={saving}
          className="w-full py-2 rounded-xl text-sm font-semibold"
          style={{
            background: 'var(--primary)',
            color: 'var(--primary-foreground)',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving...' : 'Set my password'}
        </button>
      </div>
    </div>
  );
}
