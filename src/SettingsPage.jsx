import React, { useEffect, useReducer, useState } from 'react';
import {
  ArrowLeft,
  Bell,
  Check,
  HelpCircle,
  Languages as LanguagesIcon,
  LifeBuoy,
  Lock,
  Moon,
  Send,
  ShieldCheck,
  Trash2,
  UserRound,
  Volume2,
  X,
} from 'lucide-react';
import { Avatar, VerifiedBadgeIcon, VerifiedName } from './ui.jsx';
import { useI18n } from './i18n.jsx';

const privacyOptions = [
  ['low', 'profile.privacyLowName', 'settings.privacyLowText'],
  ['balanced', 'profile.privacyBalancedName', 'settings.privacyBalancedText'],
  ['strict', 'profile.privacyStrictName', 'settings.privacyStrictText'],
];

const privacyLabels = {
  low: 'profile.privacyLowName',
  balanced: 'profile.privacyBalancedName',
  strict: 'profile.privacyStrictName',
};

const localeByLanguage = {
  vi: 'vi-VN',
  en: 'en-US',
  ko: 'ko-KR',
};

const supportTopics = [
  ['chat-realtime', 'settings.topicChatRealtime'],
  ['account-login', 'settings.topicAccountLogin'],
  ['privacy-search', 'settings.topicPrivacySearch'],
  ['extra-plan', 'settings.topicExtraPlan'],
  ['ui-bug', 'settings.topicUiBug'],
  ['other', 'settings.topicOther'],
];

const initialSupportForm = {
  category: 'chat-realtime',
  subject: '',
  body: '',
  contact: '',
};

function flowReducer(state, action) {
  switch (action.type) {
    case 'push':
      if (!action.page || action.page === state.current) return state;
      return {
        current: action.page,
        history: [...state.history, state.current],
      };
    case 'replace':
      return {
        current: action.page || 'home',
        history: state.history,
      };
    case 'back': {
      const previous = state.history.at(-1);
      if (!previous) return state.current === 'home' ? state : { current: 'home', history: [] };
      return {
        current: previous,
        history: state.history.slice(0, -1),
      };
    }
    case 'reset':
      return { current: 'home', history: [] };
    default:
      return state;
  }
}

