/**
 * AutoPin Pro - License Admin: Licenses Management Tab (Operational Phase 2)
 *
 * Provides real-time view and operational actions for issued licenses:
 * - Search by License ID, User UID, User Email, Device ID, or Key Hint
 * - Filter by status (All, Active, Expired, Blocked, Suspended)
 * - Operational License Issuance with 128-bit CSPRNG entropy across tiers:
 *   '1m' (1 month), '3m' (3 months), '6m' (6 months), '1y' (1 year), 'lifetime' (permanent)
 * - Raw plain activation key displayed strictly once with 1-click copy
 * - Operational License Renewal and Revocation/Suspension/Reactivation shortcuts
 * - Detailed inspection modal
 */

import React, { useState, useMemo } from 'react';
import {
  Key,
  Search,
  Filter,
  Eye,
  RotateCw,
  Ban,
  ArrowRightLeft,
  Plus,
  ShieldCheck,
  AlertTriangle,
  X,
  Copy,
  Check,
  Calendar,
  Smartphone,
  User,
  Clock,
  Lock,
  RefreshCw,
  CheckCircle2,
  Sparkles
} from 'lucide-react';
import { LicenseRecord, LicenseDuration } from '../../../../types/license';
import { licenseAdminService } from '../../../../services/licenseAdminService';

interface LicensesTabProps {
  licenses: LicenseRecord[];
  isLoading: boolean;
}

