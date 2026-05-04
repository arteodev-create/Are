import React from 'react';
import { useI18n } from './i18n.jsx';

export function LoadingSpinner({ label, compact = false }) {
  const { t } = useI18n();
  const text = label || t('common.loading');
  return (
    <span className={`loading-spinner ${compact ? 'compact' : ''}`} role="status" aria-label={text}>
      {Array.from({ length: 12 }).map((_, index) => (
        <i key={index} />
      ))}
    </span>
  );
}

export function LoadingState({ label }) {
  const { t } = useI18n();
  const text = label || t('common.loading');
  return (
    <div className="loading-state">
      <LoadingSpinner label={text} />
      <span>{text}</span>
    </div>
  );
}
