'use client';
import React from 'react';
import AppLayout from '@/components/AppLayout';
import ShiftReportsContent from './components/ShiftReportsContent';

export default function ShiftReportsPage() {
  return (
    <AppLayout currentPath="/shift-closure/reports">
      <ShiftReportsContent />
    </AppLayout>
  );
}
