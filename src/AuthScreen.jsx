import React from 'react';
import { useI18n } from './i18n.jsx';

export function AuthScreen({
  authMode,
  authStep,
  authForm,
  authValidation,
  authError,
  authSubmitting,
  theme,
  onAuthenticate,
  onAuthFieldChange,
  onAuthModeChange,
  onAuthStepChange,
  onResendAuthCode,
  onAuthErrorClear,
}) {
  const { language, languages, setLanguage, t } = useI18n();

  function switchMode(nextMode) {
    onAuthModeChange(nextMode);
    onAuthErrorClear();
  }

  const isRegister = authMode === 'register';
  const isReset = authMode === 'reset';
  const isRegisterCodeStep = isRegister && authStep === 3;
  const resetSteps = [
    t('auth.stepEmail'),
    t('auth.stepPassword'),
    t('auth.stepVerify'),
  ];
  const title = authMode === 'login' ? t('auth.loginTitle') : isRegister ? t('auth.registerTitle') : t('auth.resetTitle');
  const hint = authMode === 'login' ? t('auth.loginHint') : isRegister ? t('auth.registerHint') : t('auth.resetHint');
  const submitLabel = authSubmitting
    ? t('common.loading')
    : authMode === 'login'
      ? t('auth.login')
      : isReset && authStep < 1
        ? t('common.next')
        : (isRegister && !isRegisterCodeStep) || (isReset && authStep === 1)
          ? t('auth.sendCode')
          : isRegister
            ? t('auth.verifyEmail')
            : t('auth.resetPassword');

  return (
    <main className={`auth-shell theme-${theme}`}>
      <select
        className="auth-language-select"
        value={language}
        aria-label={t('settings.language')}
        onChange={(event) => setLanguage(event.target.value)}
      >
        {Object.entries(languages).map(([value, label]) => (
          <option key={value} value={value}>{label}</option>
        ))}
      </select>

      <div className="auth-frame">
        <section className="auth-logo-panel" aria-label="Veritas">
          <div className="brand-mark">
            <img className="veritas-auth-mark" src="/veritas-icon.svg" alt="" aria-hidden="true" />
          </div>
        </section>

        <form className={`auth-panel telegram-auth auth-${authMode}`} onSubmit={onAuthenticate}>
          <div className="mobile-auth-brand" aria-label="Veritas">
            <img src="/veritas-icon.svg" alt="" aria-hidden="true" />
            <span>Veritas</span>
          </div>

          <div className="auth-form-head">
            <strong>{title}</strong>
            <span>{hint}</span>
          </div>

          {isReset && (
            <div className="auth-flow three" aria-label={t('auth.registerProgress')}>
              {resetSteps.map((label, index) => (
                <span key={label} className={index === authStep ? 'active' : index < authStep ? 'done' : ''}>
                  {label}
                </span>
              ))}
            </div>
          )}

          <div className="auth-step-body">
            {(authMode === 'login' || (isRegister && !isRegisterCodeStep) || (isReset && authStep === 0)) && (
              <>
                <label className="floating-field">
                  <span>{t('auth.email')}</span>
                  <input
                    type="email"
                    value={authForm.email}
                    onChange={(event) => onAuthFieldChange('email', event.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                    aria-invalid={Boolean(authValidation.email)}
                  />
                </label>
                {authValidation.email && <span className="field-error">{authValidation.email}</span>}
              </>
            )}

            {isRegister && !isRegisterCodeStep && (
              <>
                <div className="auth-register-grid">
                  <div>
                    <label className="floating-field">
                      <span>{t('auth.displayName')}</span>
                      <input
                        value={authForm.displayName}
                        onChange={(event) => onAuthFieldChange('displayName', event.target.value)}
                        placeholder={t('auth.displayNamePlaceholder')}
                        maxLength={40}
                        autoComplete="name"
                        aria-invalid={Boolean(authValidation.displayName)}
                      />
                    </label>
                    {authValidation.displayName && <span className="field-error">{authValidation.displayName}</span>}
                  </div>

                  <div>
                    <label className="floating-field">
                      <span>{t('auth.username')}</span>
                      <input
                        value={authForm.handle}
                        onChange={(event) => onAuthFieldChange('handle', event.target.value)}
                        placeholder="@username"
                        maxLength={20}
                        autoComplete="username"
                        aria-invalid={Boolean(authValidation.handle)}
                      />
                    </label>
                    {authValidation.handle && <span className="field-error">{authValidation.handle}</span>}
                  </div>
                </div>
              </>
            )}

            {(authMode === 'login' || (isRegister && !isRegisterCodeStep) || (isReset && authStep === 1)) && (
              <>
                <label className="floating-field">
                  <span>{isReset ? t('auth.newPassword') : t('auth.password')}</span>
                  <input
                    type="password"
                    value={authForm.password}
                    onChange={(event) => onAuthFieldChange('password', event.target.value)}
                    placeholder={isReset ? t('auth.newPassword') : t('auth.password')}
                    maxLength={64}
                    autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
                    aria-invalid={Boolean(authValidation.password)}
                  />
                </label>
                {authValidation.password && <span className="field-error">{authValidation.password}</span>}
                {isReset && (
                  <>
                    <label className="floating-field">
                      <span>{t('auth.confirmPassword')}</span>
                      <input
                        type="password"
                        value={authForm.confirmPassword}
                        onChange={(event) => onAuthFieldChange('confirmPassword', event.target.value)}
                        placeholder={t('auth.confirmPassword')}
                        maxLength={64}
                        autoComplete="new-password"
                        aria-invalid={Boolean(authValidation.confirmPassword)}
                      />
                    </label>
                    {authValidation.confirmPassword && <span className="field-error">{authValidation.confirmPassword}</span>}
                  </>
                )}
              </>
            )}

            {((isRegisterCodeStep) || (isReset && authStep === 2)) && (
              <>
                <div className="auth-code-note">
                  <strong>{t('auth.checkEmail')}</strong>
                  <span>{authForm.email}</span>
                </div>
                <label className="floating-field">
                  <span>{t('auth.emailCode')}</span>
                  <input
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={authForm.emailCode}
                    onChange={(event) => onAuthFieldChange('emailCode', event.target.value)}
                    placeholder="000000"
                    maxLength={6}
                    autoComplete="one-time-code"
                    aria-invalid={Boolean(authValidation.emailCode)}
                  />
                </label>
                {authValidation.emailCode && <span className="field-error">{authValidation.emailCode}</span>}
                <button className="auth-back-link" type="button" onClick={onResendAuthCode} disabled={authSubmitting}>
                  {t('auth.resendCode')}
                </button>
              </>
            )}

            {authError && <span className="form-error">{authError}</span>}
          </div>

          <button className="primary-action" type="submit" disabled={authSubmitting}>
            {submitLabel}
          </button>

          <div className="auth-secondary-actions">
            {authMode !== 'login' && authStep > 0 && (
              <button className="auth-back-link" type="button" onClick={() => onAuthStepChange(isRegister ? 0 : Math.max(0, authStep - 1))}>
                {t('common.back')}
              </button>
            )}

            {authMode === 'login' && (
              <button className="auth-back-link" type="button" onClick={() => switchMode('reset')}>
                {t('auth.forgotPassword')}
              </button>
            )}
          </div>

          <div className="auth-account-switch">
            <span>{authMode === 'login' ? t('auth.noAccount') : t('auth.hasAccount')}</span>
            <button className="auth-link" type="button" onClick={() => switchMode(authMode === 'login' ? 'register' : 'login')}>
              {authMode === 'login' ? t('auth.register') : t('auth.login')}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
