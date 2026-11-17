/**
 * AutoPin Pro - License Admin: Revocation & Blocking Tab (Tab 7)
 *
 * Provides full Phase 2 operational capabilities:
 * - Real-time inspection of blocked, suspended, and revoked licenses
 * - Live execution of Permanent Revocation ('revoke'), Temporary Suspension ('suspend'),
 *   and Reactivation ('reactivate') via Cloud Functions `revokeLicense`
 * - Hardware Device Blacklisting toggle
 * - Audit-logged reasons and administrative timestamps
 */

import React, { useState } from 'react';
import {
  Ban,
  ShieldAlert,
  AlertTriangle,
  Key,
  Smartphone,
  CheckCircle2,
  X,
  Lock,
  RefreshCw,
  Unlock,
  AlertCircle
} from 'lucide-react';
import { LicenseRecord } from '../../../../types/license';
import { licenseAdminService } from '../../../../services/licenseAdminService';

interface RevocationsTabProps {
  licenses: LicenseRecord[];
  isLoading: boolean;
}

export const RevocationsTab: React.FC<RevocationsTabProps> = ({ licenses, isLoading }) => {
  const [showBlockForm, setShowBlockForm] = useState(false);
  const [targetLicenseId, setTargetLicenseId] = useState('');
  const [actionType, setActionType] = useState<'revoke' | 'suspend' | 'reactivate'>('suspend');
  const [blockReason, setBlockReason] = useState('');
  const [blacklistDevice, setBlacklistDevice] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [feedbackSuccess, setFeedbackSuccess] = useState<string | null>(null);

  // Quick Action Modal State
  const [quickActionLicense, setQuickActionLicense] = useState<LicenseRecord | null>(null);
  const [quickActionType, setQuickActionType] = useState<'reactivate' | 'revoke' | null>(null);

  const blockedLicenses = licenses.filter(
    (lic) => lic.isBlocked || lic.status === 'revoked' || lic.status === 'suspended'
  );

  const handleExecuteSecurityAction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetLicenseId.trim()) {
      setFeedbackError('لطفاً شناسه لایسنس هدف را مشخص نمایید.');
      return;
    }

    if (actionType !== 'reactivate' && !blockReason.trim()) {
      setFeedbackError('ثبت دلیل اقدام امنیتی جهت درج در لاگ‌های ممیزی الزامی است.');
      return;
    }

    setIsSubmitting(true);
    setFeedbackError(null);
    setFeedbackSuccess(null);

    try {
      const res = await licenseAdminService.revokeOrSuspendLicense(
        targetLicenseId.trim(),
        actionType,
        blockReason.trim() || undefined,
        blacklistDevice
      );

      const actionText =
        actionType === 'revoke'
          ? 'ابطال دائم'
          : actionType === 'suspend'
          ? 'تعلیق موقت'
          : 'رفع تعلیق و فعال‌سازی مجدد';

      setFeedbackSuccess(`عملیات ${actionText} برای لایسنس ${targetLicenseId} با موفقیت در سرور ثبت شد.`);
      setTargetLicenseId('');
      setBlockReason('');
      setBlacklistDevice(false);
      setTimeout(() => setFeedbackSuccess(null), 6000);
    } catch (err: any) {
      console.warn('License security action halted:', err?.message || err);
      setFeedbackError(licenseAdminService.mapFirebaseErrorToFa(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleQuickReactivate = async (license: LicenseRecord) => {
    setIsSubmitting(true);
    setFeedbackError(null);
    setFeedbackSuccess(null);

    try {
      await licenseAdminService.revokeOrSuspendLicense(
        license.id,
        'reactivate',
        'رفع تعلیق توسط مدیر از پنل سریع'
      );
      setFeedbackSuccess(`لایسنس ${license.id} با موفقیت رفع تعلیق شد و وضعیت آن فعال گردید.`);
      setQuickActionLicense(null);
      setQuickActionType(null);
      setTimeout(() => setFeedbackSuccess(null), 5000);
    } catch (err: any) {
      console.warn('License reactivation halted:', err?.message || err);
      setFeedbackError(licenseAdminService.mapFirebaseErrorToFa(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const openFormForLicense = (licId: string, desiredAction: 'revoke' | 'suspend' | 'reactivate') => {
    setTargetLicenseId(licId);
    setActionType(desiredAction);
    setShowBlockForm(true);
    setFeedbackError(null);
    setFeedbackSuccess(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="p-4 rounded-2xl bg-zinc-900/90 border border-zinc-800/80 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h4 className="text-sm font-bold text-white flex items-center gap-2">
            <Ban className="w-4 h-4 text-red-500" />
            <span>مدیریت لایسنس‌های مسدود و ابطال‌شده</span>
          </h4>
          <p className="text-xs text-zinc-400 mt-1">
            ابطال قطعی، تعلیق موقت و فعال‌سازی مجدد لایسنس‌ها با اجرای مستقیم در پایگاه داده Firebase و همگام‌سازی فوری در اعتبارسنجی کلاینت.
          </p>
        </div>

        <button
          onClick={() => setShowBlockForm(!showBlockForm)}
          className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold transition shrink-0 ${
            showBlockForm
              ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700'
              : 'bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/40'
          }`}
        >
          <Ban className="w-3.5 h-3.5" />
          <span>{showBlockForm ? 'بستن فرم اقدام امنیتی' : 'فرم ابطال و تعلیق لایسنس'}</span>
        </button>
      </div>

      {/* Global Success / Error Alerts */}
      {feedbackSuccess && (
        <div className="p-3.5 rounded-xl bg-emerald-950/60 border border-emerald-800 text-xs text-emerald-300 flex items-center gap-2.5">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{feedbackSuccess}</span>
        </div>
      )}

      {feedbackError && (
        <div className="p-3.5 rounded-xl bg-red-950/60 border border-red-800 text-xs text-red-300 flex items-center gap-2.5">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          <span>{feedbackError}</span>
        </div>
      )}

      {/* Operational Revoke / Suspend / Reactivate Form */}
      {showBlockForm && (
        <form onSubmit={handleExecuteSecurityAction} className="p-5 rounded-2xl bg-zinc-900 border border-red-900/60 space-y-4">
          <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
            <h4 className="text-sm font-bold text-white flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-red-500" />
              <span>اجرای اقدام امنیتی (ابطال / تعلیق / رفع تعلیق)</span>
            </h4>
            <span className="px-2 py-0.5 rounded bg-red-950 text-red-300 text-[10px] font-mono border border-red-800">
              Cloud Function: revokeLicense
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            {/* Target License ID */}
            <div>
              <label className="block text-zinc-400 mb-1 font-medium">شناسه لایسنس هدف (License ID):</label>
              <div className="space-y-1.5">
                <input
                  type="text"
                  value={targetLicenseId}
                  onChange={(e) => setTargetLicenseId(e.target.value)}
                  placeholder="مثال: lic_1730000000_abc"
                  className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-zinc-200 font-mono focus:border-red-500 outline-none transition"
                  required
                />
                {licenses.length > 0 && (
                  <select
                    onChange={(e) => {
                      if (e.target.value) setTargetLicenseId(e.target.value);
                    }}
                    value=""
                    className="w-full px-2.5 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-[11px] text-zinc-400 focus:border-zinc-700 outline-none"
                  >
                    <option value="">انتخاب سریع از میان لایسنس‌های ثبت‌شده...</option>
                    {licenses.map((lic) => (
                      <option key={lic.id} value={lic.id}>
                        {lic.id} — {lic.userEmail || lic.userId || 'بدون ایمیل'} ({lic.status})
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            {/* Action Type */}
            <div>
              <label className="block text-zinc-400 mb-1 font-medium">نوع اقدام امنیتی:</label>
              <select
                value={actionType}
                onChange={(e) => setActionType(e.target.value as any)}
                className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-zinc-200 font-medium focus:border-red-500 outline-none transition"
              >
                <option value="suspend">تعلیق موقت لایسنس (Suspended - قابل فعال‌سازی مجدد)</option>
                <option value="revoke">ابطال دائمی لایسنس (Revoked - غیرقابل بازگشت)</option>
                <option value="reactivate">رفع تعلیق و فعال‌سازی مجدد (Reactivate - بازگشت به حالت عادی)</option>
              </select>

              <div className="mt-2 text-[11px]">
                {actionType === 'revoke' && (
                  <span className="text-red-400 flex items-center gap-1">
                    <Ban className="w-3 h-3" />
                    <span>ابطال دائمی: دسترسی کاربر کاملاً قطع شده و امکان استفاده از این لایسنس نخواهد بود.</span>
                  </span>
                )}
                {actionType === 'suspend' && (
                  <span className="text-amber-400 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" />
                    <span>تعلیق موقت: دسترسی کلاینت متوقف شده اما در آینده قابل رفع تعلیق است.</span>
                  </span>
                )}
                {actionType === 'reactivate' && (
                  <span className="text-emerald-400 flex items-center gap-1">
                    <Unlock className="w-3 h-3" />
                    <span>رفع تعلیق: پرچم مسدودی پاک شده و لایسنس مجدداً معتبر خواهد شد.</span>
                  </span>
                )}
              </div>
            </div>

            {/* Reason */}
            <div className="md:col-span-2">
              <label className="block text-zinc-400 mb-1 font-medium">
                دلیل اقدام امنیتی (جهت ثبت در لاگ‌های حسابرسی Audit Logs):
              </label>
              <input
                type="text"
                value={blockReason}
                onChange={(e) => setBlockReason(e.target.value)}
                placeholder={
                  actionType === 'reactivate'
                    ? 'مثال: رفع تعلیق پس از بررسی مدارک مالکیت...'
                    : 'مثال: تلاش برای نقض قوانین امنیتی، تغییر غیرمجاز سخت‌افزار یا اتمام اشتراک...'
                }
                className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-zinc-200 focus:border-red-500 outline-none transition"
                required={actionType !== 'reactivate'}
              />
            </div>

            {/* Blacklist Hardware Device */}
            {actionType !== 'reactivate' && (
              <div className="md:col-span-2 flex items-center gap-2 p-3 rounded-xl bg-zinc-950/80 border border-zinc-800">
                <input
                  type="checkbox"
                  id="blacklistHwDevice"
                  checked={blacklistDevice}
                  onChange={(e) => setBlacklistDevice(e.target.checked)}
                  className="rounded border-zinc-700 bg-zinc-900 text-red-600 focus:ring-red-500"
                />
                <label htmlFor="blacklistHwDevice" className="text-xs text-zinc-300 cursor-pointer select-none">
                  مسدودسازی شناسه سخت‌افزاری دستگاه متصل در سطح سرور (Blacklist Hardware Device)
                </label>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-zinc-800">
            <button
              type="button"
              onClick={() => setShowBlockForm(false)}
              className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium transition"
            >
              انصراف
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition disabled:opacity-50 ${
                actionType === 'reactivate'
                  ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                  : actionType === 'suspend'
                  ? 'bg-amber-600 hover:bg-amber-500 text-white'
                  : 'bg-red-600 hover:bg-red-500 text-white'
              }`}
            >
              {isSubmitting ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>در حال ارسال دستور به سرور...</span>
                </>
              ) : (
                <>
                  <ShieldAlert className="w-3.5 h-3.5" />
                  <span>
                    {actionType === 'revoke'
                      ? 'اجرای ابطال قطعی'
                      : actionType === 'suspend'
                      ? 'اجرای تعلیق موقت'
                      : 'تأیید و رفع تعلیق'}
                  </span>
                </>
              )}
            </button>
          </div>
        </form>
      )}

      {/* Blocked Licenses Table */}
      <div className="rounded-2xl bg-zinc-900/90 border border-zinc-800/80 overflow-hidden">
        <div className="p-4 bg-zinc-950/60 border-b border-zinc-800/80 flex items-center justify-between">
          <h4 className="text-xs font-bold text-zinc-300 flex items-center gap-2">
            <Ban className="w-3.5 h-3.5 text-red-400" />
            <span>فهرست لایسنس‌های مسدود و تعلیق‌شده در سیستم</span>
          </h4>
          <span className="text-[11px] font-mono text-zinc-500">{blockedLicenses.length} لایسنس</span>
        </div>

        {isLoading ? (
          <div className="py-16 text-center text-zinc-500 text-xs font-mono">
            در حال بارگذاری لایسنس‌های مسدود...
          </div>
        ) : blockedLicenses.length === 0 ? (
          <div className="py-16 text-center text-zinc-500 text-xs">
            خوشبختانه هیچ لایسنسی در وضعیت مسدود یا لغو شده قرار ندارد.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead className="bg-zinc-950/80 text-zinc-400 border-b border-zinc-800/80 font-medium">
                <tr>
                  <th className="px-4 py-3">شناسه لایسنس</th>
                  <th className="px-4 py-3">کاربر</th>
                  <th className="px-4 py-3">سخت‌افزار قفل‌شده</th>
                  <th className="px-4 py-3">دلیل اقدام امنیتی</th>
                  <th className="px-4 py-3">وضعیت</th>
                  <th className="px-4 py-3 text-center">عملیات سریع</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {blockedLicenses.map((lic) => {
                  const isRevoked = lic.status === 'revoked';
                  const isSuspended = lic.status === 'suspended';

                  return (
                    <tr key={lic.id} className="hover:bg-zinc-800/40 transition">
                      <td className="px-4 py-3.5 font-mono text-[11px] text-zinc-300 font-bold">
                        {lic.id}
                      </td>

                      <td className="px-4 py-3.5 text-zinc-300">
                        {lic.userEmail || lic.userId || '—'}
                      </td>

                      <td className="px-4 py-3.5 font-mono text-[11px] text-zinc-400">
                        {lic.boundDeviceId ? `${lic.boundDeviceId.slice(0, 16)}...` : 'متصل‌نشده'}
                      </td>

                      <td className="px-4 py-3.5 text-red-400 max-w-[240px] truncate" title={lic.blockReason}>
                        {lic.blockReason || 'مسدودسازی امنیتی توسط مدیر'}
                      </td>

                      <td className="px-4 py-3.5">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border ${
                            isRevoked
                              ? 'bg-red-950 text-red-400 border-red-800'
                              : 'bg-amber-950 text-amber-400 border-amber-800'
                          }`}
                        >
                          <Ban className="w-3 h-3" />
                          <span>{isRevoked ? 'ابطال دائم' : 'معلق موقت'}</span>
                        </span>
                      </td>

                      <td className="px-4 py-3.5 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          {/* Reactivate Button */}
                          <button
                            onClick={() => handleQuickReactivate(lic)}
                            disabled={isSubmitting}
                            title="رفع تعلیق و فعال‌سازی مجدد"
                            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 border border-emerald-500/40 text-[11px] font-medium transition disabled:opacity-50"
                          >
                            <Unlock className="w-3 h-3" />
                            <span>رفع تعلیق</span>
                          </button>

                          {/* If suspended, provide full revoke */}
                          {isSuspended && (
                            <button
                              onClick={() => openFormForLicense(lic.id, 'revoke')}
                              title="ابطال دائمی قطعی"
                              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/40 text-[11px] font-medium transition"
                            >
                              <Ban className="w-3 h-3" />
                              <span>ابطال قطعی</span>
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
    </div>
  );
};
