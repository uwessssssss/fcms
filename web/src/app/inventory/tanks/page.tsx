import React from 'react';
import AppLayout from '@/components/AppLayout';
import { ToastProvider } from '@/components/ui/Toast';
import TankInventoryContent from './components/TankInventoryContent';

export default function TankInventoryPage() {
  return (
    <ToastProvider>
      <AppLayout currentPath="/inventory/tanks">
        <TankInventoryContent />
      </AppLayout>
    </ToastProvider>
  );
}
