'use client';
import { useHasDepot } from '@/lib/useHasDepot';
import { useOpenAlerts } from '@/lib/useOpenAlerts';
import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import AppLogo from '@/components/ui/AppLogo';
import Icon from '@/components/ui/AppIcon';
import { useAuth } from '@/context/AuthContext';

export interface NavItem {
  key: string;
  label: string;
  icon: string;
  href: string;
  badge?: number;
  group: string;
  headOfficeOnly?: boolean;
  /** The platform, not a company: only the system administrator. */
  systemAdminOnly?: boolean;
  /** Shown only to a company that runs a depot. */
  needsDepot?: boolean;
  /** A permission the screen's data needs; not offered without it. */
  needs?: string;
}

export const navItems: NavItem[] = [
  { key: 'nav-overview', label: 'All Sites Overview', icon: 'Squares2X2Icon', href: '/', group: 'Monitor', headOfficeOnly: true },
  { key: 'nav-site-ops', label: 'Site Operations', icon: 'BuildingStorefrontIcon', href: '/site-operations-detail', group: 'Monitor' },
  { key: 'nav-alerts', label: 'Alerts', icon: 'BellAlertIcon', href: '/shift-operations', group: 'Monitor' },
  { key: 'nav-tanks', label: 'Tank Inventory', icon: 'BeakerIcon', href: '/inventory/tanks', group: 'Inventory' },
  { key: 'nav-deliveries', label: 'Fuel Deliveries', icon: 'TruckIcon', href: '/inventory/deliveries', group: 'Inventory', needs: 'report.view' },
  { key: 'nav-other-stocks', label: 'Other Stocks', icon: 'ArchiveBoxIcon', href: '/other-stocks', group: 'Inventory' },
  { key: 'nav-products', label: 'Products', icon: 'TagIcon', href: '/products', group: 'Inventory', needs: 'report.view' },
  { key: 'nav-stock-counts', label: 'Stock Counts', icon: 'ClipboardDocumentCheckIcon', href: '/stock-counts', group: 'Inventory' },
  { key: 'nav-pump-setup', label: 'Pump Setup', icon: 'CpuChipIcon', href: '/pump-setup', group: 'Pumps' },
  { key: 'nav-pump-attendants', label: 'Pump Attendants', icon: 'UsersIcon', href: '/pump-attendants', group: 'Pumps' },
  { key: 'nav-attendant-shorts', label: 'Attendant Shorts', icon: 'ExclamationTriangleIcon', href: '/attendant-shorts', group: 'Pumps', needs: 'report.view' },
    { key: 'nav-shift-operations', label: 'Shift Operations', icon: 'PlayCircleIcon', href: '/shift-operations', group: 'Operations' },
{ key: 'nav-shift-closure', label: 'Shift Closure', icon: 'ClipboardDocumentCheckIcon', href: '/shift-closure', group: 'Operations' },
  { key: 'nav-shift-reports', label: 'Shift Reports', icon: 'DocumentChartBarIcon', href: '/shift-closure/reports', group: 'Operations' },
  { key: 'nav-expenses', label: 'Expenses', icon: 'ReceiptRefundIcon', href: '/expenses', group: 'Operations', needs: 'report.view' },
  { key: 'nav-suppliers', label: 'Suppliers', icon: 'TruckIcon', href: '/suppliers', group: 'Operations', needs: 'report.view' },
  { key: 'nav-credit', label: 'Credit Customers', icon: 'UserGroupIcon', href: '/credit-customers', group: 'Operations' },
  { key: 'nav-payments', label: 'Mobile Money & Visa', icon: 'DevicePhoneMobileIcon', href: '/payments', group: 'Operations', needs: 'report.view' },
  { key: 'nav-other-income', label: 'Other Income', icon: 'SparklesIcon', href: '/other-income', group: 'Operations', needs: 'report.view' },
  { key: 'nav-depot', label: 'Depot', icon: 'BuildingOffice2Icon', href: '/depot', group: 'Depot', needsDepot: true },
  { key: 'nav-books', label: 'Books & Reconciliations', icon: 'BookOpenIcon', href: '/books', group: 'Reports', needs: 'report.view' },
  { key: 'nav-full-reports', label: 'All Reports', icon: 'ChartBarSquareIcon', href: '/full-reports', group: 'Reports', needs: 'report.view' },
  { key: 'nav-losses', label: 'Losses', icon: 'ArrowTrendingDownIcon', href: '/losses', group: 'Reports', needs: 'report.view' },
  { key: 'nav-management', label: 'Management Reports', icon: 'PresentationChartLineIcon', href: '/management-reports', group: 'Reports', needs: 'report.view' },
  { key: 'nav-sales', label: 'Sales Reports', icon: 'ChartBarIcon', href: '/reports', group: 'Reports', headOfficeOnly: true },
  // Above a company, not inside one. The endpoint refuses anybody but a system
  // administrator, so this is a courtesy -- a link that 403s is a worse
  // experience than no link, but the refusal is what actually holds.
  { key: 'nav-companies', label: 'Companies', icon: 'BuildingOffice2Icon', href: '/companies', group: 'System', systemAdminOnly: true },
  { key: 'nav-users', label: 'User Management', icon: 'UsersIcon', href: '/users', group: 'System', headOfficeOnly: true },
  { key: 'nav-administration', label: 'Administration', icon: 'AdjustmentsHorizontalIcon', href: '/administration', group: 'System', headOfficeOnly: true },
  { key: 'nav-customisation', label: 'System Customisation', icon: 'Cog6ToothIcon', href: '/system-customisation', group: 'System', headOfficeOnly: true },
];

