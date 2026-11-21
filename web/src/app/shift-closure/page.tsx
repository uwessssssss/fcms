'use client';
import React from 'react';
import AppLayout from '@/components/AppLayout';
import ShiftClosureContent from './components/ShiftClosureContent';

export default function ShiftClosurePage() {
  return (
    <AppLayout currentPath="/shift-closure">
      <ShiftClosureContent />
    </AppLayout>
  );
}
