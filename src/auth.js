export function normalizeAuthEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

function hashEmail(value) {
  let hash = 0;
  for (const char of value) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash).toString(36).padStart(4, '0').slice(0, 4);
}

function titleFromEmailLocalPart(localPart) {
  const words = localPart
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const title = words
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1, 20).toLowerCase())
    .join(' ')
    .slice(0, 40)
    .trim();
  return title.length >= 2 ? title : 'Veritas User';
}

export function registerProfileFromEmail(emailValue) {
  const email = normalizeAuthEmail(emailValue);
  const localPart = email.split('@')[0] || 'veritas';
  const displayName = titleFromEmailLocalPart(localPart);
  const handleBase = localPart
    .toLowerCase()
    .replace(/[^a-z0-9_.]+/g, '')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 15) || 'user';
  const handle = `${handleBase}_${hashEmail(email || handleBase)}`.slice(0, 20);
  return { displayName, handle };
}

export function validateAuthForm(mode, form, step = null, t = (key) => key) {
  const validation = {};
  const email = normalizeAuthEmail(form.email);
  const password = String(form.password ?? '');
  const confirmPassword = String(form.confirmPassword ?? '');
  const shouldValidateEmail = mode === 'login' || step === null || step >= 0;
  const shouldValidateProfile = mode === 'register';
  const shouldValidatePassword = mode === 'login'
    ? step === null || step >= 1
    : step === null || mode === 'register' || (mode === 'reset' && step >= 1);
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
    if (displayName && (displayName.length < 2 || displayName.length > 40)) {
      validation.displayName = t('auth.validationDisplayName');
    }
    if (handle && !/^[a-z0-9_.]{3,20}$/.test(handle)) {
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
