/**
 * AutoPin Pro - License Admin: License Hardware Transfer Tab (Tab 5)
 *
 * Operational Phase 2 Capabilities:
 * - Real-time inspection of hardware migration/transfer audit logs
 * - Live execution of hardware transfer via Cloud Functions `transferLicenseDevice`
 * - Selection from active licenses and pending user device requests
 * - Enforces zero dual-device usage: old hardware is atomically unbound while
 *   remaining license duration is preserved on new device
 */

import React, { useState } from 'react';
import {
  Repeat,
  ShieldCheck,
  AlertTriangle,
  Smartphone,
  Lock,
  Calendar,
  CheckCircle2,
  RefreshCw,
  AlertCircle,
  ArrowRight,
  Info
} from 'lucide-react';
import { LicenseRecord, LicenseRequestRecord, LicenseAuditLogRecord } from '../../../../types/license';
import { licenseAdminService } from '../../../../services/licenseAdminService';

interface TransfersTabProps {
  logs: LicenseAuditLogRecord[];
  licenses?: LicenseRecord[];
  requests?: LicenseRequestRecord[];
  isLoading: boolean;
}

export const TransfersTab: React.FC<TransfersTabProps> = ({
  logs,
  licenses = [],
  requests = [],
  isLoading
}) => {
  const [showTransferForm, setShowTransferForm] = useState(false);

  // Form state
  const [selectedLicenseId, setSelectedLicenseId] = useState('');
  const [targetDevicePublicKey, setTargetDevicePublicKey] = useState('');
  const [targetDeviceModel, setTargetDeviceModel] = useState('');
  const [transferReason, setTransferReason] = useState('');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedbackSuccess, setFeedbackSuccess] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  const transferLogs = logs.filter(
    (l) => l.action === 'transfer' || (l.details && l.details.toLowerCase().includes('transfer'))
  );

  const handleSelectPendingRequest = (req: LicenseRequestRecord) => {
    setTargetDevicePublicKey(req.devicePublicKey || '');
    setTargetDeviceModel(req.deviceModel || 'Android Device');
    if (req.notes) {
      setTransferReason(`انتقال به درخواست کاربر (${req.requestToken}): ${req.notes}`);
    } else {
      setTransferReason(`انتقال به سخت‌افزار جدید بر اساس درخواست ${req.requestToken}`);
    }
  };

  const handleExecuteTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedLicenseId.trim()) {
      setFeedbackError('لطفاً لایسنس مبدأ جهت انتقال را مشخص نمایید.');
      return;
    }

    if (!targetDevicePublicKey.trim()) {
      setFeedbackError('کلید عمومی سخت‌افزاری دستگاه جدید الزامی است.');
      return;
    }

    if (!transferReason.trim()) {
      setFeedbackError('ثبت دلیل مستند انتقال جهت حفظ امنیت و گزارش‌های ممیزی الزامی است.');
      return;
    }

    setIsSubmitting(true);
    setFeedbackError(null);
    setFeedbackSuccess(null);

    try {
      const res = await licenseAdminService.transferLicenseDevice({
        licenseId: selectedLicenseId.trim(),
        newDevicePublicKey: targetDevicePublicKey.trim(),
        newDeviceModel: targetDeviceModel.trim() || undefined,
        reason: transferReason.trim(),
        challenge: 'ADMIN_OVERRIDE',
        signature: 'ADMIN_VERIFIED'
      });

      setFeedbackSuccess(
        `انتقال لایسنس ${selectedLicenseId} با موفقیت به دستگاه جدید (${res.newDeviceId}) انجام شد. دستگاه قبلی ابطال گردید.`
      );
      setSelectedLicenseId('');
      setTargetDevicePublicKey('');
      setTargetDeviceModel('');
      setTransferReason('');
      setTimeout(() => setFeedbackSuccess(null), 7000);
    } catch (err: any) {
      console.warn('License transfer halted:', err?.message || err);
      setFeedbackError(licenseAdminService.mapFirebaseErrorToFa(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Policy and Rules Card */}
      <div className="p-5 rounded-2xl bg-zinc-900/90 border border-zinc-800/80 space-y-4">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-purple-600/20 border border-purple-500/40 flex items-center justify-center text-purple-400">
              <Repeat className="w-4 h-4" />
            </div>
            <div>
              <h4 className="text-sm font-bold text-white">قوانین و استانداردهای انتقال لایسنس سخت‌افزاری</h4>
              <span className="text-[11px] text-zinc-500">حفاظت ضد کلونینگ و مهاجرت ایمن به دستگاه جدید</span>
            </div>
          </div>

          <button
            onClick={() => setShowTransferForm(!showTransferForm)}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold transition shrink-0 ${
              showTransferForm
                ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700'
                : 'bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 border border-purple-500/40'
            }`}
          >
            <Repeat className="w-3.5 h-3.5" />
            <span>{showTransferForm ? 'بستن فرم انتقال' : 'فرم ثبت انتقال لایسنس'}</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800/80 space-y-1.5">
            <div className="font-bold text-zinc-200 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-purple-400" />
              <span>ابطال بلادرنگ دستگاه قبلی</span>
            </div>
            <p className="text-zinc-500 text-[11px] leading-relaxed">
              با انتقال لایسنس به سخت‌افزار جدید، اتصال دستگاه قبلی به صورت اتمیک قطع شده و وضعیت آن به unbound_transfer تغییر می‌یابد.
            </p>
          </div>

          <div className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800/80 space-y-1.5">
            <div className="font-bold text-zinc-200 flex items-center gap-2">
              <Lock className="w-4 h-4 text-purple-400" />
              <span>احراز اصالت سخت‌افزار مقصد</span>
            </div>
            <p className="text-zinc-500 text-[11px] leading-relaxed">
              شناسه سخت‌افزاری دستگاه جدید بر اساس کلید عمومی استاندارد ECDSA P-256 در سرور محاسبه می‌شود.
            </p>
          </div>

          <div className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800/80 space-y-1.5">
            <div className="font-bold text-zinc-200 flex items-center gap-2">
              <Calendar className="w-4 h-4 text-purple-400" />
              <span>حفظ باقیمانده دوره اعتبار</span>
            </div>
            <p className="text-zinc-500 text-[11px] leading-relaxed">
              انتقال لایسنس هیچ تغییری در تاریخ انقضای لایسنس ایجاد نکرده و باقیمانده روزهای اعتبار دقیقاً به سخت‌افزار جدید منتقل می‌شود.
            </p>
          </div>
        </div>
      </div>

      {/* Global Alerts */}
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

      {/* Transfer Form Structure (Operational Phase 2) */}
      {showTransferForm && (
        <form onSubmit={handleExecuteTransfer} className="p-5 rounded-2xl bg-zinc-900 border border-purple-900/50 space-y-4">
          <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
            <h4 className="text-sm font-bold text-white flex items-center gap-2">
              <Repeat className="w-4 h-4 text-purple-400" />
              <span>فرم انتقال لایسنس به سخت‌افزار جدید (Cloud Function: transferLicenseDevice)</span>
            </h4>
            <span className="px-2 py-0.5 rounded bg-purple-950 text-purple-300 text-[10px] font-mono border border-purple-800">
              Atomic Firestore Transaction
            </span>
          </div>

          {/* Pending Requests Shortcut */}
          {requests.filter((r) => r.status === 'pending').length > 0 && (
            <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800 space-y-2">
              <div className="text-[11px] text-zinc-400 font-medium flex items-center gap-1.5">
                <Info className="w-3.5 h-3.5 text-purple-400" />
                <span>درخواست‌های معلق کاربران (امکان انتخاب خودکار مشخصات دستگاه جدید):</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {requests
                  .filter((r) => r.status === 'pending')
                  .slice(0, 4)
                  .map((req) => (
                    <button
                      key={req.id}
                      type="button"
                      onClick={() => handleSelectPendingRequest(req)}
                      className="px-2.5 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-[11px] text-zinc-300 hover:text-white transition flex items-center gap-1.5"
                    >
                      <Smartphone className="w-3 h-3 text-purple-400" />
                      <span>{req.userEmail || req.requestToken}</span>
                      <span className="text-[10px] text-zinc-500 font-mono">({req.deviceModel || 'دستگاه جدید'})</span>
                    </button>
                  ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            {/* Origin License */}
            <div>
              <label className="block text-zinc-400 mb-1 font-medium">شناسه لایسنس مبدا (License ID):</label>
              <div className="space-y-1.5">
                <input
                  type="text"
                  value={selectedLicenseId}
                  onChange={(e) => setSelectedLicenseId(e.target.value)}
                  placeholder="lic_1730000000_abc"
                  className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-zinc-200 font-mono focus:border-purple-500 outline-none transition"
                  required
                />
                {licenses.length > 0 && (
                  <select
                    onChange={(e) => {
                      if (e.target.value) setSelectedLicenseId(e.target.value);
                    }}
                    value=""
                    className="w-full px-2.5 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-[11px] text-zinc-400 focus:border-zinc-700 outline-none"
                  >
                    <option value="">انتخاب سریع از میان لایسنس‌های فعال...</option>
                    {licenses
                      .filter((l) => !l.isBlocked && l.status === 'active')
                      .map((lic) => (
                        <option key={lic.id} value={lic.id}>
                          {lic.id} — {lic.userEmail || 'بدون ایمیل'} (دستگاه: {lic.boundDeviceId ? lic.boundDeviceId.slice(0, 10) + '...' : 'متصل‌نشده'})
                        </option>
                      ))}
                  </select>
                )}
              </div>
            </div>

            {/* Target Device Model */}
            <div>
              <label className="block text-zinc-400 mb-1 font-medium">مدل سخت‌افزار مقصد (اختیاری):</label>
              <input
                type="text"
                value={targetDeviceModel}
                onChange={(e) => setTargetDeviceModel(e.target.value)}
                placeholder="مثال: Samsung Galaxy A54 (Android 14)"
                className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-zinc-200 focus:border-purple-500 outline-none transition"
              />
            </div>

            {/* Target Device Public Key */}
            <div className="md:col-span-2">
              <label className="block text-zinc-400 mb-1 font-medium">
                کلید عمومی سخت‌افزاری دستگاه جدید (ECDSA P-256 Public Key):
              </label>
              <textarea
                value={targetDevicePublicKey}
                onChange={(e) => setTargetDevicePublicKey(e.target.value)}
                rows={2}
                placeholder="MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE..."
                className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-zinc-200 font-mono text-[11px] focus:border-purple-500 outline-none transition resize-none"
                required
              />
            </div>

            {/* Reason */}
            <div className="md:col-span-2">
              <label className="block text-zinc-400 mb-1 font-medium">دلیل انتقال و تایید مالکیت:</label>
              <input
                type="text"
                value={transferReason}
                onChange={(e) => setTransferReason(e.target.value)}
                placeholder="مثال: تعویض گوشی کاربر به دلیل سوختن برد سخت‌افزاری و تأیید هویت کاربری..."
                className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-zinc-200 focus:border-purple-500 outline-none transition"
                required
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-zinc-800">
            <button
              type="button"
              onClick={() => setShowTransferForm(false)}
              className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium transition"
            >
              انصراف
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold transition disabled:opacity-50"
            >
              {isSubmitting ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>در حال انجام انتقال اتمیک...</span>
                </>
              ) : (
                <>
                  <Repeat className="w-3.5 h-3.5" />
                  <span>تأیید و اجرای انتقال لایسنس</span>
                </>
              )}
            </button>
          </div>
        </form>
      )}

      {/* Transfer History Table */}
      <div className="rounded-2xl bg-zinc-900/90 border border-zinc-800/80 overflow-hidden">
        <div className="p-4 bg-zinc-950/60 border-b border-zinc-800/80 flex items-center justify-between">
          <h4 className="text-xs font-bold text-zinc-300 flex items-center gap-2">
            <Repeat className="w-3.5 h-3.5 text-purple-400" />
            <span>تاریخچه رویدادهای انتقال سخت‌افزار (ثبت‌شده در لاگ‌های امنیتی)</span>
          </h4>
          <span className="text-[11px] font-mono text-zinc-500">{transferLogs.length} رکورد</span>
        </div>

        {isLoading ? (
          <div className="py-16 text-center text-zinc-500 text-xs font-mono">
            در حال جستجوی رکوردهای انتقال...
          </div>
        ) : transferLogs.length === 0 ? (
          <div className="py-16 text-center text-zinc-500 text-xs">
            تاکنون هیچ درخواست یا رویداد انتقالی در سامانه رخ نداده است.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead className="bg-zinc-950/80 text-zinc-400 border-b border-zinc-800/80 font-medium">
                <tr>
                  <th className="px-4 py-3">زمان انتقال</th>
                  <th className="px-4 py-3">لایسنس هدف</th>
                  <th className="px-4 py-3">مدیر اقدام‌کننده</th>
                  <th className="px-4 py-3">توضیحات و جزئیات انتقال</th>
                  <th className="px-4 py-3">وضعیت نتیجه</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {transferLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-zinc-800/40 transition">
                    <td className="px-4 py-3.5 font-mono text-[11px] text-zinc-400">
                      {log.timestamp ? new Date(log.timestamp).toLocaleString('fa-IR') : '—'}
                    </td>
                    <td className="px-4 py-3.5 font-mono text-[11px] text-emerald-400 font-bold">
                      {log.targetId}
                    </td>
                    <td className="px-4 py-3.5 text-zinc-300">
                      {log.adminEmail || log.adminId || 'مدیر سیستم'}
                    </td>
                    <td className="px-4 py-3.5 text-zinc-400 max-w-[280px] truncate" title={log.details}>
                      {log.details || 'انتقال سخت‌افزار تایید شد'}
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-purple-950 text-purple-300 border border-purple-800">
                        <CheckCircle2 className="w-3 h-3 text-purple-400" />
                        <span>موفق</span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
