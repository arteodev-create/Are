import React, { useEffect, useState } from 'react';
import { Mic, PackagePlus, Paperclip, SmilePlus, X, XCircle } from 'lucide-react';
import { useI18n } from './i18n.jsx';

const customGifPacksKey = 'veritas-custom-gif-packs';

function loadCustomGifPacks() {
  try {
    const saved = JSON.parse(localStorage.getItem(customGifPacksKey) || '[]');
    return Array.isArray(saved) ? saved.filter((pack) => pack?.id && Array.isArray(pack.items)) : [];
  } catch {
    return [];
  }
}

function saveCustomGifPacks(packs) {
  localStorage.setItem(customGifPacksKey, JSON.stringify(packs));
}

function gifSrc(gifEmojiBase, emoji) {
  return emoji.url || `${gifEmojiBase}/${emoji.name}`;
}

export function Composer({
  attachmentDrafts,
  draft,
  editingMessage,
  fileInputRef,
  formatFileSize,
  composerInputRef,
  gifEmojiBase,
  gifEmojis,
  gifEmojiGroups,
  recordingAudio,
  replyTarget,
  sendIcon: SendIcon,
  showAttachmentForm,
  uploadingFile,
  disabled = false,
  disabledReason = '',
  onCancelMode,
  onClearAttachments,
  onDraftChange,
  onFileUpload,
  onPrepareGif,
  onSend,
  onToggleAudioRecording,
  onUiSound,
}) {
  const { t } = useI18n();
  const [showEmojiTray, setShowEmojiTray] = useState(false);
  const [compactComposer, setCompactComposer] = useState(() => (
    typeof window === 'undefined' ? false : window.matchMedia('(max-width: 760px)').matches
  ));
  const [customGifGroups, setCustomGifGroups] = useState(loadCustomGifPacks);
  const [showCustomGifForm, setShowCustomGifForm] = useState(false);
  const [customGifName, setCustomGifName] = useState('');
  const [customGifUrls, setCustomGifUrls] = useState('');
  const [customGifUploads, setCustomGifUploads] = useState([]);
  const [customGifError, setCustomGifError] = useState('');
  const baseEmojiGroups = Array.isArray(gifEmojiGroups) && gifEmojiGroups.length > 0
    ? gifEmojiGroups
    : [{ id: 'all', label: t('common.all'), items: Array.isArray(gifEmojis) ? gifEmojis : [] }];
  const emojiGroups = [...baseEmojiGroups, ...customGifGroups];
  const [activeEmojiGroupId, setActiveEmojiGroupId] = useState(emojiGroups[0]?.id ?? 'all');
  const activeEmojiGroup = emojiGroups.find((group) => group.id === activeEmojiGroupId) ?? emojiGroups[0];
  const activeEmojiItems = activeEmojiGroup?.items ?? [];
  const canUseEmojiTray = !editingMessage && emojiGroups.some((group) => group.items?.length);
  const showCreatePackTile = activeEmojiGroup?.id === 'symbols';

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const query = window.matchMedia('(max-width: 760px)');
    const updateCompactComposer = () => setCompactComposer(query.matches);
    updateCompactComposer();
    query.addEventListener('change', updateCompactComposer);
    return () => query.removeEventListener('change', updateCompactComposer);
  }, []);

  function handlePrepareGif(emoji) {
    onUiSound?.('tap');
    onPrepareGif(emoji);
    setShowEmojiTray(false);
  }

  function handlePaste(event) {
    if (editingMessage || uploadingFile) return;
    const clipboardItems = Array.from(event.clipboardData?.items ?? []);
    const imageFiles = clipboardItems
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item, index) => {
        const file = item.getAsFile();
        if (!file) return null;
        const extension = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
        return new File([file], file.name || `clipboard-image-${Date.now()}-${index + 1}.${extension}`, {
          type: file.type || 'image/png',
          lastModified: Date.now(),
        });
      })
      .filter(Boolean);

    if (!imageFiles.length) return;
    event.preventDefault();
    onUiSound?.('tap');
    onFileUpload(imageFiles);
  }

  function openCustomGifForm() {
    onUiSound?.('open');
    setCustomGifError('');
    setShowCustomGifForm(true);
  }

  function uploadCustomGifFiles(files) {
    const selected = Array.from(files ?? []).slice(0, 12);
    if (!selected.length) return;

    const oversized = selected.find((file) => file.size > 1.5 * 1024 * 1024);
    if (oversized) {
      setCustomGifError(t('composer.gifFileTooLarge'));
      return;
    }

    const gifFiles = selected.filter((file) => file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif'));
    if (!gifFiles.length) {
      setCustomGifError(t('composer.gifOnly'));
      return;
    }

    Promise.all(
      gifFiles.map((file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({
          id: `${file.name}-${file.lastModified}-${file.size}`,
          name: file.name.replace(/\.gif$/i, '').slice(0, 32) || t('composer.gifUpload'),
          url: reader.result,
        });
        reader.onerror = () => reject(new Error(t('composer.gifReadFailed')));
        reader.readAsDataURL(file);
      })),
    )
      .then((items) => {
        setCustomGifUploads((current) => [...current, ...items].slice(0, 24));
        setCustomGifError('');
      })
      .catch((error) => setCustomGifError(error.message));
  }

  function createCustomGifPack(event) {
    event.preventDefault();
    const label = customGifName.trim().slice(0, 22) || t('composer.defaultPackName');
    const urls = customGifUrls
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^https?:\/\//i.test(line))
      .slice(0, 48);

    const uploadedItems = customGifUploads.map((item, index) => ({
      name: item.id,
      url: item.url,
      label: item.name || t('composer.uploadLabel', { name: label, index: index + 1 }),
    }));

    if (!urls.length && !uploadedItems.length) {
      setCustomGifError(t('composer.gifPackRequired'));
      return;
    }

    const pack = {
      id: `custom-${Date.now()}`,
      label,
      custom: true,
      items: [
        ...uploadedItems,
        ...urls.map((url, index) => ({
          name: url,
          url,
          label: t('composer.packItemLabel', { name: label, index: uploadedItems.length + index + 1 }),
        })),
      ],
    };
    const nextPacks = [...customGifGroups, pack].slice(-8);
    setCustomGifGroups(nextPacks);
    saveCustomGifPacks(nextPacks);
    setActiveEmojiGroupId(pack.id);
    setShowCustomGifForm(false);
    setShowEmojiTray(true);
    setCustomGifName('');
    setCustomGifUrls('');
    setCustomGifUploads([]);
    setCustomGifError('');
  }

  return (
    <>
      {(replyTarget || editingMessage) && (
        <div className="composer-context">
          <div>
            <strong>{editingMessage ? t('composer.editing') : t('composer.reply', { name: replyTarget.senderName })}</strong>
            <span>{editingMessage?.text || replyTarget?.text}</span>
          </div>
          <button type="button" onClick={() => { onUiSound?.('close'); onCancelMode(); }} aria-label={t('common.cancel')}>
            <XCircle size={18} />
          </button>
        </div>
      )}

      {showAttachmentForm && !editingMessage && !disabled && (
        <div className={`attachment-form ${attachmentDrafts.every((attachment) => attachment.sticker || attachment.mimeType === 'image/gif') ? 'sticker-compose' : ''}`}>
          <p className="attachment-form-hint">
            {attachmentDrafts.length > 1 ? t('composer.selectedFiles', { count: attachmentDrafts.length }) : t('composer.selectedFile')} · 25MB/file, 4 images/select
          </p>
          <div className="attachment-draft-list">
            {attachmentDrafts.map((attachment, index) => (
              <span
                key={attachment.id || attachment.url || index}
                className={attachment.sticker || attachment.mimeType === 'image/gif' ? 'sticker-draft' : ''}
              >
                {attachment.mimeType?.startsWith('image/') && <img src={attachment.url} alt={attachment.name} />}
                {!(attachment.sticker || attachment.mimeType === 'image/gif') && <strong>{attachment.name}</strong>}
                {!(attachment.sticker || attachment.mimeType === 'image/gif') && (
                  <small>{formatFileSize?.(attachment.size) || `${attachment.size || 0} B`}</small>
                )}
              </span>
            ))}
          </div>
          {attachmentDrafts.length > 0 && (
            <button className="clear-attachment-button" type="button" onClick={() => { onUiSound?.('close'); onClearAttachments(); }} aria-label={t('common.cancel')}>
              <X size={15} />
            </button>
          )}
        </div>
      )}

      {canUseEmojiTray && showEmojiTray && !disabled && (
        <div className="veritas-emoji-tray" aria-label={t('composer.gifTray')}>
          <div className="emoji-tray-tabs" role="tablist" aria-label={t('composer.gifGroups')}>
            {emojiGroups.map((group) => (
              <button
                key={group.id}
                className={group.id === activeEmojiGroup?.id ? 'active' : ''}
                type="button"
                role="tab"
                aria-selected={group.id === activeEmojiGroup?.id}
                onClick={() => { onUiSound?.('tap'); setActiveEmojiGroupId(group.id); }}
              >
                {group.label}
              </button>
            ))}
          </div>
          <div className="emoji-tray-grid">
            {showCreatePackTile && (
              <button className="gif-pack-create-tile" type="button" onClick={openCustomGifForm}>
                <PackagePlus size={20} />
                <span>{t('composer.createPack')}</span>
              </button>
            )}
            {activeEmojiItems.map((emoji) => (
              <button key={emoji.name} className="gif-emoji-button" type="button" title={emoji.label} onClick={() => handlePrepareGif(emoji)}>
                <img src={gifSrc(gifEmojiBase, emoji)} alt="" loading="lazy" />
              </button>
            ))}
          </div>
        </div>
      )}

      {showCustomGifForm && (
        <div className="custom-gif-layer" role="presentation" onMouseDown={() => { onUiSound?.('close'); setShowCustomGifForm(false); }}>
          <form className="custom-gif-modal" onSubmit={createCustomGifPack} onMouseDown={(event) => event.stopPropagation()}>
            <header className="custom-gif-head">
              <div>
                <span>{t('composer.gifIdentity')}</span>
                <strong>{t('composer.createPack')}</strong>
              </div>
              <button type="button" aria-label={t('common.close')} onClick={() => { onUiSound?.('close'); setShowCustomGifForm(false); }}>
                <X size={18} />
              </button>
            </header>
            <label>
              <span>{t('composer.packName')}</span>
                <input value={customGifName} onChange={(event) => setCustomGifName(event.target.value)} placeholder={t('composer.packNamePlaceholder')} maxLength={22} />
            </label>
            <label>
              <span>{t('composer.gifLinks')}</span>
              <textarea
                value={customGifUrls}
                onChange={(event) => setCustomGifUrls(event.target.value)}
                placeholder={t('composer.gifLinksPlaceholder')}
                rows={6}
              />
            </label>
            <label className="custom-gif-upload">
              <span>{t('composer.uploadGif')}</span>
              <input type="file" accept="image/gif,.gif" multiple onChange={(event) => uploadCustomGifFiles(event.target.files)} />
            </label>
            {customGifUploads.length > 0 && (
              <div className="custom-gif-preview-list" aria-label={t('composer.uploadedGif')}>
                {customGifUploads.map((item) => (
                  <span key={item.id}>
                    <img src={item.url} alt="" />
                    {item.name}
                  </span>
                ))}
              </div>
            )}
            {customGifError && <p className="custom-gif-error">{customGifError}</p>}
            <div className="custom-gif-actions">
              <button type="button" className="ghost-action" onClick={() => { onUiSound?.('close'); setShowCustomGifForm(false); }}>{t('common.cancel')}</button>
              <button type="submit" className="primary-action">{t('composer.createPack')}</button>
            </div>
          </form>
        </div>
      )}

      <footer className="composer">
        <input
          ref={fileInputRef}
          className="media-file-input"
          type="file"
          accept="image/*,video/*,audio/*,application/pdf"
          multiple
          onChange={(event) => onFileUpload(event.target.files)}
          disabled={disabled}
        />
        <button
          className="icon-button"
          aria-label={t('composer.attach')}
          onClick={() => { onUiSound?.('tap'); fileInputRef.current?.click(); }}
          disabled={disabled || Boolean(editingMessage) || uploadingFile}
        >
          <Paperclip size={20} />
        </button>
        <button
          className={`icon-button emoji-toggle-button ${showEmojiTray ? 'active' : ''}`}
          type="button"
          aria-label={showEmojiTray ? t('composer.hideGif') : t('composer.showGif')}
          aria-expanded={showEmojiTray}
          onClick={() => { onUiSound?.(showEmojiTray ? 'close' : 'open'); setShowEmojiTray((current) => !current); }}
          disabled={disabled || !canUseEmojiTray || uploadingFile}
        >
          <SmilePlus size={20} />
        </button>
        <input
          ref={composerInputRef}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onPaste={handlePaste}
          onKeyDown={(event) => event.key === 'Enter' && onSend()}
          placeholder={disabled ? (disabledReason || t('composer.readOnly')) : editingMessage ? t('composer.editPlaceholder') : compactComposer ? t('composer.messageShortPlaceholder') : t('composer.messagePlaceholder')}
          disabled={disabled}
        />
        <button
          className={`icon-button mic-button ${recordingAudio ? 'recording' : ''}`}
          aria-label={recordingAudio ? t('composer.stopRecord') : t('composer.record')}
          onClick={() => { onUiSound?.(recordingAudio ? 'close' : 'open'); onToggleAudioRecording(); }}
          disabled={disabled || Boolean(editingMessage) || uploadingFile}
        >
          <Mic size={20} />
        </button>
        <button className="send-button" aria-label={t('composer.send')} onClick={onSend} disabled={disabled || uploadingFile}>
          {uploadingFile ? <span className="upload-spinner" /> : <SendIcon size={21} />}
        </button>
      </footer>
    </>
  );
}
