/**
 * AutoPin Pro - License Admin: License Renewal Tab (Operational Phase 2)
 *
 * Real-time view of licenses nearing expiration (< 30 days) and expired licenses:
 * - Live expiration countdown / urgency levels
 * - Calculation of new expiration across multiple duration tiers (1m, 3m, 6m, 1y, lifetime)
 * - Preserves existing hardware device binding strictly
 * - Operational execution via Server-Side Cloud Function `renewLicense`
 * - Detailed audit logging of administrator identity, timestamp, and new expiry
 */

import React, { useState } from 'react';
import {
  RotateCw,
  Clock,
  Calendar,
  AlertTriangle,
  CheckCircle2,
  Key,
  Smartphone,
  X,
  RefreshCw,
  Check
} from 'lucide-react';
import { LicenseRecord, LicenseDuration } from '../../../../types/license';
import { licenseAdminService } from '../../../../services/licenseAdminService';

interface RenewalsTabProps {
  licenses: LicenseRecord[];
  isLoading: boolean;
}

export const RenewalsTab: React.FC<RenewalsTabProps> = ({ licenses, isLoading }) => {
  const [selectedLicenseForRenewal, setSelectedLicenseForRenewal] = useState<LicenseRecord | null>(null);
  const [renewalDuration, setRenewalDuration] = useState<LicenseDuration>('1y');
  const [isSubmittingRenewal, setIsSubmittingRenewal] = useState(false);
  const [renewalError, setRenewalError] = useState<string | null>(null);
  const [renewalSuccess, setRenewalSuccess] = useState<string | null>(null);

  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  // Filter licenses nearing expiration (< 30 days) or already expired, but not blocked
  const expiringOrExpiredLicenses = licenses.filter((lic) => {
    if (lic.isBlocked || lic.status === 'revoked') return false;
    return lic.expiresAt < now + thirtyDaysMs;
  });

  const getDurationMs = (dur: LicenseDuration) => {
    switch (dur) {
      case '1m': return 30 * 24 * 60 * 60 * 1000;
      case '3m': return 90 * 24 * 60 * 60 * 1000;
      case '6m': return 180 * 24 * 60 * 60 * 1000;
      case 'lifetime': return 100 * 365 * 24 * 60 * 60 * 1000;
      case '1y':
      default:
        return 365 * 24 * 60 * 60 * 1000;
    }
  };

  const calculateNewExpiration = (currentExpiresAt: number, dur: LicenseDuration) => {
    const base = currentExpiresAt > now ? currentExpiresAt : now;
    return base + getDurationMs(dur);
  };

  const handleExecuteRenewal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedLicenseForRenewal) return;

    setIsSubmittingRenewal(true);
    setRenewalError(null);

    try {
      const res = await licenseAdminService.renewLicense(
        selectedLicenseForRenewal.id,
        renewalDuration
      );

      const newDateFa = new Date(res.newExpiry).toLocaleDateString('fa-IR');
      setRenewalSuccess(`لایسنس ${selectedLicenseForRenewal.id} با موفقیت تمدید شد. تاریخ انقضای جدید: ${newDateFa}`);
      setSelectedLicenseForRenewal(null);
      setTimeout(() => setRenewalSuccess(null), 4500);
    } catch (err: any) {
      console.warn('License renewal halted:', err?.message || err);
      setRenewalError(err?.message || 'خطا در تمدید لایسنس سمت سرور.');
    } finally {
      setIsSubmittingRenewal(false);
    }
  };

  return (
    <div className="space-y-6" dir="rtl">
      {/* Success Notification */}
      {renewalSuccess && (
        <div className="p-3.5 rounded-2xl bg-emerald-950/70 border border-emerald-800 text-emerald-300 text-xs flex items-center gap-2.5 shadow-md animate-in fade-in">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{renewalSuccess}</span>
        </div>
      )}

      {/* Top Banner */}
      <div className="p-4 rounded-2xl bg-zinc-900/90 border border-zinc-800/80 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h4 className="text-sm font-bold text-white flex items-center gap-2">
            <RotateCw className="w-4 h-4 text-orange-400" />
            <span>مرکز مدیریت تمدید دوره لایسنس‌ها</span>
          </h4>
          <p className="text-xs text-zinc-400 mt-1">
            تمدید اعتبار لایسنس‌های منقضی‌شده یا در آستانه انقضا با حفظ کامل اتصال به سخت‌افزار قبلی.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span className="px-3 py-1.5 rounded-xl bg-orange-950/80 text-orange-300 border border-orange-800 text-xs font-mono">
            {expiringOrExpiredLicenses.length} لایسنس نیازمند اقدام
          </span>
        </div>
      </div>

      {/* Renewals Table */}
      <div className="rounded-2xl bg-zinc-900/90 border border-zinc-800/80 overflow-hidden">
        {isLoading ? (
          <div className="py-16 text-center text-zinc-500 text-xs font-mono">
            در حال ارزیابی تاریخ‌های انقضا...
          </div>
        ) : expiringOrExpiredLicenses.length === 0 ? (
          <div className="py-16 text-center text-zinc-500 text-xs">
            در حال حاضر هیچ لایسنسی در آستانه انقضا یا منقضی وجود ندارد.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead className="bg-zinc-950/80 text-zinc-400 border-b border-zinc-800/80 font-medium">
                <tr>
                  <th className="px-4 py-3">شناسه لایسنس</th>
                  <th className="px-4 py-3">کاربر / ایمیل</th>
                  <th className="px-4 py-3">دستگاه متصل</th>
                  <th className="px-4 py-3">تاریخ انقضا</th>
                  <th className="px-4 py-3">وضعیت باقیمانده</th>
                  <th className="px-4 py-3 text-center">عملیات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {expiringOrExpiredLicenses.map((lic) => {
                  const isExpired = lic.expiresAt < now;
                  const daysLeft = Math.ceil((lic.expiresAt - now) / (1000 * 60 * 60 * 24));

                  return (
                    <tr key={lic.id} className="hover:bg-zinc-800/40 transition">
                      <td className="px-4 py-3.5 font-mono text-[11px] text-zinc-300 font-bold">
                        {lic.id}
                      </td>

                      <td className="px-4 py-3.5 text-zinc-300">
                        {lic.userEmail || lic.userId || '—'}
                      </td>

                      <td className="px-4 py-3.5 font-mono text-[11px] text-zinc-400">
                        {lic.boundDeviceId ? `${lic.boundDeviceId.slice(0, 14)}...` : 'هنوز متصل نشده'}
                      </td>

                      <td className="px-4 py-3.5 font-mono text-[11px] text-zinc-400">
                        {lic.expiresAt > 0 ? new Date(lic.expiresAt).toLocaleDateString('fa-IR') : '—'}
                      </td>

                      <td className="px-4 py-3.5">
                        {isExpired ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-red-950/80 text-red-400 border border-red-800">
                            <Clock className="w-3 h-3" />
                            <span>منقضی شده</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-orange-950/80 text-orange-400 border border-orange-800">
                            <AlertTriangle className="w-3 h-3" />
                            <span>{daysLeft} روز باقیمانده</span>
                          </span>
                        )}
                      </td>

                      <td className="px-4 py-3.5 text-center">
                        <button
                          onClick={() => {
                            setSelectedLicenseForRenewal(lic);
                            setRenewalError(null);
                          }}
                          className="px-3 py-1.5 rounded-lg bg-orange-600/20 hover:bg-orange-600/30 text-orange-300 border border-orange-500/40 text-[11px] font-medium transition active:scale-95 flex items-center gap-1 mx-auto"
                        >
                          <RotateCw className="w-3 h-3" />
                          <span>فرم تمدید</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Operational Renewal Modal */}
      {selectedLicenseForRenewal && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-lg p-6 shadow-2xl space-y-4 text-right">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="flex items-center gap-2">
                <RotateCw className="w-5 h-5 text-orange-400" />
                <h3 className="font-bold text-white text-sm">تمدید اعتبار لایسنس (عملیاتی Firebase)</h3>
              </div>
              <button
                onClick={() => setSelectedLicenseForRenewal(null)}
                className="p-1 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {renewalError && (
              <div className="p-3 rounded-xl bg-red-950/70 border border-red-800 text-xs text-red-300 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                <span>{renewalError}</span>
              </div>
            )}

            <form onSubmit={handleExecuteRenewal} className="space-y-3.5 text-xs">
              <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800 space-y-1">
                <span className="text-zinc-500 block text-[11px]">شناسه لایسنس هدف:</span>
                <span className="font-mono text-zinc-200 font-bold">{selectedLicenseForRenewal.id}</span>
                <span className="text-zinc-400 block text-[11px]">مالک: {selectedLicenseForRenewal.userEmail || selectedLicenseForRenewal.userId || 'آزاد'}</span>
                {selectedLicenseForRenewal.boundDeviceId && (
                  <span className="font-mono text-emerald-400 text-[10px] block break-all">سخت‌افزار متصل (حفظ می‌شود): {selectedLicenseForRenewal.boundDeviceId}</span>
                )}
              </div>

              <div>
                <label className="block text-zinc-300 font-medium mb-1">
                  مدت زمان تمدید مورد نظر:
                </label>
                <select
                  value={renewalDuration}
                  onChange={(e) => setRenewalDuration(e.target.value as LicenseDuration)}
                  className="w-full px-3 py-2.5 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-orange-500/80 transition"
                >
                  <option value="1m">یک ماهه (۳۰ روز)</option>
                  <option value="3m">سه ماهه (۹۰ روز)</option>
                  <option value="6m">شش ماهه (۱۸۰ روز)</option>
                  <option value="1y">یک ساله (۳۶۵ روز - استاندارد)</option>
                  <option value="lifetime">دائمی (نامحدود / مادام‌العمر)</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800">
                  <span className="text-zinc-500 block text-[11px] mb-1">انقضای فعلی:</span>
                  <span className="font-mono text-zinc-300">
                    {selectedLicenseForRenewal.expiresAt > 0
                      ? new Date(selectedLicenseForRenewal.expiresAt).toLocaleDateString('fa-IR')
                      : 'نامشخص'}
                  </span>
                </div>

                <div className="p-3 rounded-xl bg-zinc-950 border border-emerald-900/60">
                  <span className="text-emerald-500 block text-[11px] mb-1">انقضای جدید پس از تمدید:</span>
                  <span className="font-mono text-emerald-400 font-bold">
                    {new Date(calculateNewExpiration(selectedLicenseForRenewal.expiresAt, renewalDuration)).toLocaleDateString('fa-IR')}
                  </span>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={() => setSelectedLicenseForRenewal(null)}
                  className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium"
                >
                  انصراف
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingRenewal}
                  className="px-4 py-2 rounded-xl bg-orange-600 hover:bg-orange-500 text-white font-bold text-xs flex items-center gap-1.5 transition active:scale-95 shadow-md shadow-orange-950/40 disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isSubmittingRenewal ? 'animate-spin' : ''}`} />
                  <span>{isSubmittingRenewal ? 'در حال ثبت تمدید در سرور...' : 'تأیید و اجرای تمدید'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
