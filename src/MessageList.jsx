import React, { useState } from 'react';
import {
  Ban,
  CheckCheck,
  CircleCheck,
  Copy,
  Edit3,
  FileText,
  Flag,
  Forward,
  MessageCircle,
  Pin,
  Reply,
  RotateCcw,
  Trash2,
  XCircle,
} from 'lucide-react';
import { Avatar, isVerifiedUser, VerifiedName } from './ui.jsx';
import { LoadingSpinner, LoadingState } from './LoadingSpinner.jsx';
import { useI18n } from './i18n.jsx';

export function MessageList({
  activeChat,
  assetUrl,
  audioMessage: AudioMessage,
  canManage,
  canPost = true,
  formatTime,
  formatUploadProgress,
  hasExtraPlan,
  isGeneratedAttachmentText,
  messageAvatarUrl,
  messageListRef,
  messagesLoading,
  messageMenuPosition,
  olderMessagesLoading,
  openMenuMessage,
  openMessageMenuId,
  participantById,
  reactionPicker: ReactionPicker,
  reactionPills: ReactionPills,
  showLatestButton,
  typingUsers = [],
  videoPreview: VideoPreview,
  onBlockUser,
  onCopyMessage,
  onForwardMessage,
  onListScroll,
  onMediaOpen,
  onMenuToggle,
  onPinMessage,
  onReactToMessage,
  onReply,
  onReportMessage,
  onRequestDelete,
  onRemoveFailedMessage,
  onRetryFailedMessage,
  onScrollLatest,
  onSelectMessage,
  onSetOpenMenu,
  onStartEditing,
}) {
  const { language, t } = useI18n();
  const messages = activeChat.messages ?? [];
  const todayKey = new Date().toDateString();
  const yesterdayKey = new Date(Date.now() - 86_400_000).toDateString();
  const emptyThreadText = activeChat.kind === 'channel'
    ? (canManage ? t('message.emptyChannelManage') : t('message.emptyChannelFollow'))
    : activeChat.kind === 'group'
      ? t('message.emptyCommunityThread')
      : t('message.emptyThread');

  function canOpenInline(attachment) {
    return attachment.mimeType?.startsWith('image/')
      || attachment.mimeType?.startsWith('video/')
      || attachment.mimeType?.startsWith('audio/');
  }

  function dateLabel(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const key = date.toDateString();
    if (key === todayKey) return t('message.today');
    if (key === yesterdayKey) return t('message.yesterday');
    return date.toLocaleDateString(language === 'vi' ? 'vi-VN' : 'en-US', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function openAttachment(event, attachment) {
    if (canOpenInline(attachment) || attachment.url) {
      event.preventDefault();
      onMediaOpen(attachment);
    }
  }

  function AttachmentImage({ attachment }) {
    const [failed, setFailed] = useState(false);
    if (failed) {
      return (
        <span className="attachment-fallback">
          <FileText size={16} />
          <span>{attachment.name || t('message.attachment')}</span>
        </span>
      );
    }
    return <img src={assetUrl(attachment.url)} alt={attachment.name || ''} onError={() => setFailed(true)} />;
  }

  function MessageMenu({ message, floating = false }) {
    return (
      <div
        className={`message-actions ${floating ? 'floating-message-actions is-open' : ''}`}
        role="menu"
        style={floating ? { left: `${messageMenuPosition.left}px`, top: `${messageMenuPosition.top}px` } : undefined}
        onClick={floating ? (event) => event.stopPropagation() : undefined}
        onContextMenu={floating ? (event) => event.preventDefault() : undefined}
      >
        <div className="menu-reaction-group" role="group" aria-label={t('message.reaction')}>
          <span>{t('message.reaction')}</span>
          <ReactionPicker
            target={message}
            onReact={(emoji) => {
              onReactToMessage(message.id, emoji);
              onSetOpenMenu('');
            }}
          />
        </div>
        {canPost && (
          <button type="button" role="menuitem" onClick={() => { onReply(message); onSetOpenMenu(''); }}>
            <Reply size={17} />
            {t('message.replyAction')}
          </button>
        )}
        <button type="button" role="menuitem" onClick={() => onPinMessage(message)}>
          <Pin size={17} />
          Pin
        </button>
        <button type="button" role="menuitem" onClick={() => onCopyMessage(message)}>
          <Copy size={17} />
          Copy Text
        </button>
        {canPost && (
          <button type="button" role="menuitem" onClick={() => onForwardMessage(message)}>
            <Forward size={17} />
            {t('message.forwardAction')}
          </button>
        )}
        {message.sender === 'me' && message.verdict === 'limited' && (
          <button type="button" role="menuitem" onClick={() => onReportMessage(message)}>
            <Flag size={17} />
            {t('message.appeal')}
          </button>
        )}
        {message.sender === 'me' && canPost && (
          <button type="button" role="menuitem" onClick={() => onStartEditing(message)}>
            <Edit3 size={17} />
            {t('message.edit')}
          </button>
        )}
        {(message.sender === 'me' || canManage) && (
          <button type="button" role="menuitem" onClick={() => onRequestDelete(message)}>
            <Trash2 size={17} />
            {t('message.delete')}
          </button>
        )}
        {message.sender !== 'me' && (
          <button type="button" role="menuitem" onClick={() => { onSetOpenMenu(''); onBlockUser(message.senderId); }}>
            <Ban size={17} />
            {t('message.block')}
          </button>
        )}
        <button type="button" role="menuitem" onClick={() => onSelectMessage(message)}>
          <CircleCheck size={17} />
          {t('message.select')}
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="message-list" ref={messageListRef} onScroll={onListScroll}>
        {olderMessagesLoading && (
          <div className="older-messages-loading">
            <LoadingSpinner compact label={t('message.loadingOlder')} />
          </div>
        )}
        {messagesLoading && messages.length === 0 && (
          <LoadingState label={t('message.loadingMessages')} />
        )}
        {messages.map((message, index) => {
          const currentDate = dateLabel(message.createdAt);
          const previousDate = index > 0 ? dateLabel(messages[index - 1]?.createdAt) : '';
          const showDateDivider = currentDate && currentDate !== previousDate;

          return (
          <React.Fragment key={message.id}>
          {showDateDivider && <div className="message-date-divider">{currentDate}</div>}
          <article
            className={`message ${message.sender} ${message.uploadStatus ? `upload-${message.uploadStatus}` : ''} ${(message.attachments ?? []).some((attachment) => attachment.mimeType?.startsWith('audio/')) ? 'has-audio' : ''} ${(message.attachments ?? []).some((attachment) => attachment.mimeType?.startsWith('video/')) ? 'has-video' : ''} ${(message.attachments ?? []).some((attachment) => attachment.mimeType?.startsWith('image/') && attachment.mimeType !== 'image/gif') ? 'has-image' : ''} ${openMessageMenuId === message.id ? 'menu-open' : ''}`}
            onClick={(event) => {
              if (openMessageMenuId && !event.target.closest('button, a, input, textarea, select')) {
                onSetOpenMenu('');
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              onMenuToggle(event, message, { allowInteractive: true });
            }}
          >
            <span
              className={`message-peer-avatar ${message.sender === 'me' ? 'self' : ''} ${
                (message.sender === 'me'
                  ? hasExtraPlan
                  : isVerifiedUser(participantById.get(message.senderId)) || isVerifiedUser(message))
                  ? 'verified-avatar'
                  : ''
              }`}
              aria-hidden="true"
            >
              <Avatar src={messageAvatarUrl(message)} name={message.senderName} size={17} />
            </span>
            {message.sender !== 'me' && (
              <span className="sender-name">
                <VerifiedName verified={isVerifiedUser(participantById.get(message.senderId)) || isVerifiedUser(message)}>
                  {message.senderName}
                </VerifiedName>
              </span>
            )}
            {message.replyTo && (
              <div className="reply-preview">
                <strong>{message.replyTo.senderName}</strong>
                <span>{message.replyTo.text}</span>
              </div>
            )}
            {!isGeneratedAttachmentText(message.text) && <p>{message.text}</p>}
            {(message.attachments ?? []).length > 0 && (
              <div
                className={`attachment-list ${
                  (message.attachments ?? []).every((attachment) => attachment.mimeType?.startsWith('image/') && attachment.mimeType !== 'image/gif')
                  && (message.attachments ?? []).length > 1
                    ? `image-grid image-grid-${Math.min((message.attachments ?? []).length, 4)}`
                    : ''
                }`}
              >
                {message.attachments.map((attachment) => (
                  <a
                    key={attachment.id || attachment.url}
                    className={
                      attachment.mimeType === 'image/gif'
                        ? 'sticker-attachment'
                        : attachment.mimeType?.startsWith('video/')
                          ? 'media-attachment video-attachment'
                          : attachment.mimeType?.startsWith('audio/')
                            ? 'media-attachment audio-attachment'
                            : attachment.mimeType?.startsWith('image/')
                              ? 'media-attachment image-attachment'
                              : ''
                    }
                    href={canOpenInline(attachment) ? undefined : assetUrl(attachment.url)}
                    target={canOpenInline(attachment) ? undefined : '_blank'}
                    rel={canOpenInline(attachment) ? undefined : 'noreferrer'}
                    role={canOpenInline(attachment) ? 'button' : undefined}
                    tabIndex={canOpenInline(attachment) ? 0 : undefined}
                    aria-label={attachment.name}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      openAttachment(event, attachment);
                    }}
                    onClick={(event) => openAttachment(event, attachment)}
                  >
                    {attachment.mimeType?.startsWith('video/') ? (
                      <VideoPreview attachment={attachment} />
                    ) : attachment.mimeType?.startsWith('audio/') ? (
                      <AudioMessage attachment={attachment} />
                    ) : attachment.mimeType?.startsWith('image/') ? (
                      <AttachmentImage attachment={attachment} />
                    ) : (
                      <FileText size={14} />
                    )}
                    {!attachment.mimeType?.startsWith('image/') && !attachment.mimeType?.startsWith('video/') && !attachment.mimeType?.startsWith('audio/') && <span>{attachment.name}</span>}
                  </a>
                ))}
              </div>
            )}
            {message.verdict === 'limited' && <span className="moderation-note">{t('message.limited')}</span>}
            {message.verdict === 'sensitive' && <span className="moderation-note soft">{t('message.sensitive')}</span>}
            {message.sender === 'me' && message.uploadStatus && (
              <div className={`upload-progress-line ${message.uploadStatus === 'failed' ? 'failed' : ''}`}>
                {message.uploadStatus === 'failed' ? (
                  <XCircle size={16} />
                ) : (
                  <svg className="upload-progress-spinner" viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" />
                  </svg>
                )}
                <span>
                  {message.uploadStatus === 'failed'
                    ? (message.uploadError || t('message.uploadFailed'))
                    : message.uploadStatus === 'sending'
                      ? t('message.sending')
                      : t('message.uploading', { progress: formatUploadProgress(message.uploadLoaded, message.uploadTotal) })}
                </span>
                {message.uploadStatus !== 'failed' && (
                  <strong>{Math.min(100, Math.max(0, Number(message.uploadProgress || 0)))}%</strong>
                )}
                {message.uploadStatus === 'failed' && (
                  <span className="failed-message-actions">
                    <button type="button" onClick={() => onRetryFailedMessage(message)}>
                      <RotateCcw size={14} />
                      {t('message.retry')}
                    </button>
                    <button type="button" onClick={() => onRemoveFailedMessage(message.id)}>
                      <Trash2 size={14} />
                      {t('message.delete')}
                    </button>
                  </span>
                )}
              </div>
            )}
            <footer>
              {formatTime(message.createdAt)}
              {message.editedAt && <span>{t('message.edited')}</span>}
              {message.sender === 'me' && <CheckCheck size={15} />}
            </footer>
            <ReactionPills target={message} onReact={(emoji) => onReactToMessage(message.id, emoji)} />
            <MessageMenu message={message} />
          </article>
          </React.Fragment>
          );
        })}
        {activeChat.id && !messagesLoading && messages.length === 0 && (
          <div className="empty-thread">
            <MessageCircle size={24} />
            <span>{emptyThreadText}</span>
          </div>
        )}
        {typingUsers.length > 0 && (
          <div className="typing-indicator" aria-live="polite">
            <span className="typing-avatar-stack">
              {typingUsers.slice(0, 3).map((user) => (
                <span className="typing-avatar" key={user.id}>
                  <Avatar src={user.avatarUrl} name={user.displayName || user.handle} size={18} />
                </span>
              ))}
            </span>
            <span className="typing-bubble" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="typing-copy">
              {typingUsers.length === 1
                ? `${t('message.typingOne', { name: typingUsers[0].displayName || typingUsers[0].handle })}`
                : t('message.typingMany', { count: typingUsers.length })}
            </span>
          </div>
        )}
      </div>

      {showLatestButton && activeChat.id && (
        <button className="latest-message-button" type="button" onClick={() => onScrollLatest('smooth')}>
          {t('message.latest')}
        </button>
      )}

      {openMenuMessage && <MessageMenu message={openMenuMessage} floating />}
    </>
  );
}