const groups = ['Monitor', 'Inventory', 'Pumps', 'Operations', 'Depot', 'Reports', 'System'];

interface SidebarProps {
  currentPath?: string;
  /** Below laptop width the sidebar is a drawer: open or not. */
  mobileOpen?: boolean;
  /** Called when a screen is chosen, so the drawer can close. */
  onNavigate?: () => void;
}


/**
 * The entries this person may open -- one rule for the sidebar AND the search,
 * so the search never offers a screen the sidebar hides.
 */
export function useVisibleNav(): NavItem[] {
  const { user } = useAuth();
  const hasDepot = useHasDepot();
  const companyWide = ['head-office', 'system-admin', 'director'];
  const isHeadOffice = !user || companyWide.includes(user.role);
  return navItems.filter((n) => {
    if (n.headOfficeOnly && !isHeadOffice) return false;
    // Companies was shown to head office and directors, who were then refused
    // by the server -- it needs system.admin. Only the platform sees it now.
    if (n.systemAdminOnly && user?.role !== 'system-admin') return false;
    // Most companies have no depot: the menu appears once one is set up.
    if (n.needsDepot && hasDepot !== true) return false;
    // A screen whose data the person may not read is not offered: a supervisor
    // was shown 13 menu items that each opened onto a refusal. (D4) A session
    // saved before permissions were kept shows everything, as before.
    if (n.needs && user?.permissions && !user.permissions.includes(n.needs)) return false;
    return true;
  });
}

