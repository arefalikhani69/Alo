/**
 * AutoPin Pro - Professional License Administration Center (Phase 1)
 *
 * Implements the 10 core administrative sections:
 * 1. داشبورد (Dashboard)
 * 2. مدیریت لایسنس‌ها (Licenses)
 * 3. درخواست‌های فعال‌سازی (Activation Requests)
 * 4. مدیریت دستگاه‌ها (Devices)
 * 5. انتقال لایسنس (License Transfers)
 * 6. تمدید لایسنس (Renewals)
 * 7. لغو و مسدودسازی (Revocations & Blocking)
 * 8. گزارش‌های امنیتی و لاگ‌ها (Security Audit Logs)
 * 9. مدیریت مدیران (Administrators)
 * 10. تنظیمات امنیتی (Security Settings)
 *
 * Enforces Phase 1 boundaries:
 * - Real-time read-only connection to Firestore collections
 * - Action buttons prepared with non-executable / disabled preview states
 * - Zero dummy mutations on live licenses
 * - Complete preservation of ComposeShield and core app views
 */

import React, { useState, useEffect } from 'react';
import {
  ShieldCheck,
  Lock,
  ArrowRight,
  RefreshCw,
  Cpu,
  Key,
  Menu,
  X,
  AlertCircle,
  CheckCircle2
} from 'lucide-react';
import { useAuth } from '../../../context/AuthContext';
import { AdminGuard, useAdminGuardStatus } from './AdminGuard';
import { LicenseAdminSidebar, LicenseAdminTabId } from './LicenseAdminSidebar';
import { DashboardTab } from './tabs/DashboardTab';
import { LicensesTab } from './tabs/LicensesTab';
import { RequestsTab } from './tabs/RequestsTab';
import { DevicesTab } from './tabs/DevicesTab';
import { TransfersTab } from './tabs/TransfersTab';
import { RenewalsTab } from './tabs/RenewalsTab';
import { RevocationsTab } from './tabs/RevocationsTab';
import { AuditLogsTab } from './tabs/AuditLogsTab';
import { AdminsTab } from './tabs/AdminsTab';
import { SecuritySettingsTab } from './tabs/SecuritySettingsTab';
import {
  licenseAdminService,
  LicenseDashboardStats,
  AdminUserRecord,
  getRoleBadgeInfo,
  hasAdminPermission
} from '../../../services/licenseAdminService';

import {
  LicenseRecord,
  DeviceRecord,
  LicenseRequestRecord,
  LicenseAuditLogRecord
} from '../../../types/license';

interface LicenseAdminPanelProps {
  onBack: () => void;
}

