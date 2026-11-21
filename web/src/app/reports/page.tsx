'use client';
import AppLayout from '@/components/AppLayout';
import ReportsContent from './components/ReportsContent';
import { usePathname } from 'next/navigation';

export default function ReportsPage() {
  const pathname = usePathname();
  return (
    <AppLayout currentPath={pathname}>
      <ReportsContent />
    </AppLayout>
  );
}