export default function Sidebar({ currentPath = '/', mobileOpen = false, onNavigate }: SidebarProps) {
  // The page we are on, read from the address -- not from a prop each page had
  // to remember to pass. Most pages added later passed nothing, so the sidebar
  // fell back to '/' and lit the Dashboard whatever page was open.
  const pathname = usePathname() ?? currentPath;
  // The MOST SPECIFIC entry wins: on /shift-closure/reports, Shift Reports is
  // the page -- not Shift Closure, whose address it merely starts with.
  const activeHref = navItems
    .map((n) => n.href)
    .filter((h) => h !== '#' && (h === '/' ? pathname === '/' : pathname === h || pathname.startsWith(h + '/')))
    .sort((a, b) => b.length - a.length)[0];
  const visible = useVisibleNav();
  const openAlerts = useOpenAlerts();
  const [collapsed, setCollapsed] = useState(false);
  const { user, logout } = useAuth();
  const router = useRouter();

  // Company-wide roles see every site and the System section. This checked
  // for 'head-office' alone, so a system administrator -- the person who
  // creates companies -- was treated as a site manager, and the Companies
  // screen was hidden from the only person allowed to use it.
  const COMPANY_WIDE = ['head-office', 'system-admin', 'director'];
  const isHeadOffice = !user || COMPANY_WIDE.includes(user.role);
  const isSiteManager = !!user && !COMPANY_WIDE.includes(user.role);

  const handleLogout = () => {
    logout();
    router.push('/sign-up-login-screen');
  };

  // Nobody, when nobody is signed in. This fell back to "Sarah Whitfield,
  // sarah.whitfield@forecourt-ops.co.uk" -- a person from the template -- so
  // during loading, or after a lost session, the sidebar named a stranger.
  const displayName = user?.name ?? 'Not signed in';
  const displayEmail = user?.email ?? '';
  const displayInitials = user?.initials ?? '--';
  // Template text said 'Head Office' and 'All 5 sites visible' to nobody.
  const displayRoleLabel = user?.roleLabel ?? 'Signed out';
  const displayScope = user?.assignedSite
    ? `${user.assignedSite} only`
    : (user?.scopeDetail ?? '');

  return (
    // Below lg (1024px) a drawer over the page, opened from the top bar; it
    // was a fixed 248px column that left a phone 142px for the screen itself.
    <aside
      className={`flex flex-col shrink-0 transition-all duration-300 ease-in-out fixed inset-y-0 left-0 z-50 lg:static lg:z-auto lg:translate-x-0 ${
        mobileOpen ? 'translate-x-0' : '-translate-x-full'
      }`}
      style={{
        width: collapsed ? 68 : 248,
        background: 'linear-gradient(180deg, #0A1220 0%, #080D18 100%)',
        borderRight: '1px solid rgba(255,255,255,0.05)',
        boxShadow: '2px 0 20px rgba(0,0,0,0.4)',
      }}
    >
      {/* Logo */}
      <div
        className="flex items-center gap-3 px-4 py-4 shrink-0"
        style={{
          borderBottom: '1px solid rgba(255,255,255,0.05)',
          minHeight: 64,
        }}
      >
        <div
          className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: 'linear-gradient(135deg, var(--primary) 0%, #007A5C 100%)',
            boxShadow: '0 2px 12px rgba(0,212,160,0.3)',
          }}
        >
          <AppLogo size={20} />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <span className="font-bold text-sm tracking-tight text-foreground block truncate">
              Forecourt
            </span>
            <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
              Management
            </span>
          </div>
        )}
      </div>

      {/* Role badge */}
      {!collapsed && (
        <div
          className="mx-3 my-3 px-3 py-2.5 rounded-xl"
          style={{
            background: isHeadOffice
              ? 'rgba(0,212,160,0.06)'
              : 'rgba(96,165,250,0.06)',
            border: `1px solid ${isHeadOffice ? 'rgba(0,212,160,0.15)' : 'rgba(96,165,250,0.15)'}`,
          }}
        >
          <div className="flex items-center gap-2">
            <div
              className="w-1.5 h-1.5 rounded-full pulse-dot"
              style={{ backgroundColor: isHeadOffice ? 'var(--primary)' : 'rgb(96,165,250)' }}
            />
            <span
              className="text-xs font-semibold"
              style={{ color: isHeadOffice ? 'var(--primary)' : 'rgb(96,165,250)' }}
            >
              {displayRoleLabel}
            </span>
          </div>
          <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--muted-foreground)' }}>
            {displayScope}
          </p>
        </div>
      )}

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto scrollbar-thin py-2 px-2">
        {groups.map((group) => {
          const items = visible.filter((n) => n.group === group);
          if (items.length === 0) return null;
          return (
            <div key={`group-${group}`} className="mb-3">
              {!collapsed && (
                <p
                  className="px-3 py-1.5 text-xs font-bold uppercase tracking-widest"
                  style={{ color: 'rgba(100,116,139,0.6)', letterSpacing: '0.12em' }}
                >
                  {group}
                </p>
              )}
              {items.map((item) => {
                const isActive = item.href === activeHref;
                return (
                  <Link
                    key={item.key}
                    href={item.href}
                    onClick={onNavigate}
                    title={collapsed ? item.label : undefined}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 group relative mb-0.5 ${
                      isActive ? '' : 'hover:bg-white/[0.04]'
                    }`}
                    style={
                      isActive
                        ? {
                            background: 'linear-gradient(135deg, rgba(0,212,160,0.15) 0%, rgba(0,212,160,0.08) 100%)',
                            color: 'var(--primary)',
                            border: '1px solid rgba(0,212,160,0.2)',
                            boxShadow: '0 2px 8px rgba(0,212,160,0.1)',
                          }
                        : { color: 'var(--muted-foreground)' }
                    }
                  >
                    {isActive && (
                      <div
                        className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-full"
                        style={{ backgroundColor: 'var(--primary)' }}
                      />
                    )}
                    <Icon
                      name={item.icon as Parameters<typeof Icon>[0]['name']}
                      size={17}
                      className="shrink-0"
                    />
                    {!collapsed && (
                      <>
                        <span className="flex-1 truncate text-sm">{item.label}</span>
                        {item.key === 'nav-alerts' && (openAlerts ?? 0) > 0 && (
                          <span
                            className="px-2 py-0.5 rounded-full text-xs font-bold"
                            style={{
                              background: 'rgba(245,158,11,0.15)',
                              color: 'var(--accent)',
                              border: '1px solid rgba(245,158,11,0.2)',
                            }}
                          >
                            {openAlerts}
                          </span>
                        )}
                      </>
                    )}
                    {collapsed && item.key === 'nav-alerts' && (openAlerts ?? 0) > 0 && (
                      <span
                        className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full"
                        style={{ backgroundColor: 'var(--accent)' }}
                      />
                    )}
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>

      {/* User + collapse toggle */}
      <div
        className="p-3 space-y-1.5"
        style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}
      >
        {!collapsed && (
          <div
            className="flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-all duration-150 hover:bg-white/[0.04]"
          >
            <div
              className="w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold shrink-0"
              style={{
                background: isHeadOffice
                  ? 'linear-gradient(135deg, var(--primary) 0%, #007A5C 100%)'
                  : 'linear-gradient(135deg, #60A5FA 0%, #3B82F6 100%)',
                color: '#fff',
                boxShadow: isHeadOffice
                  ? '0 2px 8px rgba(0,212,160,0.3)'
                  : '0 2px 8px rgba(96,165,250,0.3)',
              }}
            >
              {displayInitials}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-foreground truncate">{displayName}</p>
              <p className="text-xs truncate" style={{ color: 'var(--muted-foreground)' }}>
                {displayEmail}
              </p>
            </div>
            <Icon name="ChevronUpDownIcon" size={13} className="text-muted-foreground shrink-0" />
          </div>
        )}

        <button
          onClick={handleLogout}
          className="flex items-center gap-2 w-full px-3 py-2 rounded-xl text-xs font-medium transition-all duration-150 hover:bg-red-500/10"
          title="Sign out"
          style={{ color: 'var(--muted-foreground)' }}
        >
          <Icon name="ArrowRightOnRectangleIcon" size={15} />
          {!collapsed && <span>Sign out</span>}
        </button>

        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-2 w-full px-3 py-2 rounded-xl text-xs font-medium transition-all duration-150 hover:bg-white/[0.04]"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          style={{ color: 'var(--muted-foreground)' }}
        >
          <Icon
            name={collapsed ? 'ChevronDoubleRightIcon' : 'ChevronDoubleLeftIcon'}
            size={15}
          />
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}