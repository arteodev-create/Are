import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  MessageCircle,
  Pause,
  Play,
  Radio,
  Bot,
  Trash2,
  Volume2,
  Ban,
  X,
  User,
  Users,
  Search,
  ArrowUp,
} from 'lucide-react';
import { normalizeAuthEmail, validateAuthForm } from './auth.js';
import {
  filterChats,
  isDraftConversationId,
  isPrivateChatDraft,
  listableChats,
  removeChatMessage,
  uniqueChats,
  uniqueMessages,
  updateChatMessage,
  updateChatWithMessage,
} from './chatState.js';
import { AuthScreen } from './AuthScreen.jsx';
import { Avatar, isVerifiedUser, VerifiedBadgeIcon, VerifiedName } from './ui.jsx';
import { MediaViewer } from './MediaViewer.jsx';
import { Sidebar } from './Sidebar.jsx';
import { ProfilePage } from './ProfilePage.jsx';
import { SettingsPage } from './SettingsPage.jsx';
import { Inspector } from './Inspector.jsx';
import { ConversationHeader } from './ConversationHeader.jsx';
import { MessageList } from './MessageList.jsx';
import { Composer } from './Composer.jsx';
import { I18nProvider, useI18n } from './i18n.jsx';
import './styles.css';

const isLocalHost = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(window.location.hostname);
const productionApiUrl = 'https://veritas-api-production-4255.up.railway.app';
const defaultApiUrl = isLocalHost ? 'http://localhost:8787' : productionApiUrl;
const apiUrl = (import.meta.env.VITE_API_URL || defaultApiUrl).replace(/\/$/, '');
const wsUrl = (import.meta.env.VITE_WS_URL || apiUrl.replace(/^http/, 'ws')).replace(/\/$/, '');
const messagePageSize = 30;
const maxUploadFileSize = 25 * 1024 * 1024;
const localeByLanguage = {
  vi: 'vi-VN',
  en: 'en-US',
  ko: 'ko-KR',
};

function localeFor(language) {
  return localeByLanguage[language] || localeByLanguage.vi;
}

function assetUrl(url = '') {
  if (!url) return '';
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  return url.startsWith('/') ? `${apiUrl}${url}` : url;
}

function shareBaseUrl() {
  const configured = String(import.meta.env.VITE_SHARE_URL || import.meta.env.VITE_PUBLIC_APP_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  if (/localhost|127\.0\.0\.1|\[::1\]/i.test(window.location.hostname)) return apiUrl.replace(/\/$/, '');
  return window.location.origin;
}

function fileFromDataUrl(dataUrl, name = 'veritas-gif.gif') {
  const [metadata = '', payload = ''] = String(dataUrl).split(',');
  const mimeType = metadata.match(/^data:([^;]+);base64$/i)?.[1] || 'image/gif';
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], name.endsWith('.gif') ? name : `${name}.gif`, { type: mimeType });
}

function imageFileName(name = 'image', extension = 'webp') {
  const clean = String(name || 'image').replace(/\.[^.]+$/, '').replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-+|-+$/g, '');
  return `${clean || 'image'}.${extension}`;
}

