import React, { useState } from 'react';
import {
  Ban,
  Bell,
  Bot,
  FileText,
  Headphones,
  Image,
  Link,
  MessageCircle,
  Pencil,
  Search,
  Share2,
  ShieldAlert,
  Trash2,
  Video,
  X,
} from 'lucide-react';
import { Avatar, isVerifiedUser, VerifiedName } from './ui.jsx';
import { useI18n } from './i18n.jsx';

function countSharedLinks(messages) {
  return messages.reduce((count, message) => {
    const attachmentUrls = (message.attachments ?? []).map((attachment) => attachment.url ?? '').join(' ');
    const text = `${message.text ?? ''} ${attachmentUrls}`;
    return count + (text.match(/https?:\/\/\S+/g) ?? []).length;
  }, 0);
}

function countMedia(messages) {
  return messages.flatMap((message) => message.attachments ?? []).reduce(
    (counts, attachment) => {
      const mimeType = attachment.mimeType ?? '';
      if (mimeType.startsWith('image/')) counts.photos += 1;
      else if (mimeType.startsWith('video/')) counts.videos += 1;
      else if (mimeType.startsWith('audio/')) counts.audio += 1;
      else counts.files += 1;
      return counts;
    },
    { photos: 0, videos: 0, files: 0, audio: 0 },
  );
}

