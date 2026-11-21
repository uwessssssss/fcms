import React from 'react';
import AppLayout from '@/components/AppLayout';
import { ToastProvider } from '@/components/ui/Toast';
import SiteOperationsContent from './components/SiteOperationsContent';

export default function SiteOperationsDetailPage() {
  return (
    <ToastProvider>
      <AppLayout currentPath="/site-operations-detail">
        <SiteOperationsContent />
      </AppLayout>
    </ToastProvider>
  );
}