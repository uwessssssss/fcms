'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import Icon from '@/components/ui/AppIcon';
import { useVisibleNav } from '@/components/Sidebar';
import { useAuth } from '@/context/AuthContext';
import { businessToday } from '@/lib/dates';
import { useOpenAlerts } from '@/lib/useOpenAlerts';

/**
 * The bar across the top. Every control in it does what it shows:
 *   - search goes to a screen (Ctrl/Cmd+K) -- it was a box that ignored typing;
 *   - the clock is the time now -- it said 16:57 forever;
 *   - the bell's dot is lit only when alerts are open, and opens them -- it
 *     did nothing and was always lit;
 *   - the site and the business date are labels -- they wore dropdown arrows
 *     for menus that did not exist, and the date was fixed at 16/09/2026.
 */
export default function Topbar() {
  const router = useRouter();
  const { isSiteManager, assignedSite } = useAuth();
  const visible = useVisibleNav();
  const openAlerts = useOpenAlerts();
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState('');
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen(true); }
      if (e.key === 'Escape') { setSearchOpen(false); setQ(''); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    const seen = new Set<string>();
    return visible
      .filter((n) => n.href !== '#' && (!t || n.label.toLowerCase().includes(t) || n.group.toLowerCase().includes(t)))
      .filter((n) => (seen.has(n.href + n.label) ? false : (seen.add(n.href + n.label), true)))
      .slice(0, 8);
  }, [q, visible]);

  const go = (href: string) => { setSearchOpen(false); setQ(''); router.push(href); };
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const bday = businessToday();
  const bdayLabel = `${bday.slice(8, 10)}/${bday.slice(5, 7)}/${bday.slice(0, 4)}`;

  return (
    <header
      className="flex items-center gap-3 px-6 lg:px-8 shrink-0"
      style={{
        height: 64,
        background: 'rgba(8,13,24,0.9)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        boxShadow: '0 1px 20px rgba(0,0,0,0.3)',
      }}
    >
      {/* Go to a screen */}
      <div className="flex-1 max-w-sm relative">
        {searchOpen ? (
          <div className="relative">
            <Icon name="MagnifyingGlassIcon" size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              autoFocus
              className="input-field pl-10 py-2 text-sm"
              placeholder="Go to a screen…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && matches[0]) go(matches[0].href); }}
              onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
            />
            {matches.length > 0 && (
              <div className="absolute left-0 right-0 mt-1 rounded-xl border overflow-hidden z-50"
                   style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
                {matches.map((n) => (
                  <button key={n.key} onMouseDown={(e) => e.preventDefault()} onClick={() => go(n.href)}
                          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-white/[0.04]">
                    <Icon name={n.icon} size={14} className="text-muted-foreground" />
                    <span className="text-foreground">{n.label}</span>
                    <span className="ml-auto text-xs" style={{ color: 'var(--muted-foreground)' }}>{n.group}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <button
            onClick={() => setSearchOpen(true)}
            className="flex items-center gap-2.5 px-3.5 py-2 rounded-xl text-sm transition-all duration-150 hover:bg-white/[0.04]"
            style={{ color: 'var(--muted-foreground)' }}
          >
            <Icon name="MagnifyingGlassIcon" size={15} />
            <span className="text-sm">Go to a screen…</span>
            <span className="ml-2 px-1.5 py-0.5 rounded-md text-xs font-mono"
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', color: 'var(--muted-foreground)' }}>
              Ctrl K
            </span>
          </button>
        )}
      </div>

      {/* The time now */}
      <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-xl"
           style={{ background: 'rgba(0,212,160,0.06)', border: '1px solid rgba(0,212,160,0.15)' }}>
        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--primary)' }} />
        <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{time}</span>
      </div>

      {/* Open alerts */}
      <button
        onClick={() => router.push('/#alerts')}
        title={openAlerts ? `${openAlerts} open alert(s)` : 'No open alerts'}
        className="relative w-9 h-9 flex items-center justify-center rounded-xl transition-all duration-150 hover:bg-white/[0.04]"
        style={{ color: 'var(--muted-foreground)' }}
      >
        <Icon name="BellIcon" size={18} />
        {(openAlerts ?? 0) > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full text-[10px] font-bold flex items-center justify-center"
                style={{ backgroundColor: 'var(--status-fault)', color: '#000' }}>
            {(openAlerts ?? 0) > 99 ? '99+' : openAlerts}
          </span>
        )}
      </button>

      {/* Whose sites */}
      <div className="hidden lg:flex items-center gap-2 px-3.5 py-2 rounded-xl"
           style={{
             background: isSiteManager ? 'rgba(96,165,250,0.06)' : 'rgba(255,255,255,0.03)',
             border: isSiteManager ? '1px solid rgba(96,165,250,0.15)' : '1px solid rgba(255,255,255,0.07)',
           }}>
        <Icon name="MapPinIcon" size={13} style={{ color: isSiteManager ? 'rgb(96,165,250)' : 'var(--primary)' }} />
        <span className="text-sm font-medium" style={{ color: isSiteManager ? 'rgb(96,165,250)' : 'var(--foreground)' }}>
          {isSiteManager && assignedSite ? assignedSite : 'All Sites'}
        </span>
      </div>

      {/* The business day: 06:00 to 06:00, so 02:00 belongs to yesterday */}
      <div className="hidden xl:flex items-center gap-2 px-3.5 py-2 rounded-xl"
           title="The business day runs from 06:00 to 06:00"
           style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
        <Icon name="CalendarDaysIcon" size={13} className="text-muted-foreground" />
        <span className="text-sm" style={{ color: 'var(--muted-foreground)' }}>Business day {bdayLabel}</span>
      </div>
    </header>
  );
}
