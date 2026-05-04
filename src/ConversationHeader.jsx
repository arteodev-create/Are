import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Bot, Info, Lock, MoreVertical, Search, PanelRightOpen, PanelRightClose } from 'lucide-react';
import { Avatar, isVerifiedUser, VerifiedName } from './ui.jsx';
import { useI18n } from './i18n.jsx';

export function ConversationHeader({
  activeChat,
  isPrivateChat,
  kindIcon,
  peerProfile,
  privateStatus,
  showInspector,
  onOpenInfo,
  onOpenSearch,
  onOpenSecurity,
  onBackToChats,
  onToggleInspector,
}) {
  const { t } = useI18n();
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const moreMenuRef = useRef(null);

  useEffect(() => {
    if (!showMoreMenu) return undefined;

    function closeMenu(event) {
      if (moreMenuRef.current?.contains(event.target)) return;
      setShowMoreMenu(false);
    }

    function closeWithEscape(event) {
      if (event.key === 'Escape') setShowMoreMenu(false);
    }

    document.addEventListener('mousedown', closeMenu);
    document.addEventListener('keydown', closeWithEscape);
    return () => {
      document.removeEventListener('mousedown', closeMenu);
      document.removeEventListener('keydown', closeWithEscape);
    };
  }, [showMoreMenu]);

  function runMenuAction(action) {
    setShowMoreMenu(false);
    action?.();
  }

  const roleLabel = activeChat.myRole ? t(`role.${activeChat.myRole}`) : '';
  const policyLabel = activeChat.kind === 'channel'
    ? t('header.adminsOnly')
    : activeChat.kind === 'group'
      ? t('header.membersCanPost')
      : '';

  return (
    <header className="conversation-header">
      <div className="conversation-title">
        <button className="icon-button mobile-back-button" type="button" aria-label={t('header.back')} onClick={onBackToChats}>
          <ArrowLeft size={20} />
        </button>
        <span className="avatar large">
          {activeChat.isAi
            ? (activeChat.avatarUrl ? <Avatar src={activeChat.avatarUrl} name={activeChat.name} size={20} /> : <Bot size={20} />)
            : isPrivateChat ? <Avatar src={peerProfile?.avatarUrl || activeChat.avatarUrl} name={activeChat.name} size={20} /> : kindIcon(activeChat.kind, 20)}
        </span>
        <div>
          <h2>
            <VerifiedName verified={!activeChat.isAi && (isPrivateChat ? isVerifiedUser(peerProfile) : isVerifiedUser(activeChat))}>
              {activeChat.name}
            </VerifiedName>
          </h2>
          <span>
            {activeChat.isAi
              ? `${t('common.aiModel')} ${activeChat.aiPrivacy === 'public' ? t('header.public') : t('header.private')} · ${activeChat.handle}`
              : isPrivateChat
              ? `${privateStatus || t('lastSeen.offline')} · ${activeChat.handle}`
              : `${activeChat.kind === 'channel' ? t('header.channel') : t('header.community')} ${activeChat.privacyLevel === 'private' ? t('header.private') : t('header.public')} · ${policyLabel} · ${activeChat.handle} · ${roleLabel}`}
          </span>
        </div>
      </div>
      <div className="header-actions">
        {activeChat.id && (
          <button
            className="icon-button"
            aria-label={showInspector ? t('header.hideInfo') : t('header.showInfo')}
            onClick={onToggleInspector}
          >
            {showInspector ? <PanelRightClose size={19} /> : <PanelRightOpen size={19} />}
          </button>
        )}
        {isPrivateChat && (
          <button className="icon-button" aria-label={t('header.security')} onClick={onOpenSecurity}>
            <Lock size={19} />
          </button>
        )}
        <div className="header-more" ref={moreMenuRef}>
          <button
            className="icon-button"
            type="button"
            aria-label={t('header.options')}
            aria-expanded={showMoreMenu}
            onClick={() => setShowMoreMenu((current) => !current)}
          >
            <MoreVertical size={19} />
          </button>
          {showMoreMenu && (
            <div className="header-more-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => runMenuAction(onOpenInfo || onToggleInspector)}>
                <Info size={17} />
                {t('header.chatInfo')}
              </button>
              <button type="button" role="menuitem" onClick={() => runMenuAction(onOpenSearch || onToggleInspector)}>
                <Search size={17} />
                {t('header.searchChat')}
              </button>
              <button type="button" role="menuitem" onClick={() => runMenuAction(onToggleInspector)}>
                {showInspector ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
                {showInspector ? t('header.hideInfo') : t('header.showInfo')}
              </button>
              {isPrivateChat && (
                <button type="button" role="menuitem" onClick={() => runMenuAction(onOpenSecurity)}>
                  <Lock size={17} />
                  {t('header.securityPrivacy')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
