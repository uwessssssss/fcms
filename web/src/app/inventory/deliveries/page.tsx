import React from 'react';
import AppLayout from '@/components/AppLayout';
import { ToastProvider } from '@/components/ui/Toast';
import DeliveriesContent from './components/DeliveriesContent';

export default function DeliveriesPage() {
  return (
    <ToastProvider>
      <AppLayout currentPath="/inventory/deliveries">
        <DeliveriesContent />
      </AppLayout>
    </ToastProvider>
  );
}
