/**
 * AutoPin Pro - Customer License Management & Activation Modal
 *
 * Provides normal users with:
 * 1. Current License Status & Cryptographic Hardware Binding inspection
 * 2. Hardware-bound License Request submission with real-time status listener
 * 3. 1-Click Request Code copy and Native / Messenger sharing
 * 4. Zero-Trust Hardware Activation via Challenge-Response Handshake
 * 5. Friendly, clear Persian error handling and validation
 *
 * Strict Security:
 * - Customers have ZERO admin access (no license creation, no revocation, no transfers)
 * - Raw activation keys are NEVER stored unhashed or unverified
 * - Adheres strictly to Firestore Security Rules & Cloud Functions contracts
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Key,
  ShieldCheck,
  ShieldAlert,
  Smartphone,
  Copy,
  Check,
  Share2,
  Clock,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Calendar,
  AlertTriangle,
  X,
  ExternalLink,
  LogIn,
  Send,
  HelpCircle
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { licenseService } from '../../services/licenseService';
import { deviceKeystore } from '../../services/deviceKeystore';
import { sanitizeForFirestore } from '../../services/onlineStorage';
import { db } from '../../services/firebase';
import {
  collection,
  doc,
  setDoc,
  query,
  where,
  onSnapshot
} from 'firebase/firestore';
import {
  ClientLicenseValidationResult,
  LicenseRecord,
  LicenseRequestRecord,
  OfflineLeaseToken
} from '../../types/license';

interface CustomerLicenseModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenCustomerAuth?: () => void;
}

export const CustomerLicenseModal: React.FC<CustomerLicenseModalProps> = ({
  isOpen,
  onClose,
  onOpenCustomerAuth
}) => {
  const { currentUser, isOnlineDbConnected } = useAuth();

  // License and device states
  const [validationResult, setValidationResult] = useState<ClientLicenseValidationResult | null>(null);
  const [activeRecord, setActiveRecord] = useState<LicenseRecord | null>(null);
  const [activeLease, setActiveLease] = useState<OfflineLeaseToken | null>(null);
  const [deviceId, setDeviceId] = useState<string>('');
  const [deviceModel, setDeviceModel] = useState<string>('');
  const [isLoadingStatus, setIsLoadingStatus] = useState<boolean>(true);
  const [isVerifyingOnline, setIsVerifyingOnline] = useState<boolean>(false);

  // Activation form state
  const [activationKeyInput, setActivationKeyInput] = useState<string>('');
  const [isActivating, setIsActivating] = useState<boolean>(false);
  const [activationSuccessMsg, setActivationSuccessMsg] = useState<string | null>(null);
  const [activationErrorMsg, setActivationErrorMsg] = useState<string | null>(null);

  // License Request state
  const [userRequest, setUserRequest] = useState<LicenseRequestRecord | null>(null);
  const [isLoadingRequest, setIsLoadingRequest] = useState<boolean>(false);
  const [isSubmittingRequest, setIsSubmittingRequest] = useState<boolean>(false);
  const [requestNotes, setRequestNotes] = useState<string>('');
  const [requestSuccessMsg, setRequestSuccessMsg] = useState<string | null>(null);
  const [requestErrorMsg, setRequestErrorMsg] = useState<string | null>(null);

  // Copy and Share feedback
  const [copiedCode, setCopiedCode] = useState<boolean>(false);
  const [copiedDeviceId, setCopiedDeviceId] = useState<boolean>(false);
  const [shareSuccess, setShareSuccess] = useState<boolean>(false);

  // 1. Refresh local validation & device keystore identity
  const refreshLicenseStatus = useCallback(async () => {
    setIsLoadingStatus(true);
    try {
      const devId = await deviceKeystore.getDeviceId().catch(() => 'unknown');
      const devModel = deviceKeystore.getDeviceModelInfo();
      setDeviceId(devId);
      setDeviceModel(devModel);

      const res = await licenseService.validateCurrentLicense();
      setValidationResult(res);
      setActiveRecord(licenseService.getStoredLicense());
      setActiveLease(licenseService.getStoredOfflineLease());
    } catch (err) {
      console.error('Failed to validate license:', err);
    } finally {
      setIsLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      refreshLicenseStatus();
      setActivationErrorMsg(null);
      setActivationSuccessMsg(null);
      setRequestErrorMsg(null);
      setRequestSuccessMsg(null);
    }
  }, [isOpen, refreshLicenseStatus]);

  // 2. Real-time Firestore listener for user's pending or approved license requests
  useEffect(() => {
    if (!isOpen || !currentUser || !isOnlineDbConnected) {
      setUserRequest(null);
      return;
    }

    setIsLoadingRequest(true);
    try {
      const q = query(
        collection(db, 'licenseRequests'),
        where('userId', '==', currentUser.uid)
      );

      const unsubscribe = onSnapshot(
        q,
        (snapshot) => {
          setIsLoadingRequest(false);
          if (snapshot.empty) {
            setUserRequest(null);
            return;
          }

          // Pick the newest request
          const requests: LicenseRequestRecord[] = [];
          snapshot.forEach((docSnap) => {
            const data = docSnap.data() as Omit<LicenseRequestRecord, 'id'>;
            requests.push({
              id: docSnap.id,
              ...data
            });
          });

          // Sort descending by requestedAt
          requests.sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0));
          setUserRequest(requests[0] || null);
        },
        (err) => {
          console.warn('Real-time license requests listener encountered error:', err);
          setIsLoadingRequest(false);
        }
      );

      return () => unsubscribe();
    } catch (err) {
      console.warn('Error attaching license requests listener:', err);
      setIsLoadingRequest(false);
    }
  }, [isOpen, currentUser, isOnlineDbConnected]);

  // 3. Online Verification & Lease Renewal
  const handleVerifyOnline = async () => {
    setIsVerifyingOnline(true);
    setActivationErrorMsg(null);
    try {
      const res = await licenseService.verifyWithServer();
      setValidationResult(res);
      setActiveRecord(licenseService.getStoredLicense());
      setActiveLease(licenseService.getStoredOfflineLease());
      if (res.isValid) {
        setActivationSuccessMsg('استعلام آنلاین با موفقیت انجام شد و مهلت آفلاین ۷ روزه تمدید گردید.');
        setTimeout(() => setActivationSuccessMsg(null), 4000);
      } else {
        setActivationErrorMsg(res.messageFa);
      }
    } catch (err: any) {
      const fa = licenseService.mapFirebaseErrorToFa(err);
      setActivationErrorMsg(fa);
    } finally {
      setIsVerifyingOnline(false);
    }
  };

  // 4. Submit New License Request
  const handleSubmitLicenseRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) {
      if (onOpenCustomerAuth) {
        onOpenCustomerAuth();
      }
      return;
    }

    setIsSubmittingRequest(true);
    setRequestErrorMsg(null);
    setRequestSuccessMsg(null);

    try {
      const devId = await deviceKeystore.getDeviceId();
      const devPubKey = await deviceKeystore.getDevicePublicKey();
      const devModel = deviceKeystore.getDeviceModelInfo();

      // Formulate human-readable token e.g. REQ-ABC12-34567
      const randomSuffix = Math.random().toString(36).substring(2, 7).toUpperCase();
      const timePart = Date.now().toString(36).slice(-4).toUpperCase();
      const requestToken = `REQ-${timePart}-${randomSuffix}`;

      // Document ID satisfying isValidId(requestId): [a-zA-Z0-9_\-]+ <= 128 chars
      const requestId = `req_${Date.now()}_${randomSuffix.toLowerCase()}`;

      const trimmedNotes = requestNotes.trim();
      const rawPayload: Omit<LicenseRequestRecord, 'id'> = {
        userId: currentUser.uid,
        status: 'pending' as const,
        deviceId: devId,
        devicePublicKey: devPubKey,
        requestToken,
        requestedAt: Date.now(),
        userEmail: currentUser.email || '',
        deviceModel: devModel,
        ...(trimmedNotes ? { notes: trimmedNotes } : {})
      };
      const requestPayload = sanitizeForFirestore(rawPayload);

      const docRef = doc(db, 'licenseRequests', requestId);
      await setDoc(docRef, requestPayload);

      setUserRequest({
        id: requestId,
        ...requestPayload
      });

      setRequestSuccessMsg('درخواست فعال‌سازی شما با موفقیت ثبت شد. کد درخواست را جهت تأیید و صدور لایسنس به مدیر ارائه نمایید.');
      setRequestNotes('');
    } catch (err: any) {
      console.error('Failed to submit license request:', err);
      if (err?.code === 'permission-denied') {
        setRequestErrorMsg('خطای سطح دسترسی: برای ثبت درخواست لطفاً ابتدا وارد حساب کاربری خود شوید.');
      } else {
        setRequestErrorMsg(licenseService.mapFirebaseErrorToFa(err));
      }
    } finally {
      setIsSubmittingRequest(false);
    }
  };

  // 5. Activate License via Hardware Handshake
  const handleActivateLicense = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanKey = activationKeyInput.trim();
    if (!cleanKey) {
      setActivationErrorMsg('لطفاً کد فعال‌سازی را وارد نمایید.');
      return;
    }

    setIsActivating(true);
    setActivationErrorMsg(null);
    setActivationSuccessMsg(null);

    try {
      const res = await licenseService.activateWithServer(cleanKey);
      setValidationResult(res);
      setActiveRecord(licenseService.getStoredLicense());
      setActiveLease(licenseService.getStoredOfflineLease());

      if (res.isValid) {
        setActivationSuccessMsg('لایسنس با موفقیت بر روی این دستگاه فعال شد. اعتبار یک‌ساله شما آغاز گردید.');
        setActivationKeyInput('');
      } else {
        setActivationErrorMsg(res.messageFa || 'کد لایسنس وارد شده مورد تایید سرور قرار نگرفت.');
      }
    } catch (err: any) {
      console.error('Activation failure:', err);
      const friendlyError = licenseService.mapFirebaseErrorToFa(err);
      setActivationErrorMsg(friendlyError);
    } finally {
      setIsActivating(false);
    }
  };

  // Copy helper
  const handleCopyText = (text: string, type: 'code' | 'device') => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    if (type === 'code') {
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } else {
      setCopiedDeviceId(true);
      setTimeout(() => setCopiedDeviceId(false), 2000);
    }
  };

  // Share helper (supports native mobile navigator.share)
  const handleShareRequestCode = async (req: LicenseRequestRecord) => {
    const textToShare = `کد درخواست لایسنس AutoPin Pro:\nکد درخواست: ${req.requestToken || req.id}\nدستگاه: ${req.deviceModel || 'Android'}\nایمیل: ${req.userEmail || currentUser?.email || 'مشتری'}\nشناسه سخت‌افزار: ${req.deviceId.substring(0, 24)}...`;

    if (navigator.share) {
      try {
        await navigator.share({
          title: 'درخواست لایسنس AutoPin Pro',
          text: textToShare
        });
        setShareSuccess(true);
        setTimeout(() => setShareSuccess(false), 2500);
      } catch {
        // Fallback to clipboard
        handleCopyText(textToShare, 'code');
      }
    } else {
      handleCopyText(textToShare, 'code');
    }
  };

  if (!isOpen) return null;

  // Format Persian Shamsi dates safely
  const formatShamsi = (ms?: number) => {
    if (!ms) return 'نامشخص';
    try {
      return new Date(ms).toLocaleDateString('fa-IR');
    } catch {
      return '—';
    }
  };

  const isLicenseActive = validationResult?.isValid === true;
  const isExpired = validationResult?.status === 'expired';
  const isRevoked = validationResult?.status === 'revoked';
  const isClockTampered = validationResult?.status === 'clock_tampered';
  const hasPendingRequest = userRequest?.status === 'pending';
  const hasApprovedRequest = userRequest?.status === 'approved' || userRequest?.status === 'fulfilled';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-xs p-3 sm:p-4 overflow-y-auto animate-in fade-in duration-200">
      <div
        className="w-full max-w-xl bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col text-right my-auto max-h-[92vh]"
        dir="rtl"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-800 bg-zinc-950 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-red-600 to-amber-600 flex items-center justify-center text-white shadow-md shadow-red-950">
              <Key className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white tracking-tight">مدیریت و فعال‌سازی لایسنس</h2>
              <p className="text-[11px] text-zinc-400">
                وضعیت اعتبار لایسنس، شناسه سخت‌افزار و فعال‌سازی دستگاه
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white bg-zinc-900 hover:bg-zinc-800 transition"
            aria-label="بستن"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Scrollable Body */}
        <div className="p-4 sm:p-5 overflow-y-auto space-y-4 text-xs">
          {/* Global Alert Messages */}
          {activationSuccessMsg && (
            <div className="bg-emerald-950/70 border border-emerald-800 text-emerald-300 p-3 rounded-xl flex items-center gap-2 animate-in fade-in">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{activationSuccessMsg}</span>
            </div>
          )}

          {activationErrorMsg && (
            <div className="bg-red-950/70 border border-red-800 text-red-300 p-3 rounded-xl flex items-center gap-2 animate-in fade-in">
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
              <span>{activationErrorMsg}</span>
            </div>
          )}

          {/* 1. LICENSE STATUS CARD (Requirement 2) */}
          <div className="bg-zinc-950 border border-zinc-800 rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2 pb-2.5 border-b border-zinc-800/80">
              <span className="text-zinc-400 font-bold text-[11px] flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-amber-400" />
                <span>وضعیت فعلی لایسنس نرم‌افزار:</span>
              </span>

              {/* Status Badge */}
              {isLoadingStatus ? (
                <span className="px-2.5 py-1 rounded-lg text-[10px] font-mono bg-zinc-800 text-zinc-400 animate-pulse">
                  در حال بررسی وضعیت...
                </span>
              ) : isLicenseActive ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-emerald-950/80 text-emerald-400 border border-emerald-800">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  <span>لایسنس فعال (Active)</span>
                </span>
              ) : isExpired ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-red-950/80 text-red-400 border border-red-800">
                  <XCircle className="w-3.5 h-3.5 text-red-400" />
                  <span>لایسنس منقضی‌شده (Expired)</span>
                </span>
              ) : isRevoked ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-red-950/80 text-red-300 border border-red-800">
                  <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
                  <span>لایسنس مسدود یا لغو شده</span>
                </span>
              ) : isClockTampered ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-amber-950/80 text-amber-300 border border-amber-800">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                  <span>خطای ساعت دستگاه</span>
                </span>
              ) : hasPendingRequest ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-amber-950/80 text-amber-400 border border-amber-800">
                  <Clock className="w-3.5 h-3.5 text-amber-400 animate-spin" />
                  <span>در انتظار تأیید مدیر</span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-zinc-800 text-zinc-300 border border-zinc-700">
                  <Key className="w-3.5 h-3.5 text-zinc-400" />
                  <span>لایسنس فعال‌نشده (Unactivated)</span>
                </span>
              )}
            </div>

            {/* Specifications Details Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
              {/* Start Date */}
              <div className="p-2.5 rounded-xl bg-zinc-900/80 border border-zinc-800/80 flex items-center justify-between">
                <span className="text-zinc-500">تاریخ شروع اعتبار:</span>
                <span className="text-zinc-300 font-mono">
                  {activeRecord?.startsAt ? formatShamsi(activeRecord.startsAt) : '—'}
                </span>
              </div>

              {/* Expiry Date */}
              <div className="p-2.5 rounded-xl bg-zinc-900/80 border border-zinc-800/80 flex items-center justify-between">
                <span className="text-zinc-500">تاریخ انقضا:</span>
                <span className={`font-mono font-bold ${isExpired ? 'text-red-400' : 'text-zinc-300'}`}>
                  {activeRecord?.expiresAt ? formatShamsi(activeRecord.expiresAt) : '—'}
                </span>
              </div>

              {/* Days Remaining */}
              <div className="p-2.5 rounded-xl bg-zinc-900/80 border border-zinc-800/80 flex items-center justify-between">
                <span className="text-zinc-500">روزهای باقی‌مانده:</span>
                <span className="font-mono font-bold text-amber-400">
                  {validationResult?.daysRemaining !== undefined
                    ? `${validationResult.daysRemaining} روز`
                    : '—'}
                </span>
              </div>

              {/* Online Check & Offline Grace */}
              <div className="p-2.5 rounded-xl bg-zinc-900/80 border border-zinc-800/80 flex items-center justify-between">
                <span className="text-zinc-500">مهلت استفاده آفلاین:</span>
                <span className="font-mono text-zinc-300">
                  {validationResult?.offlineDaysRemaining !== undefined
                    ? `${validationResult.offlineDaysRemaining} از ۷ روز`
                    : activeRecord?.lastOnlineCheckAt
                    ? '۷ روز مجاز'
                    : 'نیازمند اتصال آنلاین'}
                </span>
              </div>
            </div>

            {/* Hardware Binding (Device ID) */}
            <div className="p-2.5 rounded-xl bg-zinc-900/80 border border-zinc-800/80 space-y-1">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-zinc-500 flex items-center gap-1.5">
                  <Smartphone className="w-3.5 h-3.5 text-zinc-400" />
                  <span>شناسه سخت‌افزاری دستگاه (Device ID):</span>
                </span>
                <button
                  type="button"
                  onClick={() => handleCopyText(deviceId, 'device')}
                  className="flex items-center gap-1 text-[10px] text-zinc-400 hover:text-white transition"
                  title="کپی شناسه سخت‌افزار"
                >
                  {copiedDeviceId ? (
                    <span className="text-emerald-400 flex items-center gap-0.5">
                      <Check className="w-3 h-3" /> کپی شد
                    </span>
                  ) : (
                    <span className="flex items-center gap-0.5">
                      <Copy className="w-3 h-3" /> کپی
                    </span>
                  )}
                </button>
              </div>
              <div className="font-mono text-[10px] text-zinc-300 bg-zinc-950 p-1.5 rounded-lg break-all select-all border border-zinc-800/60" dir="ltr">
                {deviceId || 'در حال واکشی کلید سخت‌افزاری...'}
              </div>
              <div className="flex items-center justify-between text-[10px] text-zinc-500 pt-0.5">
                <span>مدل شناسایی‌شده: {deviceModel || 'Android / PWA'}</span>
                <span className="text-emerald-400">حفاظت TEE / Keystore</span>
              </div>
            </div>

            {/* Sync / Refresh Button */}
            {isLicenseActive && (
              <div className="pt-1 flex items-center justify-end">
                <button
                  type="button"
                  onClick={handleVerifyOnline}
                  disabled={isVerifyingOnline}
                  className="px-3 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[11px] font-medium flex items-center gap-1.5 transition active:scale-95 disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${isVerifyingOnline ? 'animate-spin text-amber-400' : ''}`} />
                  <span>{isVerifyingOnline ? 'در حال استعلام آنلاین...' : 'استعلام آنلاین و تمدید مهلت آفلاین'}</span>
                </button>
              </div>
            )}
          </div>

          {/* 2. LICENSE REQUEST SECTION (Requirement 3) */}
          <div className="bg-zinc-950 border border-zinc-800 rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-zinc-800/80">
              <div className="flex items-center gap-2">
                <Send className="w-4 h-4 text-red-500" />
                <h3 className="font-bold text-white text-xs">درخواست لایسنس جدید برای این دستگاه</h3>
              </div>
              {hasPendingRequest && (
                <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-amber-950/90 text-amber-400 border border-amber-800 flex items-center gap-1">
                  <Clock className="w-3 h-3 animate-pulse" />
                  در انتظار بررسی مدیر
                </span>
              )}
            </div>

            {/* If user not logged in */}
            {!currentUser ? (
              <div className="p-3.5 rounded-xl bg-zinc-900/90 border border-zinc-800 space-y-2 text-center">
                <p className="text-zinc-300 text-xs">
                  برای ثبت درخواست لایسنس متصل به حساب خود، لطفاً ابتدا وارد حساب کاربری شوید.
                </p>
                {onOpenCustomerAuth && (
                  <button
                    type="button"
                    onClick={onOpenCustomerAuth}
                    className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs inline-flex items-center gap-1.5 transition active:scale-95 shadow-md shadow-red-950"
                  >
                    <LogIn className="w-3.5 h-3.5" />
                    <span>ورود یا ثبت‌نام مشتری</span>
                  </button>
                )}
              </div>
            ) : userRequest && (userRequest.status === 'pending' || userRequest.status === 'approved') ? (
              /* User has an active/pending request */
              <div className="p-3.5 rounded-xl bg-zinc-900 border border-zinc-800 space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <span className="text-zinc-400 text-[11px]">کد درخواست فعال‌سازی شما:</span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleCopyText(userRequest.requestToken || userRequest.id, 'code')}
                      className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-750 text-zinc-200 border border-zinc-700 text-[11px] flex items-center gap-1 transition active:scale-95"
                      title="کپی کد درخواست"
                    >
                      {copiedCode ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      <span>{copiedCode ? 'کپی شد' : 'کپی کد'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleShareRequestCode(userRequest)}
                      className="px-2.5 py-1 rounded-lg bg-red-950/60 hover:bg-red-900/60 text-red-300 border border-red-800 text-[11px] flex items-center gap-1 transition active:scale-95"
                      title="اشتراک‌گذاری در پیام‌رسان‌ها"
                    >
                      <Share2 className="w-3 h-3" />
                      <span>اشتراک‌گذاری</span>
                    </button>
                  </div>
                </div>

                {/* Big Readable Request Token Display */}
                <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800 text-center space-y-1">
                  <div className="text-base sm:text-lg font-black font-mono text-amber-400 tracking-wider" dir="ltr">
                    {userRequest.requestToken || userRequest.id}
                  </div>
                  <span className="text-[10px] text-zinc-500 block">
                    این کد را جهت صدور لایسنس به مدیریت یا پشتیبانی AutoPin Pro ارسال فرمایید.
                  </span>
                </div>

                {/* Status indicator banner */}
                {userRequest.status === 'pending' ? (
                  <div className="p-2.5 rounded-xl bg-amber-950/40 border border-amber-800/80 text-amber-300 flex items-start gap-2 text-[11px]">
                    <Clock className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                    <div className="space-y-0.5">
                      <span className="font-bold block">درخواست شما در انتظار تأیید مدیریت قرار دارد.</span>
                      <span className="text-zinc-400 text-[10px] block">
                        پس از بررسی توسط مدیر، کد فعال‌سازی برای شما ارسال خواهد شد و می‌توانید آن را در بخش زیر وارد نمایید.
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="p-2.5 rounded-xl bg-emerald-950/40 border border-emerald-800/80 text-emerald-300 flex items-start gap-2 text-[11px]">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    <div>
                      <span className="font-bold block">درخواست شما تأیید شده است!</span>
                      <span className="text-zinc-400 text-[10px] block">
                        کد لایسنس ارائه‌شده توسط مدیر را در کادر زیر وارد نموده و فعال‌سازی را بزنید.
                      </span>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* No pending request: Form to submit request */
              <form onSubmit={handleSubmitLicenseRequest} className="space-y-3">
                <p className="text-zinc-400 text-[11px] leading-relaxed">
                  اگر هنوز لایسنس ندارید یا تمایل به راه‌اندازی لایسنس جدید دارید، با زدن دکمه زیر اطلاعات کلید سخت‌افزاری دستگاه شما استخراج و به مدیریت ارسال می‌شود.
                </p>

                <div>
                  <label className="block text-[11px] text-zinc-400 mb-1">
                    نام تعمیرگاه یا یادداشت اختیاری (اختیاری):
                  </label>
                  <input
                    type="text"
                    value={requestNotes}
                    onChange={(e) => setRequestNotes(e.target.value)}
                    placeholder="مثال: کلینیک برق تخصصی خودرو - تهران"
                    className="w-full px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-red-500/80 transition"
                  />
                </div>

                {requestErrorMsg && (
                  <div className="p-2.5 rounded-xl bg-red-950/60 border border-red-800 text-red-300 text-[11px] flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                    <span>{requestErrorMsg}</span>
                  </div>
                )}

                {requestSuccessMsg && (
                  <div className="p-2.5 rounded-xl bg-emerald-950/60 border border-emerald-800 text-emerald-300 text-[11px] flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <span>{requestSuccessMsg}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isSubmittingRequest}
                  className="w-full py-2.5 rounded-xl bg-gradient-to-r from-red-600 to-amber-600 hover:from-red-500 hover:to-amber-500 text-white font-bold text-xs flex items-center justify-center gap-2 transition active:scale-95 shadow-lg shadow-red-950/40 disabled:opacity-50"
                >
                  <Send className={`w-3.5 h-3.5 ${isSubmittingRequest ? 'animate-spin' : ''}`} />
                  <span>{isSubmittingRequest ? 'در حال ثبت درخواست...' : 'ثبت درخواست لایسنس برای این دستگاه'}</span>
                </button>
              </form>
            )}
          </div>

          {/* 3. LICENSE ACTIVATION WITH CODE SECTION (Requirement 4) */}
          <div className="bg-zinc-950 border border-zinc-800 rounded-2xl p-4 space-y-3">
            <div className="flex items-center gap-2 pb-2 border-b border-zinc-800/80">
              <Key className="w-4 h-4 text-emerald-400" />
              <h3 className="font-bold text-white text-xs">فعال‌سازی لایسنس با کد</h3>
            </div>

            <p className="text-zinc-400 text-[11px]">
              کد فعال‌سازی ۱۶ الی ۲۴ کاراکتری دریافت‌شده از پشتیبانی یا مدیر را وارد نمایید:
            </p>

            <form onSubmit={handleActivateLicense} className="space-y-3">
              <div className="relative">
                <input
                  type="text"
                  value={activationKeyInput}
                  onChange={(e) => setActivationKeyInput(e.target.value.toUpperCase())}
                  placeholder="مثال: APRO-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-1Y"
                  dir="ltr"
                  className="w-full px-3 py-2.5 rounded-xl bg-zinc-900 border border-zinc-800 text-xs sm:text-sm font-mono text-center font-bold text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500/80 transition tracking-wider"
                />
              </div>

              <button
                type="submit"
                disabled={isActivating || !activationKeyInput.trim()}
                className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-2 transition active:scale-95 shadow-lg shadow-emerald-950/40 disabled:opacity-50"
              >
                <CheckCircle2 className={`w-4 h-4 ${isActivating ? 'animate-spin' : ''}`} />
                <span>
                  {isActivating
                    ? 'در حال برقراری ارتباط با سرور و امضای سخت‌افزاری...'
                    : 'فعال‌سازی لایسنس روی این دستگاه'}
                </span>
              </button>
            </form>
          </div>

          {/* 4. GUIDANCE & FAQ NOTE */}
          <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/80 space-y-1.5 text-[11px] text-zinc-400">
            <div className="flex items-center gap-1.5 font-bold text-zinc-300">
              <HelpCircle className="w-3.5 h-3.5 text-amber-400" />
              <span>نکات امنیتی لایسنس سخت‌افزاری AutoPin Pro:</span>
            </div>
            <ul className="space-y-1 list-disc list-inside text-zinc-400 leading-relaxed pr-1">
              <li>هر لایسنس به تراشه سخت‌افزاری امن (Keystore TEE) گوشی متصل شده و قابلیت انتقال یا کلون‌سازی ندارد.</li>
              <li>پس از فعال‌سازی، برنامه تا سقف ۷ روز بدون نیاز به اینترنت (کاملاً آفلاین در محیط تعمیرگاه) کار خواهد کرد.</li>
              <li>دستکاری تاریخ یا ساعت گوشی منجر به مسدودسازی موقت لایسنس خواهد شد.</li>
            </ul>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="p-3.5 border-t border-zinc-800 bg-zinc-950 flex items-center justify-between shrink-0">
          <span className="text-[11px] text-zinc-500 font-mono">AutoPin Pro v1.2</span>
          <button
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-750 text-zinc-200 text-xs font-semibold transition"
          >
            بستن
          </button>
        </div>
      </div>
    </div>
  );
};
