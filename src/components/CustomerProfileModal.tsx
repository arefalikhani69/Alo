import React from 'react';
import {
  User,
  Mail,
  ShieldCheck,
  Calendar,
  LogOut,
  X,
  CheckCircle2,
  Key,
  Car,
  Cpu,
  Zap,
  Bookmark
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

interface CustomerProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenLicenseModal?: () => void;
}

export const CustomerProfileModal: React.FC<CustomerProfileModalProps> = ({
  isOpen,
  onClose,
  onOpenLicenseModal
}) => {
  const { currentUser, userProfile, logout } = useAuth();

  if (!isOpen || !currentUser) return null;

  const handleLogout = async () => {
    await logout();
    onClose();
  };

  const createdDate = userProfile?.createdAt
    ? new Date(userProfile.createdAt).toLocaleDateString('fa-IR')
    : 'نامشخص';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col text-right" dir="rtl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-800 bg-zinc-950">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-red-600/15 border border-red-500/30 flex items-center justify-center text-red-500 shadow-sm">
              <User className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white tracking-tight">حساب کاربری مشتری</h3>
              <p className="text-[11px] text-zinc-400 font-mono">{currentUser.email}</p>
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

        {/* Body Content */}
        <div className="p-5 space-y-4 text-xs">
          {/* User Overview Card */}
          <div className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-zinc-400 text-[11px]">نام / عنوان کارگاه:</span>
              <span className="text-zinc-200 font-bold text-xs">
                {userProfile?.displayName || 'مشتری گرامی AutoPin Pro'}
              </span>
            </div>

            <div className="flex items-center justify-between pt-1 border-t border-zinc-800/80">
              <span className="text-zinc-400 text-[11px]">ایمیل ثبت‌شده:</span>
              <span className="text-zinc-300 font-mono text-[11px]" dir="ltr">
                {currentUser.email}
              </span>
            </div>

            <div className="flex items-center justify-between pt-1 border-t border-zinc-800/80">
              <span className="text-zinc-400 text-[11px]">شناسه کاربری (UID):</span>
              <span className="text-zinc-400 font-mono text-[10px]" dir="ltr">
                {currentUser.uid.slice(0, 16)}...
              </span>
            </div>

            <div className="flex items-center justify-between pt-1 border-t border-zinc-800/80">
              <span className="text-zinc-400 text-[11px]">وضعیت حساب:</span>
              <span className="flex items-center gap-1 text-emerald-400 font-bold text-[11px] bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800/60">
                <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                حساب فعال (Active)
              </span>
            </div>

            <div className="flex items-center justify-between pt-1 border-t border-zinc-800/80">
              <span className="text-zinc-400 text-[11px]">تاریخ عضویت:</span>
              <span className="text-zinc-300 text-[11px] flex items-center gap-1 font-mono">
                <Calendar className="w-3 h-3 text-zinc-500" />
                {createdDate}
              </span>
            </div>
          </div>

          {/* License Management Action Button */}
          {onOpenLicenseModal && (
            <button
              onClick={() => {
                onClose();
                onOpenLicenseModal();
              }}
              className="w-full p-3 rounded-xl bg-gradient-to-r from-zinc-950 to-zinc-900 hover:from-zinc-900 hover:to-zinc-850 border border-zinc-800 hover:border-amber-500/40 text-white flex items-center justify-between transition active:scale-[0.99] group shadow-sm"
            >
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-400 flex items-center justify-center">
                  <Key className="w-4 h-4" />
                </div>
                <div className="text-right">
                  <span className="text-xs font-bold block text-white group-hover:text-amber-400 transition">
                    مدیریت و فعال‌سازی لایسنس
                  </span>
                  <span className="text-[10px] text-zinc-400 block">
                    مشاهده اعتبار، شناسه سخت‌افزار و فعال‌سازی کد
                  </span>
                </div>
              </div>
              <span className="px-2 py-0.5 rounded text-[10px] bg-zinc-900 text-zinc-300 border border-zinc-750 font-medium group-hover:border-amber-500/50">
                بررسی لایسنس ←
              </span>
            </button>
          )}

          {/* Active Features list */}
          <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/80 space-y-2">
            <span className="text-[11px] font-bold text-zinc-300 block">
              امکانات فعال در حساب کاربری شما:
            </span>
            <ul className="space-y-1.5 text-[11px] text-zinc-400">
              <li className="flex items-center gap-2">
                <Car className="w-3.5 h-3.5 text-red-400 shrink-0" />
                <span>دسترسی کامل به مشخصات فنی خودروها و موتورها</span>
              </li>
              <li className="flex items-center gap-2">
                <Cpu className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>مشاهده نقشه‌ها و جدول پین‌آوت سوکت‌های ECU</span>
              </li>
              <li className="flex items-center gap-2">
                <Zap className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span>راهنمای کامل جعبه‌فیوزها، رله‌ها و تست مدارها</span>
              </li>
              <li className="flex items-center gap-2">
                <Bookmark className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                <span>ذخیره‌سازی پایه‌ها و خودروهای پرکاربرد در نشان‌ها</span>
              </li>
            </ul>
          </div>

          {/* Logout Action */}
          <div className="pt-2 flex items-center gap-2">
            <button
              onClick={handleLogout}
              className="flex-1 py-2.5 rounded-xl bg-red-950/50 hover:bg-red-900/60 text-red-300 border border-red-900/60 font-bold transition flex items-center justify-center gap-1.5 active:scale-95 text-xs"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>خروج از حساب کاربری</span>
            </button>
            <button
              onClick={onClose}
              className="py-2.5 px-5 rounded-xl bg-zinc-800 hover:bg-zinc-750 text-zinc-300 font-medium transition text-xs"
            >
              بستن
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
