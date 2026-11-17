import React, { useState } from 'react';
import {
  LogIn,
  UserPlus,
  KeyRound,
  Mail,
  User as UserIcon,
  Eye,
  EyeOff,
  AlertCircle,
  CheckCircle2,
  X,
  Loader2,
  ShieldCheck,
  ArrowRight
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

interface CustomerAuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  initialMode?: 'login' | 'register' | 'forgot';
}

export const CustomerAuthModal: React.FC<CustomerAuthModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  initialMode = 'login'
}) => {
  const { loginWithEmail, registerWithEmail, resetPassword, loginWithGoogle } = useAuth();

  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const resetFormState = () => {
    setErrorMessage(null);
    setSuccessMessage(null);
  };

  const handleModeChange = (newMode: 'login' | 'register' | 'forgot') => {
    setMode(newMode);
    resetFormState();
  };

  const mapAuthErrorToPersian = (err: unknown): string => {
    const raw = err instanceof Error ? err.message : String(err);
    if (raw.includes('email-already-in-use')) {
      return 'این آدرس ایمیل قبلاً در سیستم ثبت‌نام شده است. لطفاً وارد شوید یا رمز عبور را بازیابی کنید.';
    }
    if (raw.includes('wrong-password') || raw.includes('invalid-credential') || raw.includes('user-not-found')) {
      return 'ایمیل یا رمز عبور وارد شده نادرست است.';
    }
    if (raw.includes('weak-password') || raw.includes('حداقل ۸ کاراکتر')) {
      return 'رمز عبور باید حداقل ۸ کاراکتر باشد.';
    }
    if (raw.includes('invalid-email')) {
      return 'فرمت آدرس ایمیل وارد شده نامعتبر است.';
    }
    if (raw.includes('network-request-failed') || raw.includes('offline') || raw.includes('unavailable')) {
      return 'عدم برقراری ارتباط با سرور. لطفاً اتصال اینترنت خود را بررسی فرمایید.';
    }
    if (raw.includes('too-many-requests')) {
      return 'تعداد دفعات تلاش ناموفق بیش از حد مجاز است. لطفاً دقایقی دیگر مجدداً تلاش کنید.';
    }
    if (raw.includes('popup-closed-by-user')) {
      return 'پنجره ورود با گوگل قبل از تکمیل بسته شد.';
    }
    return `خطا در احراز هویت: ${raw.replace(/Firebase:?\s*/gi, '')}`;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail) {
      setErrorMessage('لطفاً آدرس ایمیل خود را وارد فرمایید.');
      return;
    }

    if (!cleanEmail.includes('@') || !cleanEmail.includes('.')) {
      setErrorMessage('لطفاً یک آدرس ایمیل معتبر وارد فرمایید.');
      return;
    }

    // 1. Password Reset Mode
    if (mode === 'forgot') {
      try {
        setIsSubmitting(true);
        await resetPassword(cleanEmail);
        setSuccessMessage('لینک بازیابی رمز عبور به ایمیل شما ارسال شد. لطفاً صندوق ورودی و پوشه هرزنامه (Spam) را بررسی نمایید.');
      } catch (err) {
        setErrorMessage(mapAuthErrorToPersian(err));
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    // 2. Password Validations
    if (!password) {
      setErrorMessage('لطفاً رمز عبور را وارد فرمایید.');
      return;
    }

    if (mode === 'register') {
      if (password.length < 8) {
        setErrorMessage('رمز عبور باید حداقل دارای ۸ کاراکتر باشد.');
        return;
      }
      if (password !== confirmPassword) {
        setErrorMessage('رمز عبور با تکرار آن یکسان نیست. لطفاً با دقت وارد فرمایید.');
        return;
      }
    }

    // 3. Execution
    try {
      setIsSubmitting(true);
      if (mode === 'register') {
        await registerWithEmail(cleanEmail, password, displayName.trim() || undefined);
      } else {
        await loginWithEmail(cleanEmail, password);
      }
      onSuccess();
      onClose();
    } catch (err) {
      setErrorMessage(mapAuthErrorToPersian(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleGoogleLogin = async () => {
    try {
      setIsSubmitting(true);
      setErrorMessage(null);
      setSuccessMessage(null);
      await loginWithGoogle();
      onSuccess();
      onClose();
    } catch (err) {
      setErrorMessage(mapAuthErrorToPersian(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col text-right" dir="rtl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-800 bg-zinc-950">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-red-600/15 border border-red-500/30 flex items-center justify-center text-red-500 shadow-sm">
              {mode === 'register' ? (
                <UserPlus className="w-4 h-4" />
              ) : mode === 'forgot' ? (
                <KeyRound className="w-4 h-4" />
              ) : (
                <LogIn className="w-4 h-4" />
              )}
            </div>
            <div>
              <h3 className="text-sm font-bold text-white tracking-tight">
                {mode === 'register'
                  ? 'ثبت‌نام حساب مشتریان AutoPin Pro'
                  : mode === 'forgot'
                  ? 'بازیابی رمز عبور حساب'
                  : 'ورود به حساب کاربری مشتریان'}
              </h3>
              <p className="text-[11px] text-zinc-400">
                {mode === 'register'
                  ? 'دسترسی کامل به بانک اطلاعات پین‌آوت، فیوزها و نقشه‌ها'
                  : mode === 'forgot'
                  ? 'ارسال پیوند بازنشانی به آدرس ایمیل شما'
                  : 'مشاهده مشخصات فنی، جستجو و نشان‌ها'}
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

        {/* Tab Selector (for login/register) */}
        {mode !== 'forgot' && (
          <div className="grid grid-cols-2 p-1.5 bg-zinc-950/80 border-b border-zinc-800 text-xs font-semibold gap-1">
            <button
              type="button"
              onClick={() => handleModeChange('login')}
              className={`py-2 rounded-xl transition flex items-center justify-center gap-2 ${
                mode === 'login'
                  ? 'bg-zinc-800 text-white shadow-xs'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
              }`}
            >
              <LogIn className="w-3.5 h-3.5" />
              <span>ورود با حساب</span>
            </button>
            <button
              type="button"
              onClick={() => handleModeChange('register')}
              className={`py-2 rounded-xl transition flex items-center justify-center gap-2 ${
                mode === 'register'
                  ? 'bg-red-600 text-white shadow-md shadow-red-950/60'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
              }`}
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>ثبت‌نام مشتری جدید</span>
            </button>
          </div>
        )}

        {/* Form Body */}
        <div className="p-5 space-y-4 text-xs">
          {/* Success Message Banner */}
          {successMessage && (
            <div className="p-3 rounded-xl bg-emerald-950/60 border border-emerald-800 text-emerald-300 text-xs flex items-start gap-2.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <p className="leading-relaxed">{successMessage}</p>
            </div>
          )}

          {/* Error Message Banner */}
          {errorMessage && (
            <div className="p-3 rounded-xl bg-red-950/70 border border-red-800 text-red-300 text-xs flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <p className="leading-relaxed">{errorMessage}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-3.5">
            {/* Display Name (Only in Register mode) */}
            {mode === 'register' && (
              <div>
                <label className="text-zinc-300 block mb-1 font-medium">نام و نام خانوادگی یا عنوان تعمیرگاه (اختیاری):</label>
                <div className="relative">
                  <UserIcon className="w-4 h-4 text-zinc-500 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="مثلاً مهندس رضایی یا کلینیک برق پارس"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl pr-9 pl-3 py-2 text-white placeholder-zinc-600 focus:outline-none focus:border-red-500 transition text-xs"
                    disabled={isSubmitting}
                  />
                </div>
              </div>
            )}

            {/* Email Address */}
            <div>
              <label className="text-zinc-300 block mb-1 font-medium">آدرس ایمیل:</label>
              <div className="relative">
                <Mail className="w-4 h-4 text-zinc-500 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                  dir="ltr"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl pr-9 pl-3 py-2 text-white placeholder-zinc-600 focus:outline-none focus:border-red-500 transition text-xs text-left"
                  disabled={isSubmitting}
                />
              </div>
            </div>

            {/* Password (Login & Register modes) */}
            {mode !== 'forgot' && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-zinc-300 font-medium">
                    رمز عبور {mode === 'register' ? '(حداقل ۸ کاراکتر)' : ''}:
                  </label>
                  {mode === 'login' && (
                    <button
                      type="button"
                      onClick={() => handleModeChange('forgot')}
                      className="text-[11px] text-zinc-400 hover:text-red-400 transition"
                      tabIndex={-1}
                    >
                      رمز عبور را فراموش کرده‌اید؟
                    </button>
                  )}
                </div>
                <div className="relative">
                  <KeyRound className="w-4 h-4 text-zinc-500 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    dir="ltr"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl pr-9 pl-9 py-2 text-white placeholder-zinc-600 focus:outline-none focus:border-red-500 transition text-xs text-left"
                    disabled={isSubmitting}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            )}

            {/* Confirm Password (Register mode only) */}
            {mode === 'register' && (
              <div>
                <label className="text-zinc-300 block mb-1 font-medium">تکرار رمز عبور:</label>
                <div className="relative">
                  <KeyRound className="w-4 h-4 text-zinc-500 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type={showConfirmPassword ? 'text' : 'password'}
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="••••••••"
                    dir="ltr"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl pr-9 pl-9 py-2 text-white placeholder-zinc-600 focus:outline-none focus:border-red-500 transition text-xs text-left"
                    disabled={isSubmitting}
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                    tabIndex={-1}
                  >
                    {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            )}

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full py-2.5 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-bold rounded-xl shadow-md shadow-red-950 transition active:scale-95 flex items-center justify-center gap-2 mt-2"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>در حال پردازش...</span>
                </>
              ) : mode === 'register' ? (
                <>
                  <UserPlus className="w-4 h-4" />
                  <span>ایجاد حساب کاربری جدید</span>
                </>
              ) : mode === 'forgot' ? (
                <>
                  <Mail className="w-4 h-4" />
                  <span>ارسال لینک بازیابی رمز</span>
                </>
              ) : (
                <>
                  <LogIn className="w-4 h-4" />
                  <span>ورود به حساب کاربری</span>
                </>
              )}
            </button>
          </form>

          {/* Forgot Mode: Back to Login */}
          {mode === 'forgot' && (
            <div className="text-center pt-2">
              <button
                type="button"
                onClick={() => handleModeChange('login')}
                className="text-zinc-400 hover:text-white text-[11px] flex items-center justify-center gap-1 mx-auto"
              >
                <ArrowRight className="w-3.5 h-3.5" />
                <span>بازگشت به صفحه ورود</span>
              </button>
            </div>
          )}

          {/* Google Sign-in divider & button (Login & Register modes) */}
          {mode !== 'forgot' && (
            <>
              <div className="relative my-2 text-center">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-zinc-800" />
                </div>
                <span className="relative bg-zinc-900 px-2 text-[10px] text-zinc-500 uppercase">یا</span>
              </div>

              <button
                type="button"
                onClick={handleGoogleLogin}
                disabled={isSubmitting}
                className="w-full py-2 bg-zinc-950 hover:bg-zinc-850 border border-zinc-800 text-zinc-200 font-semibold rounded-xl transition flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24">
                  <path fill="#EA4335" d="M12 5c1.6 0 3 .6 4.1 1.6l3.1-3.1C17.3 1.7 14.8 1 12 1 7.5 1 3.7 3.6 1.9 7.3l3.7 2.9C6.5 7.4 9 5 12 5z" />
                  <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.7-.2-2.3H12v4.5h6.5c-.3 1.5-1.1 2.8-2.4 3.7l3.7 2.9c2.2-2 3.7-5 3.7-8.8z" />
                  <path fill="#FBBC05" d="M5.6 14.8c-.2-.7-.4-1.5-.4-2.8s.2-2.1.4-2.8L1.9 6.3C.7 8.7 0 10.3 0 12s.7 3.3 1.9 5.7l3.7-2.9z" />
                  <path fill="#34A853" d="M12 23c3.2 0 6-1.1 8-3l-3.7-2.9c-1.1.7-2.5 1.2-4.3 1.2-3 0-5.5-2.4-6.4-5.2L1.9 16C3.7 19.7 7.5 23 12 23z" />
                </svg>
                <span>ورود و ثبت‌نام سریع با حساب گوگل</span>
              </button>
            </>
          )}

          {/* Privacy & Zero-Trust Notice */}
          <div className="pt-2 text-center text-[10px] text-zinc-500 font-mono flex items-center justify-center gap-1.5 border-t border-zinc-800/80">
            <ShieldCheck className="w-3.5 h-3.5 text-zinc-600" />
            <span>پروفایل مستقل کاربری در پایگاه داده امن ابری AutoPin Pro</span>
          </div>
        </div>
      </div>
    </div>
  );
};