function formatDate(value, t, language) {
  if (!value) return t('settings.unknownTime');
  try {
    return new Intl.DateTimeFormat(localeByLanguage[language] || localeByLanguage.vi, {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return t('settings.unknownTime');
  }
}

export function SettingsPage({
  blockedUsers = [],
  currentUser,
  hasExtraPlan,
  initialPage = 'home',
  interactionSoundsEnabled = true,
  notificationsEnabled = true,
  profileForm,
  sessions = [],
  theme,
  onClose,
  onOpenProfile,
  onProfileFormChange,
  onRevokeAllSessions,
  onRevokeSession,
  onSaveProfile,
  onSetInteractionSoundsEnabled,
  onSetNotificationsEnabled,
  onSetTheme,
  onSubmitSupportRequest,
  onSubscribeExtraPlan,
  onCleanupLaunchTestData,
  onUnblockUser,
}) {
  const { language, languages, setLanguage, t } = useI18n();
  const [flow, dispatchFlow] = useReducer(flowReducer, { current: initialPage, history: [] });
  const [supportForm, setSupportForm] = useState(initialSupportForm);
  const [supportSending, setSupportSending] = useState(false);
  const page = flow.current;
  const isHome = page === 'home';
  const profile = profileForm ?? currentUser ?? {};
  const hasSearchPrivacy = Object.prototype.hasOwnProperty.call(profile, 'privacyLevel')
    || Object.prototype.hasOwnProperty.call(currentUser ?? {}, 'privacyLevel');
  const privacyLevel = hasSearchPrivacy ? (profile.privacyLevel || currentUser?.privacyLevel || 'balanced') : '';
  const blockedCount = blockedUsers.length;
  const sessionCount = sessions.length || 1;
  const isAdmin = currentUser?.isAdmin === true;

  useEffect(() => {
    dispatchFlow({ type: 'replace', page: initialPage || 'home' });
  }, [initialPage]);

  useEffect(() => {
    if (!hasSearchPrivacy && page === 'privacy') {
      dispatchFlow({ type: 'replace', page: 'home' });
    }
  }, [hasSearchPrivacy, page]);

  const pageTitle = {
    home: t('common.settings'),
    profile: t('settings.profile'),
    privacy: t('settings.searchPrivacy'),
    appearance: t('settings.appearance'),
    extra: t('settings.extra'),
    security: t('settings.security'),
    help: t('settings.help'),
    support: t('settings.support'),
    language: t('settings.languageTitle'),
  }[page];

  function Row({ icon: Icon, title, detail, onClick }) {
    return (
      <button className="settings-row" type="button" onClick={onClick}>
        <Icon size={20} />
        <span>{title}</span>
        {detail && <small>{detail}</small>}
      </button>
    );
  }

  function choosePrivacy(value) {
    onProfileFormChange?.((current) => ({ ...current, privacyLevel: value }));
  }

  function chooseTheme(value) {
    if (theme === value) return;
    onSetTheme?.(value);
  }

  function openPage(nextPage) {
    dispatchFlow({ type: 'push', page: nextPage });
  }

  function goBack() {
    dispatchFlow({ type: 'back' });
  }

  async function submitSupportForm(event) {
    event.preventDefault();
    if (!supportForm.subject.trim() || !supportForm.body.trim() || supportSending) return;
    setSupportSending(true);
    const sent = await onSubmitSupportRequest?.(supportForm);
    setSupportSending(false);
    if (sent) {
      setSupportForm(initialSupportForm);
      dispatchFlow({ type: 'replace', page: 'help' });
    }
  }

  return (
    <div className="settings-page-layer" onClick={onClose}>
      <section className="settings-page" onClick={(event) => event.stopPropagation()}>
        <header className="settings-header">
          {!isHome && (
            <button type="button" aria-label={t('settings.back')} onClick={goBack}>
              <ArrowLeft size={20} />
            </button>
          )}
          <strong>{pageTitle}</strong>
          <div>
            <button type="button" aria-label={t('common.close')} onClick={onClose}>
              <X size={22} />
            </button>
          </div>
        </header>

        {isHome && (
          <>
            <button className="settings-profile" type="button" onClick={() => openPage('profile')}>
              <Avatar src={profile.avatarUrl} name={profile.displayName} size={46} />
              <div>
                <strong>
                  <VerifiedName verified={hasExtraPlan}>{profile.displayName}</VerifiedName>
                </strong>
                <span>{profile.handle}</span>
                {hasSearchPrivacy && <small>{t('profile.privacy')}: {t(privacyLabels[privacyLevel] ?? privacyLevel)}</small>}
              </div>
            </button>

            <div className="settings-group">
              <Row icon={UserRound} title={t('settings.profile')} detail={t('settings.profileDetail')} onClick={() => openPage('profile')} />
              {hasSearchPrivacy && (
                <Row icon={Lock} title={t('settings.searchPrivacy')} detail={t(privacyLabels[privacyLevel] ?? privacyLevel)} onClick={() => openPage('privacy')} />
              )}
              <button className="settings-row" type="button" onClick={() => onSetNotificationsEnabled?.(!notificationsEnabled)}>
                <Bell size={20} />
                <span>{t('settings.messageNotifications')}</span>
                <small>{notificationsEnabled ? t('settings.enabled') : t('settings.disabled')}</small>
              </button>
              <button className="settings-row" type="button" onClick={() => onSetInteractionSoundsEnabled?.(!interactionSoundsEnabled)}>
                <Volume2 size={20} />
                <span>{t('settings.interactionSounds')}</span>
                <small>{interactionSoundsEnabled ? t('settings.enabled') : t('settings.disabled')}</small>
              </button>
              <Row icon={Moon} title={t('settings.appearance')} detail={theme === 'dark' ? t('settings.dark') : t('settings.light')} onClick={() => openPage('appearance')} />
              <Row icon={LanguagesIcon} title={t('settings.language')} detail={languages[language]} onClick={() => openPage('language')} />
            </div>

            <div className="settings-group">
              <button className="settings-row extra-plan-row" type="button" onClick={() => openPage('extra')}>
                <span className="extra-plan-icon">
                  <VerifiedBadgeIcon size={22} />
                </span>
                <div>
                  <span>{t('settings.extra')}</span>
                  <small>{hasExtraPlan ? t('settings.verifiedBadgeActive') : t('settings.verifiedBadgeSubscribe')}</small>
                </div>
                <strong>{hasExtraPlan ? t('settings.enabled') : t('common.open')}</strong>
              </button>
            </div>

            <div className="settings-group">
              <Row icon={ShieldCheck} title={t('settings.security')} detail={t('settings.securityDetailCounts', { sessions: sessionCount, blocked: blockedCount })} onClick={() => openPage('security')} />
              <Row icon={HelpCircle} title={t('settings.help')} detail={t('settings.quickGuide')} onClick={() => openPage('help')} />
            </div>

            {isAdmin && (
              <div className="settings-group">
                <button className="settings-row danger-row" type="button" onClick={onCleanupLaunchTestData}>
                  <Trash2 size={20} />
                  <span>{t('settings.cleanupData')}</span>
                  <small>{t('settings.cleanupDataDetail')}</small>
                </button>
              </div>
            )}
          </>
        )}

        {page === 'profile' && (
          <div className="settings-subpage">
            <Avatar src={profile.avatarUrl} name={profile.displayName} size={64} />
            <h3>
              <VerifiedName verified={hasExtraPlan}>{profile.displayName}</VerifiedName>
            </h3>
            <p>{profile.handle}</p>
            <button type="button" className="primary-action compact" onClick={onOpenProfile}>
              {t('profile.editProfile')}
            </button>
          </div>
        )}

        {hasSearchPrivacy && page === 'privacy' && (
          <div className="settings-subpage align-stretch">
            <Lock size={28} />
            <h3>{t('settings.searchPrivacy')}</h3>
            <p>{t('settings.privacyHelp')}</p>
            <div className="settings-choice-list">
              {privacyOptions.map(([value, title, detail]) => (
                <button key={value} type="button" className="settings-choice" onClick={() => choosePrivacy(value)}>
                  <span>
                    <strong>{t(title)}</strong>
                    <small>{t(detail)}</small>
                  </span>
                  {privacyLevel === value && <Check size={18} />}
                </button>
              ))}
            </div>
            <button type="button" className="primary-action compact" onClick={onSaveProfile}>
              {t('common.save')}
            </button>
          </div>
        )}

        {page === 'appearance' && (
          <div className="settings-subpage align-stretch">
            <Moon size={28} />
            <h3>{t('settings.appearance')}</h3>
            <div className="settings-choice-list">
              {[ 
                ['light', t('settings.light'), t('settings.lightDetail')],
                ['dark', t('settings.dark'), t('settings.darkDetail')],
              ].map(([value, title, detail]) => (
                <button key={value} type="button" className="settings-choice" onClick={() => chooseTheme(value)}>
                  <span>
                    <strong>{title}</strong>
                    <small>{detail}</small>
                  </span>
                  {theme === value && <Check size={18} />}
                </button>
              ))}
            </div>
          </div>
        )}

        {page === 'language' && (
          <div className="settings-subpage align-stretch">
            <LanguagesIcon size={28} />
            <h3>{t('settings.languageTitle')}</h3>
            <p>{t('settings.chooseLanguage')}</p>
            <div className="settings-choice-list">
              {Object.entries(languages).map(([value, label]) => (
                <button key={value} type="button" className="settings-choice" onClick={() => setLanguage(value)}>
                  <span>
                    <strong>{label}</strong>
                    <small>{t(value === 'vi' ? 'settings.languageVi' : value === 'ko' ? 'settings.languageKo' : 'settings.languageEn')}</small>
                  </span>
                  {language === value && <Check size={18} />}
                </button>
              ))}
            </div>
          </div>
        )}

        {page === 'extra' && (
          <div className="settings-subpage">
            <VerifiedBadgeIcon size={42} />
            <h3>{hasExtraPlan ? t('settings.extraActiveTitle') : t('settings.extraSubscribeTitle')}</h3>
            <p>{hasExtraPlan ? t('settings.extraActiveText') : t('settings.extraSubscribeText')}</p>
            <button type="button" className="primary-action compact" onClick={onSubscribeExtraPlan} disabled={hasExtraPlan}>
              {hasExtraPlan ? t('settings.extraSubscribed') : t('settings.extraSubscribe')}
            </button>
          </div>
        )}

        {page === 'security' && (
          <div className="settings-subpage align-stretch">
            <ShieldCheck size={28} />
            <h3>{t('settings.securityTitle')}</h3>
            <div className="settings-stat-grid">
              <div>
                <strong>{sessionCount}</strong>
                <span>{t('settings.loginSessions')}</span>
              </div>
              <div>
                <strong>{blockedCount}</strong>
                <span>{t('settings.blockedUsers')}</span>
              </div>
            </div>

            <section className="settings-list-section">
              <strong>{t('settings.loginSessions')}</strong>
              {(sessions.length ? sessions : [{ id: 'current', userAgent: t('common.currentDevice') }]).map((session) => (
                <div className="settings-manage-row" key={session.id}>
                  <span>
                    <strong>{session.userAgent || t('common.device')}</strong>
                    <small>{t('common.recent')}: {formatDate(session.lastUsedAt || session.createdAt, t, language)}</small>
                  </span>
                  {session.id !== 'current' && (
                    <button type="button" onClick={() => onRevokeSession?.(session.id)}>
                      {t('settings.revoke')}
                    </button>
                  )}
                </div>
              ))}
              {sessions.length > 1 && (
                <button type="button" className="settings-danger" onClick={onRevokeAllSessions}>
                  {t('settings.logoutAllSessions')}
                </button>
              )}
            </section>

            <section className="settings-list-section">
              <strong>{t('inspector.blocked')}</strong>
              {blockedUsers.length === 0 && <p>{t('settings.noBlocked')}</p>}
              {blockedUsers.map((item) => (
                <div className="settings-manage-row" key={item.blockedId}>
                  <span>
                    <strong>{item.user?.displayName || item.user?.handle || t('common.user')}</strong>
                    <small>{item.user?.handle || t('common.noUsername')}</small>
                  </span>
                  <button type="button" onClick={() => onUnblockUser?.(item.blockedId)}>
                    {t('message.unblock')}
                  </button>
                </div>
              ))}
            </section>
          </div>
        )}

        {page === 'help' && (
          <div className="settings-subpage align-stretch">
            <HelpCircle size={28} />
            <h3>{t('settings.supportTitle')}</h3>
            <p>{t('settings.supportHint')}</p>
            <div className="settings-choice-list">
              <button type="button" className="settings-choice support-entry-choice" onClick={() => openPage('support')}>
                <span>
                  <strong>{t('settings.supportSendForm')}</strong>
                  <small>{t('settings.supportSendFormDetail')}</small>
                </span>
                <LifeBuoy size={18} />
              </button>
              {hasSearchPrivacy && (
                <button type="button" className="settings-choice" onClick={() => openPage('privacy')}>
                  <span>
                    <strong>{t('settings.supportFindUser')}</strong>
                    <small>{t('settings.supportFindUserDetail')}</small>
                  </span>
                </button>
              )}
              <button type="button" className="settings-choice" onClick={() => openPage('security')}>
                <span>
                  <strong>{t('settings.supportLogin')}</strong>
                  <small>{t('settings.supportLoginDetail')}</small>
                </span>
              </button>
              <button type="button" className="settings-choice" onClick={() => openPage('security')}>
                <span>
                  <strong>{t('settings.supportRealtime')}</strong>
                  <small>{t('settings.supportRealtimeDetail')}</small>
                </span>
              </button>
              <button type="button" className="settings-choice" onClick={() => openPage('extra')}>
                <span>
                  <strong>{t('settings.supportExtra')}</strong>
                  <small>{t('settings.supportExtraDetail')}</small>
                </span>
              </button>
              <button type="button" className="settings-choice" onClick={onOpenProfile}>
                <span>
                  <strong>{t('settings.supportProfile')}</strong>
                  <small>{t('settings.supportProfileDetail')}</small>
                </span>
              </button>
              <button type="button" className="settings-choice" onClick={onClose}>
                <span>
                  <strong>{t('settings.backToChat')}</strong>
                  <small>{t('settings.backToChatDetail')}</small>
                </span>
              </button>
            </div>
          </div>
        )}

        {page === 'support' && (
          <form className="settings-subpage align-stretch support-form" onSubmit={submitSupportForm}>
            <LifeBuoy size={28} />
            <h3>{t('settings.supportFormTitle')}</h3>
            <p>{t('settings.supportFormHint')}</p>

            <label>
              <span>{t('settings.issueType')}</span>
              <select
                value={supportForm.category}
                onChange={(event) => setSupportForm((current) => ({ ...current, category: event.target.value }))}
              >
                {supportTopics.map(([value, label]) => (
                  <option key={value} value={value}>{t(label)}</option>
                ))}
              </select>
            </label>

            <label>
              <span>{t('settings.subject')}</span>
              <input
                maxLength={120}
                placeholder={t('settings.subjectPlaceholder')}
                value={supportForm.subject}
                onChange={(event) => setSupportForm((current) => ({ ...current, subject: event.target.value }))}
              />
            </label>

            <label>
              <span>{t('settings.description')}</span>
              <textarea
                maxLength={1800}
                rows={5}
                placeholder={t('settings.descriptionPlaceholder')}
                value={supportForm.body}
                onChange={(event) => setSupportForm((current) => ({ ...current, body: event.target.value }))}
              />
            </label>

            <label>
              <span>{t('settings.contactMore')}</span>
              <input
                maxLength={120}
                placeholder={t('settings.contactPlaceholder')}
                value={supportForm.contact}
                onChange={(event) => setSupportForm((current) => ({ ...current, contact: event.target.value }))}
              />
            </label>

            <button type="submit" className="primary-action compact" disabled={supportSending || !supportForm.subject.trim() || !supportForm.body.trim()}>
              <Send size={16} />
              {supportSending ? t('settings.sending') : t('settings.sendAdmin')}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
