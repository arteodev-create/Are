import React, { useState } from 'react';
import { ArrowLeft, AtSign, Ban, Camera, Edit3, Info, Lock, Share2, ShieldCheck, Smartphone, UserRound } from 'lucide-react';
import { Avatar, VerifiedName } from './ui.jsx';
import { useI18n } from './i18n.jsx';

export function ProfilePage({
  blockedCount,
  chatCount,
  currentUser,
  hasExtraPlan,
  profileForm,
  sessionCount,
  onClose,
  onProfileFormChange,
  onSave,
  onShareProfile,
  onUploadAvatar,
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState('view');
  const privacyCopy = {
    low: [t('profile.privacyLowName'), t('profile.privacyLowText')],
    balanced: [t('profile.privacyBalancedName'), t('profile.privacyBalancedText')],
    strict: [t('profile.privacyStrictName'), t('profile.privacyStrictText')],
  };
  const displayName = profileForm.displayName || currentUser.displayName || t('common.user');
  const handle = profileForm.handle || currentUser.handle || '@username';
  const avatarUrl = profileForm.avatarUrl || currentUser.avatarUrl;
  const bio = profileForm.bio?.trim();
  const hasSearchPrivacy = Object.prototype.hasOwnProperty.call(profileForm, 'privacyLevel')
    || Object.prototype.hasOwnProperty.call(currentUser ?? {}, 'privacyLevel');
  const [privacyTitle, privacyDetail] = privacyCopy[profileForm.privacyLevel] ?? privacyCopy.balanced;
  const isEditing = mode === 'edit';

  return (
    <div className="profile-page-layer" onClick={onClose}>
      <section className="profile-page social-profile-page profile-modal profile-shell" onClick={(event) => event.stopPropagation()}>
        <header className="profile-modal-header profile-shell-header">
          <button type="button" aria-label={t('common.back')} onClick={isEditing ? () => setMode('view') : onClose}>
            <ArrowLeft size={20} />
          </button>
          <div>
            <span>{isEditing ? t('profile.editTitle') : t('profile.title')}</span>
            <strong>
              <VerifiedName verified={hasExtraPlan}>{displayName}</VerifiedName>
            </strong>
          </div>
        </header>

        {!isEditing && (
          <div className="profile-view messenger-profile-view">
            <section className="messenger-profile-head">
              <Avatar src={avatarUrl} name={displayName} size={96} />
              <strong>
                <VerifiedName verified={hasExtraPlan}>{displayName}</VerifiedName>
              </strong>
              <span>{handle}</span>
              <div className="profile-head-actions">
                <button type="button" className="profile-edit-primary" onClick={() => setMode('edit')}>
                  <Edit3 size={16} />
                  {t('profile.editProfile')}
                </button>
                <button type="button" className="profile-share-action" onClick={() => onShareProfile?.({ ...currentUser, ...profileForm, displayName, handle, avatarUrl })}>
                  <Share2 size={16} />
                  {t('profile.shareProfile')}
                </button>
              </div>
            </section>

            <section className="messenger-info-list" aria-label={t('profile.info')}>
              <div>
                <AtSign size={20} />
                <span>
                  <strong>{handle}</strong>
                  <small>{t('profile.username')}</small>
                </span>
              </div>
              <div>
                <Info size={20} />
                <span>
                  <strong>{bio || t('profile.noBio')}</strong>
                  <small>{t('profile.bio')}</small>
                </span>
              </div>
              {hasSearchPrivacy && (
                <div>
                  <Lock size={20} />
                  <span>
                    <strong>{privacyTitle}</strong>
                    <small>{privacyDetail}</small>
                  </span>
                </div>
              )}
            </section>

            <section className="messenger-info-list compact" aria-label={t('profile.accountOverview')}>
              <div>
                <UserRound size={20} />
                <span>
                  <strong>{chatCount}</strong>
                  <small>{t('profile.conversations')}</small>
                </span>
              </div>
              <div>
                <Smartphone size={20} />
                <span>
                  <strong>{sessionCount || 1}</strong>
                  <small>{t('profile.sessions')}</small>
                </span>
              </div>
              <div>
                <Ban size={20} />
                <span>
                  <strong>{blockedCount}</strong>
                  <small>{t('profile.blocked')}</small>
                </span>
              </div>
              <div>
                <ShieldCheck size={20} />
                <span>
                  <strong>{hasExtraPlan ? 'Extra' : 'Free'}</strong>
                  <small>{t('profile.plan')}</small>
                </span>
              </div>
            </section>
          </div>
        )}

        {isEditing && (
          <form className="profile-page-form profile-edit-form" onSubmit={onSave}>
            <section className="profile-edit-top">
              <div className="profile-avatar-wrap">
                <Avatar src={avatarUrl} name={displayName} size={116} />
                <label className="avatar-edit-button" aria-label={t('profile.avatar')}>
                  <Camera size={15} />
                  <input type="file" accept="image/*" onChange={(event) => onUploadAvatar(event.target.files)} />
                </label>
              </div>
              <div>
                <strong>{displayName}</strong>
                <span>{handle}</span>
                <p>{t('profile.editHint')}</p>
              </div>
            </section>

            <div className="profile-modal-grid profile-edit-grid">
              <label className="profile-field">
                <span>{t('profile.displayName')}</span>
                <input
                  className="profile-display-input"
                  maxLength="40"
                  required
                  value={profileForm.displayName}
                  onChange={(event) => onProfileFormChange((current) => ({ ...current, displayName: event.target.value.replace(/\s+/g, ' ').slice(0, 40) }))}
                  placeholder={t('profile.displayNamePlaceholder')}
                />
              </label>

              <label className="profile-field">
                <span>{t('profile.username')}</span>
                <input
                  value={profileForm.handle}
                  maxLength="21"
                  required
                  onChange={(event) => {
                    const nextHandle = event.target.value.replace(/^@+/, '').toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 20);
                    onProfileFormChange((current) => ({ ...current, handle: nextHandle ? `@${nextHandle}` : '' }));
                  }}
                  placeholder="@username"
                />
              </label>

              <label className="profile-field profile-field-wide">
                <span>{t('profile.bio')}</span>
                <textarea
                  className="profile-bio-input"
                  value={profileForm.bio}
                  maxLength="160"
                  onChange={(event) => onProfileFormChange((current) => ({ ...current, bio: event.target.value.slice(0, 160) }))}
                  rows="4"
                  placeholder={t('profile.writeBio')}
                />
                <small>{profileForm.bio.length}/160</small>
              </label>

              {hasSearchPrivacy && (
                <label className="profile-field">
                  <span>{t('profile.privacy')}</span>
                  <select value={profileForm.privacyLevel} onChange={(event) => onProfileFormChange((current) => ({ ...current, privacyLevel: event.target.value }))}>
                    <option value="low">{t('profile.privacyLowName')}</option>
                    <option value="balanced">{t('profile.privacyBalancedName')}</option>
                    <option value="strict">{t('profile.privacyStrictName')}</option>
                  </select>
                </label>
              )}

              <label className="profile-field">
                <span>{t('profile.avatarLink')}</span>
                <input value={profileForm.avatarUrl} onChange={(event) => onProfileFormChange((current) => ({ ...current, avatarUrl: event.target.value }))} placeholder="https://..." />
              </label>
            </div>

            <div className="profile-modal-note">
              <ShieldCheck size={17} />
              <span>{t('profile.usernameRule')}</span>
            </div>

            <footer className="profile-modal-footer">
              <button type="button" className="profile-cancel-action" onClick={() => setMode('view')}>
                {t('common.cancel')}
              </button>
              <button className="profile-save-action" type="submit">
                {t('profile.saveChanges')}
              </button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}
