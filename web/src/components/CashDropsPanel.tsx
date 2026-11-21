'use client';

/**
 * Cash drops to the safe during an open shift (migration 580).
 *
 * The forecourt practice Kenserve calls the Cash Drop Book: an attendant drops
 * cash in the safe as it builds up, witnessed by the supervisor, and never
 * holds more than the company's cap. At close the screen asks only for the
 * cash still held -- every drop here is already counted.
 *
 * A drop is never edited, only voided with a reason, and none can be recorded
 * once the shift is counting or closed. The server enforces all of it; this
 * panel checks the obvious things first so the supervisor is told before
 * pressing save.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Checker, fieldStyle, hasErrors } from '@/lib/checks';
import { FieldIssues, IssueSummary } from '@/components/ui/Issues';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/context/AuthContext';
import type { CashDropList } from '@/types/api';

const fmt = (n: number) => n.toLocaleString('en-UG', { maximumFractionDigits: 0 });
const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-UG', { hour: '2-digit', minute: '2-digit' });

export interface DropPerson { id: string; name: string }

export default function CashDropsPanel({ shiftId, people }: { shiftId: string; people: DropPerson[] }) {
  const { showToast } = useToast();
  const { user } = useAuth();
  const [data, setData] = useState<CashDropList | null>(null);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState({ attendantId: '', amount: '', witnessId: '', bookRef: '' });
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [voiding, setVoiding] = useState<{ id: string; reason: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<CashDropList>(`/api/shifts/${shiftId}/cash-drops`));
      setLoadError('');
    } catch (e) {
      setLoadError((e as ApiError).message);
    }
  }, [shiftId]);

  useEffect(() => { void load(); }, [load]);

  // The signed-in supervisor is the usual witness; preselect them when they
  // are one of the people the server allows.
  useEffect(() => {
    if (!data || form.witnessId) return;
    const me = data.witnesses.find((w) => w.id === user?.staffId);
    if (me) setForm((f) => ({ ...f, witnessId: me.id }));
  }, [data, user?.staffId, form.witnessId]);

  const dropped = (id: string) => data?.byAttendant.find((t) => t.attendantId === id)?.dropped ?? 0;

  const issues = useMemo(() => {
    const c = new Checker();
    c.required('attendantId', form.attendantId, 'Who is dropping');
    const n = c.number('amount', form.amount, 'The amount', { positive: true });
    c.required('witnessId', form.witnessId, 'A witness');
    if (form.witnessId && form.witnessId === form.attendantId)
      c.error('witnessId', 'Nobody witnesses their own drop');
    if (n !== null && n % 1000 !== 0)
      c.warn('amount', 'Not a round thousand — check the count before saving');
    if (!form.bookRef.trim())
      c.warn('bookRef', 'No Cash Drop Book line — the paper and the system will be hard to match');
    return c.issues;
  }, [form]);

  const save = async () => {
    setTried(true);
    if (hasErrors(issues)) return;
    setBusy(true);
    try {
      await api.post<{ cashDropId: string }>(`/api/shifts/${shiftId}/cash-drops`, {
        attendantId: form.attendantId,
        amount: Number(form.amount),
        witnessId: form.witnessId,
        bookRef: form.bookRef.trim() || null,
      }, { submission: `cash-drop:${shiftId}` });
      showToast(`Drop of UGX ${fmt(Number(form.amount))} recorded`, 'success');
      setForm((f) => ({ ...f, attendantId: '', amount: '', bookRef: '' }));
      setTried(false);
      await load();
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const voidDrop = async () => {
    if (!voiding) return;
    if (!voiding.reason.trim()) { showToast('Say why the drop is void', 'error'); return; }
    setBusy(true);
    try {
      await api.post<unknown>(`/api/cash-drops/${voiding.id}/void`, { reason: voiding.reason.trim() },
        { submission: `cash-drop-void:${voiding.id}` });
      showToast('Drop voided', 'success');
      setVoiding(null);
      await load();
    } catch (e) {
      showToast((e as ApiError).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const card = { backgroundColor: 'var(--card)', borderColor: 'var(--border)' };
  const muted = { color: 'var(--muted-foreground)' };

  return (
    <div className="rounded-xl border p-4 space-y-3" style={card}>
      <div>
        <h2 className="text-sm font-semibold text-foreground">Cash drops to the safe</h2>
        <p className="text-xs" style={muted}>
          Drop cash as it builds up, witnessed.
          {data && data.cap > 0 && <> Nobody should carry more than <b>UGX {fmt(data.cap)}</b> between drops.</>}
          {' '}At close, only the cash still held is counted by hand.
        </p>
      </div>

      {loadError && <p className="text-xs" style={{ color: '#ef4444' }}>Could not load the drops: {loadError}</p>}

      {people.length > 0 && data && (
        <div className="flex flex-wrap gap-2">
          {people.map((p) => (
            <span key={p.id} className="text-[11px] px-2 py-1 rounded-md border" style={{ borderColor: 'var(--border)' }}>
              {p.name}: <b>UGX {fmt(dropped(p.id))}</b> dropped
            </span>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div>
          <select className="input-field w-full text-xs" value={form.attendantId}
                  style={fieldStyle(issues, 'attendantId', tried)}
                  onChange={(e) => setForm({ ...form, attendantId: e.target.value })}>
            <option value="">Who is dropping...</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <FieldIssues issues={issues} field="attendantId" tried={tried} />
        </div>
        <div>
          <input type="number" min={0} placeholder="Amount (UGX)" className="input-field w-full text-xs"
                 style={fieldStyle(issues, 'amount', tried)}
                 value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          <FieldIssues issues={issues} field="amount" tried={tried} />
        </div>
        <div>
          <select className="input-field w-full text-xs" value={form.witnessId}
                  style={fieldStyle(issues, 'witnessId', tried)}
                  onChange={(e) => setForm({ ...form, witnessId: e.target.value })}>
            <option value="">Witnessed by...</option>
            {(data?.witnesses ?? []).map((w) => (
              <option key={w.id} value={w.id}>{w.fullName} ({w.role.toLowerCase()})</option>
            ))}
          </select>
          <FieldIssues issues={issues} field="witnessId" tried={tried} />
        </div>
        <div>
          <input placeholder="Drop Book page / line, e.g. p.14 l.3" className="input-field w-full text-xs"
                 value={form.bookRef} onChange={(e) => setForm({ ...form, bookRef: e.target.value })} />
          <FieldIssues issues={issues} field="bookRef" tried={tried} />
        </div>
      </div>
      <IssueSummary issues={issues} tried={tried} />
      <button disabled={busy} onClick={() => void save()}
              className="w-full py-2 rounded-lg text-xs font-semibold"
              style={{ background: 'rgba(0,212,160,0.12)', color: 'var(--primary)' }}>
        {busy ? 'Saving…' : 'Record drop'}
      </button>

      {data && data.drops.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr style={muted}>
                <th className="text-left py-1">#</th><th className="text-left">Time</th>
                <th className="text-left">Attendant</th><th className="text-right">UGX</th>
                <th className="text-left pl-3">Witness</th><th className="text-left">Book</th><th />
              </tr>
            </thead>
            <tbody>
              {data.drops.map((d) => (
                <tr key={d.id} className="border-t" style={{ borderColor: 'var(--border)', opacity: d.voidedAt ? 0.5 : 1 }}>
                  <td className="py-1">{d.seqNo}</td>
                  <td>{time(d.droppedAt)}</td>
                  <td>{d.attendant}</td>
                  <td className="text-right" style={{ textDecoration: d.voidedAt ? 'line-through' : undefined }}>{fmt(d.amount)}</td>
                  <td className="pl-3">{d.witness}</td>
                  <td>{d.bookRef ?? '—'}</td>
                  <td className="text-right">
                    {d.voidedAt
                      ? <span title={d.voidReason ?? ''} style={{ color: '#ef4444' }}>void</span>
                      : <button className="underline" style={muted} onClick={() => setVoiding({ id: d.id, reason: '' })}>void</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {voiding && (
        <div className="rounded-lg border p-2 space-y-2" style={{ borderColor: '#ef4444' }}>
          <p className="text-xs">A drop is never edited. Void it, say why, and record it again.</p>
          <input autoFocus placeholder="Why is it void? e.g. typed 50,000 for 500,000" className="input-field w-full text-xs"
                 value={voiding.reason} onChange={(e) => setVoiding({ ...voiding, reason: e.target.value })} />
          <div className="flex gap-2">
            <button disabled={busy} onClick={() => void voidDrop()} className="flex-1 py-1.5 rounded-lg text-xs font-semibold"
                    style={{ background: 'rgba(239,68,68,0.12)', color: '#ef4444' }}>Void the drop</button>
            <button onClick={() => setVoiding(null)} className="flex-1 py-1.5 rounded-lg text-xs" style={muted}>Keep it</button>
          </div>
        </div>
      )}
    </div>
  );
}
