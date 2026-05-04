export function normalizeAuthEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function validateAuthForm(mode, form, step = null, t = (key) => key) {
  const validation = {};
  const email = normalizeAuthEmail(form.email);
  const password = String(form.password ?? '');
  const confirmPassword = String(form.confirmPassword ?? '');
  const shouldValidateEmail = mode === 'login' || step === null || step >= 0;
  const shouldValidateProfile = mode === 'register';
  const shouldValidatePassword = mode === 'login' || step === null || mode === 'register' || (mode === 'reset' && step >= 1);
  const shouldValidateConfirmPassword = mode === 'reset' && step === 1;
  const shouldValidateCode = (mode === 'register' && step === 3) || (mode === 'reset' && step === 2);

  if (shouldValidateEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    validation.email = t('auth.validationEmail');
  }

  if (shouldValidatePassword && password.length < 6) {
    validation.password = t('auth.validationPassword');
  }

  if (shouldValidateConfirmPassword && password && confirmPassword !== password) {
    validation.confirmPassword = t('auth.validationConfirmPassword');
  }

  if (shouldValidateProfile) {
    const displayName = String(form.displayName ?? '').trim();
    const handle = String(form.handle ?? '').trim();
    if (displayName.length < 2 || displayName.length > 40) {
      validation.displayName = t('auth.validationDisplayName');
    }
    if (!/^[a-z0-9_.]{3,20}$/.test(handle)) {
      validation.handle = t('auth.validationUsername');
    }
  }

  if (shouldValidateCode) {
    const code = String(form.emailCode ?? '').replace(/\D/g, '');
    if (!/^\d{6}$/.test(code)) {
      validation.emailCode = t('auth.validationEmailCode');
    }
  }

  return validation;
}
