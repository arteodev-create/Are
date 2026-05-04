import React, { useRef } from 'react';
import {
  Bot,
  Image,
  LogOut,
  Megaphone,
  MessageCircle,
  Menu,
  Moon,
  Plus,
  Search,
  Settings,
  UserPlus,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import { Avatar, isVerifiedUser, VerifiedName } from './ui.jsx';
import { LoadingState } from './LoadingSpinner.jsx';
import { useI18n } from './i18n.jsx';

export function Sidebar({
  activeChatId,
  chats,
  currentUser,
  filteredChats,
  hasExtraPlan,
  kindIcon,
  kindLabels,
  newChat,
  searchQuery,
  showCreator,
  stageLoading,
  showMainMenu,
  theme,
  userSearchResults,
  onCreateConversation,
  onNewChatChange,
  onUploadNewChatAvatar,
  onSearchChange,
  onSelectChat,
  onSetShowCreator,
  onSetShowMainMenu,
  onSetShowProfilePage,
  onSetShowSettingsPage,
  onSignOut,
  onJoinConversation,
  onStartPrivateConversation,
  onThemeToggle,
  onUiSound,
}) {
  const { t } = useI18n();
  const searchInputRef = useRef(null);

  function formatPreviewTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const today = new Date().toDateString();
    if (date.toDateString() === today) {
      return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
  }

  function previewText(chat) {
    const latest = chat.messages?.at(-1);
    if (latest?.attachments?.length && !latest.text) {
      const sentText = t('sidebar.attachmentSent');
      return latest.sender === 'me' ? t('sidebar.youPrefix', { text: sentText }) : sentText;
    }
    const text = chat.lastMessage || latest?.text || '';
    if (!text && chat.kind === 'channel') return t('sidebar.channelEmptyPreview');
    if (!text && chat.kind === 'group') return t('sidebar.communityEmptyPreview');
    if (!text && chat.handle) return chat.handle;
    if (!text && latest?.attachments?.length) return t('sidebar.attachmentSent');
    if (latest?.sender === 'me' && text) return t('sidebar.youPrefix', { text });
    return text;
  }

  function conversationSubtitle(item) {
    const countLabel = item.memberCount
      ? t(item.kind === 'channel' ? 'sidebar.followerCount' : 'sidebar.memberCount', { count: item.memberCount })
      : '';
    const base = [item.handle, kindLabels[item.kind], countLabel]
      .filter(Boolean)
      .join(' - ');
    const rule = item.kind === 'channel' ? t('sidebar.channelRule') : item.kind === 'group' ? t('sidebar.communityRule') : '';
    return [base, rule].filter(Boolean).join(' - ');
  }

  function openCreator(kind = 'group') {
    onUiSound?.('open');
    onNewChatChange({
      name: '',
      kind,
      handle: '',
      description: '',
      postingPolicy: kind === 'channel' ? 'admins' : 'members',
      privacyLevel: 'public',
      avatarUrl: '',
      systemPrompt: '',
      provider: 'openrouter',
      modelName: 'poolside/laguna-xs.2:free',
      privacy: 'private',
      apiKey: '',
    });
    onSetShowCreator(true);
  }

  const creatingChannel = newChat.kind === 'channel';
  const creatingAi = newChat.kind === 'ai';
  const creatorTitle = creatingAi ? t('sidebar.createAi') : creatingChannel ? t('sidebar.createChannel') : t('sidebar.createCommunityTitle');
  const creatorHint = creatingAi
    ? t('sidebar.aiHint')
    : creatingChannel
    ? t('sidebar.channelHint')
    : t('sidebar.communityHint');
  const conversationTypeSummary = creatingChannel
    ? t('sidebar.channelSummary')
    : t('sidebar.communitySummary');
  const chatSections = [
    ['channel', t('sidebar.channels'), filteredChats.filter((chat) => chat.kind === 'channel' && !chat.isAi)],
    ['group', t('sidebar.communities'), filteredChats.filter((chat) => chat.kind === 'group' && !chat.isAi)],
    ['private', t('sidebar.directMessages'), filteredChats.filter((chat) => chat.kind === 'private' && !chat.isAi)],
    ['ai', t('sidebar.aiModels'), filteredChats.filter((chat) => chat.isAi)],
  ].filter(([, , items]) => items.length > 0);

  function searchActionLabel(item) {
    if (!item || item.type !== 'conversation' && !['group', 'channel'].includes(item.kind)) return t('common.chat');
    if (item.isJoined) return t('common.open');
    if (item.joinStatus === 'pending') return t('sidebar.pendingJoin');
    return item.kind === 'channel' ? t('sidebar.followChannel') : t('sidebar.joinCommunity');
  }

  function renderChatPreview(chat) {
    return (
      <button key={chat.id} className={`chat-preview ${chat.id === activeChatId ? 'selected' : ''}`} onClick={() => onSelectChat(chat.id)}>
        <span className="avatar">
          {chat.isAi
            ? (chat.avatarUrl ? <Avatar src={chat.avatarUrl} name={chat.name} size={20} /> : <Bot size={20} />)
            : chat.kind === 'private' ? <Avatar src={chat.avatarUrl} name={chat.name} size={20} /> : kindIcon(chat.kind)}
        </span>
        <span className="chat-copy">
          <span className="chat-title">
            <span>{chat.name}</span>
            {chat.isAi && <span className="kind-badge ai">AI</span>}
          </span>
          <span className={`chat-subtitle ${chat.unread > 0 ? 'unread' : ''}`}>{previewText(chat)}</span>
        </span>
        <span className="chat-meta">
          <span className={chat.unread > 0 ? 'chat-time unread' : 'chat-time'}>{formatPreviewTime(chat.lastMessageAt || chat.messages?.at(-1)?.createdAt)}</span>
          {chat.unread > 0 && <span className="badge">{chat.unread}</span>}
        </span>
      </button>
    );
  }

  return (
    <>
      <aside className="sidebar">
        <header className="topbar">
          <button
            className="icon-button"
            aria-label={showMainMenu ? t('common.close') : t('common.menu')}
            aria-expanded={showMainMenu}
            onClick={(event) => {
              event.stopPropagation();
              onUiSound?.(showMainMenu ? 'close' : 'open');
              onSetShowMainMenu((current) => !current);
            }}
          >
            <Menu size={20} />
          </button>
          <strong>{t('sidebar.title')}</strong>
          <button className="icon-button" aria-label={t('sidebar.logout')} onClick={() => { onUiSound?.('tap'); onSignOut(); }}>
            <LogOut size={18} />
          </button>
        </header>

        <label className="search-box">
          <Search size={17} />
          <input ref={searchInputRef} value={searchQuery} onChange={(event) => onSearchChange(event.target.value)} placeholder={t('sidebar.searchPlaceholder')} />
        </label>

        <nav className="chat-list">
          {stageLoading && filteredChats.length === 0 && userSearchResults.length === 0 && (
            <LoadingState label={t('sidebar.loadingHistory')} />
          )}
          {searchQuery.trim() && userSearchResults.length > 0 && (
            <section className="people-search-results" aria-label={t('sidebar.searchResults')}>
              {userSearchResults.map((item) => {
                const isConversation = item.type === 'conversation' || ['group', 'channel'].includes(item.kind);
                const title = isConversation ? item.name : item.displayName;
                const subtitle = isConversation
                  ? conversationSubtitle(item)
                  : `${item.handle}${item.privacyLevel ? ` - ${item.privacyLevel === 'low' ? t('sidebar.public') : t('sidebar.searchRestricted')}` : ''}`;
                return (
                  <button
                    key={`${item.type || 'user'}-${item.id}`}
                    type="button"
                    className="chat-preview user-search-row"
                    onClick={() => (isConversation ? onJoinConversation?.(item) : onStartPrivateConversation(item))}
                  >
                    <span className="avatar">
                      {isConversation ? kindIcon(item.kind, 20) : <Avatar src={item.avatarUrl} name={item.displayName} size={20} />}
                    </span>
                    <span className="chat-copy">
                      <span className="chat-title">
                        {isConversation ? <span>{title}</span> : <VerifiedName verified={isVerifiedUser(item)}>{title}</VerifiedName>}
                        {isConversation && item.isJoined && <span className="kind-badge">{item.kind === 'channel' ? t('sidebar.following') : t('sidebar.joined')}</span>}
                        {isConversation && !item.isJoined && item.joinStatus === 'pending' && <span className="kind-badge">{t('sidebar.pendingJoin')}</span>}
                      </span>
                      <span className="chat-subtitle">{subtitle}</span>
                    </span>
                    <span className="search-open-label">{searchActionLabel(item)}</span>
                  </button>
                );
              })}
            </section>
          )}
          {chatSections.map(([sectionId, label, items]) => (
            <section className={`chat-section ${sectionId}`} key={sectionId} aria-label={label}>
              <div className="chat-section-title">
                <span>{label}</span>
                <small>{items.length}</small>
              </div>
              {items.map(renderChatPreview)}
            </section>
          ))}
          {!stageLoading && filteredChats.length === 0 && userSearchResults.length === 0 && (
            <div className="empty-chat-list">
              <MessageCircle size={22} />
              <span>{searchQuery.trim() ? t('sidebar.noResult') : t('sidebar.noConversations')}</span>
              <small>
                {searchQuery.trim()
                  ? t('sidebar.noResultHint')
                  : t('sidebar.emptyHint')}
              </small>
              <div className="empty-chat-actions">
                <button
                  type="button"
                  onClick={() => {
                    onSearchChange('@');
                    requestAnimationFrame(() => searchInputRef.current?.focus());
                  }}
                >
                  <Search size={15} />
                  {t('sidebar.findPeople')}
                </button>
                <button type="button" onClick={() => openCreator('group')}>
                  <Users size={15} />
                  {t('sidebar.createCommunity')}
                </button>
                <button type="button" onClick={() => openCreator('channel')}>
                  <Megaphone size={15} />
                  {t('sidebar.createChannel')}
                </button>
                <button type="button" onClick={() => { onUiSound?.('open'); onSetShowProfilePage(true); }}>
                  <UserRound size={15} />
                  {t('sidebar.profile')}
                </button>
              </div>
            </div>
          )}
        </nav>

        <button className="new-chat" onClick={() => openCreator('group')}>
          <UserPlus size={18} />
          {t('sidebar.createNew')}
        </button>
      </aside>

      {showCreator && (
        <div className="creator-layer" onMouseDown={() => { onUiSound?.('close'); onSetShowCreator(false); }}>
          <form className="creator creator-modal" onSubmit={onCreateConversation} onMouseDown={(event) => event.stopPropagation()}>
            <div className="creator-head">
              <div>
                <strong>{creatorTitle}</strong>
                <span>{creatorHint}</span>
              </div>
              <button className="icon-button small" type="button" aria-label={t('common.close')} onClick={() => { onUiSound?.('close'); onSetShowCreator(false); }}>
                <X size={16} />
              </button>
            </div>
            <div className="kind-row" aria-label={t('sidebar.conversationType')}>
              {['group', 'channel', 'ai'].map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={newChat.kind === kind ? 'active' : ''}
                  onClick={() => {
                    onUiSound?.('tap');
                    onNewChatChange((current) => ({
                      ...current,
                      kind,
                      postingPolicy: kind === 'channel' ? 'admins' : 'members',
                      privacyLevel: current.privacyLevel || 'public',
                      joinPolicy: current.joinPolicy || 'open',
                    }));
                  }}
                >
                  {kindIcon(kind, 16)}
                  {kindLabels[kind]}
                </button>
              ))}
            </div>
            <label className="creator-field">
              <span>{t('sidebar.displayName')}</span>
              <input required maxLength={64} value={newChat.name} onChange={(event) => onNewChatChange((current) => ({ ...current, name: event.target.value }))} placeholder={creatingAi ? t('sidebar.createAi') : creatingChannel ? t('sidebar.createChannel') : t('sidebar.createCommunityTitle')} autoFocus />
            </label>
            {creatingAi ? (
              <>
                <div className="creator-ai-avatar">
                  <span className="avatar">
                    {newChat.avatarUrl ? <Avatar src={newChat.avatarUrl} name={newChat.name} size={20} /> : <Bot size={20} />}
                  </span>
                  <label>
                    <Image size={16} />
                    {t('inspector.uploadAvatar')}
                    <input type="file" accept="image/*" onChange={(event) => onUploadNewChatAvatar?.(event.target.files)} />
                  </label>
                </div>
                <label className="creator-field">
                  <span>{t('inspector.prompt')}</span>
                  <textarea required maxLength={8000} rows={5} value={newChat.systemPrompt || ''} onChange={(event) => onNewChatChange((current) => ({ ...current, systemPrompt: event.target.value }))} placeholder={t('sidebar.aiPromptPlaceholder')} />
                </label>
                <label className="creator-field">
                  <span>{t('inspector.model')} OpenRouter</span>
                  <input value={newChat.modelName || 'poolside/laguna-xs.2:free'} onChange={(event) => onNewChatChange((current) => ({ ...current, modelName: event.target.value }))} placeholder="poolside/laguna-xs.2:free" />
                </label>
                <div className="kind-row creator-policy" aria-label={t('inspector.privacy')}>
                  {[
                    ['private', t('sidebar.private')],
                    ['public', t('sidebar.public')],
                  ].map(([value, label]) => (
                    <button key={value} type="button" className={(newChat.privacy || 'private') === value ? 'active' : ''} onClick={() => onNewChatChange((current) => ({ ...current, privacy: value }))}>
                      {label}
                    </button>
                  ))}
                </div>
                <label className="creator-field">
                  <span>OpenRouter {t('inspector.apiKey')}</span>
                  <input required type="password" value={newChat.apiKey || ''} onChange={(event) => onNewChatChange((current) => ({ ...current, apiKey: event.target.value, provider: 'openrouter' }))} placeholder="sk-or-..." />
                </label>
              </>
            ) : (
              <>
                <div className={`conversation-kind-summary ${creatingChannel ? 'channel' : 'community'}`}>
                  <span>{creatingChannel ? t('sidebar.channel') : t('sidebar.community')}</span>
                  <strong>{conversationTypeSummary}</strong>
                  <small>{creatingChannel ? t('sidebar.channelRule') : t('sidebar.communityRule')}</small>
                </div>
                <label className="creator-field">
                  <span>{t('sidebar.handle')}</span>
                  <input maxLength={48} value={newChat.handle || ''} onChange={(event) => onNewChatChange((current) => ({ ...current, handle: event.target.value }))} placeholder={creatingChannel ? '@channel-name' : 'community-name'} />
                </label>
                <label className="creator-field">
                  <span>{t('sidebar.shortDescription')}</span>
                  <textarea maxLength={180} rows={3} value={newChat.description || ''} onChange={(event) => onNewChatChange((current) => ({ ...current, description: event.target.value }))} placeholder={t('inspector.description')} />
                </label>
                <div className="kind-row creator-policy" aria-label={t('sidebar.privacy')}>
                  {[
                    ['public', t('sidebar.public')],
                    ['private', t('sidebar.private')],
                  ].map(([value, label]) => (
                    <button key={value} type="button" className={(newChat.privacyLevel || 'public') === value ? 'active' : ''} onClick={() => onNewChatChange((current) => ({ ...current, privacyLevel: value }))}>
                      {label}
                    </button>
                  ))}
                </div>
                <div className="kind-row creator-policy" aria-label={t('sidebar.joinPolicy')}>
                  {[
                    ['open', t('sidebar.joinOpen')],
                    ['approval', t('sidebar.joinApproval')],
                  ].map(([value, label]) => (
                    <button key={value} type="button" className={(newChat.joinPolicy || 'open') === value ? 'active' : ''} onClick={() => onNewChatChange((current) => ({ ...current, joinPolicy: value }))}>
                      {label}
                    </button>
                  ))}
                </div>
                <div className="creator-fixed-policy">
                  <span>{t('sidebar.postingPolicy')}</span>
                  <strong>{creatingChannel ? t('sidebar.adminOnly') : t('sidebar.allMembers')}</strong>
                </div>
              </>
            )}
            <button className="primary-action compact" type="submit" disabled={!newChat.name?.trim()}>
              <Plus size={17} />
              {creatingAi ? t('sidebar.createAi') : creatingChannel ? t('sidebar.createChannel') : t('sidebar.createCommunityTitle')}
            </button>
          </form>
        </div>
      )}

      {showMainMenu && (
        <div className="drawer-popover-layer" onMouseDown={() => { onUiSound?.('close'); onSetShowMainMenu(false); }}>
          <aside className="main-drawer" onMouseDown={(event) => event.stopPropagation()}>
            <button
              className="drawer-close-button"
              type="button"
              aria-label={t('common.close')}
              onClick={() => {
                onUiSound?.('close');
                onSetShowMainMenu(false);
              }}
            >
              <X size={20} />
            </button>
            <div className="drawer-profile">
              <span className="avatar drawer-avatar">
                <Avatar src={currentUser.avatarUrl} name={currentUser.displayName} size={28} />
              </span>
              <strong>
                <VerifiedName verified={hasExtraPlan}>{currentUser.displayName}</VerifiedName>
              </strong>
              <span>{currentUser.handle}</span>
            </div>
            <nav className="drawer-menu">
              <button type="button" onClick={() => { onSetShowProfilePage(true); onSetShowMainMenu(false); }}>
                <UserRound size={20} />
                {t('sidebar.myProfile')}
              </button>
              <button type="button" onClick={() => { openCreator('group'); onSetShowMainMenu(false); }}>
                <Users size={20} />
                {t('sidebar.createCommunity')}
              </button>
              <button type="button" onClick={() => { openCreator('channel'); onSetShowMainMenu(false); }}>
                <Megaphone size={20} />
                {t('sidebar.createChannel')}
              </button>
              <button type="button" onClick={() => { openCreator('ai'); onSetShowMainMenu(false); }}>
                <Bot size={20} />
                {t('sidebar.createAi')}
              </button>
              <button type="button" onClick={() => { onSetShowSettingsPage(true); onSetShowMainMenu(false); }}>
                <Settings size={20} />
                {t('common.settings')}
              </button>
              <button type="button" className="night-row" onClick={onThemeToggle}>
                <Moon size={20} />
                <span>{theme === 'dark' ? t('sidebar.darkMode') : t('sidebar.lightMode')}</span>
                <span className={`switch-pill ${theme === 'dark' ? 'active' : ''}`} />
              </button>
              <button type="button" onClick={onSignOut}>
                <LogOut size={20} />
                {t('sidebar.logout')}
              </button>
            </nav>
          </aside>
        </div>
      )}
    </>
  );
}