async function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function compressImageFile(file, options = {}) {
  if (!file?.type?.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') return file;
  const maxDimension = options.maxDimension ?? 1600;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  if (file.size <= maxBytes && !options.force) return file;

  let bitmap = null;
  let objectUrl = '';
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    objectUrl = URL.createObjectURL(file);
    bitmap = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = objectUrl;
    });
  }

  try {
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width || 1, bitmap.height || 1));
    const width = Math.max(1, Math.round((bitmap.width || 1) * scale));
    const height = Math.max(1, Math.round((bitmap.height || 1) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: true });
    context.drawImage(bitmap, 0, 0, width, height);

    const mimeType = 'image/webp';
    let bestBlob = null;
    for (const quality of [options.quality ?? 0.82, 0.72, 0.62]) {
      const blob = await canvasToBlob(canvas, mimeType, quality);
      if (!blob) continue;
      bestBlob = blob;
      if (blob.size <= maxBytes) break;
    }
    if (!bestBlob || bestBlob.size >= file.size) return file;
    return new File([bestBlob], imageFileName(file.name, 'webp'), {
      type: mimeType,
      lastModified: Date.now(),
    });
  } finally {
    bitmap?.close?.();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

async function compressUploadImages(files, options) {
  return Promise.all(files.map((file) => compressImageFile(file, options).catch(() => file)));
}

const savedSession = localStorage.getItem('veritas-session');
const savedTheme = localStorage.getItem('veritas-theme') || 'dark';
const savedNotificationSetting = localStorage.getItem('veritas-notifications') ?? 'on';
const savedInteractionSoundSetting = localStorage.getItem('veritas-interaction-sounds') ?? 'on';
const startsWithInspector = typeof window === 'undefined'
  ? true
  : window.matchMedia('(min-width: 1181px)').matches;
const initialSession = (() => {
  if (!savedSession) return null;
  try {
    const session = JSON.parse(savedSession);
    return session;
  } catch {
    localStorage.removeItem('veritas-session');
    return null;
  }
})();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

const fallbackChats = [];

const telegramGifEmojiBase = 'https://raw.githubusercontent.com/goforbg/telegram-emoji-gifs/master';
const telegramGifEmojiGroups = [
  {
    id: 'popular',
    items: [
      { name: 'big-smile.gif' },
      { name: 'big-laugh.gif' },
      { name: 'clap.gif' },
      { name: 'fire.gif' },
      { name: 'black-heart.gif' },
      { name: '100.gif' },
      { name: 'chat-bubble.gif' },
      { name: 'cool-with-glasses.gif' },
      { name: 'thinking.gif' },
      { name: 'heart-eyes.gif' },
      { name: 'crying.gif' },
      { name: 'angry-flames.gif' },
      { name: 'thumbs-up.gif' },
      { name: 'thumbs-down.gif' },
      { name: 'bicep-flex.gif' },
      { name: 'shocked.gif' },
    ],
  },
  {
    id: 'faces',
    items: [
      { name: 'bouncing-laugh.gif' },
      { name: 'funny-laugh.gif' },
      { name: 'jumping-laugh.gif' },
      { name: 'tears-of-joy-laughter.gif' },
      { name: 'awkward-smile.gif' },
      { name: 'blush.gif' },
      { name: 'wink.gif' },
      { name: 'star-struck.gif' },
      { name: 'mind-blown.gif' },
      { name: 'very-shocked.gif' },
      { name: 'speechless.gif' },
      { name: 'eye-rolling.gif' },
      { name: 'sad.gif' },
      { name: 'very-sad.gif' },
      { name: 'tired.gif' },
      { name: 'sleep-zzz.gif' },
    ],
  },
  {
    id: 'hands',
    items: [
      { name: 'wave.gif' },
      { name: 'hands-together.gif' },
      { name: 'thanks.gif' },
      { name: 'okay-sign.gif' },
      { name: 'rock-on.gif' },
      { name: 'fingers-crossed.gif' },
      { name: 'handshake.gif' },
      { name: 'punch.gif' },
      { name: 'left-fist.gif' },
      { name: 'right-fist.gif' },
      { name: 'point-left.gif' },
      { name: 'point-up.gif' },
    ],
  },
  {
    id: 'hearts',
    items: [
      { name: 'heart.gif' },
      { name: 'double-heart.gif' },
      { name: 'heart-waves.gif' },
      { name: 'heart-twinkle.gif' },
      { name: 'heart-cupid.gif' },
      { name: 'heart-broken.gif' },
      { name: 'heart-dot.gif' },
      { name: 'blue-heart.gif' },
      { name: 'green-heart.gif' },
      { name: 'yellow-heart.gif' },
      { name: 'purple-heart.gif' },
      { name: 'orange-heart.gif' },
    ],
  },
  {
    id: 'symbols',
    items: [
      { name: 'party-confetti.gif' },
      { name: 'party.gif' },
      { name: 'crown.gif' },
      { name: 'diamond.gif' },
      { name: 'idea.gif' },
      { name: 'keyboard-typing.gif' },
      { name: 'pencil-writing.gif' },
      { name: 'question.gif' },
      { name: 'exclamation.gif' },
      { name: 'lock-key.gif' },
      { name: 'money-face.gif' },
      { name: 'thunder.gif' },
    ],
  },
];
const telegramGifEmojis = telegramGifEmojiGroups.flatMap((group) => group.items);

const reactionChoices = [
  { value: '\u{1f44d}', gif: 'thumbs-up.gif', labelKey: 'reaction.like' },
  { value: '\u2764\ufe0f', gif: 'heart.gif', labelKey: 'reaction.love' },
  { value: '\u{1f602}', gif: 'big-laugh.gif', labelKey: 'reaction.laugh' },
  { value: '\u{1f525}', gif: 'fire.gif', labelKey: 'reaction.fire' },
  { value: '\u{1f62e}', gif: 'shocked.gif', labelKey: 'reaction.surprised' },
  { value: '\u{1f622}', gif: 'crying.gif', labelKey: 'reaction.sad' },
];

const reactionGifByValue = Object.fromEntries(reactionChoices.map((reaction) => [reaction.value, reaction.gif]));

function gifEmojiLabelKey(name = '') {
  return `gif.${String(name).replace(/\.gif$/i, '').replace(/[^a-z0-9]+/gi, '.').replace(/(^\.|\.$)/g, '')}`;
}

const emptyActiveChat = {
  id: '',
  name: '',
  handle: '',
  status: '',
  unread: 0,
  myRole: 'member',
  memberCount: 0,
  kind: 'private',
  messages: [],
};

const emptyAttachmentDraft = { name: '', url: '', mimeType: 'application/octet-stream', size: '' };

function formatTime(value, language = 'vi') {
  return new Date(value).toLocaleTimeString(localeFor(language), { hour: '2-digit', minute: '2-digit' });
}

function formatLastSeen(value, t, language = 'vi') {
  if (!value) return t('lastSeen.offline');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t('lastSeen.offline');
  const diffMs = Date.now() - date.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < 90_000) return t('lastSeen.now');
  if (diffMs < hour) return t('lastSeen.minutes', { count: Math.max(1, Math.floor(diffMs / minute)) });
  if (diffMs < day) return t('lastSeen.hours', { count: Math.floor(diffMs / hour) });
  if (diffMs < day * 2) return t('lastSeen.yesterdayAt', { time: formatTime(value, language) });
  if (diffMs < day * 7) {
    return date.toLocaleDateString(localeFor(language), { weekday: 'long', hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString(localeFor(language), { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatDuration(value) {
  if (!Number.isFinite(value) || value <= 0) return '0:00';
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60)
    .toString()
    .padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function formatFileSize(value, t) {
  const size = Number(value || 0);
  if (!size) return t ? t('common.unknownFileSize') : 'Unknown size';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUploadProgress(loaded, total, t) {
  const loadedText = Number(loaded || 0) <= 0 ? '0 B' : formatFileSize(loaded, t);
  const totalSize = Number(total || 0);
  if (!totalSize) return `${loadedText} ${t ? t('common.uploaded') : 'uploaded'}`;
  return `${loadedText} / ${formatFileSize(totalSize, t)}`;
}

function kindIcon(kind, size = 18) {
  if (kind === 'ai') return <Bot size={size} />;
  if (kind === 'group') return <Users size={size} />;
  if (kind === 'channel') return <Radio size={size} />;
  return <User size={size} />;
}

function SendArrowIcon({ size = 20 }) {
  return <ArrowUp size={size} strokeWidth={2.4} aria-hidden="true" />;
}

function FlashLogo({ visible }) {
  if (!visible) return null;

  return (
    <div className="flash-logo-layer" aria-hidden="true">
      <svg className="flash-logo-mark veritas-auth-mark" viewBox="0 0 64 64">
        <path
          fill="currentColor"
          fillRule="evenodd"
          d="M32 6C17.64 6 6 16.75 6 30c0 5.08 1.72 9.79 4.65 13.67L6.53 58.5l15.45-5.86A27.75 27.75 0 0 0 32 54c14.36 0 26-10.75 26-24S46.36 6 32 6Zm0 7C21.56 13 13 20.6 13 30c0 4.03 1.56 7.78 4.18 10.75l1.57 1.78-1.84 6.62 6.95-2.64 2.07.74c1.91.68 3.95 1.03 6.07 1.03 10.44 0 19-7.6 19-18.28S42.44 13 32 13Z"
        />
      </svg>
    </div>
  );
}

function slugify(value) {
  return value
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function updateReactionState(target, emoji) {
  const reactions = { ...(target?.reactions ?? {}) };
  const previous = target?.myReaction ?? '';

  if (previous) {
    reactions[previous] = Math.max(0, Number(reactions[previous] ?? 1) - 1);
    if (!reactions[previous]) delete reactions[previous];
  }

  if (previous === emoji) {
    return { ...target, reactions, myReaction: '' };
  }

  reactions[emoji] = Number(reactions[emoji] ?? 0) + 1;
  return { ...target, reactions, myReaction: emoji };
}

function isGeneratedAttachmentText(text) {
  const normalized = String(text ?? '').trim().toLowerCase();
  return normalized === 'đã gửi tệp đính kèm' || normalized === 'da gui tep dinh kem';
}

function VideoPreview({ attachment }) {
  const [duration, setDuration] = useState(0);

  return (
    <span className="video-message">
      <span className="video-duration">
        {formatDuration(duration)}
        <Volume2 size={12} />
      </span>
      <span className="video-art">
        <video
          src={assetUrl(attachment.url)}
          preload="metadata"
          playsInline
          muted
          onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        />
        <span className="video-center-play" aria-hidden="true">
          <Play size={26} fill="currentColor" />
        </span>
      </span>
    </span>
  );
}

function AudioMessage({ attachment }) {
  const audioRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const progress = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  const togglePlay = async (event) => {
    event.preventDefault();
    event.stopPropagation();

    const audio = audioRef.current;
    if (!audio) return;

    if (audio.paused) {
      try {
        await audio.play();
        setIsPlaying(true);
      } catch {
        setIsPlaying(false);
      }
      return;
    }

    audio.pause();
    setIsPlaying(false);
  };

  const seekAudio = (event) => {
    event.preventDefault();
    event.stopPropagation();

    const audio = audioRef.current;
    if (!audio || !duration) return;

    const nextTime = (Number(event.target.value) / 100) * duration;
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  };

  return (
    <span className={`sound-message ${isPlaying ? 'is-playing' : ''}`}>
      <span className="sound-play" aria-hidden="true" onClick={togglePlay}>
        {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
      </span>
      <span className="sound-body">
        <span className="sound-title">{attachment.name || 'Audio'}</span>
        <span className="sound-duration">{formatDuration(isPlaying ? currentTime : duration)}</span>
        <span className="sound-wave" style={{ '--sound-progress': `${progress}%` }}>
          {Array.from({ length: 28 }).map((_, index) => (
            <i key={index} className={index / 27 <= progress / 100 ? 'active' : ''} />
          ))}
          <input
            aria-label={t('main.audioSeek')}
            className="sound-seek"
            max="100"
            min="0"
            onChange={seekAudio}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            type="range"
            value={progress}
          />
        </span>
      </span>
      <audio
        ref={audioRef}
        src={assetUrl(attachment.url)}
        preload="metadata"
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
        onEnded={() => {
          setIsPlaying(false);
          setCurrentTime(0);
        }}
      />
    </span>
  );
}

function App() {
  const { language, t } = useI18n();
  const kindLabels = useMemo(() => ({
    private: t('sidebar.private'),
    ai: t('common.aiModel'),
    group: t('header.community'),
    channel: t('header.channel'),
  }), [t]);
  const localizedGifEmojiGroups = useMemo(
    () => telegramGifEmojiGroups.map((group) => ({
      ...group,
      label: t(`gif.group.${group.id}`),
      items: group.items.map((item) => ({ ...item, label: t(gifEmojiLabelKey(item.name)) })),
    })),
    [t],
  );
  const localizedGifEmojis = useMemo(
    () => localizedGifEmojiGroups.flatMap((group) => group.items),
    [localizedGifEmojiGroups],
  );
  const [showFlashLogo, setShowFlashLogo] = useState(true);
  const [theme, setTheme] = useState(savedTheme === 'light' ? 'light' : 'dark');
  const [currentUser, setCurrentUser] = useState(initialSession?.user ?? null);
  const [accessToken, setAccessToken] = useState(initialSession?.accessToken ?? '');
  const [refreshToken, setRefreshToken] = useState(initialSession?.refreshToken ?? '');
  const [sessionId, setSessionId] = useState(initialSession?.sessionId ?? '');
  const [authMode, setAuthMode] = useState('login');
  const [authStep, setAuthStep] = useState(0);
  const [authForm, setAuthForm] = useState({ email: '', displayName: '', handle: '', password: '', confirmPassword: '', emailCode: '' });
  const [authError, setAuthError] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [activeChatId, setActiveChatId] = useState('');
  const [chats, setChats] = useState([]);
  const [stageLoading, setStageLoading] = useState(Boolean(initialSession));
  const [messageLoadingIds, setMessageLoadingIds] = useState(() => new Set());
  const [olderMessageLoadingIds, setOlderMessageLoadingIds] = useState(() => new Set());
  const [draft, setDraft] = useState('');
  const [replyTarget, setReplyTarget] = useState(null);
  const [editingMessage, setEditingMessage] = useState(null);
  const [openMessageMenuId, setOpenMessageMenuId] = useState('');
  const [messageMenuPosition, setMessageMenuPosition] = useState({ left: 12, top: 12 });
  const [deleteConfirmMessage, setDeleteConfirmMessage] = useState(null);
  const [showAttachmentForm, setShowAttachmentForm] = useState(false);
  const [attachmentDrafts, setAttachmentDrafts] = useState([]);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [recordingAudio, setRecordingAudio] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [messageSearchQuery, setMessageSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [showMessageSearch, setShowMessageSearch] = useState(false);
  const [userSearchResults, setUserSearchResults] = useState([]);
  const [showCreator, setShowCreator] = useState(false);
  const [showMainMenu, setShowMainMenu] = useState(false);
  const [showProfilePage, setShowProfilePage] = useState(false);
  const [showSettingsPage, setShowSettingsPage] = useState(false);
  const [settingsInitialPage, setSettingsInitialPage] = useState('home');
  const [showInspector, setShowInspector] = useState(startsWithInspector);
  const [isSwitchingChat, setIsSwitchingChat] = useState(false);
  const [inspectorPage, setInspectorPage] = useState('info');
  const [mediaViewer, setMediaViewer] = useState(null);
  const emptyNewChat = {
    name: '',
    kind: 'group',
    handle: '',
    description: '',
    postingPolicy: 'members',
    privacyLevel: 'public',
    joinPolicy: 'open',
    avatarUrl: '',
    systemPrompt: '',
    provider: 'openrouter',
    modelName: 'poolside/laguna-xs.2:free',
    privacy: 'private',
    apiKey: '',
  };
  const [newChat, setNewChat] = useState(emptyNewChat);
  const [participants, setParticipants] = useState([]);
  const [joinRequests, setJoinRequests] = useState([]);
  const [invite, setInvite] = useState({ handle: '', role: 'member' });
  const [moderationQueue, setModerationQueue] = useState([]);
  const [serverStatus, setServerStatus] = useState({ online: false, database: 'offline', auth: 'unknown', realtime: false });
  const [appNotice, setAppNotice] = useState('');
  const [connectionNotice, setConnectionNotice] = useState('');
  const [notificationsEnabled, setNotificationsEnabled] = useState(savedNotificationSetting !== 'off');
  const [interactionSoundsEnabled, setInteractionSoundsEnabled] = useState(savedInteractionSoundSetting !== 'off');
  const [sessions, setSessions] = useState([]);
  const [blockedUsers, setBlockedUsers] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [aiModelDetails, setAiModelDetails] = useState([]);
  const [showLatestButton, setShowLatestButton] = useState(false);
  const [profileForm, setProfileForm] = useState({
    displayName: initialSession?.user?.displayName ?? '',
    handle: initialSession?.user?.handle ?? '',
    avatarUrl: initialSession?.user?.avatarUrl ?? '',
    bio: initialSession?.user?.bio ?? '',
    privacyLevel: initialSession?.user?.privacyLevel ?? 'balanced',
  });
  const [typingUsers, setTypingUsers] = useState({});
  const socketRef = useRef(null);
  const typingTimerRef = useRef(null);
  const lastTypingSentRef = useRef(0);
  const realtimeRefreshTimerRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const olderMessagesLoadingRef = useRef(new Set());
  const fileInputRef = useRef(null);
  const composerInputRef = useRef(null);
  const messageListRef = useRef(null);
  const messageSearchInputRef = useRef(null);
  const shouldStickToBottomRef = useRef(true);
  const activeChatIdRef = useRef('');
  const previousChatIdRef = useRef('');
  const readMarkerKeyRef = useRef('');
  const sidePanelsRequestRef = useRef(0);
  const chatSwitchTimerRef = useRef(null);
  const recorderRef = useRef(null);
  const recorderStreamRef = useRef(null);
  const audioContextRef = useRef(null);
  const originalTitleRef = useRef(document.title || 'Veritas');
  const recorderChunksRef = useRef([]);
  const totalUnread = useMemo(() => chats.reduce((sum, chat) => sum + Number(chat.unread || 0), 0), [chats]);

  useEffect(() => {
    localStorage.setItem('veritas-theme', theme);
    document.documentElement.dataset.theme = theme;
    document.body.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('veritas-notifications', notificationsEnabled ? 'on' : 'off');
  }, [notificationsEnabled]);

  useEffect(() => {
    localStorage.setItem('veritas-interaction-sounds', interactionSoundsEnabled ? 'on' : 'off');
  }, [interactionSoundsEnabled]);

  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) ${originalTitleRef.current}` : originalTitleRef.current;
  }, [totalUnread]);

  useEffect(() => () => {
    document.title = originalTitleRef.current;
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setShowFlashLogo(false), 980);
    return () => window.clearTimeout(timer);
  }, []);

  function scrollToLatestMessage(behavior = 'smooth') {
    const list = messageListRef.current;
    if (!list) return;
    requestAnimationFrame(() => {
      list.scrollTo({ top: list.scrollHeight, behavior });
      shouldStickToBottomRef.current = true;
      setShowLatestButton(false);
    });
  }

  function handleMessageListScroll() {
    if (openMessageMenuId) setOpenMessageMenuId('');
    const list = messageListRef.current;
    if (!list) return;
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    const nearBottom = distanceFromBottom < 140;
    shouldStickToBottomRef.current = nearBottom;
    if (nearBottom) setShowLatestButton(false);
    if (list.scrollTop < 120 && activeChatIdRef.current) {
      loadOlderMessages(activeChatIdRef.current).catch(() => {});
    }
  }

  const activeChat = useMemo(
    () => chats.find((chat) => chat.id === activeChatId) ?? { ...emptyActiveChat, name: t('main.noConversation'), status: t('main.noConversationHint') },
    [activeChatId, chats, t],
  );

  const canManage = ['owner', 'admin'].includes(activeChat?.myRole);
  const isAiChat = Boolean(activeChat.isAi);
  const isPrivateChat = activeChat.kind === 'private' && !isAiChat;
  const canPostInActiveChat = !activeChat.id
    || isPrivateChat
    || isAiChat
    || activeChat.postingPolicy !== 'admins'
    || canManage;
  const openMenuMessage = useMemo(
    () => (activeChat.messages ?? []).find((message) => message.id === openMessageMenuId) ?? null,
    [activeChat.messages, openMessageMenuId],
  );
  const peerProfile = useMemo(
    () => participants.find((participant) => participant.id !== currentUser?.id) ?? null,
    [participants, currentUser?.id],
  );
  const participantById = useMemo(
    () => new Map(participants.map((participant) => [participant.id, participant])),
    [participants],
  );
  const peerLastSeen = peerProfile?.lastSeen || activeChat.lastSeen;
  const privateStatus = peerProfile?.online || activeChat.online ? t('lastSeen.online') : formatLastSeen(peerLastSeen, t, language);
  const typingPeople = useMemo(() => {
    const cutoff = Date.now() - 3200;
    return Object.values(typingUsers)
      .filter((entry) => entry.conversationId === activeChatId && entry.user.id !== currentUser?.id && entry.at > cutoff)
      .map((entry) => entry.user);
  }, [typingUsers, activeChatId, currentUser?.id]);
  const latestMessage = activeChat.messages?.at(-1) ?? null;
  const latestMessageKey = latestMessage ? `${activeChatId}:${latestMessage.id}:${latestMessage.createdAt}` : activeChatId;
  const hasExtraPlan = currentUser?.plan === 'extra' || currentUser?.isExtra === true;

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
    if (!activeChat.id) {
      setShowLatestButton(false);
      previousChatIdRef.current = '';
      return;
    }
    const switchedChat = previousChatIdRef.current !== activeChatId;
    const fromMe = latestMessage?.sender === 'me';
    if (switchedChat || shouldStickToBottomRef.current || fromMe) {
      scrollToLatestMessage(switchedChat ? 'auto' : 'smooth');
    } else if (latestMessage) {
      setShowLatestButton(true);
    }
    previousChatIdRef.current = activeChatId;
  }, [activeChat.id, activeChatId, latestMessageKey]);

  const visibleChats = useMemo(() => listableChats(chats), [chats]);
  const filteredChats = useMemo(() => filterChats(visibleChats, searchQuery), [visibleChats, searchQuery]);

  const authValidation = useMemo(
    () => validateAuthForm(authMode, authForm, authMode === 'login' ? null : authStep, t),
    [authMode, authForm, authStep, t],
  );
  const firstAuthError = Object.values(authValidation).find(Boolean) ?? '';

  function api(path, options = {}) {
    return fetch(`${apiUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(options.headers ?? {}),
      },
    });
  }

  function updateAuthField(field, value) {
    setAuthError('');
    setAuthForm((current) => {
      if (field === 'email') {
        return { ...current, email: normalizeAuthEmail(value).slice(0, 120) };
      }
      if (field === 'displayName') {
        return { ...current, displayName: value.replace(/\s+/g, ' ').slice(0, 40) };
      }
      if (field === 'handle') {
        return { ...current, handle: value.replace(/^@+/, '').toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 20) };
      }
      if (field === 'password') {
        return { ...current, password: value.slice(0, 64) };
      }
      if (field === 'confirmPassword') {
        return { ...current, confirmPassword: value.slice(0, 64) };
      }
      if (field === 'emailCode') {
        return { ...current, emailCode: value.replace(/\D/g, '').slice(0, 6) };
      }
      return current;
    });
  }

  function changeAuthMode(nextMode) {
    setAuthMode(nextMode);
    setAuthStep(0);
    setAuthError('');
    setAuthForm((current) => ({ ...current, password: '', confirmPassword: '', emailCode: '' }));
  }

  async function readJsonSafely(response) {
    try {
      return await response.json();
    } catch {
      return {};
    }
  }

  function serverError(data, fallback) {
    if (data?.errorCode) {
      const key = `server.${data.errorCode}`;
      const translated = t(key);
      if (translated !== key) return translated;
      return fallback;
    }
    return data?.error || fallback;
  }

  function persistAuthSession(data) {
    localStorage.setItem('veritas-session', JSON.stringify(data));
    setAccessToken(data.accessToken);
    setRefreshToken(data.refreshToken);
    setSessionId(data.sessionId ?? '');
    setCurrentUser(data.user);
    setActiveChatId('');
    setChats([]);
    setProfileForm({
      displayName: data.user.displayName ?? '',
      handle: data.user.handle ?? '',
      avatarUrl: data.user.avatarUrl ?? '',
      bio: data.user.bio ?? '',
      privacyLevel: data.user.privacyLevel ?? 'balanced',
    });
  }

  async function authenticate(event) {
    event.preventDefault();
    setAuthError('');
    if (authSubmitting) return;
    if (firstAuthError) {
      setAuthError(firstAuthError);
      return;
    }
    setAuthSubmitting(true);
    try {
      if (authMode === 'reset' && authStep === 0) {
        const response = await fetch(`${apiUrl}/api/auth/email-status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: normalizeAuthEmail(authForm.email) }),
        });
        const data = await readJsonSafely(response);
        if (!response.ok || !data.exists) {
          setAuthError(serverError(data?.errorCode ? data : { errorCode: 'AUTH_EMAIL_NOT_FOUND' }, t('server.AUTH_EMAIL_NOT_FOUND')));
          return;
        }
        setAuthStep(1);
        return;
      }

      const registerPayload = {
        email: normalizeAuthEmail(authForm.email),
        password: authForm.password,
        displayName: authForm.displayName.trim(),
        handle: authForm.handle.trim(),
        locale: language,
      };
      if (authMode === 'register' && authStep !== 3) {
        const response = await fetch(`${apiUrl}/api/auth/register/request-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(registerPayload),
        });
        const data = await readJsonSafely(response);
        if (!response.ok) {
          setAuthError(serverError(data, t('auth.codeSendFailed')));
          return;
        }
        setAuthStep(3);
        return;
      }
      if (authMode === 'reset' && authStep === 1) {
        const response = await fetch(`${apiUrl}/api/auth/password/request-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: normalizeAuthEmail(authForm.email),
            password: authForm.password,
            locale: language,
          }),
        });
        const data = await readJsonSafely(response);
        if (!response.ok) {
          setAuthError(serverError(data, t('auth.codeSendFailed')));
          return;
        }
        setAuthStep(2);
        return;
      }

      const path = authMode === 'register'
        ? '/api/auth/register/verify'
        : authMode === 'reset'
          ? '/api/auth/password/verify'
          : '/api/auth/login';
      const payload = authMode === 'login'
        ? { email: normalizeAuthEmail(authForm.email), password: authForm.password }
        : { email: normalizeAuthEmail(authForm.email), code: authForm.emailCode };
      const response = await fetch(`${apiUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await readJsonSafely(response);
      if (!response.ok) {
        setAuthError(serverError(data, authMode === 'login' ? t('auth.invalidCredentials') : t('auth.invalidCode')));
        return;
      }
      persistAuthSession(data);
    } catch (error) {
      console.error('Email auth error', error);
      setAuthError(error?.message || t('notice.connectionLost'));
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function signOut() {
    if (refreshToken) {
      fetch(`${apiUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      }).catch(() => {});
    }
    localStorage.removeItem('veritas-session');
    setCurrentUser(null);
    setAccessToken('');
    setRefreshToken('');
    setSessionId('');
    setActiveChatId('');
    setChats([]);
    setProfileForm({ displayName: '', handle: '', avatarUrl: '', bio: '', privacyLevel: 'balanced' });
  }

  function showNotice(message) {
    setAppNotice(message);
    window.clearTimeout(showNotice.timer);
    showNotice.timer = window.setTimeout(() => setAppNotice(''), 4200);
  }

  async function resendAuthCode() {
    setAuthError('');
    if (authSubmitting) return;
    setAuthSubmitting(true);
    try {
      const path = authMode === 'register' ? '/api/auth/register/request-code' : '/api/auth/password/request-code';
      const payload = authMode === 'register'
        ? {
            email: normalizeAuthEmail(authForm.email),
            password: authForm.password,
            displayName: authForm.displayName.trim(),
            handle: authForm.handle.trim(),
            locale: language,
          }
        : {
            email: normalizeAuthEmail(authForm.email),
            password: authForm.password,
            locale: language,
          };
      const response = await fetch(`${apiUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await readJsonSafely(response);
      if (!response.ok) {
        setAuthError(serverError(data, t('auth.codeResendFailed')));
        return;
      }
      setAuthError(t('auth.codeResent'));
    } catch (error) {
      console.error('Resend auth code error', error);
      setAuthError(error?.message || t('notice.connectionLost'));
    } finally {
      setAuthSubmitting(false);
    }
  }

  function playIncomingSound() {
    if (!notificationsEnabled) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const context = audioContextRef.current ?? new AudioContext();
      audioContextRef.current = context;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(740, context.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(560, context.currentTime + 0.12);
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.045, context.currentTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.18);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.2);
    } catch {
      // Audio is best-effort; browsers can block it until the user interacts.
    }
  }

  function playUiSound(type = 'tap') {
    if (!interactionSoundsEnabled) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const context = audioContextRef.current ?? new AudioContext();
      audioContextRef.current = context;
      if (context.state === 'suspended') context.resume().catch(() => {});

      const presets = {
        tap: { start: 620, end: 760, duration: 0.045, volume: 0.018 },
        open: { start: 520, end: 680, duration: 0.075, volume: 0.02 },
        send: { start: 880, end: 1180, duration: 0.105, volume: 0.032 },
        react: { start: 760, end: 1040, duration: 0.085, volume: 0.026 },
        close: { start: 520, end: 360, duration: 0.06, volume: 0.018 },
        error: { start: 220, end: 170, duration: 0.12, volume: 0.026 },
      };
      const preset = presets[type] ?? presets.tap;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = type === 'error' ? 'triangle' : 'sine';
      oscillator.frequency.setValueAtTime(preset.start, context.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(preset.end, context.currentTime + preset.duration);
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(preset.volume, context.currentTime + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + preset.duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + preset.duration + 0.015);
    } catch {
      // UI sounds are best-effort and should never block an action.
    }
  }

  async function notifyIncomingMessage(message) {
    if (!notificationsEnabled || message.sender === 'me') return;
    const chat = chats.find((item) => item.id === message.conversationId);
    playIncomingSound();
    if (!('Notification' in window)) return;
    let permission = Notification.permission;
    if (permission === 'default') {
      try {
        permission = await Notification.requestPermission();
      } catch {
        permission = 'denied';
      }
    }
    if (permission !== 'granted') return;
    const body = message.text || (message.attachments?.length ? t('sidebar.attachmentSent') : t('message.new'));
    const notification = new Notification(chat?.name || message.senderName || 'Veritas', {
      body,
      tag: message.conversationId,
      silent: true,
    });
    notification.onclick = () => {
      window.focus();
      selectConversation(message.conversationId);
      notification.close();
    };
  }

  async function updateNotificationSetting(nextEnabled) {
    if (!nextEnabled) {
      setNotificationsEnabled(false);
      showNotice(t('notice.notificationsOff'));
      return;
    }
    if (!('Notification' in window)) {
      setNotificationsEnabled(true);
      showNotice(t('notice.notificationsUnsupported'));
      return;
    }
    if (Notification.permission === 'denied') {
      setNotificationsEnabled(false);
      showNotice(t('notice.notificationsBlocked'));
      return;
    }
    let permission = Notification.permission;
    if (permission === 'default') {
      permission = await Notification.requestPermission();
    }
    if (permission === 'granted') {
      setNotificationsEnabled(true);
      showNotice(t('notice.notificationsOn'));
      return;
    }
    setNotificationsEnabled(false);
    showNotice(t('notice.notificationsDenied'));
  }

  function updateInteractionSoundSetting(nextEnabled) {
    setInteractionSoundsEnabled(nextEnabled);
    playUiSound(nextEnabled ? 'open' : 'close');
    showNotice(nextEnabled ? t('notice.soundOn') : t('notice.soundOff'));
  }

  function clearTypingForMessage(message) {
    if (!message?.senderId || !message?.conversationId) return;
    setTypingUsers((current) => {
      const entry = current[message.senderId];
      if (!entry || entry.conversationId !== message.conversationId) return current;
      const next = { ...current };
      delete next[message.senderId];
      return next;
    });
  }

  function selectConversation(conversationId) {
    if (!conversationId) return;
    if (conversationId === activeChatIdRef.current) return;
    const previousChatId = activeChatIdRef.current;
    playUiSound('open');
    window.clearTimeout(chatSwitchTimerRef.current);
    setIsSwitchingChat(true);
    chatSwitchTimerRef.current = window.setTimeout(() => setIsSwitchingChat(false), 180);
    activeChatIdRef.current = conversationId;
    shouldStickToBottomRef.current = true;
    setActiveChatId(conversationId);
    setChats((current) => current.map((chat) => (chat.id === conversationId ? { ...chat, unread: 0 } : chat)));
    setReplyTarget(null);
    setEditingMessage(null);
    setOpenMessageMenuId('');
    setDeleteConfirmMessage(null);
    if (window.matchMedia('(max-width: 1180px)').matches) {
      setShowInspector(false);
    }
    setShowLatestButton(false);
    setShowAttachmentForm(false);
    setAttachmentDrafts((current) => {
      current.filter((attachment) => attachment.local).forEach((attachment) => URL.revokeObjectURL(attachment.url));
      return [];
    });
    setDraft('');
    if (previousChatId) {
      setChats((current) => current.filter((chat) => chat.id !== previousChatId || !isPrivateChatDraft(chat)));
    }
  }

  function closeConversationView() {
    const previousChatId = activeChatIdRef.current;
    activeChatIdRef.current = '';
    setActiveChatId('');
    if (window.matchMedia('(max-width: 1180px)').matches) {
      setShowInspector(false);
    }
    if (previousChatId) {
      setChats((current) => current.filter((chat) => chat.id !== previousChatId || !isPrivateChatDraft(chat)));
    }
  }

  function makePrivateDraftConversation(user) {
    return {
      id: `draft-private-${user.id}`,
      peerId: user.id,
      name: user.displayName || user.handle || t('common.user'),
      handle: user.handle || '',
      avatarUrl: user.avatarUrl || '',
      status: user.online ? 'online' : 'offline',
      lastSeen: user.lastSeen ?? null,
      online: Boolean(user.online),
      kind: 'private',
      unread: 0,
      myRole: 'owner',
      memberCount: 2,
      lastMessage: '',
      lastMessageAt: null,
      messages: [],
    };
  }

  async function ensureSendableConversation(conversationId) {
    if (!isDraftConversationId(conversationId)) return { conversationId, createdFromDraft: false };
    const draftChat = chats.find((chat) => chat.id === conversationId);
    const targetUserId = draftChat?.peerId || conversationId.replace(/^draft-private-/, '');
    const response = await api('/api/conversations/private', {
      method: 'POST',
      body: JSON.stringify({ userId: targetUserId }),
    });
    const conversation = await response.json();
    if (!response.ok) {
      throw new Error(serverError(conversation, t('notice.openChatFailed')));
    }
    setChats((current) =>
      uniqueChats(current.map((chat) =>
        chat.id === conversationId
          ? { ...conversation, messages: chat.messages ?? [] }
          : chat,
      )),
    );
    activeChatIdRef.current = conversation.id;
    setActiveChatId(conversation.id);
    return { conversationId: conversation.id, createdFromDraft: true };
  }

  function openMessageSearch() {
    setShowMessageSearch(true);
    requestAnimationFrame(() => messageSearchInputRef.current?.focus());
  }

  function selectMessageSearchResult(result) {
    if (!result?.conversationId) return;
    selectConversation(result.conversationId);
    setShowMessageSearch(false);
    setMessageSearchQuery('');
    setSearchResults([]);
  }

  function normalizeMessage(message) {
    if (!message) return message;
    const {
      uploadStatus,
      uploadProgress,
      uploadLoaded,
      uploadTotal,
      uploadError,
      ...serverMessage
    } = message;
    const senderId = serverMessage.senderId ?? serverMessage.sender_id ?? '';
    const conversationId = serverMessage.conversationId ?? serverMessage.conversation_id ?? '';
    const createdAt = serverMessage.createdAt ?? serverMessage.created_at ?? new Date().toISOString();
    const editedAt = serverMessage.editedAt ?? serverMessage.edited_at ?? null;
    const deletedAt = serverMessage.deletedAt ?? serverMessage.deleted_at ?? null;
    return {
      ...serverMessage,
      conversationId,
      senderId,
      sender: senderId === currentUser?.id ? 'me' : 'them',
      senderName: serverMessage.senderName ?? serverMessage.sender_name ?? serverMessage.display_name ?? '',
      senderAvatarUrl: serverMessage.senderAvatarUrl ?? serverMessage.sender_avatar_url ?? serverMessage.avatar_url ?? '',
      text: serverMessage.text ?? serverMessage.body ?? '',
      createdAt,
      editedAt,
      deletedAt,
      replyTo: serverMessage.replyTo ?? (serverMessage.reply_to_message_id
        ? {
            id: serverMessage.reply_to_message_id,
            text: serverMessage.reply_body ?? '',
            senderName: serverMessage.reply_sender_name ?? '',
          }
        : null),
      reactions: serverMessage.reactions ?? {},
      myReaction: serverMessage.myReaction ?? serverMessage.my_reaction ?? '',
      attachments: Array.isArray(serverMessage.attachments) ? serverMessage.attachments : [],
    };
  }

  function patchUserInChats(user) {
    if (!user?.id) return;
    setChats((current) =>
      current.map((chat) => ({
        ...chat,
        name: !chat.isAi && chat.kind === 'private' && (chat.handle === user.handle || chat.name === user.displayName) ? user.displayName : chat.name,
        handle: !chat.isAi && chat.kind === 'private' && (chat.handle === user.handle || chat.name === user.displayName) ? user.handle : chat.handle,
        avatarUrl: !chat.isAi && chat.kind === 'private' && (chat.handle === user.handle || chat.name === user.displayName) ? user.avatarUrl : chat.avatarUrl,
        messages: (chat.messages ?? []).map((message) =>
          message.senderId === user.id
            ? { ...message, senderName: user.displayName, senderAvatarUrl: user.avatarUrl ?? '' }
            : message,
        ),
      })),
    );
    setParticipants((current) => current.map((participant) => (participant.id === user.id ? { ...participant, ...user } : participant)));
  }

  function patchPresence(user, online, lastSeen) {
    if (!user?.id) return;
    const nextUser = { ...user, online: Boolean(online), lastSeen: lastSeen || user.lastSeen || new Date().toISOString() };
    if (nextUser.id === currentUser?.id) {
      setCurrentUser((current) => current ? { ...current, online: true, lastSeen: nextUser.lastSeen } : current);
    }
    setParticipants((current) => current.map((participant) => (
      participant.id === nextUser.id ? { ...participant, online: nextUser.online, lastSeen: nextUser.lastSeen } : participant
    )));
    setChats((current) =>
      uniqueChats(current.map((chat) => {
        const isPeer = !chat.isAi && chat.kind === 'private' && (chat.peerId === nextUser.id || chat.handle === nextUser.handle);
        if (!isPeer) return chat;
        return {
          ...chat,
          online: nextUser.online,
          status: nextUser.online ? 'online' : 'offline',
          lastSeen: nextUser.lastSeen,
        };
      })),
    );
  }

  function scheduleRealtimeRefresh() {
    window.clearTimeout(realtimeRefreshTimerRef.current);
    realtimeRefreshTimerRef.current = window.setTimeout(() => {
      loadStageData();
      if (activeChatIdRef.current) loadSidePanels(activeChatIdRef.current);
    }, 180);
  }

  async function loadConversationMessages(conversationId, { markRead = false, before = '', append = false } = {}) {
    if (!conversationId) return [];
    if (append) {
      setOlderMessageLoadingIds((current) => new Set(current).add(conversationId));
    } else {
      setMessageLoadingIds((current) => new Set(current).add(conversationId));
    }
    const params = new URLSearchParams({ limit: String(messagePageSize) });
    if (markRead) params.set('read', '1');
    if (before) params.set('before', before);
    try {
      const response = await api(`/api/conversations/${conversationId}/messages?${params.toString()}`);
      if (!response.ok) return [];
      const messages = (await response.json()).map((message) => normalizeMessage(message));
      setChats((current) =>
        uniqueChats(current.map((chat) =>
          chat.id === conversationId
            ? {
                ...chat,
                unread: markRead ? 0 : chat.unread,
                hasMoreMessages: messages.length === messagePageSize,
                messages: append ? uniqueMessages([...messages, ...(chat.messages ?? [])]) : messages,
              }
            : chat,
        )),
      );
      return messages;
    } finally {
      const setter = append ? setOlderMessageLoadingIds : setMessageLoadingIds;
      setter((current) => {
        const next = new Set(current);
        next.delete(conversationId);
        return next;
      });
    }
  }

  async function loadOlderMessages(conversationId = activeChatIdRef.current) {
    if (!conversationId || olderMessagesLoadingRef.current.has(conversationId)) return;
    const chat = chats.find((item) => item.id === conversationId);
    const firstMessage = chat?.messages?.[0];
    if (!firstMessage || chat.hasMoreMessages === false) return;

    olderMessagesLoadingRef.current.add(conversationId);
    const list = messageListRef.current;
    const previousHeight = list?.scrollHeight ?? 0;
    try {
      const messages = await loadConversationMessages(conversationId, { before: firstMessage.createdAt, append: true });
      if (messages.length && list) {
        requestAnimationFrame(() => {
          list.scrollTop = list.scrollHeight - previousHeight + list.scrollTop;
        });
      }
    } finally {
      olderMessagesLoadingRef.current.delete(conversationId);
    }
  }

  async function loadStageData() {
    setStageLoading(true);
    try {
      const [healthResult, readinessResult, profileResponse, conversationsResponse] = await Promise.all([
        api('/api/health')
          .then((response) => response.json())
          .catch(() => ({ database: 'offline', auth: 'unknown' })),
        api('/api/readiness')
          .then((response) => response.json())
          .catch(() => ({ ok: false })),
        api('/api/me'),
        api('/api/conversations'),
      ]);
      if ((profileResponse.status === 401 || conversationsResponse.status === 401) && refreshToken) {
        const refreshResponse = await fetch(`${apiUrl}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (refreshResponse.ok) {
          const data = await refreshResponse.json();
          persistAuthSession(data);
          showNotice(t('notice.sessionRefreshed'));
          return;
        }
        showNotice(t('notice.sessionExpired'));
        signOut();
        return;
      }
      if (profileResponse.status === 401 || conversationsResponse.status === 401) {
        showNotice(t('notice.sessionExpired'));
        signOut();
        return;
      }
      if (profileResponse.ok) {
        const profile = await profileResponse.json();
        setCurrentUser(profile);
        setProfileForm({
          displayName: profile.displayName ?? '',
          handle: profile.handle ?? '',
          avatarUrl: profile.avatarUrl ?? '',
          bio: profile.bio ?? '',
          privacyLevel: profile.privacyLevel ?? 'balanced',
        });
      }
      if (!conversationsResponse.ok) {
        showNotice(t('notice.loadConversationsFailed'));
        return;
      }
      const conversations = await conversationsResponse.json();
      setServerStatus({ online: readinessResult.ok, database: healthResult.database, auth: healthResult.auth, realtime: false });
      setChats((current) => {
        const currentById = new Map(current.map((chat) => [chat.id, chat]));
        const syncedChats = conversations.map((conversation) => {
          const existing = currentById.get(conversation.id);
          return {
            ...conversation,
            peerId: conversation.peerId || existing?.peerId || '',
            name: conversation.name || existing?.name || '',
            handle: conversation.handle || existing?.handle || '',
            status: conversation.status || existing?.status || '',
            avatarUrl: conversation.avatarUrl || existing?.avatarUrl || '',
            lastSeen: conversation.lastSeen || existing?.lastSeen || '',
            online: Boolean(conversation.online ?? existing?.online),
            messages: existing?.messages ?? [],
            hasMoreMessages: existing?.hasMoreMessages,
          };
        });
        const activeDraft = currentById.get(activeChatIdRef.current);
        return uniqueChats(
          activeDraft && !conversations.some((conversation) => conversation.id === activeDraft.id) && isPrivateChatDraft(activeDraft)
            ? [activeDraft, ...syncedChats]
            : syncedChats,
        );
      });
      setActiveChatId((current) => {
        if (conversations.find((chat) => chat.id === current)) return current;
        const activeDraft = chats.find((chat) => chat.id === current);
        return activeDraft && isPrivateChatDraft(activeDraft) ? current : '';
      });
      if (activeChatIdRef.current && conversations.some((chat) => chat.id === activeChatIdRef.current)) {
        loadConversationMessages(activeChatIdRef.current, { markRead: true }).catch(() => {});
      }
      setConnectionNotice('');
    } catch (error) {
      setServerStatus((current) => ({ ...current, online: false, realtime: false }));
      setConnectionNotice(t('notice.connectionLost'));
    } finally {
      setStageLoading(false);
    }
  }

  async function loadSidePanels(conversationId = activeChatId) {
    const requestId = ++sidePanelsRequestRef.current;
    if (!currentUser || !serverStatus.online || !conversationId || isDraftConversationId(conversationId)) {
      if (requestId === sidePanelsRequestRef.current) {
        setParticipants(isDraftConversationId(conversationId) ? [currentUser, activeChat].filter((item) => item?.id) : []);
        setJoinRequests([]);
      }
      return;
    }
    const [participantsResponse, joinRequestsResponse, moderationResponse, sessionsResponse, blocksResponse, auditResponse, aiModelsResponse] = await Promise.all([
      api(`/api/conversations/${conversationId}/participants`),
      api(`/api/conversations/${conversationId}/join-requests`),
      api('/api/moderation/queue'),
      api('/api/sessions'),
      api('/api/blocks'),
      api('/api/moderation/audit'),
      api('/api/ai-models'),
    ]);
    if (requestId !== sidePanelsRequestRef.current || conversationId !== activeChatIdRef.current) return;
    setParticipants(participantsResponse.ok ? await participantsResponse.json() : []);
    setJoinRequests(joinRequestsResponse.ok ? await joinRequestsResponse.json() : []);
    setModerationQueue(moderationResponse.ok ? await moderationResponse.json() : []);
    setSessions(sessionsResponse.ok ? await sessionsResponse.json() : []);
    setBlockedUsers(blocksResponse.ok ? await blocksResponse.json() : []);
    setAuditLog(auditResponse.ok ? await auditResponse.json() : []);
    setAiModelDetails(aiModelsResponse.ok ? await aiModelsResponse.json() : []);
  }

  useEffect(() => {
    if (!currentUser || !accessToken) return;
    let closed = false;
    let socket;
    let reconnectAttempt = 0;

    async function boot() {
      try {
        await loadStageData();
        if (closed) return;
        connectRealtime();
      } catch {
        if (!closed) setServerStatus({ online: false, database: 'offline', auth: 'error', realtime: false });
      }
    }

    function connectRealtime() {
      if (closed) return;
      window.clearTimeout(reconnectTimerRef.current);
      if (socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState)) return;
        const realtimeUrl = `${wsUrl}${wsUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(accessToken)}`;
        socket = new WebSocket(realtimeUrl);
        socketRef.current = socket;
        socket.onopen = () => {
          reconnectAttempt = 0;
          setServerStatus((current) => ({ ...current, realtime: true }));
          setConnectionNotice('');
        };
        socket.onclose = () => {
          if (socketRef.current === socket) socketRef.current = null;
          setServerStatus((current) => ({ ...current, realtime: false }));
          if (!closed) setConnectionNotice(t('notice.realtimeReconnecting'));
          if (!closed) {
            const delay = Math.min(10_000, 800 * (2 ** reconnectAttempt));
            reconnectAttempt += 1;
            reconnectTimerRef.current = window.setTimeout(connectRealtime, delay);
          }
        };
        socket.onerror = () => {
          socket.close();
        };
        socket.onmessage = (event) => {
          let payload;
          try {
            payload = JSON.parse(event.data);
          } catch {
            return;
          }
          const isMineRealtimeEvent = !Array.isArray(payload.participantIds)
            || payload.participantIds.includes(currentUser?.id);
          if (!isMineRealtimeEvent) return;
          if (payload.type === 'message.created') {
            const message = normalizeMessage(payload.message);
            clearTypingForMessage(message);
            setChats((current) =>
              uniqueChats(current.map((chat) => {
                if (chat.id !== message.conversationId) return chat;
                const updated = updateChatWithMessage(chat, message);
                const shouldCountUnread = message.sender !== 'me' && activeChatIdRef.current !== message.conversationId;
                return shouldCountUnread ? { ...updated, unread: Number(chat.unread ?? 0) + 1 } : updated;
              })),
            );
            if (message.sender !== 'me' && activeChatIdRef.current !== message.conversationId) {
              notifyIncomingMessage(message).catch(() => {});
            }
            setChats((current) => {
              if (current.some((chat) => chat.id === message.conversationId)) {
                scheduleRealtimeRefresh();
                return current;
              }
              scheduleRealtimeRefresh();
              return current;
            });
          }
          if (payload.type === 'message.updated') {
            const message = normalizeMessage(payload.message);
            setChats((current) =>
              uniqueChats(current.map((chat) => (chat.id === message.conversationId ? updateChatMessage(chat, message) : chat))),
            );
            scheduleRealtimeRefresh();
          }
          if (payload.type === 'message.deleted') {
            setChats((current) =>
              current.map((chat) => (chat.id === payload.conversationId ? removeChatMessage(chat, payload.messageId) : chat)),
            );
            scheduleRealtimeRefresh();
          }
          if (payload.type === 'moderation.resolved') {
            setModerationQueue((current) => current.filter((item) => item.id !== payload.messageId));
            setAuditLog((current) => [
              {
                id: payload.eventId || `${payload.messageId}-${payload.action}-${Date.now()}`,
                action: payload.action,
                conversationId: payload.conversationId,
                conversationName: payload.conversationName || t('common.conversation'),
                actorName: payload.actorName || t('role.admin'),
              },
              ...current,
            ].slice(0, 20));
            scheduleRealtimeRefresh();
          }
          if (payload.type === 'conversation.created') {
            scheduleRealtimeRefresh();
          }
          if (payload.type === 'conversation.updated') {
            const conversation = payload.conversation;
            if (conversation?.id) {
              setChats((current) =>
                uniqueChats(current.map((chat) =>
                  chat.id === conversation.id
                    ? { ...chat, ...conversation, messages: chat.messages ?? [] }
                    : chat,
                )),
              );
            }
            scheduleRealtimeRefresh();
          }
          if (payload.type === 'participant.added') {
            scheduleRealtimeRefresh();
            if (payload.conversationId === activeChatIdRef.current) loadSidePanels(payload.conversationId);
          }
          if (payload.type === 'join_request.created' || payload.type === 'join_request.resolved') {
            scheduleRealtimeRefresh();
            if (payload.conversationId === activeChatIdRef.current) loadSidePanels(payload.conversationId);
          }
          if (payload.type === 'user.updated') {
            const user = payload.user;
            if (user?.id === currentUser?.id) {
              setCurrentUser(user);
              setProfileForm({
                displayName: user.displayName ?? '',
                handle: user.handle ?? '',
                avatarUrl: user.avatarUrl ?? '',
                bio: user.bio ?? '',
                privacyLevel: user.privacyLevel ?? 'balanced',
              });
              localStorage.setItem('veritas-session', JSON.stringify({ user, accessToken, refreshToken, sessionId }));
            }
            patchUserInChats(user);
            scheduleRealtimeRefresh();
          }
          if (payload.type === 'presence.updated') {
            patchPresence(payload.user, payload.online, payload.lastSeen);
          }
          if (payload.type === 'typing') {
            setTypingUsers((current) => ({
              ...current,
              [payload.user.id]: { conversationId: payload.conversationId, user: payload.user, at: Date.now() },
            }));
          }
          if (payload.type === 'typing.stop') {
            setTypingUsers((current) => {
              if (!payload.user?.id) return current;
              const entry = current[payload.user.id];
              if (!entry || entry.conversationId !== payload.conversationId) return current;
              const next = { ...current };
              delete next[payload.user.id];
              return next;
            });
          }
        };
    }

    boot();
    return () => {
      closed = true;
      socketRef.current = null;
      window.clearTimeout(realtimeRefreshTimerRef.current);
      window.clearTimeout(reconnectTimerRef.current);
      if (socket) socket.close();
    };
  }, [currentUser?.id, accessToken]);

  useEffect(() => {
    loadSidePanels(activeChatId);
  }, [activeChatId, currentUser?.id, serverStatus.online]);

  useEffect(() => {
    if (!showMessageSearch) return;
    requestAnimationFrame(() => messageSearchInputRef.current?.focus());
  }, [showMessageSearch, activeChatId]);

  useEffect(() => {
    if (!activeChatId || !currentUser || !accessToken || !serverStatus.online) return;
    const unreadCount = Number(activeChat.unread ?? 0);
    const isIncomingLatest = latestMessage?.sender === 'them';
    const markerKey = `${activeChatId}:${latestMessage?.id ?? 'empty'}:${unreadCount}`;
    const alreadyMarkedThisChat = readMarkerKeyRef.current.startsWith(`${activeChatId}:`);
    if (!isIncomingLatest && unreadCount <= 0 && alreadyMarkedThisChat) return;
    if (readMarkerKeyRef.current === markerKey) return;
    readMarkerKeyRef.current = markerKey;
    let cancelled = false;
    async function markActiveChatRead() {
      const messages = await loadConversationMessages(activeChatId, { markRead: true });
      if (cancelled || !messages.length) return;
    }
    markActiveChatRead().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeChatId, activeChat.unread, latestMessageKey, latestMessage?.sender, currentUser?.id, accessToken, serverStatus.online]);

  useEffect(() => {
    if (!openMessageMenuId) return undefined;

    function closeMenuFromOutside(event) {
      if (event.target.closest('.floating-message-actions')) return;
      if (event.target.closest('.message.menu-open')) return;
      setOpenMessageMenuId('');
    }

    function closeMenuWithEscape(event) {
      if (event.key === 'Escape') setOpenMessageMenuId('');
    }

    document.addEventListener('pointerdown', closeMenuFromOutside);
    document.addEventListener('keydown', closeMenuWithEscape);
    return () => {
      document.removeEventListener('pointerdown', closeMenuFromOutside);
      document.removeEventListener('keydown', closeMenuWithEscape);
    };
  }, [openMessageMenuId]);

  useEffect(() => {
    if (inspectorPage === 'security' || (isPrivateChat && inspectorPage === 'moderation')) {
      setInspectorPage('info');
    }
  }, [isPrivateChat, inspectorPage]);

  useEffect(() => {
    if (!currentUser || !accessToken || !serverStatus.online) return;
    function pingPresence() {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: 'presence.ping' }));
        return;
      }
      api('/api/presence', { method: 'POST', body: JSON.stringify({}) }).catch(() => {});
    }
    pingPresence();
    const timer = setInterval(pingPresence, 20_000);
    window.addEventListener('focus', pingPresence);
    document.addEventListener('visibilitychange', pingPresence);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', pingPresence);
      document.removeEventListener('visibilitychange', pingPresence);
    };
  }, [currentUser?.id, accessToken, serverStatus.online]);

  useEffect(() => {
    const timer = setInterval(() => setTypingUsers((current) => ({ ...current })), 1200);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => () => window.clearTimeout(chatSwitchTimerRef.current), []);

  useEffect(() => {
    if (!currentUser || !accessToken) return;
    const q = searchQuery.trim();
    if (!q) {
      setUserSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      if (!serverStatus.online) return;
      try {
        const userResponse = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
        setUserSearchResults(userResponse.ok ? await userResponse.json() : []);
      } catch {
        setUserSearchResults([]);
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [searchQuery, serverStatus.online, currentUser?.id, accessToken]);

  useEffect(() => {
    if (!currentUser || !accessToken) return;
    const q = messageSearchQuery.trim();
    if (!q) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      if (!serverStatus.online) return;
      try {
        const params = new URLSearchParams({ q });
        if (activeChatIdRef.current) params.set('conversationId', activeChatIdRef.current);
        const response = await api(`/api/messages/search?${params.toString()}`);
        setSearchResults(response.ok ? await response.json() : []);
      } catch {
        setSearchResults([]);
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [messageSearchQuery, activeChatId, serverStatus.online, currentUser?.id, accessToken]);

  async function sendMessage() {
    if (!canPostInActiveChat) {
      playUiSound('error');
      showNotice(t('notice.channelReadOnly'));
      return;
    }
    const text = draft.trim();
    const attachmentItems = attachmentDrafts
      .filter((attachment) => attachment.name.trim() && attachment.url.trim())
      .slice(0, 4);
    const attachments = attachmentItems.map((attachment) => ({ ...attachment, file: undefined, local: undefined, size: Number(attachment.size || 0) }));
    if ((!text && attachments.length === 0) || !activeChatId) return;
    let conversationId = activeChatId;
    let createdFromDraft = false;
    if (!editingMessage) {
      try {
        const sendableConversation = await ensureSendableConversation(activeChatId);
        conversationId = sendableConversation.conversationId;
        createdFromDraft = sendableConversation.createdFromDraft;
      } catch (error) {
        playUiSound('error');
        showNotice(error.message || t('notice.openChatFailed'));
        return;
      }
    }
    playUiSound(editingMessage ? 'tap' : 'send');
    sendTypingStop(conversationId);
    setDraft('');
    if (editingMessage) {
      const response = await api(`/api/messages/${editingMessage.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ text }),
      });
      const data = await response.json();
      if (!response.ok) {
        playUiSound('error');
        showNotice(serverError(data, t('notice.editMessageFailed')));
        setDraft(text);
        return;
      }
      const message = normalizeMessage(data);
      setChats((current) =>
        current.map((chat) =>
          chat.id === activeChatId
            ? { ...chat, lastMessage: message.text, messages: uniqueMessages((chat.messages ?? []).map((item) => (item.id === message.id ? message : item))) }
            : chat,
        ),
      );
      setEditingMessage(null);
      return;
    }
    const localUploads = attachmentItems.filter((attachment) => attachment.file);
    if (localUploads.length > 0) {
      const pendingId = `pending-upload-${crypto.randomUUID()}`;
      const totalSize = localUploads.reduce((sum, attachment) => sum + Number(attachment.size || attachment.file?.size || 0), 0);
      addPendingUploadMessage({
        id: pendingId,
        conversationId,
        sender: 'me',
        senderId: currentUser?.id,
        senderName: currentUser?.displayName || currentUser?.handle || t('common.user'),
        senderAvatarUrl: currentUser?.avatarUrl ?? '',
        text,
        attachments: localUploads.map((attachment) => ({
          id: attachment.id || `preview-${crypto.randomUUID()}`,
          name: attachment.name,
          url: attachment.url,
          mimeType: attachment.mimeType,
          size: Number(attachment.size || 0),
          uploadPreview: true,
        })),
        verdict: 'safe',
        createdAt: new Date().toISOString(),
        uploadStatus: 'uploading',
        uploadProgress: 0,
        uploadLoaded: 0,
        uploadTotal: totalSize,
        retryPayload: {
          text,
          replyToMessageId: replyTarget?.id,
          localFiles: localUploads.map((attachment) => attachment.file).filter(Boolean),
        },
      });
      setAttachmentDrafts([]);
      setShowAttachmentForm(false);
      let uploadCompleted = false;
      setUploadingFile(true);
      try {
        const uploads = await uploadFilesWithProgress(localUploads.map((attachment) => attachment.file), (progress) => {
          updatePendingUploadMessage(pendingId, {
            uploadLoaded: progress.loaded,
            uploadTotal: progress.total || totalSize,
            uploadProgress: progress.progress,
          });
        });
        updatePendingUploadMessage(pendingId, { uploadStatus: 'sending', uploadProgress: 100, uploadLoaded: totalSize, uploadTotal: totalSize });
        const response = await api(`/api/conversations/${conversationId}/messages`, {
          method: 'POST',
          body: JSON.stringify({
            text,
            replyToMessageId: replyTarget?.id,
            attachments: uploads.slice(0, 4).map((item) => ({
              name: item.name,
              url: item.url,
              mimeType: item.mimeType,
              size: Number(item.size ?? 0),
            })),
          }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(serverError(data, t('notice.sendMessageFailed')));
        const message = normalizeMessage(data);
        uploadCompleted = true;
        replacePendingUploadMessage(pendingId, message);
        setReplyTarget(null);
        if (message.verdict !== 'safe') loadSidePanels(conversationId);
      } catch (error) {
        playUiSound('error');
        if (createdFromDraft) {
          api(`/api/conversations/${conversationId}/draft`, { method: 'DELETE' }).catch(() => {});
        }
        updatePendingUploadMessage(pendingId, {
          uploadStatus: 'failed',
          uploadError: error.message || t('notice.uploadFailed'),
        });
        showNotice(error.message || t('notice.sendMediaFailed'));
      } finally {
        if (uploadCompleted) localUploads.forEach((attachment) => URL.revokeObjectURL(attachment.url));
        setUploadingFile(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
      return;
    }
    const pendingId = `pending-message-${crypto.randomUUID()}`;
    const hasAttachmentPreview = attachments.length > 0;
    addPendingUploadMessage({
      id: pendingId,
      conversationId,
      sender: 'me',
      senderId: currentUser?.id,
      senderName: currentUser?.displayName || currentUser?.handle || t('common.user'),
      senderAvatarUrl: currentUser?.avatarUrl ?? '',
      text,
      attachments,
      verdict: 'safe',
      createdAt: new Date().toISOString(),
      ...(hasAttachmentPreview
        ? {
            uploadStatus: 'sending',
            uploadProgress: 100,
            uploadLoaded: 0,
            uploadTotal: 0,
          }
        : {}),
      retryPayload: { text, replyToMessageId: replyTarget?.id, attachments },
    });
    setReplyTarget(null);
    setAttachmentDrafts([]);
    setShowAttachmentForm(false);
    try {
      const response = await api(`/api/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text, replyToMessageId: replyTarget?.id, attachments }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(serverError(data, t('notice.sendMessageFailed')));
      const message = normalizeMessage(data);
      replacePendingUploadMessage(pendingId, message);
      if (message.verdict !== 'safe') loadSidePanels(conversationId);
    } catch (error) {
      playUiSound('error');
      if (createdFromDraft) {
        api(`/api/conversations/${conversationId}/draft`, { method: 'DELETE' }).catch(() => {});
      }
      updatePendingUploadMessage(pendingId, {
        uploadStatus: hasAttachmentPreview ? 'failed' : 'send-failed',
        uploadError: error.message || t('notice.sendFailed'),
      });
      showNotice(error.message || t('notice.sendMessageFailed'));
    }
  }

  function sendTypingHint() {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN || !activeChatId || isDraftConversationId(activeChatId) || !currentUser) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current < 1200) return;
    lastTypingSentRef.current = now;
    window.clearTimeout(typingTimerRef.current);
    socketRef.current.send(JSON.stringify({ type: 'typing', conversationId: activeChatId, user: currentUser }));
    typingTimerRef.current = window.setTimeout(() => {
      lastTypingSentRef.current = 0;
    }, 1800);
  }

  function sendTypingStop(conversationId = activeChatId) {
    window.clearTimeout(typingTimerRef.current);
    lastTypingSentRef.current = 0;
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN || !conversationId || isDraftConversationId(conversationId) || !currentUser) return;
    socketRef.current.send(JSON.stringify({ type: 'typing.stop', conversationId, user: currentUser }));
  }

  async function reactToMessage(messageId, emoji, attachmentId = '') {
    playUiSound('react');
    setChats((current) =>
      current.map((chat) => {
        if (chat.id !== activeChatId) return chat;
        return {
          ...chat,
          messages: (chat.messages ?? []).map((message) => {
            if (message.id !== messageId) return message;
            if (!attachmentId) return updateReactionState(message, emoji);
            return {
              ...message,
              attachments: (message.attachments ?? []).map((attachment) =>
                (attachment.id || attachment.url) === attachmentId
                  ? updateReactionState(attachment, emoji)
                  : attachment,
              ),
            };
          }),
        };
      }),
    );

    try {
      const response = await api(`/api/messages/${messageId}/reaction`, {
        method: 'PUT',
        body: JSON.stringify({ emoji, attachmentId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(serverError(data, t('notice.reactionFailed')));
      setChats((current) =>
        current.map((chat) =>
          chat.id === data.conversationId
            ? {
                ...chat,
                messages: uniqueMessages((chat.messages ?? []).map((message) => (message.id === data.id ? data : message))),
              }
            : chat,
        ),
      );
    } catch (error) {
      showNotice(error.message || t('notice.reactionFailed'));
      loadStageData().catch(() => {});
    }
  }

  function ReactionVisual({ value }) {
    const gifName = reactionGifByValue[value];
    if (!gifName) return <span className="reaction-fallback">{value}</span>;
    return <img className="reaction-gif" src={`${telegramGifEmojiBase}/${gifName}`} alt={value} loading="lazy" />;
  }

  function ReactionPicker({ target, onReact }) {
    return (
      <div className="reaction-picker" aria-label={t('main.chooseReaction')}>
        {reactionChoices.map((reaction) => (
          <button
            key={reaction.value}
            className={target?.myReaction === reaction.value ? 'active' : ''}
            type="button"
            title={t(reaction.labelKey)}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onReact(reaction.value);
            }}
          >
            <span className="reaction-menu-emoji" aria-hidden="true">{reaction.value}</span>
          </button>
        ))}
      </div>
    );
  }

  function ReactionPills({ target, onReact }) {
    const activeReactions = Object.entries(target?.reactions ?? {}).filter(([, count]) => Number(count) > 0);
    if (!activeReactions.length) return null;

    return (
      <div className="reaction-pills">
        {activeReactions.map(([value, count]) => (
          <button
            key={value}
            className={target?.myReaction === value ? 'active' : ''}
            type="button"
            aria-label={t('main.reactionCount', { value, count })}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onReact(value);
            }}
          >
            <ReactionVisual value={value} />
            <strong>{count}</strong>
          </button>
        ))}
      </div>
    );
  }

  function messageAvatarUrl(message) {
    if (message.sender === 'me') return currentUser?.avatarUrl ?? '';
    return message.senderAvatarUrl || participants.find((participant) => participant.id === message.senderId)?.avatarUrl || '';
  }

  function getMessageMenuPosition(event, message) {
    const rect = event.currentTarget.getBoundingClientRect();
    const padding = 12;
    const gutter = 8;
    const menuWidth = Math.min(window.innerWidth <= 760 ? 280 : 330, window.innerWidth - padding * 2);
    const menuHeight = Math.min(430, window.innerHeight - padding * 2);
    const anchorX = Number.isFinite(event.clientX) ? event.clientX : rect.left + rect.width / 2;
    const anchorY = Number.isFinite(event.clientY) ? event.clientY : rect.top + 8;
    const minLeft = padding;
    const maxLeft = Math.max(minLeft, window.innerWidth - menuWidth - padding);
    const minTop = padding;
    const maxTop = Math.max(minTop, window.innerHeight - menuHeight - padding);
    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

    let left = message.sender === 'me' ? anchorX - menuWidth - gutter : anchorX + gutter;
    if (left < minLeft || left > maxLeft) {
      left = anchorX + menuWidth / 2 > window.innerWidth / 2
        ? anchorX - menuWidth - gutter
        : anchorX + gutter;
    }

    let top = anchorY + gutter;
    if (top + menuHeight > window.innerHeight - padding) {
      top = anchorY - menuHeight - gutter;
    }

    return {
      left: Math.round(clamp(left, minLeft, maxLeft)),
      top: Math.round(clamp(top, minTop, maxTop)),
    };
  }

  function toggleMessageMenu(event, message, options = {}) {
    if (!options.allowInteractive && event.target.closest('button, a, input, textarea, select')) return;
    const nextPosition = getMessageMenuPosition(event, message);
    setOpenMessageMenuId((current) => {
      if (current === message.id) return '';
      setMessageMenuPosition(nextPosition);
      return message.id;
    });
  }

  function updateDraft(value) {
    setDraft(value);
    if (value.trim()) {
      sendTypingHint();
    } else {
      sendTypingStop(activeChatId);
    }
  }

  function prepareGifEmoji(emoji) {
    const url = emoji.url || `${telegramGifEmojiBase}/${emoji.name}`;
    const label = emoji.label || emoji.name || t('composer.gifUpload');
    if (url.startsWith('data:')) {
      try {
        const file = fileFromDataUrl(url, `${label.replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-+|-+$/g, '') || 'veritas-gif'}.gif`);
        const previewUrl = URL.createObjectURL(file);
        setAttachmentDrafts([{
          id: `gif-${crypto.randomUUID()}`,
          name: file.name,
          url: previewUrl,
          mimeType: file.type || 'image/gif',
          size: String(file.size),
          sticker: true,
          file,
          local: true,
        }]);
        setShowAttachmentForm(true);
        return;
      } catch {
        showNotice(t('notice.gifUploadBroken'));
        return;
      }
    }
    setAttachmentDrafts([{
      name: label,
      url,
      mimeType: 'image/gif',
      size: '0',
      sticker: true,
    }]);
    setShowAttachmentForm(true);
  }

  function addPendingUploadMessage(message) {
    setChats((current) =>
      current.map((chat) =>
        chat.id === message.conversationId
          ? {
              ...chat,
              lastMessage: message.text || t('notice.uploading'),
              lastMessageAt: message.createdAt,
              messages: uniqueMessages([...(chat.messages ?? []), message]),
            }
          : chat,
      ),
    );
  }

  function updatePendingUploadMessage(messageId, patch) {
    setChats((current) =>
      current.map((chat) =>
        (chat.messages ?? []).some((message) => message.id === messageId)
          ? {
              ...chat,
              messages: (chat.messages ?? []).map((message) => (message.id === messageId ? { ...message, ...patch } : message)),
            }
          : chat,
      ),
    );
  }

  function replacePendingUploadMessage(pendingId, message) {
    setChats((current) =>
      current.map((chat) =>
        chat.id === message.conversationId
          ? {
              ...chat,
              lastMessage: message.text,
              lastMessageAt: message.createdAt,
              messages: uniqueMessages([...(chat.messages ?? []).filter((item) => item.id !== pendingId && item.id !== message.id), message]),
            }
          : chat,
      ),
    );
  }

  function removeFailedMessage(messageId) {
    setChats((current) =>
      current.map((chat) => ({
        ...chat,
        messages: (chat.messages ?? []).filter((message) => message.id !== messageId),
      })),
    );
  }

  async function retryFailedMessage(message) {
    if (!message?.id || message.uploadStatus !== 'failed') return;
    const retryPayload = message.retryPayload ?? {
      text: message.text ?? '',
      replyToMessageId: message.replyTo?.id,
      attachments: message.attachments ?? [],
    };
    updatePendingUploadMessage(message.id, {
      uploadStatus: retryPayload.localFiles?.length ? 'uploading' : 'sending',
      uploadError: '',
      uploadProgress: retryPayload.localFiles?.length ? 0 : 100,
      uploadLoaded: 0,
    });
    try {
      let attachments = retryPayload.attachments ?? [];
      if (retryPayload.localFiles?.length) {
        const uploads = await uploadFilesWithProgress(retryPayload.localFiles, (progress) => {
          updatePendingUploadMessage(message.id, {
            uploadLoaded: progress.loaded,
            uploadTotal: progress.total,
            uploadProgress: progress.progress,
          });
        });
        attachments = uploads.slice(0, 4).map((item) => ({
          name: item.name,
          url: item.url,
          mimeType: item.mimeType,
          size: Number(item.size ?? 0),
        }));
        updatePendingUploadMessage(message.id, { uploadStatus: 'sending', uploadProgress: 100 });
      }
      const response = await api(`/api/conversations/${message.conversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          text: retryPayload.text ?? message.text ?? '',
          replyToMessageId: retryPayload.replyToMessageId,
          attachments,
        }),
      });
      const savedMessage = await response.json();
      if (!response.ok) throw new Error(serverError(savedMessage, t('notice.sendMessageFailed')));
      replacePendingUploadMessage(message.id, savedMessage);
      if (savedMessage.verdict !== 'safe') loadSidePanels(message.conversationId);
    } catch (error) {
      updatePendingUploadMessage(message.id, {
        uploadStatus: 'failed',
        uploadError: error.message || t('notice.sendFailed'),
      });
    }
  }

  function uploadFilesWithProgress(files, onProgress) {
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      files.forEach((file) => formData.append('file', file));
      const request = new XMLHttpRequest();
      request.open('POST', `${apiUrl}/api/uploads`);
      request.timeout = 30000;
      request.setRequestHeader('Authorization', `Bearer ${accessToken}`);
      request.upload.onprogress = (event) => {
        const fallbackTotal = files.reduce((sum, file) => sum + file.size, 0);
        const total = event.lengthComputable ? event.total : fallbackTotal;
        onProgress({
          loaded: event.loaded,
          total,
          progress: total ? Math.round((event.loaded / total) * 100) : 0,
        });
      };
      request.onload = () => {
        let data = null;
        try {
          data = JSON.parse(request.responseText || 'null');
        } catch {
          data = null;
        }
        if (request.status >= 200 && request.status < 300) {
          resolve(Array.isArray(data) ? data : [data]);
          return;
        }
        reject(new Error(data?.error || t('notice.uploadServerFailed')));
      };
      request.onerror = () => reject(new Error(t('notice.uploadNoConnection')));
      request.ontimeout = () => reject(new Error(t('notice.uploadTimeout')));
      request.onabort = () => reject(new Error(t('notice.uploadAborted')));
      request.send(formData);
    });
  }

  async function uploadMediaFile(fileList) {
    const files = Array.from(fileList ?? []);
    if (!files.length || !activeChatId || editingMessage) return;
    const imageFiles = files.filter((file) => file.type.startsWith('image/')).slice(0, 4);
    let selectedFiles = imageFiles.length === files.length ? imageFiles : files.slice(0, 1);
    if (files.length > 4 && imageFiles.length === files.length) {
      showNotice(t('notice.maxImages'));
    }
    if (imageFiles.length !== files.length && files.length > 1) {
      showNotice(t('notice.singleNonImage'));
    }
    selectedFiles = await compressUploadImages(selectedFiles, {
      maxDimension: 1600,
      maxBytes: 2 * 1024 * 1024,
      quality: 0.82,
    });
    const oversized = selectedFiles.find((file) => file.size > maxUploadFileSize);
    if (oversized) {
      showNotice(t('notice.fileTooLarge', { name: oversized.name, size: formatFileSize(oversized.size, t) }));
      return;
    }
    setAttachmentDrafts((current) => {
      current.filter((attachment) => attachment.local).forEach((attachment) => URL.revokeObjectURL(attachment.url));
      return selectedFiles.map((file) => ({
        ...emptyAttachmentDraft,
        id: `local-${crypto.randomUUID()}`,
        name: file.name,
        url: URL.createObjectURL(file),
        mimeType: file.type || 'application/octet-stream',
        size: String(file.size),
        file,
        local: true,
      }));
    });
    setShowAttachmentForm(true);
    showNotice(selectedFiles.length > 1 ? t('notice.filesSelected', { count: selectedFiles.length }) : t('notice.fileSelected'));
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function stopAudioRecording() {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  async function toggleAudioRecording() {
    if (editingMessage || uploadingFile) return;
    if (recordingAudio) {
      stopAudioRecording();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      showNotice(t('notice.recordUnsupported'));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;
      recorderStreamRef.current = stream;
      recorderChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data?.size) recorderChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const chunks = recorderChunksRef.current;
        recorderChunksRef.current = [];
        recorderStreamRef.current?.getTracks().forEach((track) => track.stop());
        recorderStreamRef.current = null;
        recorderRef.current = null;
        setRecordingAudio(false);
        if (!chunks.length) return;
        const blob = new Blob(chunks, { type: mimeType });
        const file = new File([blob], `veritas-voice-${Date.now()}.webm`, { type: mimeType });
        const url = URL.createObjectURL(blob);
        setAttachmentDrafts((current) => {
          current.filter((attachment) => attachment.local).forEach((attachment) => URL.revokeObjectURL(attachment.url));
          return [{
            ...emptyAttachmentDraft,
            id: `voice-${crypto.randomUUID()}`,
            name: t('message.voiceName'),
            url,
            mimeType,
            size: String(file.size),
            file,
            local: true,
          }];
        });
        setShowAttachmentForm(true);
      };
      recorder.start();
      setRecordingAudio(true);
      showNotice(t('notice.recording'));
    } catch {
      setRecordingAudio(false);
      recorderStreamRef.current?.getTracks().forEach((track) => track.stop());
      recorderStreamRef.current = null;
      showNotice(t('notice.microphoneFailed'));
    }
  }

  async function uploadProfileAvatar(fileList) {
    let file = Array.from(fileList ?? []).find((item) => item.type.startsWith('image/'));
    if (!file) {
      showNotice(t('notice.chooseAvatar'));
      return;
    }
    if (file.size > maxUploadFileSize) {
      showNotice(t('notice.fileTooLarge', { name: file.name, size: formatFileSize(file.size, t) }));
      return;
    }
    file = await compressImageFile(file, {
      maxDimension: 512,
      maxBytes: 650 * 1024,
      quality: 0.78,
      force: true,
    }).catch(() => file);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const response = await fetch(`${apiUrl}/api/uploads`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: formData,
      });
      const data = await response.json();
      if (!response.ok) {
        showNotice(serverError(data, t('notice.avatarUploadFailed')));
        return;
      }
      const [avatar] = Array.isArray(data) ? data : [data];
      setProfileForm((current) => ({ ...current, avatarUrl: avatar.url }));
      showNotice(t('notice.avatarSelected'));
    } catch {
      showNotice(t('notice.avatarUploadNoConnection'));
    }
  }

  function startEditing(message) {
    setOpenMessageMenuId('');
    setEditingMessage(message);
    setReplyTarget(null);
    setDraft(message.text);
  }

  async function copyMessageText(message) {
    try {
      await navigator.clipboard?.writeText(message.text ?? '');
      showNotice(t('notice.copyMessageOk'));
    } catch {
      showNotice(t('notice.copyMessageFailed'));
    }
    setOpenMessageMenuId('');
  }

  function selectMessage(message) {
    setReplyTarget(message);
    setOpenMessageMenuId('');
    showNotice(t('notice.messageSelected'));
  }

  function forwardMessage(message) {
    setDraft(message.text ?? '');
    setOpenMessageMenuId('');
    showNotice(t('notice.forwardPrepared'));
  }

  function pinMessage() {
    setOpenMessageMenuId('');
    showNotice(t('notice.pinSoon'));
  }

  function cancelComposerMode() {
    setEditingMessage(null);
    setReplyTarget(null);
    setDraft('');
    setShowAttachmentForm(false);
    setAttachmentDrafts([]);
  }

  function requestDeleteMessage(message) {
    setOpenMessageMenuId('');
    setDeleteConfirmMessage(message);
  }

  async function deleteChatMessage(message = deleteConfirmMessage) {
    if (!message) return;
    setDeleteConfirmMessage(null);
    const response = await api(`/api/messages/${message.id}`, { method: 'DELETE' });
    if (!response.ok) {
      const data = await response.json();
      showNotice(serverError(data, t('notice.deleteMessageFailed')));
      return;
    }
    setChats((current) =>
      current.map((chat) =>
        chat.id === activeChatId
          ? { ...chat, messages: (chat.messages ?? []).filter((item) => item.id !== message.id) }
          : chat,
      ),
    );
    showNotice(t('notice.deleteMessageOk'));
  }

  async function saveProfile(event) {
    event?.preventDefault?.();
    const response = await api('/api/me', {
      method: 'PATCH',
      body: JSON.stringify(profileForm),
    });
    const profile = await response.json();
    if (!response.ok) {
      showNotice(serverError(profile, t('notice.saveProfileFailed')));
      return;
    }
    const session = { user: profile, accessToken, refreshToken, sessionId };
    localStorage.setItem('veritas-session', JSON.stringify(session));
    setCurrentUser(profile);
    setProfileForm({
      displayName: profile.displayName ?? '',
      handle: profile.handle ?? '',
      avatarUrl: profile.avatarUrl ?? '',
      bio: profile.bio ?? '',
      privacyLevel: profile.privacyLevel ?? 'balanced',
    });
    setAuthError('');
    setShowProfilePage(false);
    showNotice(t('notice.saveProfileOk'));
  }

  async function subscribeExtraPlan() {
    if (hasExtraPlan) {
      showNotice(t('notice.extraActive'));
      return;
    }

    try {
      const response = await api('/api/me/plan', {
        method: 'POST',
        body: JSON.stringify({ plan: 'extra' }),
      });
      const user = await response.json();
      if (!response.ok) {
        showNotice(serverError(user, t('notice.extraFailed')));
        return;
      }
      const session = { user, accessToken, refreshToken, sessionId };
      localStorage.setItem('veritas-session', JSON.stringify(session));
      setCurrentUser(user);
      setProfileForm({
        displayName: user.displayName ?? '',
        handle: user.handle ?? '',
        avatarUrl: user.avatarUrl ?? '',
        bio: user.bio ?? '',
        privacyLevel: user.privacyLevel ?? 'balanced',
      });
      showNotice(t('notice.extraOk'));
    } catch {
      showNotice(t('notice.extraNoConnection'));
    }
  }

  async function createNewConversation(event) {
    event.preventDefault();
    const name = newChat.name.trim();
    if (!name) return;
    if (newChat.kind === 'ai') {
      if (name.length < 2) {
        showNotice(t('notice.aiNameShort'));
        return;
      }
      if (!newChat.systemPrompt?.trim() || newChat.systemPrompt.trim().length < 6) {
        showNotice(t('notice.aiPromptShort'));
        return;
      }
      if (!newChat.modelName?.trim() || !newChat.modelName.includes('/')) {
        showNotice(t('notice.aiModelInvalid'));
        return;
      }
      if (!newChat.apiKey?.trim() || newChat.apiKey.trim().length < 16) {
        showNotice(t('notice.aiKeyInvalid'));
        return;
      }
      showNotice(t('notice.aiKeyChecking'));
      const response = await api('/api/ai-models', {
        method: 'POST',
        body: JSON.stringify({
          name,
          avatarUrl: newChat.avatarUrl,
          systemPrompt: newChat.systemPrompt,
          provider: newChat.provider || 'openrouter',
          modelName: newChat.modelName || 'poolside/laguna-xs.2:free',
          privacy: newChat.privacy || 'private',
          apiKey: newChat.apiKey,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        showNotice(serverError(result, t('notice.aiCreateFailed')));
        return;
      }
      const conversation = result.conversation;
      if (result.model) {
        setAiModelDetails((current) => [result.model, ...current.filter((item) => item.id !== result.model.id)]);
      }
      setChats((current) => uniqueChats([{ ...conversation, messages: [] }, ...current]));
      selectConversation(conversation.id);
      loadConversationMessages(conversation.id, { markRead: true }).catch(() => {});
      setNewChat(emptyNewChat);
      setShowCreator(false);
      showNotice(t('notice.aiCreated'));
      return;
    }
    const kind = newChat.kind === 'channel' ? 'channel' : 'group';
    const fallbackHandle = kind === 'channel' ? `@${slugify(name)}` : slugify(name);
    const response = await api('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({
        kind,
        name,
        handle: newChat.handle?.trim() || fallbackHandle,
        description: newChat.description?.trim() || '',
        postingPolicy: kind === 'channel' ? 'admins' : 'members',
        privacyLevel: newChat.privacyLevel || 'public',
        joinPolicy: newChat.joinPolicy || 'open',
      }),
    });
    const conversation = await response.json();
    if (!response.ok) {
      showNotice(serverError(conversation, t('notice.conversationCreateFailed')));
      return;
    }
    setChats((current) => uniqueChats([{ ...conversation, messages: [] }, ...current]));
    selectConversation(conversation.id);
    loadConversationMessages(conversation.id, { markRead: true }).catch(() => {});
    setNewChat(emptyNewChat);
    setShowCreator(false);
    showNotice(kind === 'channel' ? t('notice.channelCreated') : t('notice.communityCreated'));
  }

  async function uploadNewChatAvatar(fileList) {
    let file = Array.from(fileList ?? []).find((item) => item.type.startsWith('image/'));
    if (!file) {
      showNotice(t('notice.aiAvatarChoose'));
      return;
    }
    if (file.size > maxUploadFileSize) {
      showNotice(t('notice.fileTooLarge', { name: file.name, size: formatFileSize(file.size, t) }));
      return;
    }
    file = await compressImageFile(file, {
      maxDimension: 512,
      maxBytes: 650 * 1024,
      quality: 0.78,
      force: true,
    }).catch(() => file);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const response = await fetch(`${apiUrl}/api/uploads`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: formData,
      });
      const data = await response.json();
      if (!response.ok) {
        showNotice(serverError(data, t('notice.aiAvatarUploadFailed')));
        return;
      }
      const [avatar] = Array.isArray(data) ? data : [data];
      setNewChat((current) => ({ ...current, avatarUrl: avatar.url }));
      showNotice(t('notice.aiAvatarSelected'));
    } catch {
      showNotice(t('notice.aiAvatarNoConnection'));
    }
  }

  async function uploadAiModelAvatar(fileList) {
    let file = Array.from(fileList ?? []).find((item) => item.type.startsWith('image/'));
    if (!file) {
      showNotice(t('notice.aiAvatarChoose'));
      return '';
    }
    if (file.size > maxUploadFileSize) {
      showNotice(t('notice.fileTooLarge', { name: file.name, size: formatFileSize(file.size, t) }));
      return '';
    }
    file = await compressImageFile(file, {
      maxDimension: 512,
      maxBytes: 650 * 1024,
      quality: 0.78,
      force: true,
    }).catch(() => file);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const response = await fetch(`${apiUrl}/api/uploads`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: formData,
      });
      const data = await response.json();
      if (!response.ok) {
        showNotice(serverError(data, t('notice.aiAvatarUploadFailed')));
        return '';
      }
      const [avatar] = Array.isArray(data) ? data : [data];
      showNotice(t('notice.aiAvatarUploaded'));
      return avatar.url || '';
    } catch {
      showNotice(t('notice.aiAvatarNoConnection'));
      return '';
    }
  }

  async function updateAiModel(modelId, form) {
    if (!form.name?.trim() || form.name.trim().length < 2) {
      showNotice(t('notice.aiNameShort'));
      return false;
    }
    if (!form.systemPrompt?.trim() || form.systemPrompt.trim().length < 6) {
      showNotice(t('notice.aiPromptShort'));
      return false;
    }
    if (!form.modelName?.trim() || !form.modelName.includes('/')) {
      showNotice(t('notice.aiModelInvalid'));
      return false;
    }
    if (form.apiKey?.trim() && form.apiKey.trim().length < 16) {
      showNotice(t('notice.aiKeyInvalid'));
      return false;
    }
    showNotice(form.apiKey?.trim() ? t('notice.aiKeyChecking') : t('notice.aiModelChecking'));
    const response = await api(`/api/ai-models/${modelId}`, {
      method: 'PATCH',
      body: JSON.stringify(form),
    });
    const result = await response.json();
    if (!response.ok) {
      showNotice(serverError(result, t('notice.aiUpdateFailed')));
      return false;
    }
    if (result.model) {
      setAiModelDetails((current) => [result.model, ...current.filter((item) => item.id !== result.model.id)]);
    }
    if (result.conversation) {
      setChats((current) =>
        uniqueChats(current.map((chat) =>
          chat.id === result.conversation.id
            ? { ...chat, ...result.conversation, messages: chat.messages ?? [] }
            : chat,
        )),
      );
    }
    showNotice(t('notice.aiUpdated'));
    return true;
  }

  async function updateConversationSettings(conversationId, form) {
    if (!form.name?.trim() || form.name.trim().length < 2) {
      showNotice(t('notice.conversationNameShort'));
      return false;
    }
    const response = await api(`/api/conversations/${conversationId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: form.name,
        handle: form.handle,
        description: form.description,
        privacyLevel: form.privacyLevel,
        postingPolicy: form.kind === 'channel' ? 'admins' : 'members',
        joinPolicy: form.joinPolicy,
      }),
    });
    const conversation = await response.json();
    if (!response.ok) {
      showNotice(serverError(conversation, t('notice.conversationUpdateFailed')));
      return false;
    }
    setChats((current) =>
      uniqueChats(current.map((chat) =>
        chat.id === conversation.id
          ? { ...chat, ...conversation, messages: chat.messages ?? [] }
          : chat,
      )),
    );
    showNotice(conversation.kind === 'channel' ? t('notice.channelUpdated') : t('notice.communityUpdated'));
    loadSidePanels(conversation.id);
    return true;
  }

  async function deleteAiModel(modelId) {
    const response = await api(`/api/ai-models/${modelId}`, { method: 'DELETE' });
    const result = await response.json();
    if (!response.ok) {
      showNotice(serverError(result, t('notice.aiDeleteFailed')));
      return false;
    }
    setChats((current) => current.filter((chat) => chat.id !== result.conversationId));
    setAiModelDetails((current) => current.filter((item) => item.id !== modelId));
    setActiveChatId((current) => (current === result.conversationId ? '' : current));
    showNotice(t('notice.aiDeleted'));
    return true;
  }

  async function startPrivateConversation(user) {
    const existing = chats.find((chat) => chat.peerId === user.id && chat.kind === 'private');
    const conversation = existing ?? makePrivateDraftConversation(user);
    setChats((current) => uniqueChats([{ ...conversation, messages: conversation.messages ?? [] }, ...current]));
    selectConversation(conversation.id);
    if (!isDraftConversationId(conversation.id)) {
      loadConversationMessages(conversation.id, { markRead: true }).catch(() => {});
    }
    setSearchQuery('');
    setUserSearchResults([]);
    setSearchResults([]);
  }

  async function joinPublicConversation(item) {
    const response = await api('/api/conversations/join', {
      method: 'POST',
      body: JSON.stringify({ conversationId: item.id, handle: item.handle }),
    });
    const conversation = await response.json();
    if (!response.ok) {
      showNotice(serverError(conversation, t('notice.joinFailed')));
      return;
    }
    if (conversation.joinStatus === 'pending') {
      setSearchResults((current) => current.map((result) => result.id === conversation.id ? { ...result, joinStatus: 'pending' } : result));
      setSearchQuery('');
      setUserSearchResults([]);
      setSearchResults([]);
      showNotice(t('notice.joinRequestSent'));
      return;
    }
    setChats((current) => uniqueChats([{ ...conversation, messages: [] }, ...current]));
    selectConversation(conversation.id);
    loadConversationMessages(conversation.id, { markRead: true }).catch(() => {});
    setSearchQuery('');
    setUserSearchResults([]);
    setSearchResults([]);
    showNotice(conversation.kind === 'channel' ? t('notice.channelFollowed') : t('notice.communityJoined'));
  }

  async function inviteParticipant(event) {
    event.preventDefault();
    if (!invite.handle.trim()) return;
    const response = await api(`/api/conversations/${activeChatId}/participants`, {
      method: 'POST',
      body: JSON.stringify(invite),
    });
    const data = await response.json();
    if (!response.ok) {
      showNotice(serverError(data, t('notice.inviteFailed')));
      return;
    }
    setInvite({ handle: '', role: 'member' });
    loadSidePanels(activeChatId);
  }

  async function resolveJoinRequest(requestId, action) {
    if (!activeChatId || !requestId) return;
    const response = await api(`/api/conversations/${activeChatId}/join-requests/${requestId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
    const result = await response.json();
    if (!response.ok) {
      showNotice(serverError(result, t('notice.joinRequestResolveFailed')));
      return;
    }
    setJoinRequests((current) => current.filter((request) => request.id !== requestId));
    showNotice(action === 'approve' ? t('notice.joinRequestApproved') : t('notice.joinRequestDeclined'));
    loadSidePanels(activeChatId);
  }

  async function resolveModeration(messageId, action) {
    try {
      const response = await api(`/api/moderation/${messageId}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      const data = await readJsonSafely(response);
      if (!response.ok) {
        showNotice(serverError(data, t('notice.moderationFailed')));
        return;
      }
      setModerationQueue((current) => current.filter((item) => item.id !== messageId));
      if (data.message) {
        const message = normalizeMessage(data.message);
        setChats((current) =>
          uniqueChats(current.map((chat) =>
            chat.id === message.conversationId
              ? action === 'approve'
                ? updateChatWithMessage(chat, message)
                : updateChatMessage(chat, message)
              : chat,
          )),
        );
      }
      showNotice(action === 'approve' ? t('notice.moderationApproved') : t('notice.moderationLimited'));
      loadStageData().catch(() => {});
      loadSidePanels(activeChatId).catch(() => {});
    } catch {
      showNotice(t('notice.moderationNoConnection'));
    }
  }

  async function revokeSession(sessionId) {
    const response = await api(`/api/sessions/${sessionId}/revoke`, { method: 'POST', body: JSON.stringify({}) });
    if (!response.ok) {
      const data = await response.json();
      showNotice(serverError(data, t('notice.sessionRevokeFailed')));
      return;
    }
    setSessions((current) => current.filter((session) => session.id !== sessionId));
    showNotice(t('notice.sessionRevoked'));
  }

  async function revokeAllSessions() {
    const response = await api('/api/sessions/revoke-all', { method: 'POST', body: JSON.stringify({}) });
    if (!response.ok) {
      const data = await response.json();
      showNotice(serverError(data, t('notice.sessionRevokeFailed')));
      return;
    }
    signOut();
  }

  async function reportMessage(message) {
    setOpenMessageMenuId('');
    try {
      const response = await api('/api/reports', {
        method: 'POST',
        body: JSON.stringify({
          messageId: message.id,
          targetUserId: message.senderId,
          conversationId: activeChatId,
          reason: message.verdict === 'limited' ? 'limited-appeal' : 'user-report',
        }),
      });
      if (!response.ok) {
        const data = await readJsonSafely(response);
        showNotice(serverError(data, t('notice.reportFailed')));
        return;
      }
      showNotice(message.sender === 'me' ? t('notice.appealSent') : t('notice.reportSent'));
      loadSidePanels(activeChatId).catch(() => {});
    } catch {
      showNotice(t('notice.reportNoConnection'));
    }
  }

  async function submitSupportRequest(form) {
    const response = await api('/api/support-requests', {
      method: 'POST',
      body: JSON.stringify(form),
    });
    const data = await response.json();
    if (!response.ok) {
      showNotice(serverError(data, t('notice.supportFailed')));
      return false;
    }
    showNotice(t('notice.supportSent'));
    return true;
  }

  async function cleanupLaunchTestData() {
    try {
      const response = await api('/api/admin/launch-test-data', { method: 'DELETE' });
      const data = await readJsonSafely(response);
      if (!response.ok) {
        showNotice(serverError(data, t('notice.cleanupFailed')));
        return false;
      }
      showNotice(t('notice.cleanupOk', { users: data.usersDeleted ?? 0, conversations: data.conversationsDeleted ?? 0 }));
      await loadStageData();
      return true;
    } catch {
      showNotice(t('notice.cleanupNoConnection'));
      return false;
    }
  }

  async function blockUserById(userId) {
    const response = await api('/api/blocks', {
      method: 'POST',
      body: JSON.stringify({ blockedId: userId }),
    });
    if (!response.ok) {
      const data = await response.json();
      showNotice(serverError(data, t('notice.blockFailed')));
      return;
    }
    showNotice(t('notice.blockOk'));
    await loadStageData();
    await loadSidePanels(activeChatId);
  }

  async function unblockUserById(userId) {
    const response = await api(`/api/blocks/${userId}/unblock`, { method: 'POST', body: JSON.stringify({}) });
    if (!response.ok) {
      const data = await response.json();
      showNotice(serverError(data, t('notice.unblockFailed')));
      return;
    }
    setBlockedUsers((current) => current.filter((item) => item.blockedId !== userId));
    await loadStageData();
    showNotice(t('notice.unblockOk'));
  }

  async function shareContact(contact) {
    const handle = String(contact?.handle || peerProfile?.handle || activeChat.handle || '').replace(/^@/, '');
    if (!handle) {
      showNotice(t('notice.shareNoUsername'));
      return;
    }

    const sharePath = contact?.kind && contact.kind !== 'private' ? 'c' : 'u';
    const url = `${shareBaseUrl()}/${sharePath}/${encodeURIComponent(handle)}`;
    const shareNotice = contact?.type === 'profile'
      ? t('notice.shareProfileOk')
      : contact?.kind === 'channel'
      ? t('notice.shareChannelOk')
      : sharePath === 'c'
        ? t('notice.shareCommunityOk')
        : t('notice.shareContactOk');
    try {
      await navigator.clipboard?.writeText(url);
      showNotice(shareNotice);
    } catch {
      showNotice(url);
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function shareMyProfile(profile) {
    shareContact({ ...currentUser, ...profile, type: 'profile' });
  }

  if (!currentUser) {
    return (
      <>
        <FlashLogo visible={showFlashLogo} />
        <AuthScreen
          authMode={authMode}
          authStep={authStep}
          authForm={authForm}
          authValidation={authValidation}
          authError={authError}
          authSubmitting={authSubmitting}
          theme={theme}
          onAuthenticate={authenticate}
          onAuthFieldChange={updateAuthField}
          onAuthModeChange={changeAuthMode}
          onAuthStepChange={setAuthStep}
          onResendAuthCode={resendAuthCode}
          onAuthErrorClear={() => setAuthError('')}
        />
      </>
    );
  }

  return (
    <main className={`app-shell theme-${theme} ${showInspector ? '' : 'inspector-hidden'} ${activeChat.id ? 'has-active-chat' : 'chat-list-mode'} ${isSwitchingChat ? 'chat-switching' : ''}`}>
      <FlashLogo visible={showFlashLogo} />
      <MediaViewer
        media={mediaViewer}
        assetUrl={assetUrl}
        formatFileSize={formatFileSize}
        onClose={() => setMediaViewer(null)}
      />
      {connectionNotice && (
        <div className="connection-banner" role="status">
          <span>{connectionNotice}</span>
          <button type="button" onClick={() => loadStageData().catch(() => {})}>{t('main.retry')}</button>
        </div>
      )}
      {appNotice && <div className="app-notice global" role="status">{appNotice}</div>}
      <Sidebar
        activeChatId={activeChatId}
        chats={chats}
        currentUser={currentUser}
        filteredChats={filteredChats}
        hasExtraPlan={hasExtraPlan}
        kindIcon={kindIcon}
        kindLabels={kindLabels}
        newChat={newChat}
        searchQuery={searchQuery}
        showCreator={showCreator}
        stageLoading={stageLoading}
        showMainMenu={showMainMenu}
        theme={theme}
        userSearchResults={userSearchResults}
        onCreateConversation={createNewConversation}
        onNewChatChange={setNewChat}
        onUploadNewChatAvatar={uploadNewChatAvatar}
        onSearchChange={setSearchQuery}
        onSelectChat={selectConversation}
        onSetShowCreator={setShowCreator}
        onSetShowMainMenu={setShowMainMenu}
        onSetShowProfilePage={setShowProfilePage}
        onSetShowSettingsPage={(value) => {
          playUiSound(value ? 'open' : 'close');
          setSettingsInitialPage('home');
          setShowSettingsPage(value);
        }}
        onSignOut={signOut}
        onJoinConversation={joinPublicConversation}
        onStartPrivateConversation={startPrivateConversation}
        onThemeToggle={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
        onUiSound={playUiSound}
      />

      {showProfilePage && (
        <ProfilePage
          blockedCount={blockedUsers.length}
          chatCount={chats.length}
          currentUser={currentUser}
          hasExtraPlan={hasExtraPlan}
          profileForm={profileForm}
          sessionCount={sessions.length}
          onClose={() => setShowProfilePage(false)}
          onProfileFormChange={setProfileForm}
          onSave={saveProfile}
          onShareProfile={shareMyProfile}
          onUploadAvatar={uploadProfileAvatar}
        />
      )}

      {showSettingsPage && (
        <SettingsPage
          blockedUsers={blockedUsers}
          currentUser={currentUser}
          hasExtraPlan={hasExtraPlan}
          initialPage={settingsInitialPage}
          interactionSoundsEnabled={interactionSoundsEnabled}
          notificationsEnabled={notificationsEnabled}
          profileForm={profileForm}
          sessions={sessions}
          sessionCount={sessions.length}
          theme={theme}
          onClose={() => setShowSettingsPage(false)}
          onOpenProfile={() => {
            setShowSettingsPage(false);
            setShowProfilePage(true);
          }}
          onProfileFormChange={setProfileForm}
          onRevokeAllSessions={revokeAllSessions}
          onRevokeSession={revokeSession}
          onSaveProfile={saveProfile}
          onSetInteractionSoundsEnabled={updateInteractionSoundSetting}
          onSetNotificationsEnabled={updateNotificationSetting}
          onSetTheme={setTheme}
          onSubmitSupportRequest={submitSupportRequest}
          onSubscribeExtraPlan={subscribeExtraPlan}
          onCleanupLaunchTestData={cleanupLaunchTestData}
          onUnblockUser={unblockUserById}
        />
      )}

      <section className={`conversation ${activeChat.id ? '' : 'conversation-empty'} ${isSwitchingChat ? 'is-switching' : ''}`}>
        {!activeChat.id && (
          <div className="no-chat-state">
            <MessageCircle size={34} />
            <strong>{t('main.noConversation')}</strong>
            <span>{t('main.noConversationHint')}</span>
          </div>
        )}
        {activeChat.id && (
          <>
            <ConversationHeader
              activeChat={activeChat}
              isPrivateChat={isPrivateChat}
              kindIcon={kindIcon}
              peerProfile={peerProfile}
              privateStatus={privateStatus}
              showInspector={showInspector}
              onOpenInfo={() => {
                setInspectorPage('info');
                setShowInspector(true);
              }}
              onOpenSearch={() => {
                openMessageSearch();
              }}
              onOpenSecurity={() => {
                setSettingsInitialPage('privacy');
                setShowSettingsPage(true);
              }}
              onBackToChats={closeConversationView}
              onToggleInspector={() => setShowInspector((current) => !current)}
            />

            {showMessageSearch && (
              <section className="inline-message-search" aria-label={t('main.searchMessages')}>
                <label>
                  <Search size={17} />
                  <input
                    ref={messageSearchInputRef}
                    value={messageSearchQuery}
                    onChange={(event) => setMessageSearchQuery(event.target.value)}
                    placeholder={t('main.searchInChat', { name: activeChat.name })}
                  />
                  <button
                    type="button"
                    aria-label={t('main.closeSearch')}
                    onClick={() => {
                      setShowMessageSearch(false);
                      setMessageSearchQuery('');
                      setSearchResults([]);
                    }}
                  >
                    <X size={17} />
                  </button>
                </label>
                {messageSearchQuery.trim() && (
                  <div className="inline-message-search-results">
                    {searchResults.slice(0, 5).map((result) => (
                      <button key={result.id} type="button" onClick={() => selectMessageSearchResult(result)}>
                        <span>{result.senderName || result.conversationName}</span>
                        <small>{result.text}</small>
                        <em>{formatTime(result.createdAt)}</em>
                      </button>
                    ))}
                    {searchResults.length === 0 && <p>{t('inspector.noSearchResult')}</p>}
                  </div>
                )}
              </section>
            )}

            <MessageList
              activeChat={activeChat}
              assetUrl={assetUrl}
              audioMessage={AudioMessage}
              canManage={canManage}
              canPost={canPostInActiveChat}
              formatTime={formatTime}
              formatUploadProgress={(loaded, total) => formatUploadProgress(loaded, total, t)}
              hasExtraPlan={hasExtraPlan}
              isGeneratedAttachmentText={isGeneratedAttachmentText}
              messageAvatarUrl={messageAvatarUrl}
              messageListRef={messageListRef}
              messagesLoading={messageLoadingIds.has(activeChat.id)}
              messageMenuPosition={messageMenuPosition}
              olderMessagesLoading={olderMessageLoadingIds.has(activeChat.id)}
              openMenuMessage={openMenuMessage}
              openMessageMenuId={openMessageMenuId}
              participantById={participantById}
              reactionPicker={ReactionPicker}
              reactionPills={ReactionPills}
              showLatestButton={showLatestButton}
              typingUsers={typingPeople}
              videoPreview={VideoPreview}
              onBlockUser={blockUserById}
              onCopyMessage={copyMessageText}
              onForwardMessage={forwardMessage}
              onListScroll={handleMessageListScroll}
              onMediaOpen={setMediaViewer}
              onMenuToggle={toggleMessageMenu}
              onPinMessage={pinMessage}
              onReactToMessage={reactToMessage}
              onReply={setReplyTarget}
              onReportMessage={reportMessage}
              onRequestDelete={requestDeleteMessage}
              onRemoveFailedMessage={removeFailedMessage}
              onRetryFailedMessage={retryFailedMessage}
              onScrollLatest={scrollToLatestMessage}
              onSelectMessage={selectMessage}
              onSetOpenMenu={setOpenMessageMenuId}
              onStartEditing={startEditing}
            />

            <Composer
              attachmentDrafts={attachmentDrafts}
              composerInputRef={composerInputRef}
              draft={draft}
              editingMessage={editingMessage}
              fileInputRef={fileInputRef}
              formatFileSize={formatFileSize}
              gifEmojiBase={telegramGifEmojiBase}
              gifEmojis={localizedGifEmojis}
              gifEmojiGroups={localizedGifEmojiGroups}
              recordingAudio={recordingAudio}
              replyTarget={replyTarget}
              sendIcon={SendArrowIcon}
              showAttachmentForm={showAttachmentForm}
              uploadingFile={uploadingFile}
              onCancelMode={cancelComposerMode}
              onClearAttachments={() => {
                attachmentDrafts.filter((attachment) => attachment.local).forEach((attachment) => URL.revokeObjectURL(attachment.url));
                setAttachmentDrafts([]);
                setShowAttachmentForm(false);
              }}
              onDraftChange={updateDraft}
              onFileUpload={uploadMediaFile}
              onPrepareGif={prepareGifEmoji}
              onSend={sendMessage}
              onToggleAudioRecording={toggleAudioRecording}
              onUiSound={playUiSound}
              disabled={!canPostInActiveChat}
              disabledReason={activeChat.kind === 'channel' ? t('composer.channelReadOnly') : t('composer.readOnly')}
            />
          </>
        )}
      </section>

      <Inspector
        activeChat={activeChat}
        aiModel={aiModelDetails.find((model) => model.id === activeChat.aiModelId || model.conversationId === activeChat.id)}
        auditLog={auditLog}
        blockedUsers={blockedUsers}
        canManage={canManage}
        inspectorPage={inspectorPage}
        isPrivateChat={isPrivateChat}
        kindIcon={kindIcon}
        kindLabels={kindLabels}
        messageSearchQuery={messageSearchQuery}
        moderationQueue={moderationQueue}
        participants={participants}
        joinRequests={joinRequests}
        peerProfile={peerProfile}
        privateStatus={privateStatus}
        searchResults={searchResults}
        serverStatus={serverStatus}
        onMessageSearchChange={setMessageSearchQuery}
        onModerationResolve={resolveModeration}
        onJoinRequestResolve={resolveJoinRequest}
        onBlockUser={blockUserById}
        onCloseInspector={() => setShowInspector(false)}
        onDeleteAiModel={deleteAiModel}
        onFocusComposer={() => composerInputRef.current?.focus()}
        onOpenProfile={() => setShowProfilePage(true)}
        onPageChange={setInspectorPage}
        onRefreshModeration={async () => {
          await loadSidePanels(activeChatId);
          showNotice(t('inspector.refreshData'));
        }}
        onSelectSearchResult={(conversationId) => selectMessageSearchResult({ conversationId })}
        onShareContact={shareContact}
        onUnblockUser={unblockUserById}
        onUpdateConversation={updateConversationSettings}
        onUpdateAiModel={updateAiModel}
        onUploadAiModelAvatar={uploadAiModelAvatar}
      />

      {deleteConfirmMessage && (
        <div className="confirm-layer" role="presentation" onMouseDown={() => setDeleteConfirmMessage(null)}>
          <section
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-message-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="confirm-icon">
              <Trash2 size={22} />
            </div>
            <h3 id="delete-message-title">{t('common.deleteForever')}?</h3>
            <p>
              {t('main.deleteMessageText')}
            </p>
            <div className="confirm-preview">
              {deleteConfirmMessage.text || (deleteConfirmMessage.attachments?.length ? t('main.deleteAttachmentPreview') : t('main.deleteMessagePreview'))}
            </div>
            <div className="confirm-actions">
              <button type="button" className="ghost-action" onClick={() => setDeleteConfirmMessage(null)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="danger-action solid" onClick={() => deleteChatMessage()}>
                {t('common.deleteForever')}
              </button>
            </div>
          </section>
        </div>
      )}

    </main>
  );
}

createRoot(document.getElementById('root')).render(
  <I18nProvider>
    <App />
  </I18nProvider>,
);
