import React from 'react';
import AppLayout from '@/components/AppLayout';
import { ToastProvider } from '@/components/ui/Toast';
import DashboardContent from './components/DashboardContent';

export default function MultiSiteOverviewPage() {
  return (
    <ToastProvider>
      <AppLayout currentPath="/">
        <DashboardContent />
      </AppLayout>
    </ToastProvider>
  );
}