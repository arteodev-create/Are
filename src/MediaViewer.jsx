import React from 'react';
import { FileText, Volume2, X } from 'lucide-react';

export function MediaViewer({ media, assetUrl, formatFileSize, onClose }) {
  if (!media) return null;

  return (
    <div className="media-viewer" onClick={onClose}>
      <button className="media-viewer-close" type="button" aria-label="Dong" onClick={onClose}>
        <X size={24} />
      </button>
      <div className="media-viewer-stage" onClick={(event) => event.stopPropagation()}>
        <div className="media-viewer-content">
          {media.mimeType?.startsWith('video/') ? (
            <video src={assetUrl(media.url)} controls autoPlay playsInline />
          ) : media.mimeType?.startsWith('audio/') ? (
            <div className="media-viewer-audio">
              <span className="media-viewer-file-icon">
                <Volume2 size={34} />
              </span>
              <audio src={assetUrl(media.url)} controls autoPlay />
            </div>
          ) : media.mimeType?.startsWith('image/') ? (
            <img src={assetUrl(media.url)} alt={media.name || 'Media'} />
          ) : (
            <div className="media-viewer-file">
              <span className="media-viewer-file-icon">
                <FileText size={36} />
              </span>
              <a href={assetUrl(media.url)} target="_blank" rel="noreferrer">
                Mo tep
              </a>
            </div>
          )}
        </div>
        <div className="media-viewer-details">
          <strong>{media.name || 'Media'}</strong>
          <span>{media.mimeType || 'application/octet-stream'} · {formatFileSize(media.size)}</span>
        </div>
      </div>
    </div>
  );
}