export const LicensesTab: React.FC<LicensesTabProps> = ({ licenses, isLoading }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'expired' | 'blocked'>('all');
  const [selectedLicense, setSelectedLicense] = useState<LicenseRecord | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedIssuedKey, setCopiedIssuedKey] = useState(false);

  // Issue License Form States
  const [showIssueModal, setShowIssueModal] = useState(false);
  const [issueDuration, setIssueDuration] = useState<LicenseDuration>('1y');
  const [issueUserEmail, setIssueUserEmail] = useState('');
  const [isSubmittingIssue, setIsSubmittingIssue] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issuedResult, setIssuedResult] = useState<{
    licenseId: string;
    activationKey: string;
    keyHint: string;
    duration: LicenseDuration;
  } | null>(null);

  // Quick Action Modal States (Renew & Revoke/Suspend)
  const [actionTargetLicense, setActionTargetLicense] = useState<LicenseRecord | null>(null);
  const [actionType, setActionType] = useState<'renew' | 'revoke' | 'suspend' | 'reactivate' | null>(null);
  const [renewalDuration, setRenewalDuration] = useState<LicenseDuration>('1y');
  const [actionReason, setActionReason] = useState('');
  const [blacklistDevice, setBlacklistDevice] = useState(false);
  const [isExecutingAction, setIsExecutingAction] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccessMsg, setActionSuccessMsg] = useState<string | null>(null);

  const filteredLicenses = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    const now = Date.now();

    return licenses.filter((lic) => {
      // Filter by status
      if (statusFilter === 'active') {
        if (lic.isBlocked || (lic.expiresAt > 0 && lic.expiresAt < now) || lic.status !== 'active') return false;
      } else if (statusFilter === 'expired') {
        if (lic.expiresAt === 0 || lic.expiresAt >= now || lic.isBlocked) return false;
      } else if (statusFilter === 'blocked') {
        if (!lic.isBlocked && lic.status !== 'revoked' && lic.status !== 'suspended') return false;
      }

      // Filter by search query
      if (!q) return true;
      return (
        lic.id.toLowerCase().includes(q) ||
        (lic.userId && lic.userId.toLowerCase().includes(q)) ||
        (lic.userEmail && lic.userEmail.toLowerCase().includes(q)) ||
        (lic.boundDeviceId && lic.boundDeviceId.toLowerCase().includes(q)) ||
        (lic.keyHint && lic.keyHint.toLowerCase().includes(q)) ||
        (lic.activationKey && lic.activationKey.toLowerCase().includes(q))
      );
    });
  }, [licenses, searchQuery, statusFilter]);

  const copyToClipboard = (text?: string, isIssued = false) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    if (isIssued) {
      setCopiedIssuedKey(true);
      setTimeout(() => setCopiedIssuedKey(false), 2000);
    } else {
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    }
  };

  const formatShamsiDate = (ms?: number) => {
    if (!ms || ms === 0) return 'هنوز فعال نشده';
    try {
      return new Intl.DateTimeFormat('fa-IR', {
        dateStyle: 'medium',
        timeStyle: 'short'
      }).format(new Date(ms));
    } catch {
      return new Date(ms).toLocaleDateString('fa-IR');
    }
  };

  const getDurationFa = (dur?: LicenseDuration) => {
    switch (dur) {
      case '1m': return 'یک ماهه (۳۰ روز)';
      case '3m': return 'سه ماهه (۹۰ روز)';
      case '6m': return 'شش ماهه (۱۸۰ روز)';
      case 'lifetime': return 'دائمی (نامحدود)';
      case '1y':
      default:
        return 'یک ساله (۳۶۵ روز)';
    }
  };

  // 1. Submit Issue License
  const handleExecuteIssue = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmittingIssue(true);
    setIssueError(null);

    try {
      const res = await licenseAdminService.issueLicense(
        issueDuration,
        issueUserEmail.trim() || undefined
      );

      setIssuedResult({
        licenseId: res.licenseId,
        activationKey: res.activationKey,
        keyHint: res.keyHint,
        duration: res.duration
      });
      setIssueUserEmail('');
    } catch (err: any) {
      console.warn('Issue license halted:', err?.message || err);
      setIssueError(err?.message || 'خطا در صدور لایسنس سمت سرور.');
    } finally {
      setIsSubmittingIssue(false);
    }
  };

  // 2. Submit Quick Action (Renew, Revoke, Suspend, Reactivate)
  const handleExecuteQuickAction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!actionTargetLicense || !actionType) return;

    setIsExecutingAction(true);
    setActionError(null);

    try {
      if (actionType === 'renew') {
        const res = await licenseAdminService.renewLicense(
          actionTargetLicense.id,
          renewalDuration
        );
        setActionSuccessMsg(`اعتبار لایسنس با موفقیت تمدید شد (تا تاریخ ${new Date(res.newExpiry).toLocaleDateString('fa-IR')}).`);
      } else {
        await licenseAdminService.revokeOrSuspendLicense(
          actionTargetLicense.id,
          actionType,
          actionReason.trim() || undefined,
          blacklistDevice
        );
        setActionSuccessMsg(
          actionType === 'reactivate'
            ? 'لایسنس با موفقیت رفع مسدودی و فعال شد.'
            : actionType === 'suspend'
            ? 'لایسنس به صورت موقت تعلیق شد.'
            : 'لایسنس به صورت دائمی باطل و مسدود شد.'
        );
      }

      setActionTargetLicense(null);
      setActionType(null);
      setActionReason('');
      setBlacklistDevice(false);
      setSelectedLicense(null);
      setTimeout(() => setActionSuccessMsg(null), 4000);
    } catch (err: any) {
      console.warn('Quick license action halted:', err?.message || err);
      setActionError(err?.message || 'خطا در ثبت عملیات در سرور.');
    } finally {
      setIsExecutingAction(false);
    }
  };

  return (
    <div className="space-y-5" dir="rtl">
      {/* Toast Notification */}
      {actionSuccessMsg && (
        <div className="p-3.5 rounded-2xl bg-emerald-950/70 border border-emerald-800 text-emerald-300 text-xs flex items-center gap-2.5 shadow-md animate-in fade-in">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{actionSuccessMsg}</span>
        </div>
      )}

      {/* Search and Filter Controls */}
      <div className="p-4 rounded-2xl bg-zinc-900/90 border border-zinc-800/80 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4">
        {/* Search Input */}
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-zinc-400 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="جستجو در شناسه لایسنس، ایمیل کاربر، شناسه سخت‌افزار یا ماسک کلید..."
            className="w-full pl-4 pr-10 py-2.5 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-red-500/60 transition"
          />
        </div>

        {/* Status Filter Buttons & Issue Action */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1 bg-zinc-950 p-1 rounded-xl border border-zinc-800/80 text-xs">
            <button
              onClick={() => setStatusFilter('all')}
              className={`px-3 py-1.5 rounded-lg transition font-medium ${
                statusFilter === 'all'
                  ? 'bg-zinc-800 text-white shadow-xs'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              همه ({licenses.length})
            </button>
            <button
              onClick={() => setStatusFilter('active')}
              className={`px-3 py-1.5 rounded-lg transition font-medium ${
                statusFilter === 'active'
                  ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                  : 'text-zinc-400 hover:text-emerald-400'
              }`}
            >
              فعال
            </button>
            <button
              onClick={() => setStatusFilter('expired')}
              className={`px-3 py-1.5 rounded-lg transition font-medium ${
                statusFilter === 'expired'
                  ? 'bg-red-950 text-red-400 border border-red-800'
                  : 'text-zinc-400 hover:text-red-400'
              }`}
            >
              منقضی
            </button>
            <button
              onClick={() => setStatusFilter('blocked')}
              className={`px-3 py-1.5 rounded-lg transition font-medium ${
                statusFilter === 'blocked'
                  ? 'bg-red-950 text-red-400 border border-red-800'
                  : 'text-zinc-400 hover:text-red-400'
              }`}
            >
              مسدود / معلق
            </button>
          </div>

          <button
            onClick={() => {
              setIssuedResult(null);
              setIssueError(null);
              setShowIssueModal(true);
            }}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-gradient-to-r from-red-600 to-amber-600 hover:from-red-500 hover:to-amber-500 text-white text-xs font-bold transition shadow-md shadow-red-950/40 active:scale-95"
          >
            <Plus className="w-4 h-4" />
            <span>صدور لایسنس جدید</span>
          </button>
        </div>
      </div>

      {/* Licenses Table */}
      <div className="rounded-2xl bg-zinc-900/90 border border-zinc-800/80 overflow-hidden">
        {isLoading ? (
          <div className="py-20 text-center text-zinc-500 text-xs font-mono">
            در حال بارگذاری لایسنس‌ها از Cloud Firestore...
          </div>
        ) : filteredLicenses.length === 0 ? (
          <div className="py-20 text-center text-zinc-500 text-xs">
            {searchQuery
              ? 'هیچ لایسنسی با مشخصات جستجو شده یافت نشد.'
              : 'تاکنون هیچ لایسنسی در پایگاه داده ثبت نشده است.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead className="bg-zinc-950/80 text-zinc-400 border-b border-zinc-800/80 font-medium">
                <tr>
                  <th className="px-4 py-3">شناسه لایسنس</th>
                  <th className="px-4 py-3">ماسک کلید (Key Hint)</th>
                  <th className="px-4 py-3">مالک / کاربر</th>
                  <th className="px-4 py-3">مدت دوره</th>
                  <th className="px-4 py-3">سخت‌افزار قفل‌شده</th>
                  <th className="px-4 py-3">تاریخ انقضا</th>
                  <th className="px-4 py-3">وضعیت</th>
                  <th className="px-4 py-3 text-center">عملیات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {filteredLicenses.map((lic) => {
                  const now = Date.now();
                  const isBlocked = lic.isBlocked || lic.status === 'revoked';
                  const isSuspended = lic.status === 'suspended';
                  const isExpired = lic.expiresAt > 0 && lic.expiresAt < now;

                  return (
                    <tr key={lic.id} className="hover:bg-zinc-800/40 transition">
                      {/* License ID */}
                      <td className="px-4 py-3.5 font-mono text-[11px] text-zinc-300 font-bold">
                        {lic.id}
                      </td>

                      {/* Key Hint */}
                      <td className="px-4 py-3.5 font-mono text-[11px] text-emerald-400">
                        {lic.keyHint || lic.activationKey || '—'}
                      </td>

                      {/* User */}
                      <td className="px-4 py-3.5 text-zinc-300">
                        {lic.userEmail || (lic.userId ? lic.userId.slice(0, 10) + '...' : 'آزاد (متصل‌نشده)')}
                      </td>

                      {/* Duration */}
                      <td className="px-4 py-3.5 text-zinc-400 text-[11px]">
                        {getDurationFa(lic.duration)}
                      </td>

                      {/* Hardware Device ID */}
                      <td className="px-4 py-3.5 font-mono text-[11px] text-zinc-400">
                        <span title={lic.boundDeviceId}>
                          {lic.boundDeviceId ? `${lic.boundDeviceId.slice(0, 14)}...` : 'هنوز فعال نشده'}
                        </span>
                      </td>

                      {/* Expiration Date */}
                      <td className="px-4 py-3.5 font-mono text-[11px] text-zinc-400">
                        {lic.expiresAt > 0 ? new Date(lic.expiresAt).toLocaleDateString('fa-IR') : 'پس از اولین فعال‌سازی'}
                      </td>

                      {/* Status */}
                      <td className="px-4 py-3.5">
                        {isBlocked ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-red-950/80 text-red-400 border border-red-800">
                            <Ban className="w-3 h-3" />
                            <span>ابطال‌شده</span>
                          </span>
                        ) : isSuspended ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-amber-950/80 text-amber-400 border border-amber-800">
                            <Clock className="w-3 h-3" />
                            <span>تعلیق موقت</span>
                          </span>
                        ) : isExpired ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-zinc-800 text-zinc-400 border border-zinc-700">
                            <Clock className="w-3 h-3" />
                            <span>منقضی</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-950/80 text-emerald-400 border border-emerald-800">
                            <ShieldCheck className="w-3 h-3" />
                            <span>فعال</span>
                          </span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="px-4 py-3.5 text-center whitespace-nowrap">
                        <div className="flex items-center justify-center gap-1.5">
                          {/* View details */}
                          <button
                            onClick={() => setSelectedLicense(lic)}
                            className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition"
                            title="مشاهده جزئیات کامل لایسنس"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>

                          {/* Quick Renew */}
                          <button
                            onClick={() => {
                              setActionTargetLicense(lic);
                              setActionType('renew');
                              setActionError(null);
                            }}
                            className="p-1.5 rounded-lg bg-orange-950/60 hover:bg-orange-900/60 border border-orange-800/60 text-orange-400 transition"
                            title="تمدید لایسنس"
                          >
                            <RotateCw className="w-3.5 h-3.5" />
                          </button>

                          {/* Quick Revoke / Suspend */}
                          {!lic.isBlocked && lic.status !== 'revoked' ? (
                            <button
                              onClick={() => {
                                setActionTargetLicense(lic);
                                setActionType('suspend');
                                setActionError(null);
                              }}
                              className="p-1.5 rounded-lg bg-red-950/60 hover:bg-red-900/60 border border-red-800/60 text-red-400 transition"
                              title="مسدودسازی یا تعلیق لایسنس"
                            >
                              <Ban className="w-3.5 h-3.5" />
                            </button>
                          ) : (
                            <button
                              onClick={() => {
                                setActionTargetLicense(lic);
                                setActionType('reactivate');
                                setActionError(null);
                              }}
                              className="p-1.5 rounded-lg bg-emerald-950/60 hover:bg-emerald-900/60 border border-emerald-800/60 text-emerald-400 transition"
                              title="فعال‌سازی مجدد لایسنس"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* License Details Modal */}
      {selectedLicense && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 shadow-2xl space-y-5 text-right">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-red-600/20 border border-red-500/40 flex items-center justify-center text-red-400">
                  <Key className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-bold text-white text-sm">جزئیات کامل لایسنس رمزنگاری</h3>
                  <span className="font-mono text-[11px] text-zinc-500">{selectedLicense.id}</span>
                </div>
              </div>
              <button
                onClick={() => setSelectedLicense(null)}
                className="p-1.5 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Info Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800/80 space-y-1">
                <span className="text-zinc-500 block text-[11px]">شناسه اختصاصی سند:</span>
                <span className="font-mono text-zinc-200 font-bold break-all">{selectedLicense.id}</span>
              </div>

              <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800/80 space-y-1">
                <span className="text-zinc-500 block text-[11px]">ماسک کلید (Key Hint):</span>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-emerald-400 font-bold">{selectedLicense.keyHint || selectedLicense.activationKey || '—'}</span>
                  <button
                    onClick={() => copyToClipboard(selectedLicense.keyHint || selectedLicense.activationKey)}
                    className="p-1 rounded bg-zinc-800 text-zinc-400 hover:text-white"
                    title="کپی در حافظه"
                  >
                    {copiedKey ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800/80 space-y-1">
                <span className="text-zinc-500 block text-[11px]">مالک لایسنس:</span>
                <span className="text-zinc-200 break-all">{selectedLicense.userEmail || selectedLicense.userId || 'آزاد (متصل‌نشده)'}</span>
              </div>

              <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800/80 space-y-1">
                <span className="text-zinc-500 block text-[11px]">مدت اعتبار:</span>
                <span className="text-zinc-200 font-bold">{getDurationFa(selectedLicense.duration)}</span>
              </div>

              <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800/80 space-y-1 md:col-span-2">
                <span className="text-zinc-500 block text-[11px]">سخت‌افزار قفل‌شده (Hardware Keystore ID):</span>
                <span className="font-mono text-zinc-200 break-all">{selectedLicense.boundDeviceId || 'هنوز فعال‌سازی سخت‌افزاری انجام نشده است'}</span>
              </div>

              <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800/80 space-y-1">
                <span className="text-zinc-500 block text-[11px]">تاریخ شروع اعتبار:</span>
                <span className="text-zinc-300 font-mono">{formatShamsiDate(selectedLicense.startsAt)}</span>
              </div>

              <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800/80 space-y-1">
                <span className="text-zinc-500 block text-[11px]">تاریخ انقضا:</span>
                <span className="text-zinc-300 font-mono">{formatShamsiDate(selectedLicense.expiresAt)}</span>
              </div>

              <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800/80 space-y-1">
                <span className="text-zinc-500 block text-[11px]">آخرین بررسی آنلاین:</span>
                <span className="text-zinc-300 font-mono">{formatShamsiDate(selectedLicense.lastOnlineCheckAt)}</span>
              </div>

              <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800/80 space-y-1">
                <span className="text-zinc-500 block text-[11px]">حداکثر مهلت آفلاین (Grace Period):</span>
                <span className="text-zinc-300 font-mono">{selectedLicense.maxOfflineDays || 7} روز (با توکن امضاشده سرور)</span>
              </div>
            </div>

            {selectedLicense.isBlocked && (
              <div className="p-3 rounded-xl bg-red-950/50 border border-red-800 text-xs text-red-300">
                <span className="font-bold block mb-1">دلیل مسدودسازی:</span>
                <span>{selectedLicense.blockReason || 'توسط مدیر سیستم مسدود شده است.'}</span>
              </div>
            )}

            {/* Quick Action Shortcuts inside Details Modal */}
            <div className="flex items-center justify-between gap-2 pt-2 border-t border-zinc-800 flex-wrap">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setActionTargetLicense(selectedLicense);
                    setActionType('renew');
                    setActionError(null);
                  }}
                  className="px-3 py-1.5 rounded-xl bg-orange-600 hover:bg-orange-500 text-white text-xs font-bold transition flex items-center gap-1"
                >
                  <RotateCw className="w-3.5 h-3.5" />
                  <span>تمدید اعتبار</span>
                </button>

                {!selectedLicense.isBlocked && selectedLicense.status !== 'revoked' ? (
                  <button
                    onClick={() => {
                      setActionTargetLicense(selectedLicense);
                      setActionType('suspend');
                      setActionError(null);
                    }}
                    className="px-3 py-1.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition flex items-center gap-1"
                  >
                    <Ban className="w-3.5 h-3.5" />
                    <span>مسدودسازی / تعلیق</span>
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      setActionTargetLicense(selectedLicense);
                      setActionType('reactivate');
                      setActionError(null);
                    }}
                    className="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition flex items-center gap-1"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>فعال‌سازی مجدد</span>
                  </button>
                )}
              </div>

              <button
                onClick={() => setSelectedLicense(null)}
                className="px-4 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium"
              >
                بستن
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Operational Issue License Modal (Phase 2) */}
      {showIssueModal && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-lg p-6 shadow-2xl space-y-4 text-right">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="flex items-center gap-2">
                <Key className="w-5 h-5 text-red-500" />
                <h3 className="font-bold text-white text-sm">صدور لایسنس رمزنگاری جدید (عملیاتی Firebase)</h3>
              </div>
              <button
                onClick={() => setShowIssueModal(false)}
                className="p-1 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {issueError && (
              <div className="p-3 rounded-xl bg-red-950/70 border border-red-800 text-xs text-red-300 space-y-1.5">
                <div className="flex items-center gap-2 font-medium">
                  <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                  <span>{issueError}</span>
                </div>
                {issueError.includes('Cloud Functions') && (
                  <p className="text-[11px] text-red-200/80 leading-relaxed pr-6">
                    تولید کد فعال‌سازی ۱۲۸ بیتی به‌صورت امن فقط توسط Cloud Functions سمت سرور مجاز است. برای اجرای عملیاتی، توابع <code className="font-mono">functions</code> باید روی یک پروژه Firebase با پشتیبانی Cloud Functions مستقر شوند یا به Firebase Emulator متصل باشید.
                  </p>
                )}
              </div>
            )}

            {/* If Key was generated: Display Raw Key ONCE */}
            {issuedResult ? (
              <div className="space-y-4 animate-in fade-in">
                <div className="p-4 rounded-xl bg-emerald-950/50 border border-emerald-800/80 text-emerald-300 text-xs space-y-2">
                  <div className="flex items-center gap-2 font-bold text-sm">
                    <Sparkles className="w-4 h-4 text-emerald-400" />
                    <span>لایسنس با موفقیت صادر شد!</span>
                  </div>
                  <p className="text-zinc-300 leading-relaxed text-[11px]">
                    کد فعال‌سازی زیر دارای ۱۲۸ بیت آنتروپی رمزنگاری است.
                    <strong>این کد خام فقط یک‌بار نمایش داده می‌شود</strong> و در سرور تنها هش SHA-256 آن ذخیره شده است. لطفاً آن را کپی نموده و در اختیار کاربر قرار دهید:
                  </p>
                </div>

                <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 text-center space-y-2">
                  <span className="text-zinc-500 text-[10px] block font-mono">کد فعال‌سازی اختصاصی (Plain Key):</span>
                  <div className="text-base sm:text-lg font-black font-mono text-amber-400 tracking-wider select-all" dir="ltr">
                    {issuedResult.activationKey}
                  </div>
                  <div className="flex items-center justify-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => copyToClipboard(issuedResult.activationKey, true)}
                      className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-750 text-white font-bold text-xs flex items-center gap-1.5 transition active:scale-95 shadow-sm"
                    >
                      {copiedIssuedKey ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedIssuedKey ? 'کپی شد!' : 'کپی کد فعال‌سازی'}</span>
                    </button>
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800 text-xs space-y-1">
                  <div className="flex justify-between text-zinc-400">
                    <span>شناسه لایسنس در دیتابیس:</span>
                    <span className="font-mono text-zinc-200">{issuedResult.licenseId}</span>
                  </div>
                  <div className="flex justify-between text-zinc-400">
                    <span>مدت اعتبار:</span>
                    <span className="text-zinc-200">{getDurationFa(issuedResult.duration)}</span>
                  </div>
                  <div className="flex justify-between text-zinc-400">
                    <span>ماسک کلید (Key Hint):</span>
                    <span className="font-mono text-emerald-400">{issuedResult.keyHint}</span>
                  </div>
                </div>

                <div className="flex justify-end pt-2 border-t border-zinc-800">
                  <button
                    onClick={() => setShowIssueModal(false)}
                    className="px-5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs transition"
                  >
                    متوجه شدم و کد را ذخیره کردم
                  </button>
                </div>
              </div>
            ) : (
              /* Issue Form */
              <form onSubmit={handleExecuteIssue} className="space-y-3.5 text-xs">
                <div>
                  <label className="block text-zinc-300 font-medium mb-1">
                    مدت اعتبار لایسنس (یکی از ۵ دوره مجاز):
                  </label>
                  <select
                    value={issueDuration}
                    onChange={(e) => setIssueDuration(e.target.value as LicenseDuration)}
                    className="w-full px-3 py-2.5 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-red-500/80 transition"
                  >
                    <option value="1m">یک ماهه (۳۰ روزه)</option>
                    <option value="3m">سه ماهه (۹۰ روزه)</option>
                    <option value="6m">شش ماهه (۱۸۰ روزه)</option>
                    <option value="1y">یک ساله (۳۶۵ روزه - استاندارد)</option>
                    <option value="lifetime">دائمی (نامحدود / مادام‌العمر)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-zinc-300 font-medium mb-1">
                    ایمیل کاربر یا شناسه خریدار (اختیاری):
                  </label>
                  <input
                    type="email"
                    value={issueUserEmail}
                    onChange={(e) => setIssueUserEmail(e.target.value)}
                    placeholder="مثال: customer@gmail.com"
                    dir="ltr"
                    className="w-full px-3 py-2.5 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-red-500/80 transition"
                  />
                  <span className="text-[10px] text-zinc-500 mt-1 block">
                    در صورت خالی بودن، لایسنس به صورت آزاد صادر شده و در زمان اولین فعال‌سازی به حساب کاربر و سخت‌افزار متصل خواهد شد.
                  </span>
                </div>

                <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800 text-[11px] text-zinc-400 space-y-1">
                  <div className="flex items-center gap-1.5 text-zinc-300 font-bold">
                    <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />
                    <span>استانداردهای امنیتی صدور:</span>
                  </div>
                  <p>تولید با CSPRNG امنیتی حداقل ۱۲۸ بیتی • عدم ذخیره متن واضح کلید در دیتابیس • اتصال انحصاری به Keystore در زمان فعال‌سازی</p>
                </div>

                <div className="flex justify-end gap-2 pt-3 border-t border-zinc-800">
                  <button
                    type="button"
                    onClick={() => setShowIssueModal(false)}
                    className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium"
                  >
                    انصراف
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmittingIssue}
                    className="px-5 py-2 rounded-xl bg-gradient-to-r from-red-600 to-amber-600 hover:from-red-500 hover:to-amber-500 text-white font-bold text-xs flex items-center gap-1.5 transition active:scale-95 shadow-md shadow-red-950/40 disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isSubmittingIssue ? 'animate-spin' : ''}`} />
                    <span>{isSubmittingIssue ? 'در حال صدور لایسنس در سرور...' : 'تولید و صدور لایسنس'}</span>
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Quick Action Modal (Renew, Revoke, Suspend, Reactivate) */}
      {actionTargetLicense && actionType && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-md p-5 shadow-2xl space-y-4 text-right">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="flex items-center gap-2">
                {actionType === 'renew' ? (
                  <RotateCw className="w-5 h-5 text-orange-400" />
                ) : actionType === 'reactivate' ? (
                  <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                ) : (
                  <Ban className="w-5 h-5 text-red-500" />
                )}
                <h3 className="font-bold text-white text-sm">
                  {actionType === 'renew'
                    ? 'تمدید اعتبار دوره لایسنس'
                    : actionType === 'reactivate'
                    ? 'فعال‌سازی مجدد لایسنس معلق‌شده'
                    : actionType === 'suspend'
                    ? 'تعلیق موقت لایسنس'
                    : 'ابطال و مسدودسازی دائمی لایسنس'}
                </h3>
              </div>
              <button
                onClick={() => {
                  setActionTargetLicense(null);
                  setActionType(null);
                }}
                className="p-1 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {actionError && (
              <div className="p-3 rounded-xl bg-red-950/70 border border-red-800 text-xs text-red-300 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                <span>{actionError}</span>
              </div>
            )}

            <form onSubmit={handleExecuteQuickAction} className="space-y-3.5 text-xs">
              <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800 space-y-1">
                <span className="text-zinc-500 block text-[11px]">شناسه لایسنس هدف:</span>
                <span className="font-mono text-zinc-200 font-bold block">{actionTargetLicense.id}</span>
                <span className="text-zinc-400 block text-[11px]">مالک: {actionTargetLicense.userEmail || actionTargetLicense.userId || 'آزاد'}</span>
                {actionTargetLicense.boundDeviceId && (
                  <span className="font-mono text-zinc-500 text-[10px] block break-all">سخت‌افزار: {actionTargetLicense.boundDeviceId}</span>
                )}
              </div>

              {actionType === 'renew' ? (
                <div>
                  <label className="block text-zinc-300 font-medium mb-1">
                    مدت زمان تمدید:
                  </label>
                  <select
                    value={renewalDuration}
                    onChange={(e) => setRenewalDuration(e.target.value as LicenseDuration)}
                    className="w-full px-3 py-2.5 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-orange-500/80 transition"
                  >
                    <option value="1m">یک ماه (۳۰ روز)</option>
                    <option value="3m">سه ماه (۹۰ روز)</option>
                    <option value="6m">شش ماه (۱۸۰ روز)</option>
                    <option value="1y">یک سال (۳۶۵ روز - استاندارد)</option>
                    <option value="lifetime">دائمی (نامحدود)</option>
                  </select>
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1">
                      دلیل اقدام (ثبت در گزارش‌های امنیتی):
                    </label>
                    <input
                      type="text"
                      value={actionReason}
                      onChange={(e) => setActionReason(e.target.value)}
                      placeholder={actionType === 'reactivate' ? 'تأیید مجدد هویت کاربر...' : 'تخلف از قوانین، نقض شرایط استفاده یا عدم پرداخت...'}
                      className="w-full px-3 py-2.5 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-red-500/80 transition"
                    />
                  </div>

                  {actionType === 'revoke' && actionTargetLicense.boundDeviceId && (
                    <label className="flex items-center gap-2 p-2 rounded-xl bg-zinc-950 border border-zinc-800/80 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={blacklistDevice}
                        onChange={(e) => setBlacklistDevice(e.target.checked)}
                        className="rounded border-zinc-700 text-red-600 focus:ring-0"
                      />
                      <span className="text-zinc-300 text-[11px]">
                        قرار دادن سخت‌افزار این دستگاه در لیست سیاه (Blacklist)
                      </span>
                    </label>
                  )}
                </>
              )}

              <div className="flex justify-end gap-2 pt-2 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={() => {
                    setActionTargetLicense(null);
                    setActionType(null);
                  }}
                  className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium"
                >
                  انصراف
                </button>
                <button
                  type="submit"
                  disabled={isExecutingAction}
                  className={`px-4 py-2 rounded-xl text-white font-bold text-xs flex items-center gap-1.5 transition active:scale-95 shadow-md ${
                    actionType === 'renew'
                      ? 'bg-orange-600 hover:bg-orange-500 shadow-orange-950/40'
                      : actionType === 'reactivate'
                      ? 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-950/40'
                      : 'bg-red-600 hover:bg-red-500 shadow-red-950/40'
                  } disabled:opacity-50`}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isExecutingAction ? 'animate-spin' : ''}`} />
                  <span>{isExecutingAction ? 'در حال ثبت در سرور...' : 'تأیید و اجرای عملیات'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
