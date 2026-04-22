'use strict';

(function bootstrapPlaygroundUi() {
  const LOCK_CONTROL_MODES = [
    ['secure', 'Secure', 'Door remains locked at all times.'],
    ['passage', 'Passage', 'Door remains unlocked for free access.'],
    ['momentaryUnlock', 'Momentary Unlock', 'Unlocks briefly, then returns to secure.'],
    ['frozenSecure', 'Frozen Secure', 'Forces secure mode and ignores external unlock triggers.'],
    ['frozenPassage', 'Frozen Passage', 'Forces passage mode and ignores external relock triggers.'],
  ];

  const CONFIG_FIELDS = [
    ['invCrdAudEn', 'Invalid Credential Audit', 'Writes denied and unknown-card swipes into the audit stream.'],
    ['auditIDEn', 'Audit ID Tracking', 'Adds audit identifiers for troubleshooting and correlation.'],
    ['proxConfHID', 'HID Prox', 'Enables standard HID low-frequency prox credentials.'],
    ['proxConfGECASI', 'GE CASI Prox', 'Enables GE CASI prox credentials.'],
    ['proxConfAWID', 'AWID Prox', 'Enables AWID low-frequency prox credentials.'],
    ['uid14443', '14443 UID', 'Reads raw ISO 14443 UID values directly.'],
    ['mi14443', 'MIFARE / 14443', 'Enables standard MIFARE-family credentials.'],
    ['mip14443', 'MIFARE Plus / 14443', 'Enables MIFARE Plus support.'],
    ['noc14443', 'No-Card / 14443', 'Enables the configured 14443 no-card mode.'],
    ['uid15693', '15693 UID', 'Reads raw ISO 15693 UID values directly.'],
    ['iClsUID40b', 'iCLASS UID 40-bit', 'Enables iCLASS UID 40-bit credentials.'],
  ];

  const DB_FIELDS = [
    ['usrRcrd', 'object', 'Credential records sent to the lock.', 'Object with deleteAll/delete/update/add arrays.'],
    ['schedules', 'array', 'Time windows referenced by user records.', 'Array of {days,strtHr,strtMn,lngth}.'],
    ['holidays', 'array', 'Holiday overrides. Current preview leaves this empty.', 'Array; empty disables overrides.'],
    ['autoUnlock', 'array', 'Scheduled unlock windows. Current backend preserves but does not auto-generate this.', 'Array; empty disables auto-unlock.'],
    ['firstPersonIn', 'example', 'First valid credential temporarily unlocks the opening period.', 'Example only; backend does not validate exact contract yet.'],
    ['dbDwnLdTm', 'string', 'Download timestamp marker.', 'String, usually empty when omitted.'],
    ['nxtDbVerTS', 'string', 'Database version token for tracking changes.', 'Hex string like 0x00000123456789ab.'],
  ];

  const API_DEFS = [
    { id: 'gatewayTime', label: 'GET /gateway/time', method: 'GET', pathTemplate: '/gateway/time', needsLinkId: false, hasBody: false, templateBody: null, description: 'Read gateway RTC time and linked-device time summary.' },
    { id: 'gatewayConfig', label: 'PUT /gateway/config', method: 'PUT', pathTemplate: '/gateway/config', needsLinkId: false, hasBody: true, templateBody: { gatewayConfig: { genGatewayConfig: { deviceName: 'New Gateway Name', rtcTime: '20150720140000', dstEnable: 'true', dstStart: '3022', dstEnd: 'B012', fwurl: '', fwDwnldTm: '', fwImplTm: '' }, gatewayIpModeConfig: { discoveryMethod: 'zeroConf', fixedIpAddr: '', defGatewayIpAddr: '', netmask: '', ipDnsAddr: '', altDnsAddr: '' } } }, description: 'Update gateway-level configuration values from the Playground.' },
    { id: 'gatewayDeviceInfo', label: 'GET /gateway/deviceInfo', method: 'GET', pathTemplate: '/gateway/deviceInfo', needsLinkId: false, hasBody: false, templateBody: null, description: 'Fetch read-only gateway identity, connection, and linked-device details.' },
    { id: 'gatewayScanList', label: 'GET /gateway/scanList', method: 'GET', pathTemplate: '/gateway/scanList', needsLinkId: false, hasBody: false, templateBody: null, description: 'Trigger a BLE scan or use the current linked-device cache if the gateway does not answer.' },
    { id: 'edgeLinkCreate', label: 'POST /edgeDevices', method: 'POST', pathTemplate: '/edgeDevices', needsLinkId: false, hasBody: true, templateBody: { deviceId: 'a0a1000000000024' }, description: 'Request a new BLE link between the selected gateway and an edge device.' },
    { id: 'linkList', label: 'GET /edgeDevices/linkList', method: 'GET', pathTemplate: '/edgeDevices/linkList', needsLinkId: false, hasBody: false, templateBody: null, description: 'Discover all edge devices linked to the selected gateway.' },
    { id: 'lockStatus', label: 'GET /edgeDevices/lockStatus', method: 'GET', pathTemplate: '/edgeDevices/lockStatus', needsLinkId: false, hasBody: false, templateBody: null, description: 'Read the current lock state cache for linked devices.' },
    { id: 'unlinkDevice', label: 'DELETE /edgeDevices/{linkId}', method: 'DELETE', pathTemplate: '/edgeDevices/{linkId}', needsLinkId: true, hasBody: false, templateBody: null, description: 'Delete an existing gateway-to-edge-device link.' },
    { id: 'lockControl', label: 'PUT /edgeDevices/{linkId}/lockControl', method: 'PUT', pathTemplate: '/edgeDevices/{linkId}/lockControl', needsLinkId: true, hasBody: true, templateBody: { lockControl: { lockState: { nextLockState: 'momentaryUnlock' } } }, description: 'Send a direct single-lock state command with guided modes and inline explanations.' },
    { id: 'lockControlBulk', label: 'PUT /edgeDevices/lockControl (all locks)', method: 'PUT', pathTemplate: '/edgeDevices/lockControl', needsLinkId: false, hasBody: true, templateBody: { lockControl: { lockState: { nextLockState: 'secure' } } }, description: 'Broadcast one lock state command to all locks linked to the selected gateway.' },
    { id: 'lockStatusSingle', label: 'GET /edgeDevices/{linkId}/lockStatus', method: 'GET', pathTemplate: '/edgeDevices/{linkId}/lockStatus', needsLinkId: true, hasBody: false, templateBody: null, description: 'Read current status for one linked edge device.' },
    { id: 'params', label: 'GET /edgeDevices/{linkId}/params', method: 'GET', pathTemplate: '/edgeDevices/{linkId}/params', needsLinkId: true, hasBody: false, templateBody: null, description: 'Fetch current reader and audit parameters from a lock.' },
    { id: 'time', label: 'GET /edgeDevices/{linkId}/time', method: 'GET', pathTemplate: '/edgeDevices/{linkId}/time', needsLinkId: true, hasBody: false, templateBody: null, description: 'Read the current lock RTC time before deciding whether to correct it.' },
    { id: 'config', label: 'PUT /edgeDevices/{linkId}/config', method: 'PUT', pathTemplate: '/edgeDevices/{linkId}/config', needsLinkId: true, hasBody: true, templateBody: { config: { invCrdAudEn: 'T', auditIDEn: 'T', proxConfHID: 'T', mi14443: 'T' } }, description: 'Update reader and audit flags with user-friendly Enabled/Disabled controls.' },
    { id: 'configDelete', label: 'DELETE /edgeDevices/{linkId}/config', method: 'DELETE', pathTemplate: '/edgeDevices/{linkId}/config', needsLinkId: true, hasBody: false, templateBody: null, description: 'Cancel an in-flight configuration change for the selected device.' },
    { id: 'database', label: 'PUT /edgeDevices/{linkId}/database', method: 'PUT', pathTemplate: '/edgeDevices/{linkId}/database', needsLinkId: true, hasBody: true, templateBody: { db: { usrRcrd: { deleteAll: 1, delete: [], update: [], add: [{ usrID: 20020, adaEn: 0, fnctn: 'norm', crSch: 1, actDtTm: '20000101000000', expDtTm: '21350101000000', primeCr: 'REPLACE_WITH_ENCRYPTED_HEX_32_CHARS', prCrTyp: 'card', scndCrTyp: 'null' }] }, schedules: [{ days: ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'], strtHr: 0, strtMn: 0, lngth: 1440 }], holidays: [], autoUnlock: [] }, dbDwnLdTm: '', nxtDbVerTS: '0x' + Date.now().toString(16).padStart(16, '0') }, description: 'Build and send an ENGAGE database payload with guided examples for important sections.' },
    { id: 'dbDownloadStatus', label: 'GET /edgeDevices/{linkId}/dbDownloadStatus', method: 'GET', pathTemplate: '/edgeDevices/{linkId}/dbDownloadStatus', needsLinkId: true, hasBody: false, templateBody: null, description: 'Read transfer progress for the current database push.' },
    { id: 'databaseDelete', label: 'DELETE /edgeDevices/{linkId}/database', method: 'DELETE', pathTemplate: '/edgeDevices/{linkId}/database', needsLinkId: true, hasBody: false, templateBody: null, description: 'Cancel an in-flight database transfer.' },
    { id: 'auditsSingle', label: 'GET /edgeDevices/{linkId}/audits', method: 'GET', pathTemplate: '/edgeDevices/{linkId}/audits', needsLinkId: true, hasBody: false, templateBody: null, description: 'Read locally stored audits for one linked edge device.' },
    { id: 'auditsSingleDelete', label: 'DELETE /edgeDevices/{linkId}/audits', method: 'DELETE', pathTemplate: '/edgeDevices/{linkId}/audits', needsLinkId: true, hasBody: false, templateBody: null, description: 'Clear locally stored audits for one linked edge device.' },
    { id: 'auditsAll', label: 'GET /edgeDevices/audits', method: 'GET', pathTemplate: '/edgeDevices/audits', needsLinkId: false, hasBody: false, templateBody: null, description: 'Read locally stored audits for all linked edge devices on the selected gateway.' },
    { id: 'auditsAllDelete', label: 'DELETE /edgeDevices/audits', method: 'DELETE', pathTemplate: '/edgeDevices/audits', needsLinkId: false, hasBody: false, templateBody: null, description: 'Clear locally stored audits for all linked edge devices on the selected gateway.' },
    { id: 'gatewayNetworkStatistics', label: 'GET /gateway/gatewayNetworkStatistics', method: 'GET', pathTemplate: '/gateway/gatewayNetworkStatistics', needsLinkId: false, hasBody: false, templateBody: null, description: 'Inspect aggregated request timing, status, and link-level diagnostics recorded by the Playground.' },
    { id: 'gatewayEventLog', label: 'GET /gateway/gatewayEventLog', method: 'GET', pathTemplate: '/gateway/gatewayEventLog', needsLinkId: false, hasBody: false, templateBody: null, description: 'Inspect recent gateway requests, responses, and events recorded by the Playground.' },
  ];

  const API_GROUPS = [
    {
      id: 'group-10-1',
      sequence: '10.1',
      title: 'Gateway Configuration & Setup',
      apiIds: ['gatewayTime', 'gatewayConfig', 'gatewayDeviceInfo', 'gatewayScanList'],
    },
    {
      id: 'group-10-2',
      sequence: '10.2',
      title: 'Linking & Controlling Edge Devices',
      apiIds: [
        'edgeLinkCreate',
        'linkList',
        'lockControlBulk',
        'lockStatus',
        'unlinkDevice',
        'database',
        'databaseDelete',
        'dbDownloadStatus',
        'config',
        'configDelete',
        'params',
        'auditsSingle',
        'auditsSingleDelete',
        'auditsAll',
        'auditsAllDelete',
        'lockControl',
        'lockStatusSingle',
        'time',
      ],
    },
    {
      id: 'group-10-3',
      sequence: '10.3',
      title: 'Gateway Diagnostics',
      apiIds: ['gatewayNetworkStatistics', 'gatewayEventLog'],
    },
  ];

  const API_SEQUENCE = {
    gatewayTime: '10.1.3',
    gatewayConfig: '10.1.4',
    gatewayDeviceInfo: '10.1.5',
    gatewayScanList: '10.1.6',
    edgeLinkCreate: '10.2.1',
    linkList: '10.2.2',
    lockControlBulk: '10.2.3',
    lockStatus: '10.2.4',
    unlinkDevice: '10.2.5',
    database: '10.2.6',
    databaseDelete: '10.2.7',
    dbDownloadStatus: '10.2.8',
    config: '10.2.9',
    configDelete: '10.2.10',
    params: '10.2.11',
    auditsSingle: '10.2.12',
    auditsSingleDelete: '10.2.13',
    auditsAll: '10.2.14',
    auditsAllDelete: '10.2.15',
    lockControl: '10.2.16',
    lockStatusSingle: '10.2.17',
    time: '10.2.18',
    gatewayNetworkStatistics: '10.3.1',
    gatewayEventLog: '10.3.2',
  };

  const pgState = { selectedApiId: API_DEFS[0].id, selectedGatewaySn: null, selectedLinkId: null, lastResponse: null, capturedEvents: [], capturing: false, captureTimer: null, sending: false, activeTab: 'response' };

  function $(id) { return document.getElementById(id); }
  function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function getGlobalState() { return (typeof state !== 'undefined') ? state : {}; }
  function selectedApi() { return API_DEFS.find(api => api.id === pgState.selectedApiId) || API_DEFS[0]; }
  function apiSequence(api) { return API_SEQUENCE[api.id] || ''; }
  function apiDisplayLabel(api) { return apiSequence(api) ? `${apiSequence(api)} ${api.label}` : api.label; }
  function cloneTemplate(api = selectedApi()) {
    const template = api.templateBody == null ? null : JSON.parse(JSON.stringify(api.templateBody));
    if (api.id === 'database' && template?.nxtDbVerTS) template.nxtDbVerTS = '0x' + Date.now().toString(16).padStart(16, '0');
    return template;
  }
  function safeParseEditor() { try { return $('pg-payload-editor').value.trim() ? JSON.parse($('pg-payload-editor').value) : null; } catch { return null; } }
  function setEditorJson(value) { $('pg-payload-editor').value = value == null ? '' : JSON.stringify(value, null, 2); clearValidation(); }
  function getConnectedGateways() {
    const s = getGlobalState();
    if (Array.isArray(s.gateways)) return s.gateways.map(g => g?.sn).filter(Boolean);
    return Object.keys(s.gateways || {});
  }
  function getAllLocks() {
    const s = getGlobalState();
    const locks = [];
    for (const [sn, devList] of Object.entries(s.devices || {})) {
      for (const d of devList) locks.push({ sn, linkId: d.linkId, deviceName: d.deviceName || d.linkId, lockState: d.lockState });
    }
    return locks;
  }
  function resolvePath(api) { return api.needsLinkId ? api.pathTemplate.replace('{linkId}', pgState.selectedLinkId || 'UNKNOWN') : api.pathTemplate; }
  function renderApiDropdown() {
    const apiById = Object.fromEntries(API_DEFS.map(api => [api.id, api]));
    const groupedHtml = API_GROUPS.map(group => {
      const options = group.apiIds
        .map(id => apiById[id])
        .filter(Boolean)
        .map(api => `<option value="${api.id}" ${api.id === pgState.selectedApiId ? 'selected' : ''}>${esc(apiDisplayLabel(api))}</option>`)
        .join('');
      return `<optgroup label="${esc(`${group.sequence} ${group.title}`)}">${options}</optgroup>`;
    }).join('');

    const groupedIds = new Set(API_GROUPS.flatMap(group => group.apiIds));
    const ungrouped = API_DEFS
      .filter(api => !groupedIds.has(api.id))
      .map(api => `<option value="${api.id}" ${api.id === pgState.selectedApiId ? 'selected' : ''}>${esc(apiDisplayLabel(api))}</option>`)
      .join('');

    $('pg-api-select').innerHTML = groupedHtml + ungrouped;
  }
  function renderGatewayDropdown() {
    const gateways = getConnectedGateways();
    if (gateways.length === 0) { $('pg-gateway-select').innerHTML = '<option value="">No gateways connected</option>'; pgState.selectedGatewaySn = null; return; }
    if (!pgState.selectedGatewaySn || !gateways.includes(pgState.selectedGatewaySn)) pgState.selectedGatewaySn = gateways[0];
    $('pg-gateway-select').innerHTML = gateways.map(sn => `<option value="${esc(sn)}" ${sn === pgState.selectedGatewaySn ? 'selected' : ''}>GW: ${esc(sn)}</option>`).join('');
  }
  function renderLockDropdown() {
    const api = selectedApi();
    if (!api.needsLinkId) { $('pg-lock-select').innerHTML = '<option value="">(no lock selection needed)</option>'; $('pg-lock-select').disabled = true; return; }
    $('pg-lock-select').disabled = false;
    const locks = getAllLocks().filter(lock => !pgState.selectedGatewaySn || lock.sn === pgState.selectedGatewaySn);
    if (locks.length === 0) { $('pg-lock-select').innerHTML = '<option value="">No locks connected</option>'; pgState.selectedLinkId = null; return; }
    if (!pgState.selectedLinkId || !locks.find(lock => lock.linkId === pgState.selectedLinkId)) pgState.selectedLinkId = locks[0].linkId;
    $('pg-lock-select').innerHTML = locks.map(lock => `<option value="${esc(lock.linkId)}" ${lock.linkId === pgState.selectedLinkId ? 'selected' : ''}>${esc(lock.deviceName)} (${esc(lock.linkId)})</option>`).join('');
  }
  function renderDescription() {
    const api = selectedApi();
    const extra = api.id === 'database' ? ' Guided examples are available below, but raw JSON editing remains enabled.' : api.id === 'config' ? ' Builder values sync back to T/F wire flags and can also set rtcTime.' : api.id === 'lockControl' ? ' Single-lock control now includes frozen modes.' : api.id === 'time' ? ' Recommended first step before deciding whether to correct the lock clock.' : '';
    const prefix = apiSequence(api) ? `${apiSequence(api)} ` : '';
    $('pg-api-desc').innerHTML = `<strong>${esc(prefix)}${api.method} ${esc(resolvePath(api))}</strong> &mdash; ${esc(api.description + extra)}`;
  }
  function populateTemplate() {
    const api = selectedApi();
    const editor = $('pg-payload-editor');
    if (!api.hasBody) { editor.value = ''; editor.placeholder = 'No payload required for this API (GET/DELETE).'; editor.disabled = true; }
    else { editor.disabled = false; editor.placeholder = 'Enter JSON payload...'; setEditorJson(cloneTemplate(api)); }
    clearValidation();
    renderHelperPanel();
  }

  function renderHelperPanel() {
    const api = selectedApi();
    const shell = $('pg-helper-shell');
    const body = $('pg-helper-body');
    const subtitle = $('pg-helper-subtitle');
    if (!['lockControl', 'config', 'database', 'time'].includes(api.id)) { shell.hidden = true; body.innerHTML = ''; return; }
    shell.hidden = false;

    if (api.id === 'lockControl') {
      subtitle.textContent = 'Pick a supported lock mode, review its impact, then sync it into the request body.';
      body.innerHTML = `
        <div class="pg-helper-form">
          <div class="pg-helper-field">
            <label for="pg-lock-mode">Single Lock Mode</label>
            <select class="pg-select" id="pg-lock-mode" onchange="window.playgroundUI.previewLockMode()">
              ${LOCK_CONTROL_MODES.map(mode => `<option value="${esc(mode[0])}">${esc(mode[1])} (${esc(mode[0])})</option>`).join('')}
            </select>
            <div class="pg-helper-note" id="pg-lock-mode-note"></div>
          </div>
          <div class="pg-helper-grid">
            ${LOCK_CONTROL_MODES.map(mode => `<div class="pg-helper-card"><h4>${esc(mode[1])}</h4><p>${esc(mode[2])}</p><div class="pg-helper-meta">${esc(mode[0])}</div></div>`).join('')}
          </div>
          <div class="pg-helper-actions">
            <button class="pg-helper-btn primary" type="button" onclick="window.playgroundUI.applyLockMode()">Sync To JSON</button>
            <button class="pg-helper-btn" type="button" onclick="window.playgroundUI.resetPayload()">Reset Template</button>
          </div>
        </div>`;
      const parsed = safeParseEditor();
      $('pg-lock-mode').value = parsed?.lockControl?.lockState?.nextLockState || cloneTemplate(api).lockControl.lockState.nextLockState;
      previewLockMode();
      return;
    }

    if (api.id === 'config') {
      subtitle.textContent = 'Use Enabled/Disabled controls for reader and audit flags, then sync the generated T/F payload.';
      body.innerHTML = `
        <div class="pg-helper-hint">The gateway expects wire values of <strong>T</strong> and <strong>F</strong>. The builder shows them as Enabled (T) and Disabled (F).</div>
        <div class="pg-helper-row">
          <div class="pg-helper-key">rtcTime<small>Lock RTC Time</small></div>
          <div style="display:grid;gap:8px">
            <input class="pg-select" id="cfg-rtcTime" type="text" placeholder="YYYYMMDDHHmmss">
            <div class="pg-helper-actions">
              <button class="pg-helper-btn" type="button" onclick="window.playgroundUI.useCurrentHostTime()">Use Current Host Time</button>
              <button class="pg-helper-btn" type="button" onclick="window.playgroundUI.openTimeReadApi()">Read Lock Time First</button>
            </div>
          </div>
          <div class="pg-helper-note">Set the lock clock in ENGAGE format: <code>YYYYMMDDHHmmss</code>. Read <code>/time</code> first, compare it to host time, then send only when correction is needed.</div>
        </div>
        <div class="pg-helper-table">
          ${CONFIG_FIELDS.map(field => `
            <div class="pg-helper-row">
              <div class="pg-helper-key">${esc(field[0])}<small>${esc(field[1])}</small></div>
              <div><select class="pg-select" id="cfg-${esc(field[0])}"><option value="T">Enabled (T)</option><option value="F">Disabled (F)</option></select></div>
              <div class="pg-helper-note">${esc(field[2])}</div>
            </div>`).join('')}
        </div>
        <div class="pg-helper-actions">
          <button class="pg-helper-btn primary" type="button" onclick="window.playgroundUI.applyConfigBuilder()">Sync To JSON</button>
          <button class="pg-helper-btn" type="button" onclick="window.playgroundUI.resetPayload()">Reset Template</button>
        </div>`;
      const config = safeParseEditor()?.config || cloneTemplate(api).config;
      if ($('cfg-rtcTime')) $('cfg-rtcTime').value = typeof config.rtcTime === 'string' ? config.rtcTime : '';
      CONFIG_FIELDS.forEach(field => { const input = $('cfg-' + field[0]); if (input) input.value = String(config[field[0]] || 'F').toUpperCase() === 'T' ? 'T' : 'F'; });
      return;
    }

    if (api.id === 'time') {
      subtitle.textContent = 'Read the lock RTC first, compare it to host time, then switch to config only if correction is needed.';
      body.innerHTML = `
        <div class="pg-helper-hint">Suggested flow: 1. Send <strong>GET /time</strong>. 2. Compare the returned <code>rtcTime</code> to your actual host time. 3. If needed, open the config API and send a corrected <code>rtcTime</code>.</div>
        <div class="pg-helper-actions">
          <button class="pg-helper-btn primary" type="button" onclick="window.playgroundUI.send()">Read Lock Time</button>
          <button class="pg-helper-btn" type="button" onclick="window.playgroundUI.openTimeSyncConfig()">Open Config Time Sync</button>
        </div>
        <div class="pg-helper-example">Expected response example:\n{\n  "rtcTime": "20260409150300"\n}\n\nIf the host time is 20260409150100, send this correction via PUT /config:\n{\n  "config": {\n    "rtcTime": "20260409150100"\n  }\n}</div>`;
      return;
    }

    subtitle.textContent = 'Choose the database sections you want in the sample payload, then sync them into the JSON editor.';
    body.innerHTML = `
      <div class="pg-helper-hint">The backend fully validates <strong>usrRcrd</strong> and <strong>schedules</strong>. Optional sections like <strong>firstPersonIn</strong> are inserted as editable examples because the repo does not yet validate their exact wire contract.</div>
      <div class="pg-helper-form">
        <div class="pg-helper-grid">
          <div class="pg-helper-field">
            <label for="pg-db-deleteAll">Credential Update Mode</label>
            <select class="pg-select" id="pg-db-deleteAll" onchange="window.playgroundUI.previewDatabaseBuilder()">
              <option value="1">Full replace (deleteAll = 1)</option>
              <option value="0">Incremental update (deleteAll = 0)</option>
            </select>
          </div>
          <div class="pg-helper-field">
            <label for="pg-db-keep-sample-user">Sample Credential</label>
            <select class="pg-select" id="pg-db-keep-sample-user" onchange="window.playgroundUI.previewDatabaseBuilder()">
              <option value="true">Include sample user record</option>
              <option value="false">Omit sample user record</option>
            </select>
          </div>
        </div>
        <div class="pg-helper-table">
          ${DB_FIELDS.map(field => `
            <div class="pg-helper-row">
              <div class="pg-helper-key">${esc(field[0])}<small>${esc(field[1])}</small></div>
              <label class="pg-helper-check"><input type="checkbox" id="db-include-${esc(field[0])}" ${['usrRcrd', 'schedules', 'holidays', 'autoUnlock', 'dbDwnLdTm', 'nxtDbVerTS'].includes(field[0]) ? 'checked' : ''} onchange="window.playgroundUI.previewDatabaseBuilder()"> Include example</label>
              <div><div class="pg-helper-note">${esc(field[2])}</div><div class="pg-helper-meta">${esc(field[3])}</div></div>
            </div>`).join('')}
        </div>
        <div class="pg-helper-actions">
          <button class="pg-helper-btn primary" type="button" onclick="window.playgroundUI.applyDatabaseBuilder()">Sync To JSON</button>
          <button class="pg-helper-btn" type="button" onclick="window.playgroundUI.resetPayload()">Reset Template</button>
        </div>
      </div>
      <div class="pg-helper-example" id="pg-db-example"></div>`;
    previewDatabaseBuilder();
  }

  function previewLockMode() {
    const selected = LOCK_CONTROL_MODES.find(mode => mode[0] === $('pg-lock-mode')?.value) || LOCK_CONTROL_MODES[0];
    $('pg-lock-mode-note').textContent = `${selected[2]} Wire value: ${selected[0]}`;
  }

  function buildDatabaseFromBuilder() {
    const include = key => $('db-include-' + key)?.checked;
    const deleteAll = Number($('pg-db-deleteAll')?.value || 1);
    const keepSampleUser = String($('pg-db-keep-sample-user')?.value || 'true') === 'true';
    const payload = { db: {} };
    if (include('usrRcrd')) {
      payload.db.usrRcrd = { deleteAll, delete: [], update: [], add: keepSampleUser ? [{ usrID: 20020, adaEn: 0, fnctn: 'norm', crSch: 1, actDtTm: '20000101000000', expDtTm: '21350101000000', primeCr: 'REPLACE_WITH_ENCRYPTED_HEX_32_CHARS', prCrTyp: 'card', scndCrTyp: 'null' }] : [] };
    }
    if (include('schedules')) payload.db.schedules = [{ days: ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'], strtHr: 0, strtMn: 0, lngth: 1440 }];
    if (include('holidays')) payload.db.holidays = [];
    if (include('autoUnlock')) payload.db.autoUnlock = [{ days: ['Mo', 'Tu', 'We', 'Th', 'Fr'], strtHr: 8, strtMn: 0, lngth: 60 }];
    if (include('firstPersonIn')) payload.db.firstPersonIn = { enabled: true, unlockMinutes: 15 };
    if (include('dbDwnLdTm')) payload.dbDwnLdTm = '';
    if (include('nxtDbVerTS')) payload.nxtDbVerTS = '0x' + Date.now().toString(16).padStart(16, '0');
    return payload;
  }

  function previewDatabaseBuilder() { const example = $('pg-db-example'); if (example) example.textContent = JSON.stringify(buildDatabaseFromBuilder(), null, 2); }
  function applyLockMode() { setEditorJson({ lockControl: { lockState: { nextLockState: $('pg-lock-mode')?.value || 'secure' } } }); validate(); }
  function applyConfigBuilder() {
    const config = {};
    const rtcTime = $('cfg-rtcTime')?.value.trim();
    if (rtcTime) config.rtcTime = rtcTime;
    CONFIG_FIELDS.forEach(field => { config[field[0]] = $('cfg-' + field[0])?.value === 'T' ? 'T' : 'F'; });
    setEditorJson({ config });
    validate();
  }
  function applyDatabaseBuilder() { setEditorJson(buildDatabaseFromBuilder()); previewDatabaseBuilder(); validate(); }

  function hostTimeString() {
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }

  function useCurrentHostTime() {
    const input = $('cfg-rtcTime');
    if (input) input.value = hostTimeString();
  }

  function selectApiById(apiId) {
    pgState.selectedApiId = apiId;
    const select = $('pg-api-select');
    if (select) select.value = apiId;
    renderLockDropdown();
    renderDescription();
    populateTemplate();
    pgState.lastResponse = null;
    renderResponse();
  }

  function openTimeReadApi() {
    selectApiById('time');
  }

  function openTimeSyncConfig() {
    selectApiById('config');
    setTimeout(() => {
      const input = $('cfg-rtcTime');
      if (input && !input.value) input.value = hostTimeString();
    }, 0);
  }

  function openHelpModal() {
    const api = selectedApi();
    let title = 'API Playground Coverage Audit';
    let cards = [
      ['Implemented WebSocket Requests', 'GET /edgeDevices/linkList, GET /edgeDevices/lockStatus, PUT /edgeDevices/{linkId}/lockControl, PUT /edgeDevices/{linkId}/config, GET /edgeDevices/{linkId}/params, PUT /edgeDevices/{linkId}/database, GET /edgeDevices/{linkId}/dbDownloadStatus, and DELETE /edgeDevices/{linkId}/database are wired through this repo.'],
      ['Automatic Event Subscription', 'Event subscription is implemented during the server-to-gateway handshake and is intentionally not exposed as a manual Playground action.'],
      ['Known Contract Inconsistencies', 'Repo docs show different raw eventType examples: numeric in README/GATEWAY_SETUP, 8-character audit hex in implementation, and string-style examples elsewhere. The dashboard consumes a normalized SSE event contract, not the raw gateway frame.'],
      ['Database Schema Gaps', 'The repo fully validates usrRcrd and schedules, but fields like firstPersonIn are not yet validated by backend helpers. The builder inserts those sections as editable examples only.'],
    ];

    if (api.id === 'lockControl') {
      title = 'Lock Control Field Guide';
      cards = LOCK_CONTROL_MODES.map(mode => [`${mode[1]} (${mode[0]})`, mode[2]]);
    } else if (api.id === 'time') {
      title = 'Lock Time Read Guide';
      cards = [
        ['GET /time', 'Reads the current RTC value from the selected lock.'],
        ['Expected Response', 'The lock should return a payload like {"rtcTime":"20260409150300"} in ENGAGE YYYYMMDDHHmmss format.'],
        ['Correction Flow', 'If the returned time is wrong, switch to PUT /config and send {"config":{"rtcTime":"<actual host time>"}}.'],
      ];
    } else if (api.id === 'config') {
      title = 'Reader / Audit Config Guide';
      cards = [['Lock RTC Time (rtcTime)', 'Optional time correction field. Use YYYYMMDDHHmmss format, for example 20260409150100.']].concat(CONFIG_FIELDS.map(field => [`${field[1]} (${field[0]})`, `${field[2]} Enabled writes "T". Disabled writes "F".`]));
    } else if (api.id === 'database') {
      title = 'Database Payload Guide';
      cards = DB_FIELDS.map(field => [`${field[0]} · ${field[1]}`, `${field[2]} Valid values: ${field[3]}`]);
    }

    $('pg-help-title').textContent = title;
    $('pg-help-body').innerHTML = cards.map(card => `<div style="padding:12px 14px;border-radius:10px;border:1px solid rgba(148,163,184,.18);background:rgba(255,255,255,.03);margin-bottom:12px"><div style="font-weight:700;color:var(--text);margin-bottom:6px">${esc(card[0])}</div><div style="color:var(--text-dim)">${esc(card[1])}</div></div>`).join('');
    $('pg-help-modal').classList.add('show');
  }

  function closeHelpModal() { $('pg-help-modal').classList.remove('show'); }
  function resetPayload() { populateTemplate(); validate(); }

  function validate() {
    const api = selectedApi();
    const errors = [];
    const warnings = [];
    const editor = $('pg-payload-editor');
    if (!api.hasBody) { renderValidation(errors, warnings); return true; }

    let parsed;
    try { parsed = JSON.parse(editor.value); } catch (e) {
      const match = e.message.match(/position (\d+)/);
      let hint = '';
      if (match) {
        const pos = Number.parseInt(match[1], 10);
        const lines = editor.value.substring(0, pos).split('\n');
        hint = ` (line ${lines.length}, col ${lines[lines.length - 1].length + 1})`;
      }
      errors.push({ field: 'JSON', message: `Syntax error${hint}: ${e.message}` });
      renderValidation(errors, warnings);
      return false;
    }

    if (api.id === 'lockControl' || api.id === 'lockControlBulk') validateLockControl(parsed, errors);
    else if (api.id === 'config') validateConfig(parsed, errors, warnings);
    else if (api.id === 'database') validateDatabase(parsed, errors, warnings);
    if (api.needsLinkId && !pgState.selectedLinkId) errors.push({ field: 'Lock', message: 'No lock selected. Select a lock from the dropdown.' });
    if (!pgState.selectedGatewaySn) errors.push({ field: 'Gateway', message: 'No gateway connected.' });
    renderValidation(errors, warnings);
    return errors.length === 0;
  }

  function validateLockControl(parsed, errors) {
    const nextState = parsed?.lockControl?.lockState?.nextLockState;
    const validStates = LOCK_CONTROL_MODES.map(mode => mode[0]);
    if (!nextState) errors.push({ field: 'lockControl.lockState.nextLockState', message: `Required. Must be one of: ${validStates.join(', ')}.` });
    else if (!validStates.includes(nextState)) errors.push({ field: 'nextLockState', message: `"${nextState}" is invalid. Must be one of: ${validStates.join(', ')}.` });
  }

  function validateConfig(parsed, errors, warnings) {
    const config = parsed?.config;
    if (!config || typeof config !== 'object') { errors.push({ field: 'config', message: 'Root "config" object is required.' }); return; }
    const validBooleans = ['T', 'F', 'true', 'false', true, false, 1, 0];
    const knownKeys = CONFIG_FIELDS.map(field => field[0]).concat(['proxConfGE4001', 'proxConfGE4002']);
    for (const [key, val] of Object.entries(config)) {
      if (key === 'rtcTime') {
        if (typeof val !== 'string' || !/^\d{14}$/.test(val)) {
          errors.push({ field: key, message: 'rtcTime must use YYYYMMDDHHmmss format, for example 20260409150100.' });
        }
      } else if (!knownKeys.includes(key)) warnings.push({ field: key, message: `Unknown config key "${key}". It will be sent as-is but may be ignored by the lock.` });
      else if (!validBooleans.includes(val)) errors.push({ field: key, message: `Value "${val}" is invalid. Use Enabled (T) or Disabled (F).` });
    }
  }

  function validateDatabase(parsed, errors, warnings) {
    if (!parsed?.db) { errors.push({ field: 'db', message: 'Root "db" object is required.' }); return; }
    const db = parsed.db;
    if (!db.usrRcrd) errors.push({ field: 'db.usrRcrd', message: 'User record section is required.' });
    else {
      if (db.usrRcrd.deleteAll === undefined) warnings.push({ field: 'db.usrRcrd.deleteAll', message: 'Missing deleteAll. Set 1 for full replace or 0 for incremental update.' });
      const addList = db.usrRcrd.add || [];
      if (!Array.isArray(addList)) errors.push({ field: 'db.usrRcrd.add', message: 'Must be an array of user records.' });
      else {
        addList.forEach((user, i) => {
          const prefix = `add[${i}]`;
          if (!Number.isInteger(user.usrID) || user.usrID < 1) errors.push({ field: `${prefix}.usrID`, message: `usrID must be a positive integer. Got: ${user.usrID}` });
          if (typeof user.primeCr !== 'string' || user.primeCr.length !== 32) errors.push({ field: `${prefix}.primeCr`, message: `Must be exactly 32 hex characters (16 bytes). Got ${(user.primeCr || '').length} chars.` });
          else if (!/^[0-9a-fA-F]{32}$/.test(user.primeCr)) errors.push({ field: `${prefix}.primeCr`, message: 'Contains non-hex characters. Must use 0-9 and a-f only.' });
          if (user.actDtTm && !/^\d{14}$/.test(user.actDtTm)) errors.push({ field: `${prefix}.actDtTm`, message: 'Must be 14-digit datetime (YYYYMMDDHHmmss).' });
          if (user.expDtTm && !/^\d{14}$/.test(user.expDtTm)) errors.push({ field: `${prefix}.expDtTm`, message: 'Must be 14-digit datetime (YYYYMMDDHHmmss).' });
        });
      }
    }
    if (!db.schedules || !Array.isArray(db.schedules)) errors.push({ field: 'db.schedules', message: 'Schedules array is required.' });
    if (Object.prototype.hasOwnProperty.call(db, 'firstPersonIn')) warnings.push({ field: 'db.firstPersonIn', message: 'firstPersonIn is exposed as an editable example only. The repo does not yet validate its exact gateway contract.' });
    if (!parsed.nxtDbVerTS) warnings.push({ field: 'nxtDbVerTS', message: 'Missing. Recommended for version tracking.' });
  }

  function clearValidation() { $('pg-validation').innerHTML = ''; $('pg-validation').className = 'pg-validation'; }
  function renderValidation(errors, warnings) {
    const el = $('pg-validation');
    if (errors.length === 0 && warnings.length === 0) { el.className = 'pg-validation is-valid'; el.innerHTML = '<div class="pg-val-item">&#10003; Payload is valid</div>'; return; }
    el.className = 'pg-validation' + (errors.length > 0 ? ' has-errors' : ' is-valid');
    el.innerHTML = [...errors.map(error => `<div class="pg-val-item">&#10007; <span class="pg-val-field">${esc(error.field)}</span>: ${esc(error.message)}</div>`), ...warnings.map(warning => `<div class="pg-val-item" style="color:#fbbf24">&#9888; <span class="pg-val-field">${esc(warning.field)}</span>: ${esc(warning.message)}</div>`)].join('');
  }

  async function send() {
    if (pgState.sending || !validate()) return;
    const api = selectedApi();
    const path = resolvePath(api);
    let body = null;
    if (api.hasBody) { try { body = JSON.parse($('pg-payload-editor').value); } catch { return; } }

    pgState.sending = true;
    pgState.lastResponse = null;
    pgState.capturedEvents = [];
    pgState.capturing = true;
    clearTimeout(pgState.captureTimer);
    pgState.captureTimer = setTimeout(() => stopCapture(), 30000);

    const btn = $('pg-send-btn');
    btn.disabled = true;
    btn.classList.add('loading');
    btn.textContent = 'Sending...';
    $('pg-send-status').textContent = '';
    $('pg-timing').textContent = '';
    renderCaptureState();
    renderEvents();
    renderSentPanel(api.method, path, body);

    const sendTime = performance.now();
    try {
      const res = await fetch('/api/playground/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gateway_sn: pgState.selectedGatewaySn, method: api.method, path, body }),
      });
      const data = await res.json();
      pgState.lastResponse = {
        httpStatus: res.status,
        responseStatus: data.responseStatus || (res.ok ? '200' : String(res.status)),
        responseBody: data.responseBody || data,
        error: data.error || null,
        sentMethod: api.method,
        sentPath: path,
        sentBody: body,
        sentAt: data.sentAt,
        receivedAt: data.receivedAt,
        elapsed: Math.round(performance.now() - sendTime),
      };
      $('pg-timing').textContent = `${pgState.lastResponse.elapsed} ms`;
      renderResponse();
    } catch (err) {
      pgState.lastResponse = { httpStatus: 0, responseStatus: 'ERROR', responseBody: null, error: err.message, sentMethod: api.method, sentPath: path, sentBody: body, elapsed: Math.round(performance.now() - sendTime) };
      renderResponse();
    } finally {
      pgState.sending = false;
      btn.disabled = false;
      btn.classList.remove('loading');
      btn.textContent = 'Send Request';
    }
  }

  function getErrorExplanation(httpStatus, error) {
    if (httpStatus === 503 || (error && error.includes('timeout'))) return 'Explanation: Gateway did not respond within the timeout.\nPossible causes:\n  - Lock is out of BLE range\n  - Gateway is busy\n  - Lock battery is low\n  - Gateway 24-hour re-authentication is in progress';
    if (httpStatus === 404) return 'Explanation: Gateway or lock was not found.\nCheck the selected gateway serial and lock linkId.';
    if (httpStatus === 400) return 'Explanation: Bad request. Review the builder guidance and validation messages.';
    return '';
  }

  function renderResponse() {
    const response = pgState.lastResponse;
    if (!response) { $('pg-response-body').textContent = 'Send a request to see the response here.'; $('pg-response-header').style.display = 'none'; return; }
    $('pg-response-header').style.display = '';
    $('pg-response-status').textContent = response.responseStatus;
    $('pg-response-status').className = 'pg-status-tag ' + (String(response.responseStatus) === '200' ? 'pg-status-200' : 'pg-status-err');
    $('pg-response-path').textContent = `${response.sentMethod} ${response.sentPath}`;
    let bodyText = '';
    if (response.error) bodyText = `ERROR: ${response.error}\n\n${getErrorExplanation(response.httpStatus, response.error)}`;
    if (response.responseBody) bodyText += (bodyText ? '\n\n--- Response Body ---\n' : '') + JSON.stringify(response.responseBody, null, 2);
    $('pg-response-body').textContent = bodyText || '(empty response)';
    switchTab('response');
  }

  function renderSentPanel(method, path, body) {
    $('pg-sent-header').style.display = '';
    $('pg-sent-method-path').textContent = `${method} ${path}`;
    $('pg-sent-body').textContent = body ? JSON.stringify(body, null, 2) : '(no body — GET/DELETE request)';
  }

  function switchTab(tab) {
    pgState.activeTab = tab;
    ['response', 'sent', 'events'].forEach(name => {
      const panel = $('pg-panel-' + name);
      const button = $('pg-tab-' + name);
      if (panel) panel.style.display = name === tab ? 'flex' : 'none';
      if (button) button.classList.toggle('active', name === tab);
    });
  }

  function onEvent(eventData) {
    if (!pgState.capturing) return;
    pgState.capturedEvents.push({ ...eventData, _capturedAt: new Date().toISOString() });
    updateEventCount();
    if (pgState.activeTab === 'events') renderEvents();
  }

  function updateEventCount() {
    const badge = $('pg-event-count');
    badge.textContent = pgState.capturedEvents.length;
    badge.style.display = pgState.capturedEvents.length > 0 ? '' : 'none';
  }

  function renderEvents() {
    const el = $('pg-event-list');
    if (pgState.capturedEvents.length === 0) { el.innerHTML = '<div class="pg-empty">Events will appear here after sending a request.</div>'; return; }
    el.innerHTML = pgState.capturedEvents.map(ev => {
      const time = (ev._capturedAt || '').split('T')[1]?.split('.')[0] || '';
      const evType = ev.type || 'unknown';
      const resultClass = ev.result === 'granted' ? 'pg-event-granted' : ev.result === 'denied' ? 'pg-event-denied' : (ev.result === 'warning' || ev.result === 'alert') ? 'pg-event-warning' : 'pg-event-info';
      let summary = ev.title || (ev.status ? `Status: ${ev.status}` : (ev.action ? `Action: ${ev.action}` : ''));
      if (ev.linkId) summary += ` [${ev.linkId}]`;
      if (ev.progress !== undefined) summary += ` (${ev.progress}%)`;
      const mapping = ev.workbookMapping;
      const workbookLine = mapping
        ? `${mapping.eventHex || ''}${mapping.dataHex ? ` / ${mapping.dataHex}` : ''}${mapping.caption ? ` / ${mapping.caption}` : ''}${mapping.matched ? '' : ' / No workbook match'}`
        : '';
      const bodyParts = [ev.reason || ev.subject || '', workbookLine].filter(Boolean);
      return `<div class="pg-event-row"><span class="pg-event-time">${esc(time)}</span><span class="pg-event-type ${resultClass}">${esc(evType)}</span><span class="pg-event-body">${esc(summary)}${bodyParts.length ? ' — ' + esc(bodyParts.join(' | ')) : ''}</span></div>`;
    }).join('');
    el.scrollTop = el.scrollHeight;
  }

  function renderCaptureState() {
    if (pgState.capturing) { $('pg-capture-indicator').style.display = ''; $('pg-capture-toggle').textContent = 'Stop'; }
    else { $('pg-capture-indicator').style.display = 'none'; $('pg-capture-toggle').textContent = 'Start'; }
  }
  function toggleCapture() { if (pgState.capturing) stopCapture(); else { pgState.capturing = true; clearTimeout(pgState.captureTimer); pgState.captureTimer = setTimeout(() => stopCapture(), 30000); renderCaptureState(); } }
  function stopCapture() { pgState.capturing = false; clearTimeout(pgState.captureTimer); renderCaptureState(); }
  function clearEvents() { pgState.capturedEvents = []; updateEventCount(); renderEvents(); }
  function onApiChange() { pgState.selectedApiId = $('pg-api-select').value; renderLockDropdown(); renderDescription(); populateTemplate(); pgState.lastResponse = null; renderResponse(); }
  function onGatewayChange() { pgState.selectedGatewaySn = $('pg-gateway-select').value; renderLockDropdown(); renderDescription(); }
  function onLockChange() { pgState.selectedLinkId = $('pg-lock-select').value; renderDescription(); }

  function onActivated() {
    renderApiDropdown();
    renderGatewayDropdown();
    renderLockDropdown();
    renderDescription();
    renderHelperPanel();
    renderCaptureState();
    updateEventCount();
    if (pgState.activeTab === 'events') renderEvents();
    else if (pgState.activeTab === 'sent') renderSentPanel(pgState.lastResponse?.sentMethod || selectedApi().method, pgState.lastResponse?.sentPath || resolvePath(selectedApi()), pgState.lastResponse?.sentBody || null);
    else renderResponse();
    switchTab(pgState.activeTab || 'response');
  }

  function init() { renderApiDropdown(); renderGatewayDropdown(); renderLockDropdown(); renderDescription(); populateTemplate(); switchTab('response'); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else setTimeout(init, 0);

  window.playgroundUI = {
    onActivated,
    onEvent,
    onApiChange,
    onGatewayChange,
    onLockChange,
    send,
    switchTab,
    toggleCapture,
    clearEvents,
    resetPayload,
    previewLockMode,
    previewDatabaseBuilder,
    applyLockMode,
    applyConfigBuilder,
    applyDatabaseBuilder,
    useCurrentHostTime,
    openTimeReadApi,
    openTimeSyncConfig,
    openHelpModal,
    closeHelpModal,
  };
})();
