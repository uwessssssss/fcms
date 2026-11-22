import { useAuth } from '@/context/AuthContext';

/**
 * Whether the signed-in person holds a permission. Write controls are drawn
 * only for people the server will let through: an auditor (audit.view and
 * report.view only) was shown Record invoice, Create User and the rest, each
 * ending in a refusal. A session saved before permissions were kept sees
 * everything, as the sidebar does.
 */
export function useCan(): (permission: string) => boolean {
  const { user } = useAuth();
  return (permission: string) => !user?.permissions || user.permissions.includes(permission);
}
