/**
 * AutoPin Pro - License Admin: Activation Requests Tab (Operational Phase 2)
 *
 * Real-time view of hardware activation requests submitted by devices:
 * - Real user requests from Firestore
 * - Inspect Device ID & Hardware Keystore TEE Public Key
 * - Approve or Reject requests via Server-Side Cloud Function `reviewLicenseRequest`
 * - Strict prevention of multiple reviews on already processed requests
 * - Audit logging with Admin UID, timestamp, and review notes
 */

import React, { useState } from 'react';
import {
  FileText,
  Search,
  CheckCircle2,
  XCircle,
  Eye,
  Key,
  Smartphone,
  Copy,
  Check,
  X,
  AlertTriangle,
  Clock,
  Send,
  RefreshCw,
  ShieldCheck
} from 'lucide-react';
import { LicenseRequestRecord } from '../../../../types/license';
import { licenseAdminService } from '../../../../services/licenseAdminService';

interface RequestsTabProps {
  requests: LicenseRequestRecord[];
  isLoading: boolean;
}

export const RequestsTab: React.FC<RequestsTabProps> = ({ requests, isLoading }) => {
  const [filterStatus, setFilterStatus] = useState<'all' | 'pending' | 'approved' | 'rejected'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedReq, setSelectedReq] = useState<LicenseRequestRecord | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  // Review modal state
  const [reviewingReq, setReviewingReq] = useState<LicenseRequestRecord | null>(null);
  const [reviewAction, setReviewAction] = useState<'approved' | 'rejected'>('approved');
  const [reviewNotes, setReviewNotes] = useState('');
  const [isSubmittingReview, setIsSubmittingReview] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewSuccess, setReviewSuccess] = useState<string | null>(null);

  const filteredRequests = requests.filter((req) => {
    if (filterStatus !== 'all' && req.status !== filterStatus) return false;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase().trim();
    return (
      req.id.toLowerCase().includes(q) ||
      (req.deviceId && req.deviceId.toLowerCase().includes(q)) ||
      (req.userEmail && req.userEmail.toLowerCase().includes(q)) ||
      (req.deviceModel && req.deviceModel.toLowerCase().includes(q)) ||
      (req.requestToken && req.requestToken.toLowerCase().includes(q))
    );
  });

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  const openReviewModal = (req: LicenseRequestRecord, action: 'approved' | 'rejected') => {
    if (req.status !== 'pending') return;
    setReviewingReq(req);
    setReviewAction(action);
    setReviewNotes('');
    setReviewError(null);
  };

  const handleExecuteReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reviewingReq) return;

    setIsSubmittingReview(true);
    setReviewError(null);

    try {
      await licenseAdminService.reviewLicenseRequest(
        reviewingReq.id,
        reviewAction,
        reviewNotes.trim()
      );

      setReviewSuccess(
        `درخواست با موفقیت ${reviewAction === 'approved' ? 'تأیید' : 'رد'} شد و در لاگ‌های امنیتی ثبت گردید.`
      );
      setReviewingReq(null);
      setSelectedReq(null);
      setTimeout(() => setReviewSuccess(null), 4000);
    } catch (err: any) {
      console.warn('License request review halted:', err?.message || err);
      const msg = err?.message || 'خطا در برقراری ارتباط با سرور یا عدم وجود مجوز مدیریتی.';
      setReviewError(msg);
    } finally {
      setIsSubmittingReview(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Success Notification */}
      {reviewSuccess && (
        <div className="p-3.5 rounded-2xl bg-emerald-950/70 border border-emerald-800 text-emerald-300 text-xs flex items-center gap-2.5 shadow-md animate-in fade-in">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{reviewSuccess}</span>
        </div>
      )}

      {/* Search and Filter */}
      <div className="p-4 rounded-2xl bg-zinc-900/90 border border-zinc-800/80 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-zinc-400 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="جستجو بر اساس شناسه درخواست، کد درخواست، شناسه سخت‌افزار، مدل دستگاه یا ایمیل کاربر..."
            className="w-full pl-4 pr-10 py-2.5 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-red-500/60 transition"
          />
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto">
          <button
            onClick={() => setFilterStatus('all')}
            className={`px-3 py-1.5 rounded-xl text-xs font-medium transition ${
              filterStatus === 'all'
                ? 'bg-zinc-800 text-white border border-zinc-700'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
            }`}
          >
            همه ({requests.length})
          </button>
          <button
            onClick={() => setFilterStatus('pending')}
            className={`px-3 py-1.5 rounded-xl text-xs font-medium transition ${
              filterStatus === 'pending'
                ? 'bg-amber-950 text-amber-400 border border-amber-800'
                : 'text-zinc-400 hover:text-amber-400 hover:bg-zinc-800/50'
            }`}
          >
            در انتظار بررسی ({requests.filter((r) => r.status === 'pending').length})
          </button>
          <button
            onClick={() => setFilterStatus('approved')}
            className={`px-3 py-1.5 rounded-xl text-xs font-medium transition ${
              filterStatus === 'approved'
                ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                : 'text-zinc-400 hover:text-emerald-400 hover:bg-zinc-800/50'
            }`}
          >
            تأیید شده ({requests.filter((r) => r.status === 'approved' || r.status === 'fulfilled').length})
          </button>
          <button
            onClick={() => setFilterStatus('rejected')}
            className={`px-3 py-1.5 rounded-xl text-xs font-medium transition ${
              filterStatus === 'rejected'
                ? 'bg-red-950 text-red-400 border border-red-800'
                : 'text-zinc-400 hover:text-red-400 hover:bg-zinc-800/50'
            }`}
          >
            رد شده ({requests.filter((r) => r.status === 'rejected').length})
          </button>
        </div>
      </div>

      {/* Requests Table */}
      <div className="rounded-2xl bg-zinc-900/90 border border-zinc-800/80 overflow-hidden">
        {isLoading ? (
          <div className="py-16 text-center text-zinc-500 text-xs font-mono">
            در حال بارگذاری درخواست‌های فعال‌سازی از Firestore...
          </div>
        ) : filteredRequests.length === 0 ? (
          <div className="py-16 text-center text-zinc-500 text-xs">
            {searchQuery
              ? 'درخواستی با مشخصات جستجو شده یافت نشد.'
              : 'هیچ درخواست فعال‌سازی ثبت نشده است.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead className="bg-zinc-950/80 text-zinc-400 border-b border-zinc-800/80 font-medium">
                <tr>
                  <th className="px-4 py-3">کد / شناسه درخواست</th>
                  <th className="px-4 py-3">دستگاه متقاضی (Device ID)</th>
                  <th className="px-4 py-3">مدل دستگاه</th>
                  <th className="px-4 py-3">کاربر / ایمیل</th>
                  <th className="px-4 py-3">تاریخ ثبت درخواست</th>
                  <th className="px-4 py-3">وضعیت</th>
                  <th className="px-4 py-3 text-center">عملیات مدیریت</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {filteredRequests.map((req) => (
                  <tr key={req.id} className="hover:bg-zinc-800/40 transition">
                    <td className="px-4 py-3.5 font-mono text-[11px] text-zinc-300 font-bold">
                      <div className="flex flex-col">
                        <span className="text-amber-400">{req.requestToken || req.id.slice(0, 14) + '...'}</span>
                        <span className="text-[9px] text-zinc-500">{req.id}</span>
                      </div>
                    </td>

                    <td className="px-4 py-3.5 font-mono text-[11px] text-zinc-400">
                      <span title={req.deviceId}>{req.deviceId ? req.deviceId.slice(0, 16) + '...' : '—'}</span>
                    </td>

                    <td className="px-4 py-3.5 text-zinc-300">
                      {req.deviceModel || 'دستگاه اندروید'}
                    </td>

                    <td className="px-4 py-3.5 text-zinc-400">
                      {req.userEmail || (req.userId ? req.userId.slice(0, 8) + '...' : 'ناشناس')}
                    </td>

                    <td className="px-4 py-3.5 text-[11px] font-mono text-zinc-400">
                      {req.requestedAt ? new Date(req.requestedAt).toLocaleDateString('fa-IR') : '—'}
                    </td>

                    <td className="px-4 py-3.5">
                      {req.status === 'pending' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-amber-950/80 text-amber-400 border border-amber-800">
                          <Clock className="w-3 h-3 animate-pulse" />
                          <span>در انتظار بررسی</span>
                        </span>
                      ) : req.status === 'approved' || req.status === 'fulfilled' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-950/80 text-emerald-400 border border-emerald-800">
                          <CheckCircle2 className="w-3 h-3" />
                          <span>تأیید شده</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-red-950/80 text-red-400 border border-red-800">
                          <XCircle className="w-3 h-3" />
                          <span>رد شده</span>
                        </span>
                      )}
                    </td>

                    <td className="px-4 py-3.5 text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          onClick={() => setSelectedReq(req)}
                          className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition"
                          title="مشاهده جزئیات کلید سخت‌افزاری"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>

                        {req.status === 'pending' ? (
                          <>
                            <button
                              onClick={() => openReviewModal(req, 'approved')}
                              className="px-2.5 py-1 rounded-lg bg-emerald-950 hover:bg-emerald-900 border border-emerald-800 text-[11px] text-emerald-300 font-bold transition active:scale-95 flex items-center gap-1"
                              title="تأیید درخواست"
                            >
                              <Check className="w-3 h-3 text-emerald-400" />
                              <span>تأیید</span>
                            </button>

                            <button
                              onClick={() => openReviewModal(req, 'rejected')}
                              className="px-2.5 py-1 rounded-lg bg-red-950 hover:bg-red-900 border border-red-800 text-[11px] text-red-300 font-bold transition active:scale-95 flex items-center gap-1"
                              title="رد درخواست"
                            >
                              <X className="w-3 h-3 text-red-400" />
                              <span>رد</span>
                            </button>
                          </>
                        ) : (
                          <span className="px-2 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-[10px] text-zinc-500 font-medium cursor-not-allowed">
                            بررسی‌شده
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Review Modal */}
      {reviewingReq && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-md p-5 shadow-2xl space-y-4 text-right" dir="rtl">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="flex items-center gap-2">
                {reviewAction === 'approved' ? (
                  <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                ) : (
                  <XCircle className="w-5 h-5 text-red-400" />
                )}
                <h3 className="font-bold text-white text-sm">
                  {reviewAction === 'approved' ? 'تأیید درخواست لایسنس' : 'رد درخواست لایسنس'}
                </h3>
              </div>
              <button
                onClick={() => setReviewingReq(null)}
                className="p-1 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {reviewError && (
              <div className="p-3 rounded-xl bg-red-950/70 border border-red-800 text-xs text-red-300 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                <span>{reviewError}</span>
              </div>
            )}

            <form onSubmit={handleExecuteReview} className="space-y-3 text-xs">
              <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800 space-y-1">
                <span className="text-zinc-500 block text-[11px]">شناسه / کد درخواست:</span>
                <span className="font-mono text-amber-400 font-bold block">{reviewingReq.requestToken || reviewingReq.id}</span>
                <span className="text-zinc-400 block text-[11px]">کاربر: {reviewingReq.userEmail || reviewingReq.userId || 'ناشناس'}</span>
                <span className="text-zinc-500 font-mono text-[10px] block break-all">سخت‌افزار: {reviewingReq.deviceId}</span>
              </div>

              <div>
                <label className="block text-zinc-400 mb-1">توضیحات و یادداشت بررسی (ثبت در لاگ‌های امنیتی):</label>
                <textarea
                  value={reviewNotes}
                  onChange={(e) => setReviewNotes(e.target.value)}
                  placeholder={reviewAction === 'approved' ? 'تأیید شد و آماده صدور لایسنس' : 'دلیل رد درخواست (مثلاً عدم تطابق مشخصات)'}
                  rows={3}
                  className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-red-500/80 transition resize-none"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={() => setReviewingReq(null)}
                  className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium"
                >
                  انصراف
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingReview}
                  className={`px-4 py-2 rounded-xl text-white text-xs font-bold transition flex items-center gap-1.5 shadow-md ${
                    reviewAction === 'approved'
                      ? 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-950/40'
                      : 'bg-red-600 hover:bg-red-500 shadow-red-950/40'
                  } disabled:opacity-50`}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isSubmittingReview ? 'animate-spin' : ''}`} />
                  <span>
                    {isSubmittingReview
                      ? 'در حال ثبت در سرور...'
                      : reviewAction === 'approved'
                      ? 'ثبت و تأیید درخواست'
                      : 'ثبت و رد درخواست'}
                  </span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Request Inspection Modal */}
      {selectedReq && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto p-6 shadow-2xl space-y-4 text-right" dir="rtl">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="flex items-center gap-2">
                <FileText className="w-5 h-5 text-amber-400" />
                <h3 className="font-bold text-white text-sm">جزئیات درخواست فعال‌سازی سخت‌افزار</h3>
              </div>
              <button
                onClick={() => setSelectedReq(null)}
                className="p-1 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800">
                <span className="text-zinc-500 block text-[11px] mb-1">کد اختصاصی درخواست:</span>
                <span className="font-mono text-amber-400 font-bold text-sm">{selectedReq.requestToken || selectedReq.id}</span>
              </div>

              <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800">
                <span className="text-zinc-500 block text-[11px] mb-1">شناسه سخت‌افزاری دستگاه (Device ID Hash):</span>
                <span className="font-mono text-zinc-200 font-bold break-all">{selectedReq.deviceId}</span>
              </div>

              <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-zinc-500 text-[11px]">کلید عمومی سخت‌افزاری (Hardware Keystore Public Key):</span>
                  <button
                    onClick={() => copyToClipboard(selectedReq.devicePublicKey)}
                    className="flex items-center gap-1 text-[10px] text-zinc-400 hover:text-white"
                  >
                    {copiedKey ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    <span>کپی کلید</span>
                  </button>
                </div>
                <div className="font-mono text-[10px] text-zinc-400 bg-zinc-900 p-2 rounded-lg break-all max-h-24 overflow-y-auto">
                  {selectedReq.devicePublicKey || 'در دسترس نیست'}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800">
                  <span className="text-zinc-500 block text-[11px] mb-1">مدل و سیستم‌عامل:</span>
                  <span className="text-zinc-200">{selectedReq.deviceModel || 'Android Native App'}</span>
                </div>

                <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800">
                  <span className="text-zinc-500 block text-[11px] mb-1">تاریخ درخواست:</span>
                  <span className="text-zinc-300 font-mono">
                    {selectedReq.requestedAt ? new Date(selectedReq.requestedAt).toLocaleString('fa-IR') : '—'}
                  </span>
                </div>
              </div>

              {selectedReq.notes && (
                <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800">
                  <span className="text-zinc-500 block text-[11px] mb-1">یادداشت کاربر:</span>
                  <span className="text-zinc-300">{selectedReq.notes}</span>
                </div>
              )}
            </div>

            {/* If pending, offer action buttons inside modal too */}
            {selectedReq.status === 'pending' ? (
              <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800 flex items-center justify-between text-xs">
                <span className="text-zinc-300">عملیات بررسی برای این درخواست:</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => openReviewModal(selectedReq, 'approved')}
                    className="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center gap-1 transition"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>تأیید درخواست</span>
                  </button>
                  <button
                    onClick={() => openReviewModal(selectedReq, 'rejected')}
                    className="px-3 py-1.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs flex items-center gap-1 transition"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>رد درخواست</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800 flex items-center justify-between text-xs">
                <span className="text-zinc-400">وضعیت نهایی درخواست:</span>
                <span className="font-bold text-zinc-300">
                  {selectedReq.status === 'approved' || selectedReq.status === 'fulfilled' ? 'تأیید شده' : 'رد شده'}
                </span>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2 border-t border-zinc-800">
              <button
                onClick={() => setSelectedReq(null)}
                className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium"
              >
                بستن
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
