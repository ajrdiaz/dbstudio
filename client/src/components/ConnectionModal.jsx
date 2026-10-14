import React, { useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { ENVS, EnvBadge } from '../lib/env.jsx';

// Create / edit a saved connection profile, with a "Test" button. Two tabs
// like SQLyog: MySQL (server + credentials) and SSH (optional tunnel).
// Secrets are never sent back by the server: blank fields keep the stored ones.
export default function ConnectionModal({ initial, groups = [], onClose, onSaved, toast }) {
  const { t } = useI18n();
  const editing = !!initial?.id;
  const s0 = initial?.ssh || {};
  const [tab, setTab] = useState('mysql');
  const [form, setForm] = useState({
    name: initial?.name || 'Localhost',
    host: initial?.host || '127.0.0.1',
    port: initial?.port || 3306,
    user: initial?.user || 'root',
    password: '',
    database: initial?.database || '',
    ssl: initial?.ssl || false,
    env: initial?.env || '',
    group: initial?.group || '',
    color: initial?.color || '',
    confirmWrites: initial?.confirmWrites ?? false,
    readOnly: initial?.readOnly ?? false,
  });
  const [ssh, setSsh] = useState({
    enabled: !!s0.enabled,
    host: s0.host || '',
    port: s0.port || 22,
    user: s0.user || '',
    auth: s0.auth || 'password',
    password: '',
    privateKey: '',
    passphrase: '',
  });
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
  };
  const setS = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setSsh((f) => ({ ...f, [k]: v }));
  };

  function loadKeyFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((text) => setSsh((f) => ({ ...f, privateKey: text })));
    e.target.value = '';
  }

  // Payload: blank secrets are omitted so the stored ones are kept.
  function payload() {
    const p = { ...form };
    if (editing && p.password === '') delete p.password;
    const sp = { ...ssh };
    for (const k of ['password', 'privateKey', 'passphrase']) if (!sp[k]) delete sp[k];
    p.ssh = sp;
    return p;
  }

  async function test() {
    setTesting(true);
    try {
      const r = await api.testConnection(editing ? { ...payload(), id: initial.id } : payload());
      toast(t(r.ssh ? 'conn.connectedServerSsh' : 'conn.connectedServer', { version: r.version }), 'ok');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const saved = editing
        ? await api.updateConnection(initial.id, payload())
        : await api.createConnection(payload());
      onSaved(saved);
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setSaving(false);
    }
  }

  const keep = (has) => editing && has && <span className="count">{t('conn.keepBlank')}</span>;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>{editing ? t('conn.edit') : t('conn.new')}</h3>
        <div className="modal-tabs">
          <button className={tab === 'mysql' ? 'active' : ''} onClick={() => setTab('mysql')}>MySQL / MariaDB</button>
          <button className={tab === 'ssh' ? 'active' : ''} onClick={() => setTab('ssh')}>
            SSH {ssh.enabled && <span className="badge">{t('conn.on')}</span>}
          </button>
        </div>

        {tab === 'mysql' && (
          <div className="content">
            <div className="row2">
              <div className="field">
                <label>{t('conn.name')}</label>
                <input value={form.name} onChange={set('name')} autoFocus />
              </div>
              <div className="field">
                <label>{t('groups.label')}</label>
                <input list="dbstudio-groups" value={form.group} onChange={set('group')} placeholder={t('groups.none')} />
                <datalist id="dbstudio-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
              </div>
            </div>
            <div className="row2">
              <div className="field">
                <label>{t('conn.host')}{ssh.enabled && <span className="count"> {t('conn.hostViaSsh')}</span>}</label>
                <input value={form.host} onChange={set('host')} />
              </div>
              <div className="field">
                <label>{t('conn.port')}</label>
                <input type="number" value={form.port} onChange={set('port')} />
              </div>
            </div>
            <div className="row2">
              <div className="field">
                <label>{t('conn.user')}</label>
                <input value={form.user} onChange={set('user')} />
              </div>
              <div className="field">
                <label>{t('conn.password')} {editing && <span className="count">{t('conn.keepBlank')}</span>}</label>
                <input type="password" value={form.password} onChange={set('password')} />
              </div>
            </div>
            <div className="field">
              <label>{t('conn.defaultDb')}</label>
              <input value={form.database} onChange={set('database')} />
            </div>
            <label className="radio" style={{ fontSize: 12 }}>
              <input type="checkbox" checked={form.ssl} onChange={set('ssl')} /> {t('conn.useSsl')}
            </label>
            <div className="env-section">
              <div className="row2">
                <div className="field">
                  <label>{t('env.label')}</label>
                  <select value={form.env} onChange={(e) => {
                    const env = e.target.value;
                    // Production defaults to "confirm before modifying".
                    setForm((f) => ({ ...f, env, confirmWrites: env === 'production' ? true : f.confirmWrites }));
                  }}>
                    {ENVS.map((v) => <option key={v} value={v}>{t(v ? 'env.' + v : 'env.none')}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>{t('env.color')}</label>
                  <div className="color-row">
                    <input type="color" value={form.color || '#888888'} onChange={set('color')} disabled={!form.color} />
                    <label className="radio"><input type="checkbox" checked={!!form.color}
                      onChange={(e) => setForm((f) => ({ ...f, color: e.target.checked ? '#7c3aed' : '' }))} /> {t('env.customColor')}</label>
                    <EnvBadge conn={form} />
                  </div>
                </div>
              </div>
              <label className="radio"><input type="checkbox" checked={form.confirmWrites} onChange={set('confirmWrites')} /> {t('env.confirmWrites')}</label>
              <label className="radio"><input type="checkbox" checked={form.readOnly} onChange={set('readOnly')} /> {t('env.readOnly')}</label>
            </div>
          </div>
        )}

        {tab === 'ssh' && (
          <div className="content">
            <label className="radio">
              <input type="checkbox" checked={ssh.enabled} onChange={setS('enabled')} /> <b>{t('conn.sshEnable')}</b>
            </label>
            <div className="count">{t('conn.sshHint')}</div>
            <fieldset disabled={!ssh.enabled} className="plain">
              <div className="row2">
                <div className="field">
                  <label>{t('conn.sshHost')}</label>
                  <input value={ssh.host} onChange={setS('host')} placeholder="bastion.midominio.com" />
                </div>
                <div className="field">
                  <label>{t('conn.port')}</label>
                  <input type="number" value={ssh.port} onChange={setS('port')} />
                </div>
              </div>
              <div className="field">
                <label>{t('conn.sshUser')}</label>
                <input value={ssh.user} onChange={setS('user')} />
              </div>
              <div className="field">
                <label>{t('conn.sshAuth')}</label>
                <div style={{ display: 'flex', gap: 16 }}>
                  <label className="radio"><input type="radio" checked={ssh.auth === 'password'} onChange={() => setSsh((f) => ({ ...f, auth: 'password' }))} /> {t('conn.password')}</label>
                  <label className="radio"><input type="radio" checked={ssh.auth === 'key'} onChange={() => setSsh((f) => ({ ...f, auth: 'key' }))} /> {t('conn.sshKey')}</label>
                </div>
              </div>
              {ssh.auth === 'password' ? (
                <div className="field">
                  <label>{t('conn.sshPassword')} {keep(s0.hasPassword)}</label>
                  <input type="password" value={ssh.password} onChange={setS('password')} />
                </div>
              ) : (
                <>
                  <div className="field">
                    <label>
                      {t('conn.sshKeyLabel')} {keep(s0.hasPrivateKey)}
                    </label>
                    <textarea
                      rows={4}
                      className="key-text"
                      value={ssh.privateKey}
                      onChange={setS('privateKey')}
                      placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…'}
                    />
                    <label className="file-pick">
                      <input type="file" onChange={loadKeyFile} />
                      <span>{t('conn.sshKeyFile')}</span>
                    </label>
                  </div>
                  <div className="field">
                    <label>{t('conn.sshPassphrase')} {keep(s0.hasPassphrase)}</label>
                    <input type="password" value={ssh.passphrase} onChange={setS('passphrase')} />
                  </div>
                </>
              )}
            </fieldset>
          </div>
        )}

        <div className="actions">
          <button onClick={test} disabled={testing}>{testing ? t('conn.testing') : t('conn.test')}</button>
          <span style={{ flex: 1 }} />
          <button onClick={onClose}>{t('conn.cancel')}</button>
          <button className="primary" onClick={save} disabled={saving}>{saving ? t('conn.saving') : t('conn.save')}</button>
        </div>
      </div>
    </div>
  );
}
