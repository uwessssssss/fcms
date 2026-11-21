import React from 'react';
import Sidebar from './Sidebar';
import Topbar from './Topbar';

interface AppLayoutProps {
  children: React.ReactNode;
  currentPath?: string;
}

export default function AppLayout({ children, currentPath }: AppLayoutProps) {
  return (
    <div className="flex h-screen overflow-hidden" style={{ backgroundColor: 'var(--background)' }}>
      <Sidebar currentPath={currentPath} />
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Topbar />
        <main
          className="flex-1 overflow-y-auto scrollbar-thin"
          style={{
            background: 'radial-gradient(ellipse at 20% 0%, rgba(0,212,160,0.04) 0%, transparent 60%), radial-gradient(ellipse at 80% 100%, rgba(96,165,250,0.03) 0%, transparent 60%), var(--background)',
          }}
        >
          <div className="px-6 lg:px-8 xl:px-10 2xl:px-12 py-7 max-w-screen-2xl mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}