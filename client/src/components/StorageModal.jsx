import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';

// Choose where DBStudio keeps its data (connections, saved queries, history,
// open tabs): the local default folder, a detected OneDrive / Google Drive
// folder, or any other path. Switching copies this PC's data over, or adopts
// data already in the folder (e.g. set up from another PC).
export default function StorageModal({ onClose, toast }) {
  const { t } = useI18n();
  const [info, setInfo] = useState(null);
  const [target, setTarget] = useState(null); // inspectDir result for the chosen folder
  const [custom, setCustom] = useState('');
  const [mode, setMode] = useState('use');
  const [includeKey, setIncludeKey] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getStorage().then(setInfo).catch((e) => toast(e.message, 'err'));
  }, [toast]);

  async function choose(dir) {
    try {
      const r = await api.inspectStorage(dir);
      setTarget(r);
      setMode(r.hasData ? 'use' : 'copy');
    } catch (e) { toast(e.message, 'err'); }
  }

  async function apply() {
    if (!target) return;
    setSaving(true);
    try {
      await api.setStorage({ dir: target.dir, mode: target.hasData ? mode : 'copy', includeKey: keyChoice && includeKey });
      toast(t('storage.changed'), 'ok');
      // Reload so connections, tabs, saved queries and history come from the new folder.
      setTimeout(() => location.reload(), 600);
    } catch (e) {
      toast(e.message, 'err');
      setSaving(false);
    }
  }

  if (!info) return null;
  const locked = info.source === 'env';
  const options = [
    { provider: 'local', label: t('storage.local'), dir: info.defaultDir },
    ...info.suggestions,
  ];
  const isSame = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();
  const changing = target && !isSame(target.dir, info.dataDir);
  // Keys: the folder already has one → it'll be used; otherwise offer to put ours there.
  const keyChoice = changing && !target.hasKey && !(target.hasData && mode === 'use') && target.dir !== info.defaultDir;
  const passwordsAtRisk = changing && target.hasData && mode === 'use' && !target.hasKey;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal storage-modal">
        <h3>{t('storage.title')}</h3>
        <div className="content">
          <div className="field">
            <label>{t('storage.current')}</label>
            <code className="path">{info.dataDir}</code>
            <span className="count">
              {t('storage.files', { n: info.current.files.length })}
              {info.keySynced ? ` · ${t('storage.keyInFolder')}` : ''}
            </span>
          </div>

          {locked ? (
            <div className="note warn">{t('storage.envLocked')}</div>
          ) : (
            <>
              <div className="field">
                <label>{t('storage.choose')}</label>
                <div className="storage-options">
                  {options.map((o) => {
                    const sel = isSame(target?.dir, o.dir);
                    const cur = isSame(info.dataDir, o.dir);
                    return (
                      <button
                        key={o.dir}
                        className={'storage-option' + (sel ? ' selected' : '')}
                        onClick={() => { setCustom(''); choose(o.dir); }}
                      >
                        <span className="prov">{providerIcon(o.provider)}</span>
                        <span className="grow">
                          <span className="name">{o.label}</span>
                          <span className="sub">{o.dir}</span>
                        </span>
                        {cur && <span className="badge">{t('storage.inUse')}</span>}
                        {!cur && o.hasData && <span className="badge">{t('storage.hasData')}</span>}
                      </button>
                    );
                  })}
                </div>
                {info.suggestions.length === 0 && <span className="count">{t('storage.noneDetected')}</span>}
              </div>

              <div className="field">
                <label>{t('storage.other')}</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    style={{ flex: 1 }}
                    placeholder={t('storage.otherPlaceholder')}
                    value={custom}
                    onChange={(e) => setCustom(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && custom.trim() && choose(custom.trim())}
                  />
                  <button onClick={() => custom.trim() && choose(custom.trim())}>{t('storage.check')}</button>
                </div>
              </div>

              {target && !changing && <div className="note">{t('storage.alreadyHere')}</div>}

              {changing && (
                <div className="note">
                  <div><b>{target.dir}</b></div>
                  {target.hasData ? (
                    <>
                      <div>{t('storage.folderHasData', { files: target.files.join(', ') })}</div>
                      <label className="radio">
                        <input type="radio" checked={mode === 'use'} onChange={() => setMode('use')} />
                        {t('storage.modeUse')}
                      </label>
                      <label className="radio">
                        <input type="radio" checked={mode === 'copy'} onChange={() => setMode('copy')} />
                        {t('storage.modeCopy')}
                      </label>
                    </>
                  ) : (
                    <div>{t('storage.willCopy')}</div>
                  )}
                  {keyChoice && (
                    <label className="radio">
                      <input type="checkbox" checked={includeKey} onChange={(e) => setIncludeKey(e.target.checked)} />
                      <span>
                        {t('storage.includeKey')}
                        <br /><span className="count">{t('storage.includeKeyHint')}</span>
                      </span>
                    </label>
                  )}
                  {target.hasKey && <div className="count">{t('storage.folderHasKey')}</div>}
                  {passwordsAtRisk && <div className="warn">{t('storage.noKeyWarn')}</div>}
                  <div className="count">{t('storage.backupNote')}</div>
                </div>
              )}

              <div className="count">{t('storage.syncNote')}</div>
            </>
          )}
        </div>
        <div className="actions">
          <button onClick={onClose}>{t('conn.cancel')}</button>
          {!locked && (
            <button className="primary" disabled={!changing || saving} onClick={apply}>
              {saving ? t('conn.saving') : t('storage.apply')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function providerIcon(p) {
  if (p === 'onedrive') return '☁︎';
  if (p === 'gdrive') return '△';
  return '🖳︎';
}