export function Inspector({
  activeChat,
  aiModel,
  auditLog,
  blockedUsers,
  canManage,
  inspectorPage,
  isPrivateChat,
  kindIcon,
  kindLabels,
  messageSearchQuery,
  moderationQueue,
  participants,
  joinRequests = [],
  peerProfile,
  privateStatus,
  searchResults,
  onMessageSearchChange,
  onModerationResolve,
  onJoinRequestResolve,
  onBlockUser,
  onDeleteAiModel,
  onOpenProfile,
  onPageChange,
  onRefreshModeration,
  onSelectSearchResult,
  onShareContact,
  onCloseInspector,
  onFocusComposer,
  onUnblockUser,
  onUpdateConversation,
  onUpdateAiModel,
  onUploadAiModelAvatar,
}) {
  const { t } = useI18n();
  const [muted, setMuted] = useState(false);
  const [aiEditForm, setAiEditForm] = useState(null);
  const [conversationEditForm, setConversationEditForm] = useState(null);
  const [showModerationManager, setShowModerationManager] = useState(false);
  const messages = activeChat.messages ?? [];
  const mediaCounts = countMedia(messages);
  const sharedLinkCount = countSharedLinks(messages);
  const onlineMembers = participants.filter((participant) => participant.online || (participant.lastSeen && Date.now() - new Date(participant.lastSeen).getTime() < 90_000)).length;
  const queueForActiveChat = moderationQueue.filter((item) => item.conversationId === activeChat.id);
  const visibleQueue = queueForActiveChat.slice(0, 6);
  const recentAudit = auditLog.filter((item) => !activeChat.id || !item.conversationId || item.conversationId === activeChat.id).slice(0, 5);
  const displayHandle = activeChat.isAi ? activeChat.handle : isPrivateChat ? peerProfile?.handle || activeChat.handle : activeChat.handle;
  const privacyLabel = activeChat.privacyLevel === 'private' ? t('inspector.private') : t('inspector.public');
  const postingLabel = activeChat.postingPolicy === 'admins' ? t('inspector.adminsOnly') : t('inspector.membersCanPost');
  const audienceLabel = activeChat.kind === 'channel' ? t('inspector.followers') : t('inspector.members');
  const audienceCountText = t(activeChat.kind === 'channel' ? 'sidebar.followerCount' : 'sidebar.memberCount', {
    count: activeChat.id ? activeChat.memberCount || participants.length || 1 : 0,
  });
  const statusText = activeChat.isAi
    ? `${t('common.aiModel')} ${activeChat.aiPrivacy === 'public' ? t('inspector.public') : t('inspector.private')}`
    : isPrivateChat
    ? privateStatus || t('lastSeen.offline')
    : audienceCountText;
  const tabs = [
    ['info', t('inspector.overview')],
    ['moderation', t('inspector.moderation')],
  ];

  function openAiEditor() {
    setAiEditForm({
      id: aiModel?.id || activeChat.aiModelId,
      name: aiModel?.name || activeChat.name || '',
      avatarUrl: aiModel?.avatarUrl || activeChat.avatarUrl || '',
      systemPrompt: aiModel?.systemPrompt || '',
      provider: aiModel?.provider || 'openrouter',
      modelName: aiModel?.modelName || 'poolside/laguna-xs.2:free',
      privacy: aiModel?.privacy || activeChat.aiPrivacy || 'private',
      enabled: aiModel?.enabled !== false,
      apiKey: '',
      apiKeyHint: aiModel?.apiKeyHint || '',
    });
  }

  function openConversationEditor() {
    setConversationEditForm({
      id: activeChat.id,
      kind: activeChat.kind,
      name: activeChat.name || '',
      handle: activeChat.handle || '',
      description: activeChat.description || '',
      privacyLevel: activeChat.privacyLevel || 'public',
      joinPolicy: activeChat.joinPolicy || 'open',
      postingPolicy: activeChat.postingPolicy || (activeChat.kind === 'channel' ? 'admins' : 'members'),
    });
  }

  async function saveConversationEditor(event) {
    event.preventDefault();
    if (!conversationEditForm?.id) return;
    const ok = await onUpdateConversation?.(conversationEditForm.id, conversationEditForm);
    if (ok) setConversationEditForm(null);
  }

  async function saveAiEditor(event) {
    event.preventDefault();
    if (!aiEditForm?.id) return;
    const ok = await onUpdateAiModel?.(aiEditForm.id, aiEditForm);
    if (ok) setAiEditForm(null);
  }

  async function uploadAiEditorAvatar(fileList) {
    const avatarUrl = await onUploadAiModelAvatar?.(fileList);
    if (avatarUrl) setAiEditForm((current) => ({ ...current, avatarUrl }));
  }

  return (
    <aside className={`inspector ${activeChat.id ? '' : 'inspector-empty-state'}`}>
      {!activeChat.id && (
        <div className="inspector-empty">
          <header>
            <strong>{t('inspector.info')}</strong>
            <span>{t('inspector.noChatSelected')}</span>
          </header>
          <section>
            <MessageCircle size={22} />
            <div>
              <strong>{t('inspector.noConversation')}</strong>
              <span>{t('inspector.noConversationHint')}</span>
            </div>
          </section>
          <section>
            <Search size={22} />
            <div>
              <strong>{t('inspector.findPeopleOrChat')}</strong>
              <span>{t('inspector.searchHint')}</span>
            </div>
          </section>
        </div>
      )}

      <div className="profile-card inspector-contact-card">
        <button type="button" className="inspector-close" aria-label={t('header.hideInfo')} onClick={onCloseInspector}>
          <X size={20} />
        </button>
        <span className="avatar profile-avatar inspector-contact-avatar">
          {activeChat.isAi
            ? (activeChat.avatarUrl ? <Avatar src={activeChat.avatarUrl} name={activeChat.name} size={34} /> : <Bot size={34} />)
            : isPrivateChat ? <Avatar src={peerProfile?.avatarUrl || activeChat.avatarUrl} name={activeChat.name} size={34} /> : kindIcon(activeChat.kind, 34)}
        </span>
        <strong>
          <VerifiedName verified={!activeChat.isAi && (isPrivateChat ? isVerifiedUser(peerProfile) : isVerifiedUser(activeChat))}>
            {activeChat.name}
          </VerifiedName>
        </strong>
        <small>{statusText}</small>
        <div className="profile-actions inspector-contact-actions">
          <button type="button" onClick={onFocusComposer}>
            <span><MessageCircle size={20} fill="currentColor" /></span>
            <em>{t('inspector.message')}</em>
          </button>
          <button type="button" className={muted ? 'active' : ''} onClick={() => setMuted((current) => !current)}>
            <span><Bell size={20} fill="currentColor" /></span>
            <em>{muted ? t('inspector.unmute') : t('inspector.mute')}</em>
          </button>
        </div>
      </div>

      <div className="inspector-page contact-layout">
        {canManage && !isPrivateChat && (
          <nav className="inspector-tabs compact" aria-label={t('inspector.info')}>
            {tabs.map(([page, label]) => (
              <button
                key={page}
                type="button"
                className={inspectorPage === page ? 'active' : ''}
                onClick={() => onPageChange(page)}
              >
                {label}
              </button>
            ))}
          </nav>
        )}

        {inspectorPage === 'info' && (
          <>
            <section className="inspector-contact-section inspector-contact-info">
              <div>
                <strong>{displayHandle}</strong>
                <span>{t('profile.username')}</span>
              </div>
              <div>
                <strong>{activeChat.isAi ? 'AI' : kindLabels[activeChat.kind]}</strong>
                <span>{t('inspector.type')}</span>
              </div>
              {!isPrivateChat && !activeChat.isAi && (
                <div>
                  <strong>{privacyLabel}</strong>
                  <span>{postingLabel}</span>
                </div>
              )}
              {!isPrivateChat && !activeChat.isAi && (
                <div>
                  <strong>{activeChat.kind === 'channel' ? t('inspector.channelMode') : t('inspector.communityMode')}</strong>
                  <span>{activeChat.kind === 'channel' ? t('inspector.channelRule') : t('inspector.communityRule')}</span>
                </div>
              )}
            </section>

            <section className="inspector-contact-section inspector-media-list">
              <div className="inspector-info-row">
                <Image size={20} />
                <span>{t('inspector.photos', { count: mediaCounts.photos })}</span>
              </div>
              <div className="inspector-info-row">
                <Video size={20} />
                <span>{t('inspector.videos', { count: mediaCounts.videos })}</span>
              </div>
              <div className="inspector-info-row">
                <FileText size={20} />
                <span>{t('inspector.files', { count: mediaCounts.files })}</span>
              </div>
              <div className="inspector-info-row">
                <Headphones size={20} />
                <span>{t('inspector.audio', { count: mediaCounts.audio })}</span>
              </div>
              <div className="inspector-info-row">
                <Link size={20} />
                <span>{t('inspector.links', { count: sharedLinkCount })}</span>
              </div>
            </section>

            <section className="inspector-contact-section inspector-action-list">
              <button type="button" onClick={() => onShareContact?.(isPrivateChat ? peerProfile || activeChat : activeChat)}>
                <Share2 size={20} />
                <span>{t('inspector.share')}</span>
              </button>
              {activeChat.isAi ? (
                <>
                  <button type="button" onClick={openAiEditor}>
                    <Pencil size={20} />
                    <span>{t('inspector.editAi')}</span>
                  </button>
                  <div className="inspector-info-row">
                    <Bot size={20} />
                    <span>{aiModel?.modelName || 'poolside/laguna-xs.2:free'}</span>
                  </div>
                </>
              ) : (
                <>
                  <button type="button" onClick={!isPrivateChat && canManage ? openConversationEditor : onOpenProfile}>
                    <Pencil size={20} />
                    <span>{!isPrivateChat && canManage ? t('inspector.edit') : t('inspector.editContact')}</span>
                  </button>
                  <button type="button" className="danger" disabled={!isPrivateChat || !peerProfile?.id} onClick={() => onBlockUser?.(peerProfile.id)}>
                    <Ban size={20} />
                    <span>{t('inspector.blockUser')}</span>
                  </button>
                </>
              )}
            </section>
          </>
        )}

        {inspectorPage === 'moderation' && (
          <>
            <section className="inspector-contact-section inspector-contact-info">
              <div>
                <strong>{visibleQueue.length ? t('inspector.pendingCount', { count: visibleQueue.length }) : t('inspector.stable')}</strong>
                <span>{t('inspector.moderation')}</span>
              </div>
              <div>
                <strong>{participants.length}</strong>
                <span>{audienceLabel}</span>
              </div>
            </section>

            <section className="inspector-contact-section inspector-media-list">
              <button type="button" onClick={() => setShowModerationManager(true)}>
                <ShieldAlert size={20} />
                <span>{t('inspector.pendingCount', { count: visibleQueue.length })}</span>
              </button>
              <button type="button" onClick={() => setShowModerationManager(true)}>
                <MessageCircle size={20} />
                <span>{t('inspector.onlineCount', { count: onlineMembers })}</span>
              </button>
              <button type="button" onClick={() => setShowModerationManager(true)}>
                <Ban size={20} />
                <span>{blockedUsers.length} {t('inspector.blocked')}</span>
              </button>
              <button type="button" onClick={() => setShowModerationManager(true)}>
                <FileText size={20} />
                <span>{t('inspector.auditCount', { count: recentAudit.length })}</span>
              </button>
            </section>

            <section className="inspector-contact-section inspector-action-list">
              {canManage ? (
                <button type="button" onClick={() => setShowModerationManager(true)}>
                  <ShieldAlert size={20} />
                  <span>{t('inspector.manageModeration')}</span>
                </button>
              ) : (
                <div className="inspector-info-row">
                  <ShieldAlert size={20} />
                  <span>{t('inspector.readOnlyModeration')}</span>
                </div>
              )}
              <button type="button" onClick={onRefreshModeration}>
                <Search size={20} />
                <span>{t('inspector.refreshData')}</span>
              </button>
            </section>

            {showModerationManager && (
              <div className="moderation-manager-layer" role="presentation" onMouseDown={() => setShowModerationManager(false)}>
                <section
                  className="moderation-manager"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="moderation-manager-title"
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <header>
                    <div>
                      <strong id="moderation-manager-title">{t('inspector.manageModeration')}</strong>
                      <span>{activeChat.name}</span>
                    </div>
                    <button type="button" aria-label={t('common.close')} onClick={() => setShowModerationManager(false)}>
                      <X size={19} />
                    </button>
                  </header>

                  <div className="moderation-manager-stats">
                    <div>
                      <strong>{joinRequests.length}</strong>
                      <span>{t('inspector.joinRequests')}</span>
                    </div>
                    <div>
                      <strong>{participants.length}</strong>
                      <span>{audienceLabel}</span>
                    </div>
                    <div>
                      <strong>{blockedUsers.length}</strong>
                      <span>{t('inspector.blocked')}</span>
                    </div>
                  </div>

                  <section className="moderation-manager-section">
                    <div className="manager-section-head">
                      <strong>{t('inspector.joinRequests')}</strong>
                      <button type="button" onClick={onRefreshModeration}>{t('inspector.refresh')}</button>
                    </div>
                    {joinRequests.map((request) => (
                      <div className="manager-row" key={request.id}>
                        <span>
                          <strong>{request.user?.displayName || t('inspector.user')}</strong>
                          <small>{request.user?.handle || t('inspector.pending')}</small>
                        </span>
                        <span className="manager-actions">
                          <button type="button" className="approve" onClick={() => onJoinRequestResolve?.(request.id, 'approve')}>{t('inspector.approve')}</button>
                          <button type="button" onClick={() => onJoinRequestResolve?.(request.id, 'decline')}>{t('inspector.decline')}</button>
                        </span>
                      </div>
                    ))}
                    {joinRequests.length === 0 && <p className="manager-empty">{t('inspector.noJoinRequests')}</p>}
                  </section>

                  <section className="moderation-manager-section">
                    <div className="manager-section-head">
                      <strong>{t('inspector.pendingMessages')}</strong>
                      <button type="button" onClick={onRefreshModeration}>{t('inspector.refresh')}</button>
                    </div>
                    {visibleQueue.map((item) => (
                      <article className="manager-message" key={item.id}>
                        <div>
                          <strong>{item.senderName || t('inspector.user')}</strong>
                          <span>{item.verdict || 'limited'}</span>
                        </div>
                        <p>{item.text || t('inspector.noText')}</p>
                        <footer>
                          <button type="button" className="approve" onClick={() => onModerationResolve(item.id, 'approve')}>{t('inspector.approve')}</button>
                          <button type="button" onClick={() => onModerationResolve(item.id, 'limit')}>{t('inspector.keepLimited')}</button>
                        </footer>
                      </article>
                    ))}
                    {visibleQueue.length === 0 && <p className="manager-empty">{t('inspector.noPending')}</p>}
                  </section>

                  <section className="moderation-manager-section">
                    <strong>{audienceLabel}</strong>
                    {participants.slice(0, 10).map((participant) => {
                      const online = participant.online || (participant.lastSeen && Date.now() - new Date(participant.lastSeen).getTime() < 90_000);
                      return (
                        <div className="manager-row" key={participant.id}>
                          <span>
                            <strong>{participant.displayName}</strong>
                            <small>{participant.handle} - {participant.role}</small>
                          </span>
                          <em>{online ? 'online' : 'offline'}</em>
                        </div>
                      );
                    })}
                    {participants.length === 0 && <p className="manager-empty">{t('inspector.noMembers')}</p>}
                  </section>

                  <section className="moderation-manager-section">
                    <strong>{t('inspector.blocked')}</strong>
                    {blockedUsers.slice(0, 8).map((item) => (
                      <div className="manager-row" key={item.blockedId}>
                        <span>
                          <strong>{item.user.displayName}</strong>
                          <small>{item.user.handle}</small>
                        </span>
                        <button type="button" onClick={() => onUnblockUser(item.blockedId)}>{t('message.unblock')}</button>
                      </div>
                    ))}
                    {blockedUsers.length === 0 && <p className="manager-empty">{t('inspector.noBlocked')}</p>}
                  </section>

                  <section className="moderation-manager-section">
                    <strong>{t('inspector.audit')}</strong>
                    {recentAudit.map((item) => (
                      <div className="manager-row audit" key={item.id}>
                        <span>
                          <strong>{item.action}</strong>
                    <small>{item.conversationName || t('common.conversation')} - {item.actorName}</small>
                        </span>
                      </div>
                    ))}
                    {recentAudit.length === 0 && <p className="manager-empty">{t('inspector.noAudit')}</p>}
                  </section>
                </section>
              </div>
            )}
          </>
        )}

        <section className="search-results inspector-contact-section">
          <h4>{t('inspector.messageHistory')}</h4>
          <label className="history-search-box">
            <Search size={16} />
            <input
              value={messageSearchQuery}
              onChange={(event) => onMessageSearchChange(event.target.value)}
              placeholder={t('inspector.searchHistory')}
            />
          </label>
          {messageSearchQuery.trim() && searchResults.slice(0, 6).map((result) => (
            <button key={result.id} onClick={() => onSelectSearchResult(result.conversationId)} className="result-row">
              <span>{result.conversationName}</span>
              <small>{result.text}</small>
            </button>
          ))}
          {messageSearchQuery.trim() && searchResults.length === 0 && <p className="note tight">{t('inspector.noSearchResult')}</p>}
        </section>
      </div>
      {aiEditForm && (
        <div className="ai-editor-layer" role="presentation" onMouseDown={() => setAiEditForm(null)}>
          <form
            className="ai-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-editor-title"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={saveAiEditor}
          >
            <header className="ai-editor-head">
              <div>
                <strong id="ai-editor-title">{t('inspector.editAiTitle')}</strong>
                <span>{aiEditForm.modelName || 'OpenRouter'}</span>
              </div>
              <button type="button" aria-label={t('inspector.closeAiEditor')} onClick={() => setAiEditForm(null)}>
                <X size={19} />
              </button>
            </header>

            <section className="ai-editor-body">
              <div className="ai-editor-identity">
                <div className="ai-editor-avatar">
                  <span className="avatar">
                    {aiEditForm.avatarUrl ? <Avatar src={aiEditForm.avatarUrl} name={aiEditForm.name} size={24} /> : <Bot size={24} />}
                  </span>
                  <label title={t('inspector.uploadAvatar')}>
                    <Image size={16} />
                    <input type="file" accept="image/*" onChange={(event) => uploadAiEditorAvatar(event.target.files)} />
                  </label>
                </div>
                <label className="creator-field ai-editor-name">
                  <span>{t('inspector.aiName')}</span>
                  <input required maxLength={80} value={aiEditForm.name} onChange={(event) => setAiEditForm((current) => ({ ...current, name: event.target.value }))} />
                </label>
              </div>

              <label className="creator-field">
                <span>{t('inspector.prompt')}</span>
                <textarea required rows={5} maxLength={8000} value={aiEditForm.systemPrompt} onChange={(event) => setAiEditForm((current) => ({ ...current, systemPrompt: event.target.value }))} />
              </label>

              <label className="creator-field">
                <span>{t('inspector.model')}</span>
                <input value={aiEditForm.modelName} onChange={(event) => setAiEditForm((current) => ({ ...current, modelName: event.target.value }))} />
              </label>

              <div className="kind-row creator-policy" aria-label={t('inspector.privacy')}>
                {[
                  ['private', t('inspector.private')],
                  ['public', t('inspector.public')],
                ].map(([value, label]) => (
                  <button key={value} type="button" className={aiEditForm.privacy === value ? 'active' : ''} onClick={() => setAiEditForm((current) => ({ ...current, privacy: value }))}>
                    {label}
                  </button>
                ))}
              </div>

              <label className="creator-field">
                <span>{t('inspector.apiKey')}</span>
                <input type="password" value={aiEditForm.apiKey} onChange={(event) => setAiEditForm((current) => ({ ...current, apiKey: event.target.value }))} placeholder={aiEditForm.apiKeyHint ? t('inspector.keepKey', { hint: aiEditForm.apiKeyHint }) : 'sk-or-...'} />
              </label>

              <label className="ai-editor-toggle">
                <input type="checkbox" checked={aiEditForm.enabled} onChange={(event) => setAiEditForm((current) => ({ ...current, enabled: event.target.checked }))} />
                <span>{t('inspector.aiEnabled')}</span>
              </label>
            </section>

            <footer className="ai-editor-footer">
              <button type="button" className="ai-editor-delete" onClick={async () => {
                if (!window.confirm(t('inspector.deleteAiConfirm'))) return;
                const ok = await onDeleteAiModel?.(aiEditForm.id);
                if (ok) setAiEditForm(null);
              }}>
                <Trash2 size={16} />
                {t('inspector.deleteAi')}
              </button>
              <span />
              <button type="button" className="ai-editor-cancel" onClick={() => setAiEditForm(null)}>{t('common.cancel')}</button>
              <button type="submit" className="ai-editor-save">{t('common.save')}</button>
            </footer>
          </form>
        </div>
      )}
      {conversationEditForm && (
        <div className="ai-editor-layer" role="presentation" onMouseDown={() => setConversationEditForm(null)}>
          <form
            className="ai-editor conversation-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="conversation-editor-title"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={saveConversationEditor}
          >
            <header className="ai-editor-head">
              <div>
                <strong id="conversation-editor-title">{t('inspector.editConversationTitle', { type: conversationEditForm.kind === 'channel' ? t('inspector.channel') : t('inspector.community') })}</strong>
                <span>{conversationEditForm.handle || activeChat.handle}</span>
              </div>
              <button type="button" aria-label={t('inspector.closeEditor')} onClick={() => setConversationEditForm(null)}>
                <X size={19} />
              </button>
            </header>

            <section className="ai-editor-body">
              <label className="creator-field">
                <span>{t('inspector.displayName')}</span>
                <input required maxLength={80} value={conversationEditForm.name} onChange={(event) => setConversationEditForm((current) => ({ ...current, name: event.target.value }))} />
              </label>

              <label className="creator-field">
                <span>{t('inspector.handle')}</span>
                <input maxLength={48} value={conversationEditForm.handle} onChange={(event) => setConversationEditForm((current) => ({ ...current, handle: event.target.value }))} />
              </label>

              <label className="creator-field">
                <span>{t('inspector.description')}</span>
                <textarea rows={4} maxLength={180} value={conversationEditForm.description} onChange={(event) => setConversationEditForm((current) => ({ ...current, description: event.target.value }))} />
              </label>

              <div className="kind-row creator-policy" aria-label={t('inspector.privacy')}>
                {[
                  ['public', t('inspector.public')],
                  ['private', t('inspector.private')],
                ].map(([value, label]) => (
                  <button key={value} type="button" className={conversationEditForm.privacyLevel === value ? 'active' : ''} onClick={() => setConversationEditForm((current) => ({ ...current, privacyLevel: value }))}>
                    {label}
                  </button>
                ))}
              </div>

              <div className="kind-row creator-policy" aria-label={t('inspector.joinPolicy')}>
                {[
                  ['open', t('inspector.joinOpen')],
                  ['approval', t('inspector.joinApproval')],
                ].map(([value, label]) => (
                  <button key={value} type="button" className={(conversationEditForm.joinPolicy || 'open') === value ? 'active' : ''} onClick={() => setConversationEditForm((current) => ({ ...current, joinPolicy: value }))}>
                    {label}
                  </button>
                ))}
              </div>

              <div className="conversation-editor-fixed-policy">
                <span>{t('inspector.posting')}</span>
                <strong>{conversationEditForm.kind === 'channel' ? t('inspector.adminsOnly') : t('inspector.membersCanPost')}</strong>
                <small>{conversationEditForm.kind === 'channel' ? t('inspector.channelRule') : t('inspector.communityRule')}</small>
              </div>

            </section>

            <footer className="ai-editor-footer conversation-editor-footer">
              <span />
              <span />
              <button type="button" className="ai-editor-cancel" onClick={() => setConversationEditForm(null)}>{t('common.cancel')}</button>
              <button type="submit" className="ai-editor-save">{t('common.save')}</button>
            </footer>
          </form>
        </div>
      )}
    </aside>
  );
}
