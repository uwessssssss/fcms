'use client';
import { api, ApiError, setToken } from '@/lib/api';
import type { LoginResponse } from '@/types/api';
import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import AppLogo from '@/components/ui/AppLogo';
import Icon from '@/components/ui/AppIcon';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';

// Backend: POST /api/v1/auth/login — returns { token, user: { role, siteId?, name } }

interface LoginFormData {
  email: string;
  password: string;
  rememberMe: boolean;
}



const capabilities = [
  { icon: 'Squares2X2Icon', text: 'Live multi-site operations view' },
  { icon: 'BeakerIcon',     text: 'Tank stock levels with low-stock alerts' },
  { icon: 'BoltIcon',       text: 'Real-time pump and nozzle status' },
  { icon: 'ChartBarIcon',   text: 'Daily, weekly, and monthly revenue' },
  { icon: 'BellAlertIcon',  text: 'Cross-site alert feed with acknowledgement' },
];

export default function LoginContent() {
  const [forgotOpen, setForgotOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loginError, setLoginError] = useState('');
  const router = useRouter();
  const { login } = useAuth();

  const { register, handleSubmit, setValue, formState: { errors } } = useForm<LoginFormData>({
    defaultValues: { email: '', password: '', rememberMe: false },
  });


  const onSubmit = async (data: LoginFormData) => {
    setIsLoading(true);
    setLoginError('');

    try {
      // Employee number -- SUP01, MGR01. Attendants have no sign-in at all
      // by design: they are subjects of the record, not authors of it, and
      // the database enforces that with a composite key.
      const res = await api.post<LoginResponse>('/api/auth/login', {
        employeeNo: data.email.trim(),
        password: data.password,
      });

      setToken(res.token);

      if (res.mustChangePassword) {
        // A first sign-in on an issued password. Sending them to the app with
        // a password everyone in the office knows would defeat the point.
        router.push('/change-password');
        return;
      }

      login({
        role: res.role.toLowerCase().replace('_', '-'),
        roleLabel: res.role
          .replace('_', ' ')
          .toLowerCase()
          .replace(/\b\w/g, (c) => c.toUpperCase()),
        name: res.fullName,
        email: data.email.trim(),
        initials: res.fullName
          .split(' ')
          .map((x) => x[0])
          .slice(0, 2)
          .join('')
          .toUpperCase(),
        scope: ['DIRECTOR', 'SYSTEM_ADMIN', 'HEAD_OFFICE'].includes(res.role) ? 'All sites' : 'This site',
        scopeDetail: res.permissions.length + ' permissions',
        // A director sees every site; everyone else is scoped to theirs. The
        // server enforces this with row-level security regardless -- this only
        // decides what the interface offers.
        // The id; AuthContext looks up the station's name (W1).
        assignedSite: null,
        assignedSiteId:
          ['DIRECTOR', 'SYSTEM_ADMIN', 'HEAD_OFFICE'].includes(res.role) ? null : res.siteId,
        staffId: res.staffId,
      });

      router.push('/');
    } catch (e) {
      const err = e as ApiError;
      setLoginError(
        err.code === 'INVALID_CREDENTIALS'
          ? 'That employee number and password do not match.'
          : err.message,
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex" style={{ backgroundColor: 'var(--background)' }}>
      {/* Brand panel */}
      <div
        className="hidden lg:flex flex-col justify-between w-[480px] xl:w-[520px] shrink-0 p-10"
        style={{ backgroundColor: 'var(--card)', borderRight: '1px solid var(--border)' }}
      >
        <div>
          <div className="flex items-center gap-3 mb-12">
            <AppLogo size={36} />
            <span className="font-semibold text-lg text-foreground">Forecourt</span>
          </div>
          <h2 className="text-3xl font-bold text-foreground leading-tight mb-4">
            Multi-site forecourt operations, under control.
          </h2>
          <p className="text-sm leading-relaxed mb-10" style={{ color: 'var(--muted-foreground)' }}>
            Head office teams monitor live pump status, tank stock levels, and revenue across every
            fuel station in Uganda, Kenya, Tanzania, and South Sudan from a single dashboard.
          </p>
          <div className="space-y-3">
            {capabilities.map((cap) => (
              <div key={`cap-${cap.icon}`} className="flex items-center gap-3">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                  style={{ backgroundColor: 'rgba(0,200,150,0.1)' }}
                >
                  <Icon name={cap.icon as Parameters<typeof Icon>[0]['name']} size={16} className="text-primary" />
                </div>
                <span className="text-sm" style={{ color: 'var(--muted-foreground)' }}>{cap.text}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Stats strip */}
        <div
          className="grid grid-cols-3 gap-4 pt-8 border-t"
          style={{ borderColor: 'var(--border)' }}
        >
          {[
            { value: '5', label: 'Locations' },
            { value: '44', label: 'Pumps' },
            { value: '99.2%', label: 'Uptime SLA' },
          ].map((stat) => (
            <div key={`stat-${stat.label}`}>
              <p className="text-2xl font-bold font-mono-nums text-foreground">{stat.value}</p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--muted-foreground)' }}>{stat.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Form panel */}
      <div className="flex-1 flex items-center justify-center p-6 overflow-y-auto">
        <div className="w-full max-w-[440px] space-y-6">
          {/* Mobile logo */}
          <div className="flex lg:hidden items-center gap-2 mb-2">
            <AppLogo size={28} />
            <span className="font-semibold text-base text-foreground">Forecourt</span>
          </div>

          <div>
            <h1 className="text-2xl font-semibold text-foreground">Sign in</h1>
            <p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>
              Access your forecourt operations dashboard
            </p>
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
            {/* Error banner */}
            {loginError && (
              <div
                className="flex items-start gap-3 px-4 py-3 rounded-lg text-sm slide-up"
                style={{
                  backgroundColor: 'rgba(239,68,68,0.1)',
                  border: '1px solid rgba(239,68,68,0.3)',
                  color: 'var(--status-offline)',
                }}
              >
                <Icon name="ExclamationCircleIcon" size={16} className="shrink-0 mt-0.5" />
                <p>{loginError}</p>
              </div>
            )}

            {/* Employee number.
                This was an email field with a pattern requiring an @, which
                meant SUP01 failed validation IN THE BROWSER and never reached
                the server -- the sign-in simply refused with "enter a valid
                email address" for the only credentials that actually work.

                This system signs people in by employee number because a
                forecourt hires and loses staff faster than anyone issues
                email addresses, and the number is already on the badge. */}
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-foreground mb-1.5">
                Employee number
              </label>
              <input
                id="email"
                type="text"
                autoComplete="username"
                autoCapitalize="characters"
                spellCheck={false}
                className="input-field"
                placeholder="SUP01"
                {...register('email', {
                  required: 'Enter your employee number',
                })}
              />
              {errors.email && (
                <p className="text-xs mt-1" style={{ color: 'var(--status-offline)' }}>
                  {errors.email.message}
                </p>
              )}
            </div>

            {/* Password */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label htmlFor="password" className="block text-sm font-medium text-foreground">
                  Password
                </label>
                <button type="button" className="text-xs hover:text-primary transition-colors" style={{ color: 'var(--muted-foreground)' }}
                        onClick={() => setForgotOpen((v) => !v)}>
                  Forgot password?
                </button>
              </div>
              {forgotOpen && (
                <p className="text-xs mb-2 rounded-lg p-2" style={{ color: 'var(--muted-foreground)', background: 'rgba(255,255,255,0.03)' }}>
                  Passwords are reset by your head office or the system administrator. They set a temporary
                  one, and you choose your own the next time you sign in.
                </p>
              )}
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  className="input-field pr-10"
                  placeholder="Enter your password"
                  {...register('password', {
                    required: 'Password is required',
                    minLength: { value: 6, message: 'Password must be at least 6 characters' },
                  })}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  <Icon name={showPassword ? 'EyeSlashIcon' : 'EyeIcon'} size={16} />
                </button>
              </div>
              {errors.password && (
                <p className="text-xs mt-1" style={{ color: 'var(--status-offline)' }}>
                  {errors.password.message}
                </p>
              )}
            </div>

            {/* Remember me */}
            <div className="flex items-center gap-2">
              <input
                id="rememberMe"
                type="checkbox"
                className="w-4 h-4 rounded accent-primary"
                {...register('rememberMe')}
              />
              <label htmlFor="rememberMe" className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
                Keep me signed in for 30 days
              </label>
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={isLoading}
              className="btn-primary w-full justify-center py-2.5"
              style={{ opacity: isLoading ? 0.7 : 1 }}
            >
              {isLoading ? (
                <>
                  <Icon name="ArrowPathIcon" size={16} className="animate-spin" />
                  Signing in…
                </>
              ) : (
                'Sign in to Forecourt'
              )}
            </button>
          </form>

          {/* Demo credentials table */}
          <div
            className="rounded-xl p-4"
            style={{ backgroundColor: 'var(--muted)', border: '1px solid var(--border)' }}
          >
            <div className="flex items-center gap-2 mb-3">
              <Icon name="UserCircleIcon" size={15} className="text-primary" />
              <p className="text-xs font-semibold text-foreground">Demo accounts — click to autofill</p>
            </div>
            <div className="space-y-2">
                          </div>
          </div>

          {/* Sign up link */}
          <p className="text-center text-xs" style={{ color: 'var(--muted-foreground)' }}>
            New to Forecourt?{' '}
            <span className="font-medium" style={{ color: 'var(--foreground)' }}>
              Ask your head office administrator for access
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}