const LicenseAdminContent: React.FC<LicenseAdminPanelProps> = ({ onBack }) => {
  const { currentUser, adminRole } = useAuth();
  const {
    verifiedRole,
    hasFirestoreAdminDoc,
    isProvisioningAdmin,
    bootstrapError,
    bootstrapErrorCategory,
    bootstrapStepLabel,
    bootstrapSuccessMessage,
    retryServerBootstrap
  } = useAdminGuardStatus();
  const effectiveRole = hasFirestoreAdminDoc ? (verifiedRole || adminRole) : null;
  const canViewAuditLogs = hasAdminPermission(effectiveRole, 'view_audit_logs');
  const roleBadge = hasFirestoreAdminDoc
    ? getRoleBadgeInfo(effectiveRole)
    : {
        label: 'در انتظار تأیید سند سرور',
        badgeClass: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
        description: 'بدون سند فعال admins/{uid} نقش مدیریتی ابری صادر نمی‌شود'
      };
  const [activeTab, setActiveTab] = useState<LicenseAdminTabId>('dashboard');

  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  // Live Data States
  const [stats, setStats] = useState<LicenseDashboardStats>({
    totalLicenses: 0,
    activeLicenses: 0,
    expiredLicenses: 0,
    blockedLicenses: 0,
    pendingRequests: 0,
    activeDevices: 0,
    totalTransfers: 0,
    expiringIn30Days: 0
  });
  const [licenses, setLicenses] = useState<LicenseRecord[]>([]);
  const [requests, setRequests] = useState<LicenseRequestRecord[]>([]);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [auditLogs, setAuditLogs] = useState<LicenseAuditLogRecord[]>([]);
  const [admins, setAdmins] = useState<AdminUserRecord[]>([]);

  // Loading States
  const [isLoading, setIsLoading] = useState(true);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date>(new Date());

  // Real-time Firestore Subscriptions (gated on verified active /admins/{uid} doc)
  useEffect(() => {
    if (!currentUser || !hasFirestoreAdminDoc) {
      setSyncError(null);
      setIsLoading(isProvisioningAdmin);
      if (!hasFirestoreAdminDoc) {
        setAuditLogs([]);
      }
      return;
    }

    setIsLoading(true);
    setSyncError(null);

    const unsubStats = licenseAdminService.subscribeDashboardStats(
      (newStats) => {
        setStats(newStats);
        setLastRefreshedAt(new Date());
      },
      (err) => setSyncError(`خطا در همگام‌سازی آمار داشبورد: ${err.message}`),
      { includeAuditLogs: canViewAuditLogs }
    );

    const unsubLicenses = licenseAdminService.subscribeLicenses(
      (newLicenses) => {
        setLicenses(newLicenses);
        setIsLoading(false);
      },
      (err) => setSyncError(`خطا در همگام‌سازی لایسنس‌ها: ${err.message}`)
    );

    const unsubRequests = licenseAdminService.subscribeRequests(
      (newRequests) => {
        setRequests(newRequests);
      },
      (err) => setSyncError(`خطا در همگام‌سازی درخواست‌ها: ${err.message}`)
    );

    const unsubDevices = licenseAdminService.subscribeDevices(
      (newDevices) => {
        setDevices(newDevices);
      },
      (err) => setSyncError(`خطا در همگام‌سازی دستگاه‌ها: ${err.message}`)
    );

    let unsubLogs = () => {};
    if (canViewAuditLogs) {
      unsubLogs = licenseAdminService.subscribeAuditLogs(
        (newLogs) => {
          setAuditLogs(newLogs);
        },
        150,
        (err) => setSyncError(`خطا در دریافت لاگ‌های امنیتی: ${err.message}`)
      );
    } else {
      setAuditLogs([]);
    }

    const unsubAdmins = licenseAdminService.subscribeAdmins(
      (newAdmins) => {
        setAdmins(newAdmins);
      },
      (err) => setSyncError(`خطا در دریافت مدیران: ${err.message}`)
    );

    return () => {
      unsubStats();
      unsubLicenses();
      unsubRequests();
      unsubDevices();
      unsubLogs();
      unsubAdmins();
    };
  }, [currentUser?.uid, hasFirestoreAdminDoc, isProvisioningAdmin, canViewAuditLogs]);

  const handleSelectTab = (tab: LicenseAdminTabId) => {
    setActiveTab(tab);
    setIsMobileMenuOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="space-y-6 pb-12 antialiased selection:bg-red-600 selection:text-white" dir="rtl">
      {/* Top Header Bar */}
      <header className="p-4 sm:p-5 rounded-2xl bg-zinc-950 border border-zinc-800 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-600 to-zinc-950 border border-red-500/50 flex items-center justify-center text-white shadow-md shadow-red-950">
              <Key className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base sm:text-lg font-black text-white tracking-tight">
                  پنل مدیریت حرفه‌ای لایسنس
                </h1>
                <span className="px-2 py-0.5 rounded-full bg-red-950/80 text-red-400 border border-red-800 text-[10px] font-bold font-mono">
                  ComposeShield Core
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400 mt-0.5">
                <span>مدیر جاری:</span>
                <span className="font-mono text-zinc-300 font-bold">{currentUser?.email || 'Admin'}</span>
                <span className={`px-2 py-0.5 rounded-md border text-[11px] font-medium ${roleBadge.badgeClass}`}>
                  {roleBadge.label}
                </span>
                <span className="text-zinc-600 hidden sm:inline">•</span>
                {hasFirestoreAdminDoc ? (
                  <span className="text-[11px] text-emerald-400 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                    همگام‌سازی دیتابیس فعال
                  </span>
                ) : isProvisioningAdmin ? (
                  <span className="text-[11px] text-sky-400 flex items-center gap-1">
                    <RefreshCw className="w-3 h-3 animate-spin" />
                    {bootstrapStepLabel || 'در حال ثبت سند مدیر در سرور...'}
                  </span>
                ) : (
                  <span className="text-[11px] text-amber-400 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                    حالت پیش‌نمایش محلی (بدون سند admins)
                  </span>
                )}
              </div>

            </div>
          </div>

          {/* Mobile menu toggle */}
          <button
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="md:hidden p-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white"
          >
            {isMobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>

        <div className="flex items-center gap-2.5 self-end md:self-auto">
          <div className="hidden sm:flex flex-col text-left text-[10px] text-zinc-500 font-mono">
            <span>AutoPin Pro Security Enclave</span>
            <span>Updated: {lastRefreshedAt.toLocaleTimeString('fa-IR')}</span>
          </div>

          <button
            onClick={onBack}
            className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-800 text-xs font-medium transition active:scale-95"
          >
            <ArrowRight className="w-4 h-4" />
            <span>بازگشت به برنامه</span>
          </button>
        </div>
      </header>

      {/* Server Verification Success Confirmation */}
      {hasFirestoreAdminDoc && bootstrapSuccessMessage && (
        <div className="p-3.5 rounded-xl bg-emerald-950/50 border border-emerald-800/70 text-xs text-emerald-200 flex items-center gap-2.5">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{bootstrapSuccessMessage}</span>
        </div>
      )}

      {/* Firestore Admin Document Provisioning Notice */}
      {!hasFirestoreAdminDoc && (
        <div className="p-3.5 rounded-xl bg-amber-950/40 border border-amber-800/70 text-xs text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            {isProvisioningAdmin ? (
              <RefreshCw className="w-4 h-4 text-sky-400 shrink-0 mt-0.5 animate-spin" />
            ) : (
              <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            )}
            <div className="space-y-1">
              <p>
                سند مدیریتی فعال برای این حساب در مجموعه <code className="font-mono">admins/{currentUser?.uid}</code> در پایگاه داده ابری ثبت نشده است؛ برای همگام‌سازی زنده لایسنس‌ها و لاگ‌های امنیتی، ثبت یا Bootstrap سند مدیر در سرور لازم است.
              </p>
              {isProvisioningAdmin && bootstrapStepLabel && (
                <p className="text-[11px] text-sky-300 font-medium">
                  {bootstrapStepLabel}
                </p>
              )}
              {!isProvisioningAdmin && bootstrapError && (
                <div className="space-y-1">
                  <p className="text-[11px] text-amber-300/95 font-medium">
                    جزئیات بررسی سرور{bootstrapErrorCategory ? ` (${bootstrapErrorCategory})` : ''}: {bootstrapError}
                  </p>
                  {bootstrapErrorCategory === 'function_not_deployed' && (
                    <p className="text-[10px] text-amber-200/80 font-mono" dir="ltr">
                      Target: project=airy-sunrise-fc70r | region=us-central1 | function=verifyAdminSession
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            disabled={isProvisioningAdmin}
            onClick={() => retryServerBootstrap()}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-900/60 hover:bg-amber-800/70 disabled:opacity-50 disabled:cursor-not-allowed border border-amber-700/70 text-amber-100 text-[11px] font-bold transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isProvisioningAdmin ? 'animate-spin' : ''}`} />
            <span>{isProvisioningAdmin ? 'در حال بررسی سرور...' : 'استعلام و ثبت مجدد در سرور'}</span>
          </button>
        </div>
      )}

      {/* Sync Error Notice if any */}
      {syncError && (
        <div className="p-3.5 rounded-xl bg-red-950/50 border border-red-800 text-xs text-red-300 flex items-center gap-2.5">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          <span>{syncError}</span>
        </div>
      )}

      {/* Mobile Navigation Drawer */}
      {isMobileMenuOpen && (
        <div className="md:hidden">
          <LicenseAdminSidebar
            activeTab={activeTab}
            onSelectTab={handleSelectTab}
            stats={stats}
          />
        </div>
      )}

      {/* Main Content Layout (Desktop 2-Column: Sidebar + Active Tab Content) */}
      <div className="grid grid-cols-1 md:grid-cols-4 lg:grid-cols-5 gap-6 items-start">
        {/* Desktop Sidebar (1 Column) */}
        <aside className="hidden md:block md:col-span-1 lg:col-span-1 sticky top-16">
          <LicenseAdminSidebar
            activeTab={activeTab}
            onSelectTab={handleSelectTab}
            stats={stats}
          />
        </aside>

        {/* Active Tab Viewport (3-4 Columns) */}
        <main className="md:col-span-3 lg:col-span-4 min-w-0">
          {activeTab === 'dashboard' && (
            <DashboardTab
              stats={stats}
              recentLogs={auditLogs}
              recentLicenses={licenses}
              onNavigateTab={(tabId) => handleSelectTab(tabId as LicenseAdminTabId)}
            />
          )}

          {activeTab === 'licenses' && (
            <LicensesTab licenses={licenses} isLoading={isLoading} />
          )}

          {activeTab === 'requests' && (
            <RequestsTab requests={requests} isLoading={isLoading} />
          )}

          {activeTab === 'devices' && (
            <DevicesTab devices={devices} isLoading={isLoading} />
          )}

          {activeTab === 'transfers' && (
            <TransfersTab logs={auditLogs} licenses={licenses} requests={requests} isLoading={isLoading} />
          )}

          {activeTab === 'renewals' && (
            <RenewalsTab licenses={licenses} isLoading={isLoading} />
          )}

          {activeTab === 'revocations' && (
            <RevocationsTab licenses={licenses} isLoading={isLoading} />
          )}

          {activeTab === 'audit_logs' && (
            <AuditLogsTab logs={auditLogs} isLoading={isLoading} canViewAuditLogs={canViewAuditLogs} />
          )}

          {activeTab === 'admins' && (
            <AdminsTab admins={admins} isLoading={isLoading} />
          )}

          {activeTab === 'security_settings' && (
            <SecuritySettingsTab />
          )}
        </main>
      </div>
    </div>
  );
};

export const LicenseAdminPanel: React.FC<LicenseAdminPanelProps> = ({ onBack }) => {
  return (
    <AdminGuard onReturn={onBack}>
      <LicenseAdminContent onBack={onBack} />
    </AdminGuard>
  );
};
